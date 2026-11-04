import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { emptyPlatformSettings, emptySpeech, parseSpeech, type SpeechSettings } from '../src/db.ts'
import { SPEECH_PRESETS, billedSeconds, canonicalWav, resolveSpeech, speechSecretName, transcribe } from '../src/lib/speech.ts'

const wavSeconds = (b: Buffer) => canonicalWav(b).seconds
import { Meter } from '../src/lib/meter.ts'

const LOCAL_ENV = { GATEWAY_SPEECH_ALLOW_PRIVATE: '1' }

/** 和页面 chat-voice.js 的 encodeWav 同一个格式：16 位单声道 PCM。 */
function wav(seconds: number, opts: { rate?: number; channels?: number; bits?: number; format?: number; dataSize?: number } = {}): Buffer {
  const rate = opts.rate ?? 16_000
  const data = Math.round(seconds * rate) * 2
  const b = Buffer.alloc(44 + data)
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8, 'ascii')
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(opts.format ?? 1, 20); b.writeUInt16LE(opts.channels ?? 1, 22)
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(opts.bits ?? 16, 34)
  b.write('data', 36, 'ascii'); b.writeUInt32LE(opts.dataSize ?? data, 40)
  return b
}

test('WAV 时长按字节数算，不信头里写的长度', () => {
  assert.equal(wavSeconds(wav(2.5)), 2.5)
  assert.equal(wavSeconds(wav(1, { rate: 8000 })), 1)
  // 流式写出的 WAV 头里 data 长度常是 0xFFFFFFFF：按实际收到的字节截。
  assert.equal(wavSeconds(wav(3, { dataSize: 0xffffffff })), 3)
  // 写 0 的（没回填长度）按收到的全部算。
  assert.equal(wavSeconds(wav(2, { dataSize: 0 })), 2)
})

test('头里把长度写小：计费和转给上游的是同一段，多塞的音频不会被识别', () => {
  const sneaky = wav(30, { dataSize: 16_000 * 2 }) // 头说 1 秒，实际 30 秒
  const { wav: out, seconds } = canonicalWav(sneaky)
  assert.equal(seconds, 1)
  assert.equal(out.length, 44 + 32_000, '转给上游的只能是计费的那一秒')
  assert.equal(out.readUInt32LE(40), 32_000)
  assert.equal(out.readUInt32LE(4), 36 + 32_000)
})

test('不是 16 位单声道 PCM 的一律拒', () => {
  for (const bad of [wav(1, { channels: 2 }), wav(1, { bits: 8 }), wav(1, { format: 3 }), wav(1, { rate: 96_000 }), Buffer.from('not a wav at all, definitely not a wav file here')]) {
    assert.throws(() => wavSeconds(bad), /WAV/)
  }
  const noData = wav(1).subarray(0, 36)
  assert.throws(() => wavSeconds(Buffer.concat([noData, Buffer.alloc(16)])), /WAV/)
})

test('计费秒数：不足一秒按一秒', () => {
  assert.equal(billedSeconds(0.4), 1)
  assert.equal(billedSeconds(1), 1)
  assert.equal(billedSeconds(1.01), 2)
  assert.equal(billedSeconds(59.2), 60)
})

test('配置：预设用代码里的地址，自定义要 HTTPS，没配就不可用', () => {
  const none = resolveSpeech(emptySpeech(), 'k', {})
  assert.match(none.error, /还没有配置/)
  assert.equal(resolveSpeech({ ...emptySpeech(), region: 'intl', provider: 'openai' }, 'k', {}).model, 'gpt-transcribe', 'OpenAI 默认该是没弃用的那个')
  const zhipu = resolveSpeech({ ...emptySpeech(), region: 'cn', provider: 'zhipu' }, 'k', {})
  assert.equal(zhipu.error, '')
  assert.equal(zhipu.base, SPEECH_PRESETS.find((p) => p.id === 'zhipu')!.baseUrl)
  assert.equal(zhipu.model, 'glm-asr-2512')
  assert.equal(zhipu.maxSeconds, 30)
  assert.match(resolveSpeech({ ...emptySpeech(), provider: 'custom', baseUrl: 'http://example.com/v1', model: 'x' }, 'k', {}).error, /HTTPS/)
  assert.match(resolveSpeech({ ...emptySpeech(), provider: 'custom', baseUrl: 'https://example.com/v1', model: '' }, 'k', {}).error, /模型/)
  assert.match(resolveSpeech({ ...emptySpeech(), provider: 'nope' }, 'k', {}).error, /不认识/)
  // 自定义的密钥钉在 origin 上：换主机就是另一把。
  assert.notEqual(speechSecretName('custom', 'https://a.example/v1'), speechSecretName('custom', 'https://b.example/v1'))
  assert.equal(speechSecretName('openai'), 'speech:openai')
})

test('设置解析：负价和乱填都收成 0', () => {
  assert.equal(parseSpeech({ pricing: { minuteMicros: -3 } }).pricing.minuteMicros, 0)
  assert.equal(parseSpeech({ pricing: { minuteMicros: 'x' } }).pricing.minuteMicros, 0)
  assert.equal(parseSpeech({ pricing: { minuteMicros: 4500.4 } }).pricing.minuteMicros, 4500)
  // 早先按厘存的老数据照常换算：6 厘 = 6000 微元。
  assert.equal(parseSpeech({ pricing: { minuteMils: 6 } }).pricing.minuteMicros, 6000)
  assert.equal(parseSpeech({ pricing: { minuteMicros: 4500, minuteMils: 6 } }).pricing.minuteMicros, 4500)
  assert.equal(parseSpeech({ region: 'mars', provider: 'Bad Id!' }).provider, '')
  assert.equal(parseSpeech({ region: 'mars' }).region, '')
})

test('报价：厘 / 分钟按秒折算，乘平台倍率', async () => {
  const settings = { ...emptyPlatformSettings(), priceMultiplier: 1.5, speech: { ...emptySpeech(), pricing: { minuteMicros: 6000 } } as SpeechSettings }
  const meter = new Meter({ platformSettings: async () => settings } as never)
  const account = { id: 'a', companyId: 'c' } as never
  // 6 厘/分钟 = 6000 微元/分钟；30 秒 × 1.5 倍 = 4500 微元。
  const q = await meter.quote({ kind: 'speech', account, status: 'ok', model: 'm', units: 30 })
  assert.equal(q.amountMicros, 4500)
  assert.deepEqual(q.unitPrice, { unit: 6000 })
  assert.equal(q.multiplier, 1.5)
  const zero = await meter.quote({ kind: 'speech', account, status: 'failed', model: 'm', units: 0 })
  assert.equal(zero.amountMicros, 0)
  // 不到一厘的价也收得准：$0.0045 / 分钟 × 60 秒 × 1.5 倍 = 6750 微元（按厘存会变成 7500）。
  const fine = new Meter({ platformSettings: async () => ({ ...settings, speech: { ...emptySpeech(), pricing: { minuteMicros: 4500 } } }) } as never)
  assert.equal((await fine.quote({ kind: 'speech', account, status: 'ok', model: 'gpt-transcribe', units: 60 })).amountMicros, 6750)
  // 重算用行上存的倍率和计量。
  const re = await meter.requote({ kind: 'speech', subject: 'speech:m', status: 'ok', quantity: { units: 60 }, multiplier: 2 } as never, undefined, settings)
  assert.equal(re?.amountMicros, 12_000)
})

test('转写：multipart 里带 model 和 WAV，回 text；上游失败不把正文回给页面', async () => {
  let seen = ''
  let fail = false
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen = Buffer.concat(chunks).toString('latin1')
      assert.equal(req.url, '/v1/audio/transcriptions')
      assert.equal(req.headers.authorization, 'Bearer test-secret')
      if (fail) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end('{"error":"bad key test-secret"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: '  你好世界  ' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const cfg = resolveSpeech({ ...emptySpeech(), provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'whisper-test' }, 'test-secret', LOCAL_ENV)
  try {
    assert.equal(await transcribe(cfg, wav(1)), '你好世界')
    assert.match(seen, /name="model"\r\n\r\nwhisper-test\r\n/)
    // 只带 model：智谱、硅基流动的文档里没有 response_format。
    assert.ok(!seen.includes('response_format'), '不该带 response_format')
    assert.match(seen, /filename="speech\.wav"\r\nContent-Type: audio\/wav/)
    assert.ok(seen.includes('RIFF'))
    fail = true
    await assert.rejects(transcribe(cfg, wav(1)), (e: Error) => /HTTP 401/.test(e.message) && !e.message.includes('test-secret'))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
