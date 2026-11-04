/**
 * 语音输入（gateway/src/lib/speech.ts、routes/speech.ts）：平台在「工具配置 → 语音」配识别模型和单价，
 * `/me` 据此告诉手机端画不画麦克风；`POST /me/transcribe` 收 WAV、按音频秒数计费、过余额闸。
 *
 * 识别服务用一台假的 OpenAI 兼容 `/audio/transcriptions` 顶替，记下每次收到的 multipart。
 */
import { createServer } from 'node:http'
import { withPg } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { createCompany } from './org.mjs'
import { closeServer } from './probe.mjs'
import { startGateway } from './gateway.mjs'

async function mockAsr() {
  const seen = { calls: 0, bodies: [] }
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.calls++
      seen.bodies.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('latin1') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: '帮我订明天的会议室' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, seen, url: `http://127.0.0.1:${server.address().port}/v1` }
}

/** 页面 chat-voice.js 的 encodeWav 那个格式：16 kHz、16 位、单声道。 */
function wav(seconds, channels = 1) {
  const rate = 16000
  const data = Math.round(seconds * rate) * 2 * channels
  const b = Buffer.alloc(44 + data)
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8, 'ascii')
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22)
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2 * channels, 28); b.writeUInt16LE(2 * channels, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36, 'ascii'); b.writeUInt32LE(data, 40)
  return b
}

export async function runSpeech({ test, req, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-speech-gw')
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`
  const schema = schemaOf('e2e_speech')
  log('\n# speech')
  const asr = await mockAsr()
  const { gw } = await startGateway({
    name: 'speech-gw',
    what: 'speech gateway',
    home: GW_HOME,
    schema,
    port: GW_PORT,
    env: {
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
      // 假识别服务听在 127.0.0.1：放行内网地址（生产上页面填的地址要过 SSRF 闸）。
      GATEWAY_SPEECH_ALLOW_PRIVATE: '1',
    },
  })
  let owner = ''
  let orgId = ''
  let admin = ''
  const transcribe = (body, token = admin) => req(base, 'POST', '/me/transcribe', { token, raw: body, headers: { 'content-type': 'audio/wav' } })
  const charges = () => withPg(schema, async (c) => (await c.query(`select status, subject, quantity, "amountMicros" from usage_charges where kind='speech' order by "createdAt"`)).rows)

  try {
    await test('没配之前：/me 说不开，转写回 503 且不打上游', async () => {
      const setup = await req(base, 'POST', '/auth/setup', { body: { email: 'owner@speech.test', name: 'owner', password: 'correct-horse-1' } })
      assert(setup.status === 201, `setup ${setup.status} ${setup.text}`)
      owner = setup.json.token
      const company = await createCompany(req, base, {
        ownerToken: owner, email: 'admin@speech.test', password: 'correct-horse-2', companyName: 'Speech Co', slug: 'speech-co', topup: 0,
      })
      orgId = company.company.id
      admin = company.token
      const me = await req(base, 'GET', '/me', { token: admin })
      assert(me.json.speech && me.json.speech.enabled === false, `没配时该是关的：${JSON.stringify(me.json.speech)}`)
      const r = await transcribe(wav(1))
      assert(r.status === 503 && asr.seen.calls === 0, `没配时 ${r.status} ${r.text}`)
    })

    await test('平台配置：校验、只有 owner 能改、密钥不进模型供应商清单', async () => {
      const bad = await req(base, 'PUT', '/platform/speech', { token: owner, body: { region: 'intl', provider: 'custom', baseUrl: 'http://example.com/v1', model: 'm' } })
      assert(bad.status === 400, `明文公网地址该 400：${bad.status} ${bad.text}`)
      const wrongRegion = await req(base, 'PUT', '/platform/speech', { token: owner, body: { region: 'intl', provider: 'zhipu' } })
      assert(wrongRegion.status === 400, `国际区选智谱该 400：${wrongRegion.status}`)
      const badPrice = await req(base, 'PUT', '/platform/speech', { token: owner, body: { pricing: { minuteMicros: -1 } } })
      assert(badPrice.status === 400, `负价该 400：${badPrice.status}`)
      const notOwner = await req(base, 'PUT', '/platform/speech', { token: admin, body: { region: 'intl' } })
      assert(notOwner.status === 403 || notOwner.status === 401, `公司管理员不该能改：${notOwner.status}`)
      const keyFirst = await req(base, 'PUT', '/platform/speech/key', { token: owner, body: { provider: 'custom', secret: 'x' } })
      assert(keyFirst.status === 400, `地址没存先填密钥该 400：${keyFirst.status}`)

      // $0.006 / 分钟（6000 微元）：3 秒 = 300 微元。
      const saved = await req(base, 'PUT', '/platform/speech', { token: owner, body: { region: 'intl', provider: 'custom', baseUrl: asr.url, model: 'e2e-asr', pricing: { minuteMicros: 6000 } } })
      assert(saved.status === 200 && saved.json.speech.provider === 'custom' && saved.json.speech.pricing.minuteMicros === 6000, `保存 ${saved.status} ${saved.text}`)
      assert(saved.json.ready === false, `还没密钥不该就绪：${saved.text}`)
      const key = await req(base, 'PUT', '/platform/speech/key', { token: owner, body: { provider: 'custom', secret: 'e2e-asr-secret' } })
      assert(key.status === 200 && key.json.keys.custom && key.json.ready === true, `密钥 ${key.status} ${key.text}`)
      assert(!key.text.includes('e2e-asr-secret'), '密钥不该回显')
      const creds = await req(base, 'GET', '/platform/credentials', { token: owner })
      assert(!creds.text.includes('speech:'), `语音密钥混进了模型供应商清单：${creds.text}`)
      const viaModels = await req(base, 'PUT', '/platform/credentials', { token: owner, body: { provider: 'speech:openai', secret: 'x' } })
      assert(viaModels.status === 400 || viaModels.status === 404, `从模型供应商那条路存语音密钥该被拦：${viaModels.status} ${viaModels.text}`)

      const me = await req(base, 'GET', '/me', { token: admin })
      assert(me.json.speech.enabled === true && me.json.speech.maxSeconds === 60 && me.json.speech.provider === '自定义语音识别服务', `/me ${JSON.stringify(me.json.speech)}`)
      const test = await req(base, 'POST', '/platform/speech/test', { token: owner, body: {} })
      assert(test.json.ok === true, `自检 ${test.text}`)
      assert((await charges()).length === 0, '自检不该记账')
    })

    await test('在模型配置那一屏存平台设置，语音配置和单价不能被抹掉', async () => {
      const r = await req(base, 'PUT', '/platform/settings', { token: owner, body: { priceMultiplier: 1 } })
      assert(r.status === 200, `settings ${r.status} ${r.text}`)
      const kb = await req(base, 'PUT', '/platform/settings', { token: owner, body: { knowledge: { pricing: { queryMils: 1, ingestMils: 1 }, scoreMin: 0.4 } } })
      assert(kb.status === 200, `settings ${kb.status} ${kb.text}`)
      const back = await req(base, 'GET', '/platform/speech', { token: owner })
      assert(back.json.speech.provider === 'custom' && back.json.speech.pricing.minuteMicros === 6000 && back.json.ready === true, `语音配置被抹了：${back.text}`)
    })

    await test('余额为零：402，不打上游，落一行 denied', async () => {
      const before = asr.seen.calls
      const r = await transcribe(wav(2.5))
      assert(r.status === 402, `没余额该 402：${r.status} ${r.text}`)
      assert(asr.seen.calls === before, '被拦的那次不该打上游')
      const rows = await charges()
      assert(rows.length === 1 && rows[0].status === 'denied' && Number(rows[0].amountMicros) === 0, `账本 ${JSON.stringify(rows)}`)
    })

    await test('充值后：转写成功，按秒计费，WAV 原样转给上游', async () => {
      const paid = await req(base, 'POST', '/platform/orders', { token: owner, body: { companyId: orgId, kind: 'topup', amount: 1, payStatus: 'paid', note: 'e2e' } })
      assert(paid.status === 201, `充值 ${paid.status} ${paid.text}`)
      const r = await transcribe(wav(2.5))
      assert(r.status === 200 && r.json.text === '帮我订明天的会议室' && r.json.seconds === 3, `转写 ${r.status} ${r.text}`)
      const call = asr.seen.bodies.at(-1)
      assert(call.url === '/v1/audio/transcriptions' && call.auth === 'Bearer e2e-asr-secret', `上游请求 ${call.url} ${call.auth}`)
      assert(/name="model"\r\n\r\ne2e-asr\r\n/.test(call.body) && call.body.includes('RIFF'), '上游没收到模型名或 WAV')
      const rows = await charges()
      const ok = rows.find((x) => x.status === 'ok')
      assert(ok && ok.subject === 'speech:e2e-asr' && ok.quantity.units === 3 && Number(ok.amountMicros) === 300, `账本 ${JSON.stringify(rows)}`)
      assert(!JSON.stringify(rows).includes('会议室'), '转出来的文字不该进账本')
      // 公司侧的账单列表能按 kind 筛出来。
      const list = await req(base, 'GET', `/orgs/${orgId}/charges?kind=speech`, { token: admin })
      assert(list.status === 200, `charges ${list.status} ${list.text}`)
    })

    await test('坏音频、太长、太短都在打上游之前拦下，不收钱', async () => {
      const before = asr.seen.calls
      const rowsBefore = (await charges()).length
      const stereo = await transcribe(wav(1, 2))
      assert(stereo.status === 400, `双声道该 400：${stereo.status} ${stereo.text}`)
      const junk = await transcribe(Buffer.from('this is definitely not a wav file, not even close'))
      assert(junk.status === 400, `乱码该 400：${junk.status}`)
      const short = await transcribe(wav(0.1))
      assert(short.status === 400, `太短该 400：${short.status}`)
      const long = await transcribe(wav(62))
      assert(long.status === 413, `超长该 413：${long.status} ${long.text}`)
      const anon = await transcribe(wav(1), '')
      assert(anon.status === 401, `没登录该 401：${anon.status}`)
      assert(asr.seen.calls === before && (await charges()).length === rowsBefore, '拦下的不该打上游也不该记账')
    })
  } finally {
    gw.kill('SIGTERM')
    await closeServer(asr.server, 'mock asr')
  }
}
