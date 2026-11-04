/**
 * 手机端语音消息的页面那一半（gateway/ui/chat-voice.js）：发送键什么时候变麦克风、封出来的 WAV 对不对、
 * 停下之后当场画上、一次交给 Gateway 就放手、Gateway 拒收时撤掉、录音许可和发消息许可是不是两回事。录音
 * 本身要真麦克风，在真机上验；服务端那一半在 e2e/gateway-chat.mjs（真席位）和 e2e/speech.mjs，正文的拼和拆、
 * 回执认领在 core/test/fold.test.ts。
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
    ArrayBuffer, DataView, Float32Array, Math, String, JSON, Number, Promise, Date, AbortController, Error,
    setTimeout, clearTimeout,
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

/** 停下之后那一串要的桩：录音句柄、AI 共享许可、交给 Gateway 的那一跳、对话那几样。 */
function wire(ctx, { seconds = 3.2, reply = { accepted: true, name: 'voice-20261104-120000-abc123.wav', text: '帮我订明天下午三点的会议室', heard: true }, consent = true } = {}) {
  const calls = { posted: [], flashes: [], asked: 0, timers: [] }
  Object.assign(ctx, {
    flash: (kind, msg) => calls.flashes.push([kind, msg]),
    render: () => {},
    paintChat: () => {},
    paintSendFace: () => {},
    reviveChatStream: () => {},
    followChatBottom: () => {},
    document: { getElementById: () => null, addEventListener() {} },
    chatBotIdNow: () => 'bot-1',
    mobileAiSharingInfo: () => ({ key: 'k' }),
    mobileAiSharingAllowed: () => consent,
    requestMobileAiSharing: async () => { calls.asked++; return false },
    api: async (method, path, body) => {
      calls.posted.push([method, path, body.type, ctx.voiceStateNow()])
      if (reply instanceof Error) throw reply
      return reply
    },
    setTimeout: (fn, ms) => { calls.timers.push([fn, ms]); return 0 },
  })
  ctx.state.chatSessionId = 's1'
  ctx.state.chatBotId = 'bot-1'
  ctx.state.chatEvents = [{ seq: 7 }]
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

  await test('点发送键停下：当场画上本地这条、输入框立刻空出来，WAV 交给 Gateway，转好的字当场补上、记住文件名', async () => {
    const v = load(root)
    const calls = wire(v)
    v.state.chatDraft = '顺手打的字'
    await v.finishVoice()
    assert(calls.posted.length === 1 && calls.posted[0][1] === '/runtime/sessions/s1/voice' && calls.posted[0][2] === 'audio/wav', `交给 Gateway：${JSON.stringify(calls.posted)}`)
    assert(calls.posted[0][3] === 'idle', '交出去的时候输入框就该空出来了，不等送达')
    const pending = v.state.chatPending
    assert(pending.length === 1 && pending[0].sessionId === 's1' && pending[0].afterSeq === 7, `本地这条 ${JSON.stringify(pending)}`)
    assert(pending[0].voice.seconds === 3.2 && pending[0].voice.path.startsWith('local:') && pending[0].text === '', '本地这条该是语音条、还没有转写')
    assert(pending[0].voiceName === 'voice-20261104-120000-abc123.wav', '收下之后该记住文件名，回执按它认领')
    assert(pending[0].voiceText === '帮我订明天下午三点的会议室', '转好的字该当场补上，不等 Bot')
    assert(v.voiceUrls.get('name:voice-20261104-120000-abc123.wav') === 'blob:local', '认领之后该接着用本地副本放')
    assert(v.state.chatDraft === '顺手打的字', '输入框里的字不该被动')
    assert(calls.flashes.length === 0, `不该报错：${JSON.stringify(calls.flashes)}`)
    // 送达兜底：到点还没在对话流里见到它，撤掉、说一声。
    const [expire, ms] = calls.timers[0]
    assert(ms === 120000, `兜底时长 ${ms}`)
    expire()
    assert(v.state.chatPending.length === 0 && calls.flashes.some(([, m]) => m.includes('没送到')), '到点没送达该撤掉并说明')
  })

  await test('Gateway 不收（没余额、没开通）：本地这条撤掉、说清原因；太短、切了对话、没点 AI 许可都不交', async () => {
    const deaf = load(root)
    wire(deaf, { reply: { accepted: true, name: 'voice-x.wav', text: '', heard: false } })
    await deaf.finishVoice()
    assert(deaf.state.chatPending.length === 1 && deaf.state.chatPending[0].voiceText.includes('没能自动转成文字'), '没转成文字也照发，气泡上说一声')

    const poor = load(root)
    const c1 = wire(poor, { reply: new Error('这家公司的额度用完了，请联系管理员充值。') })
    await poor.finishVoice()
    assert(poor.state.chatPending.length === 0 && c1.flashes.some(([k, m]) => k === 'err' && m.includes('额度用完了')), `被拒该撤掉：${JSON.stringify(c1.flashes)}`)

    const short = load(root)
    const c2 = wire(short, { seconds: 0.2 })
    await short.finishVoice()
    assert(c2.posted.length === 0 && !(short.state.chatPending || []).length && c2.flashes.some(([, m]) => m.includes('太短')), '太短不该交')

    const moved = load(root)
    const c3 = wire(moved)
    moved.chatBotIdNow = () => 'bot-2'
    await moved.finishVoice()
    assert(c3.posted.length === 0 && c3.flashes.some(([, m]) => m.includes('切到了别的对话')), '切了对话不该交')

    const shy = load(root)
    const c4 = wire(shy, { consent: false })
    await shy.finishVoice()
    assert(c4.asked === 1 && c4.posted.length === 0 && !(shy.state.chatPending || []).length, '没同意 AI 共享不该交')
    assert(shy.voiceStateNow() === 'idle', '都该回到空闲')
  })

  await test('Bot 忙、语音进了队列：本地那条气泡交给排队那一行', async () => {
    const v = load(root)
    wire(v)
    await v.finishVoice()
    const body = v.SatuCore.composeVoice('zh', { path: 'uploads/s1/voice-20261104-120000-abc123.wav', seconds: 3 }, '你好')
    v.chatQueues = new Map([['s1', [{ id: 'q1', text: body }]]])
    assert(v.dropQueuedVoice('s1') === true && v.state.chatPending.length === 0, '进了队列该撤掉本地气泡')
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
