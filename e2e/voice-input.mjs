/**
 * 手机端语音消息的页面那一半（gateway/ui/chat-voice.js）：发送键什么时候变麦克风、封出来的 WAV 对不对、
 * 停下之后怎么传录音转文字再发出去、转不出文字时不发、录音许可和发消息许可是不是两回事。录音本身要真
 * 麦克风，在真机上验；Gateway 那一半在 e2e/speech.mjs，正文的拼和拆在 core/test/fold.test.ts。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

function load(root, { mobile = true, speech = { enabled: true, maxSeconds: 60, provider: '硅基流动' }, gum = true } = {}) {
  const ctx = {
    state: { me: { account: { id: 'acc-1' }, speech }, chatDraft: '', chatFiles: [], chatMentions: [], chatRefs: [] },
    window: { __SATUWORK_GATEWAY__: 'https://gw.example' },
    location: { origin: 'satu://localhost' },
    navigator: { mediaDevices: gum ? { getUserMedia() {} } : undefined },
    MOBILE_AI_CONSENT_PREFIX: 'satu.mobile.ai-consent.v1:',
    mobileShell: () => mobile,
    esc: (s) => String(s),
    t: (zh) => zh,
    localeMode: 'zh',
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts?.type; this.size = parts.reduce((n, p) => n + (p.byteLength ?? p.size ?? 0), 0) } },
    File: class { constructor(parts, name, opts) { this.parts = parts; this.name = name; this.type = opts?.type } },
    URL: { createObjectURL: () => 'blob:local' },
    ArrayBuffer, DataView, Float32Array, Math, String, JSON, Number, Promise, Date,
  }
  // 拼正文用的是 core 的 composeVoice：把打包好的 core.js 装进同一个上下文。
  runInNewContext(readFileSync(join(root, 'gateway/ui/core.js'), 'utf8'), ctx)
  // 顶层 const / let 不挂在上下文上，要用的那几样单独递出来。
  runInNewContext(readFileSync(join(root, 'gateway/ui/chat-voice.js'), 'utf8') +
    '\nthis.VOICE_SHARING_COPY = VOICE_SHARING_COPY; this.voiceUrls = voiceUrls; this.__voice = (st, rec) => { voiceState = st; voiceRec = rec }', ctx)
  return ctx
}

/** 一段 n 秒的 16 kHz WAV（只看大小）。 */
const wavOf = (ctx, seconds) => new ctx.Blob([new ArrayBuffer(44 + Math.round(seconds * 16000) * 2)], { type: 'audio/wav' })

/** 停下之后那一串（传、转、发）要的桩：录音句柄、上传、转写、发送。 */
function wire(ctx, { text = '帮我订明天下午三点的会议室', seconds = 3.2 } = {}) {
  const calls = { uploads: [], sent: [], flashes: [], transcribed: [] }
  Object.assign(ctx, {
    flash: (kind, msg) => calls.flashes.push([kind, msg]),
    render: () => {},
    paintSendFace: () => {},
    document: { getElementById: () => null, addEventListener() {} },
    chatBotIdNow: () => 'bot-1',
    uploadChatFile: async (sessionId, file) => { calls.uploads.push([sessionId, file.name]); return { path: `uploads/${sessionId}/${file.name}` } },
    api: async (method, path, body) => { calls.transcribed.push([method, path, body.type]); return { text } },
    sendChat: async () => { calls.sent.push({ draft: ctx.state.chatDraft, files: ctx.state.chatFiles.length }); ctx.state.chatDraft = '' },
  })
  ctx.state.chatSessionId = 's1'
  ctx.__voice('rec', { botId: 'bot-1', stop: () => wavOf(ctx, seconds), cancel() {}, seconds: () => seconds })
  return calls
}

export async function runVoiceInput({ root, test, assert, log }) {
  log('\n# voice-input')
  await test('发送键只在手机壳、开了语音、输入框空着、没挂东西时变成麦克风', async () => {
    assert(load(root).sendAsVoice() === true, '该是麦克风')
    assert(load(root).chatVoiceBarHtml().includes('id="chat-voicebar"'), '录音条没画')
    assert(load(root, { mobile: false }).sendAsVoice() === false && load(root, { mobile: false }).chatVoiceBarHtml() === '', '浏览器 / 桌面壳不该变')
    assert(load(root, { speech: { enabled: false } }).sendAsVoice() === false, '平台没配不该变')
    assert(load(root, { speech: null }).sendAsVoice() === false, '老 Gateway 没有 speech 字段不该变')
    assert(load(root, { gum: false }).sendAsVoice() === false, '没有麦克风接口不该变')
    for (const [key, val] of [['chatDraft', '你好'], ['chatFiles', [{}]], ['chatMentions', [{}]], ['chatRefs', [{}]]]) {
      const v = load(root)
      v.state[key] = val
      assert(v.sendAsVoice() === false, `${key} 有东西时该还是发送`)
    }
    const spaces = load(root)
    spaces.state.chatDraft = '   '
    assert(spaces.sendAsVoice() === true, '只有空格也算空着')
  })

  await test('封出来的是 16 位单声道 PCM WAV，换采样率后时长不变', async () => {
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
    const up = v.resample(new Float32Array(8000).fill(0.5), 8000, 16000)
    assert(up.length === 16000 && up.every((x) => Math.abs(x - 0.5) < 1e-6), '升采样不该出现静音样本')
    // 截幅：超出 [-1, 1] 的不能绕回去。
    const loud = Buffer.from(v.encodeWav(new Float32Array([2, -2]), 16000).parts[0])
    assert(loud.readInt16LE(44) === 32767 && loud.readInt16LE(46) === -32768, '截幅不对')
  })

  await test('点发送键停下：录音传进工作区、转出文字，拼成一条语音消息发出去；录音中打的字还回输入框', async () => {
    const v = load(root)
    const calls = wire(v)
    v.state.chatDraft = '顺手打的字'
    await v.finishVoice()
    assert(calls.uploads.length === 1 && calls.uploads[0][0] === 's1' && /^voice-\d{8}-\d{6}\.wav$/.test(calls.uploads[0][1]), `上传 ${JSON.stringify(calls.uploads)}`)
    assert(calls.transcribed.length === 1 && calls.transcribed[0][1] === '/me/transcribe' && calls.transcribed[0][2] === 'audio/wav', `转写 ${JSON.stringify(calls.transcribed)}`)
    assert(calls.sent.length === 1, `该发一条：${JSON.stringify(calls.flashes)}`)
    const parsed = v.SatuCore.splitVoice(calls.sent[0].draft)
    assert(parsed && parsed.text === '帮我订明天下午三点的会议室' && parsed.voice.seconds === 3 && parsed.voice.path === `uploads/s1/${calls.uploads[0][1]}`, `发出去的正文 ${calls.sent[0].draft}`)
    assert(v.state.chatDraft === '顺手打的字', '录音那几秒打的字该还回来')
    assert(v.voiceStateNow() === 'idle', '发完该回到空闲')
    assert(v.voiceUrls.get(parsed.voice.path) === 'blob:local', '刚录的那段该直接用本地副本放')
  })

  await test('转不出文字、太短、录音时切了对话：都不发，说一句为什么', async () => {
    const blank = load(root)
    const c1 = wire(blank, { text: '' })
    await blank.finishVoice()
    assert(c1.sent.length === 0 && c1.flashes.some(([k, m]) => k === 'err' && m.includes('没听清')), `没转出文字不该发：${JSON.stringify(c1.flashes)}`)

    const short = load(root)
    const c2 = wire(short, { seconds: 0.2 })
    await short.finishVoice()
    assert(c2.sent.length === 0 && c2.uploads.length === 0 && c2.flashes.some(([, m]) => m.includes('太短')), '太短不该传也不该发')

    const moved = load(root)
    const c3 = wire(moved)
    moved.chatBotIdNow = () => 'bot-2'
    await moved.finishVoice()
    assert(c3.sent.length === 0 && c3.uploads.length === 0 && c3.flashes.some(([, m]) => m.includes('切到了别的对话')), '切了对话不该发')
    assert(moved.voiceStateNow() === 'idle', '失败后该回到空闲')
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
      paintSendFace: () => {},
      chatBotIdNow: () => 'bot-1',
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
    assert(ctx.voiceStateNow() === 'idle' && runInNewContext('voiceStarting', ctx) === false, '失败后状态没复位')
  })

  await test('语音条：点播放才去取录音，取过的不再取', async () => {
    const v = load(root)
    let fetched = 0
    Object.assign(v, {
      authHeaders: () => ({}),
      swFetch: async () => { fetched++; return { ok: true, blob: async () => new v.Blob([new ArrayBuffer(8)], { type: 'audio/wav' }) } },
    })
    v.state.chatSessionId = 's1'
    assert(v.voiceNoteHtml({ path: 'uploads/s1/a.wav', seconds: 75 }).includes('1:15'), '时长该按分秒画')
    assert(fetched === 0, '画语音条不该去取录音')
    await v.voiceUrlOf('uploads/s1/a.wav')
    await v.voiceUrlOf('uploads/s1/a.wav')
    assert(fetched === 1, `取了 ${fetched} 次`)
  })
}
