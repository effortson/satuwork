/**
 * 手机端语音输入的页面那一半（gateway/ui/chat-voice.js）：什么时候画麦克风、封出来的 WAV 对不对、
 * 识别出的字怎么接进输入框、录音许可和发消息许可是不是两回事。录音本身要真麦克风，在真机上验
 * （见 PR 说明）；Gateway 那一半在 e2e/speech.mjs。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

function load(root, { mobile = true, speech = { enabled: true, maxSeconds: 60, provider: '硅基流动' }, gum = true } = {}) {
  const ctx = {
    state: { me: { account: { id: 'acc-1' }, speech } },
    window: { __SATUWORK_GATEWAY__: 'https://gw.example' },
    location: { origin: 'satu://localhost' },
    navigator: { mediaDevices: gum ? { getUserMedia() {} } : undefined },
    MOBILE_AI_CONSENT_PREFIX: 'satu.mobile.ai-consent.v1:',
    mobileShell: () => mobile,
    esc: (s) => String(s),
    t: (zh) => zh,
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts?.type; this.size = parts.reduce((n, p) => n + p.byteLength, 0) } },
    ArrayBuffer, DataView, Float32Array, Math, String, JSON, Number,
  }
  // 顶层 const 不挂在上下文上，弹框文案那一份单独递出来。
  runInNewContext(readFileSync(join(root, 'gateway/ui/chat-voice.js'), 'utf8') + '\nthis.VOICE_SHARING_COPY = VOICE_SHARING_COPY', ctx)
  return ctx
}

export async function runVoiceInput({ root, test, assert, log }) {
  log('\n# voice-input')
  await test('麦克风只在手机壳、平台开了语音、有 getUserMedia 时画', async () => {
    assert(load(root).chatVoiceButtonHtml().includes('data-act="chat-voice"'), '该画没画')
    assert(load(root, { mobile: false }).chatVoiceButtonHtml() === '', '浏览器 / 桌面壳不该画')
    assert(load(root, { speech: { enabled: false } }).chatVoiceButtonHtml() === '', '平台没配不该画')
    assert(load(root, { speech: null }).chatVoiceButtonHtml() === '', '老 Gateway 没有 speech 字段不该画')
    assert(load(root, { gum: false }).chatVoiceButtonHtml() === '', '没有麦克风接口不该画')
  })

  await test('封出来的是 16 位单声道 PCM WAV，降采样后时长不变', async () => {
    const v = load(root)
    const input = new Float32Array(48000) // 48 kHz 一秒
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(i / 10) * 0.5
    const pcm = v.resample(input, 48000, 16000)
    assert(pcm.length === 16000, `降到 16 kHz 应是 16000 个样本：${pcm.length}`)
    const blob = v.encodeWav(pcm, 16000)
    const b = Buffer.from(blob.parts[0])
    assert(blob.type === 'audio/wav' && b.length === 44 + 32000, `大小 ${b.length}`)
    assert(b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE' && b.toString('ascii', 36, 40) === 'data', '头不对')
    assert(b.readUInt16LE(20) === 1 && b.readUInt16LE(22) === 1 && b.readUInt32LE(24) === 16000 && b.readUInt16LE(34) === 16, '格式字段不对')
    // 设备只有 8 kHz：线性插值升上去，中间不能夹满 0。
    const low = new Float32Array(8000).fill(0.5)
    const up = v.resample(low, 8000, 16000)
    assert(up.length === 16000 && up.every((x) => Math.abs(x - 0.5) < 1e-6), '升采样不该出现静音样本')
    // 截幅：超出 [-1, 1] 的不能绕回去。
    const loud = Buffer.from(v.encodeWav(new Float32Array([2, -2]), 16000).parts[0])
    assert(loud.readInt16LE(44) === 32767 && loud.readInt16LE(46) === -32768, '截幅不对')
  })

  await test('识别出的字接进输入框：拉丁字母之间补空格，中文不补', async () => {
    const v = load(root)
    assert(v.joinVoice('你好', '世界', '') === '你好世界', '中文不该补空格')
    assert(v.joinVoice('hello', 'world', '') === 'hello world', '英文前面该补空格')
    assert(v.joinVoice('', 'hello', 'world') === 'hello ', '英文后面该补空格')
    assert(v.joinVoice('价格 ', '100', '') === '价格 100', '已有空格不重复补')
  })

  await test('录音许可和发消息许可分开存，都在退出登录会清的前缀下', async () => {
    const v = load(root)
    const info = v.voiceSharingInfo()
    assert(info.recipients.length === 1 && info.recipients[0] === '硅基流动', `录音发给谁 ${JSON.stringify(info.recipients)}`)
    assert(info.key.startsWith('satu.mobile.ai-consent.v1:voice:'), `键 ${info.key}`)
    // 换了识别服务要重新问。
    const other = load(root, { speech: { enabled: true, maxSeconds: 60, provider: 'OpenAI' } }).voiceSharingInfo()
    assert(other.key !== info.key, '换了服务商该重新征求许可')
    assert(v.VOICE_SHARING_COPY.info().key === info.key, '弹框核对用的范围该和请求时一致')
  })

  await runVoiceInputStart({ root, test, assert })
}

export async function runVoiceInputStart({ root, test, assert }) {
  await test('开麦那几百毫秒里再点，不能开出第二路；开麦失败要把麦克风关掉', async () => {
    let opens = 0
    let release
    const stopped = []
    const track = { stop: () => stopped.push(1) }
    const ctx = load(root)
    Object.assign(ctx, {
      mobileAiSharingAllowed: () => true,
      flash: () => {},
      render: () => {},
      document: { getElementById: () => null, addEventListener() {} },
      setInterval: () => 0, clearInterval() {},
    })
    ctx.navigator.mediaDevices.getUserMedia = () => { opens++; return new Promise((r) => { release = () => r({ getTracks: () => [track] }) }) }
    // AudioContext 搭不起来：麦克风已经开了，必须关掉。
    ctx.window.AudioContext = function () { throw new Error('no audio') }
    const first = ctx.toggleVoice()
    await ctx.toggleVoice()
    assert(opens === 1, `连点开了 ${opens} 路`)
    release()
    await first
    assert(stopped.length === 1, '开麦失败没关麦克风')
    assert(runInNewContext('voiceState', ctx) === 'idle' && runInNewContext('voiceStarting', ctx) === false, '失败后状态没复位')
  })
}
