/**
 * 手机端的语音消息，和 WhatsApp 那种发语音一个用法：输入框空着的时候，发送键变成麦克风；点一下开始录，
 * 输入框换成一条「正在录音」的计时条（左边能扔掉这段），再点一下发送键就停下、发出去。对话里这条消息是
 * 一个能点着听的语音条，下面附着自动转写的文字。
 *
 * **录完就放手，剩下的在服务端做。** 停下的那一刻这条语音就画进对话（本地副本，当场能听），输入框立刻
 * 能接着打字、接着录；手机只把 WAV 交给 Gateway 的 `POST /runtime/sessions/:id/voice`，收下了就算发出去。
 * 放进席位工作区、转写（平台在「工具配置 → 语音」配的模型，按秒计费）、发给 Bot 都在 Gateway 回完包之后做
 * （gateway/src/lib/voice-message.ts）。席位把这条消息经对话流送回来时，按录音文件名认领本地这条，转写
 * 补到语音条下面。手机也不用直连席位机器。
 *
 * 只在手机壳里有（`mobileShell()`），而且平台开了语音（`/me` 的 `speech.enabled`）。浏览器和桌面壳里
 * 发送键不变——但别人发来的语音条照样能听。
 *
 * **自己录 PCM、自己封 WAV，不用 MediaRecorder。** MediaRecorder 在 Android WebView 出 webm/opus、
 * iOS 出 mp4/aac，几家识别服务认的格式不一样；WAV 谁都认，而且时长由字节数算得出来——Gateway
 * 按秒计费就靠这个，不用信页面报的数（gateway/src/lib/speech.ts 的 canonicalWav）。16 kHz 单声道
 * 一分钟不到 2 MB，各家 WebView 的 <audio> 也都放得了。
 *
 * 录音发给的是第三方识别服务，和发消息给模型一样要先问过人（chat-composer.js 的
 * requestMobileAiSharing，同一个弹框、同一个本机许可前缀，退出登录一起撤回）。
 */
const ICON_MIC =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><path d="M12 18v4"/></svg>'
const ICON_TRASH =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>'
const ICON_PLAY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>'
const ICON_PAUSE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/></svg>'

const VOICE_RATE = 16000

/** 正在录的那一段。同一时刻只有一段。 */
let voiceRec = null
/** 'idle' | 'rec'。发送键和计时条跟着它。停下就回到 'idle'——发出去的事不占着输入框。 */
let voiceState = 'idle'
/**
 * 交给 Gateway 之后多久还没在对话流里见到它，就当它没送到：本地那条撤掉、说一声。正常是几秒（放进工作区
 * 和转写并行，再发给席位）；Bot 忙着时它会先进队列，那时本地这条由排队那一行接手（dropQueuedVoice）。
 */
const VOICE_DELIVER_MS = 120_000

/**
 * 正在开麦（等系统权限框、等 getUserMedia）。这几百毫秒里发送键还是麦克风的面孔，不挡的话再点一下会
 * 开出第二路，第一路的麦克风永远关不掉。
 */
let voiceStarting = false

function voiceEnabled() {
  return mobileShell() && state.me?.speech?.enabled === true && !!navigator.mediaDevices?.getUserMedia
}

/** 别的分片问「现在在录吗」用这个，不直接摸 voiceState（分片之间只认函数）。 */
function voiceStateNow() {
  return voiceState
}

/**
 * 发送键这会儿该不该是麦克风：开了语音、输入框空着、也没挂附件 / 点名 / 引用。挂了东西就还是发送——
 * 人选了个文件不打字，按下去要的是把文件发出去，不是录音。
 */
function sendAsVoice() {
  return voiceEnabled() && !String(state.chatDraft || '').trim() &&
    !(state.chatFiles || []).length && !(state.chatMentions || []).length && !(state.chatRefs || []).length
}

function voiceClock(s) {
  const n = Math.floor(s)
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
}

/** 输入框里那条「正在录音」的计时条。没开语音时是空串。显隐和读秒由 paintVoice 就地改。 */
function chatVoiceBarHtml() {
  if (!voiceEnabled()) return ''
  return `<div class="sw-voicebar" id="chat-voicebar" ${voiceState === 'idle' ? 'hidden' : ''}>
    <button type="button" class="sw-iconbtn" data-act="chat-voice-cancel" id="chat-voice-cancel"
      aria-label="${esc(t('扔掉这段录音', 'Discard recording'))}" title="${esc(t('扔掉这段录音', 'Discard recording'))}">${ICON_TRASH}</button>
    <span class="sw-voicebar-dot" aria-hidden="true"></span>
    <span class="sw-voicebar-time" id="chat-voicebar-time">0:00</span>
    <span class="sw-voicebar-hint" id="chat-voicebar-hint"></span>
  </div>`
}

/** 录音状态变了：计时条、输入框显隐、发送键的面孔一起改。 */
function paintVoice() {
  const form = document.getElementById('chat-form')
  if (form) form.setAttribute('data-voice', voiceState)
  const bar = document.getElementById('chat-voicebar')
  if (bar) bar.hidden = voiceState === 'idle'
  const time = document.getElementById('chat-voicebar-time')
  if (time && voiceState === 'rec' && voiceRec) time.textContent = voiceClock(voiceRec.seconds())
  const hint = document.getElementById('chat-voicebar-hint')
  if (hint) hint.textContent = t('正在录音，点发送键发出去', 'Recording — tap send when done')
  if (typeof paintSendFace === 'function') paintSendFace()
}

function voiceSharingInfo() {
  const accountId = state.me?.account?.id || ''
  const provider = state.me?.speech?.provider || ''
  const recipients = provider ? [provider] : []
  return {
    accountId,
    recipients,
    key: MOBILE_AI_CONSENT_PREFIX + 'voice:' + JSON.stringify([accountId, window.__SATUWORK_GATEWAY__ || location.origin, recipients]),
  }
}

const VOICE_SHARING_COPY = {
  title: ['允许把录音发给语音识别服务？', 'Allow sending recordings to a speech service?'],
  body: ['为了把你说的话转成文字，Satuwork 会把这段录音交给组织配置的语音识别服务。录音和转写会作为一条消息发进对话。', 'To turn your speech into text, Satuwork sends the recording to the speech recognition service configured by your organization. The recording and its transcript are sent into the conversation as one message.'],
  sub: ['请先了解录音会发送到哪里。', 'Review where your recording will be sent.'],
  recipients: ['组织配置的语音识别服务：', 'Organization-configured speech service:'],
  note: ['服务商的保留与训练政策可能不同。录音时请不要说出你无权共享的个人信息或机密；录音中可以点左边的垃圾桶扔掉这段。退出登录会撤回本机许可。', 'Provider retention and training practices may differ. Do not say personal or confidential information you are not authorized to share; tap the trash icon to discard a recording. Signing out revokes permission on this device.'],
  allow: ['同意并录音', 'Allow and record'],
  cancel: ['暂不使用', 'Not now'],
  info: () => voiceSharingInfo(),
}

/** 发送键在麦克风 / 录音中两副面孔下被点了。 */
async function toggleVoice() {
  if (voiceStarting) return
  if (voiceState === 'rec') return finishVoice()
  voiceStarting = true
  try {
    const sharing = voiceSharingInfo()
    if (!mobileAiSharingAllowed(sharing)) {
      if (!await requestMobileAiSharing(sharing, VOICE_SHARING_COPY)) return
    }
    voiceRec = await startVoiceRecording(Number(state.me?.speech?.maxSeconds) || 60)
  } catch (err) {
    voiceRec = null
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
    flash('err', denied
      ? t('没有麦克风权限。请到系统设置里允许 Satuwork 使用麦克风。', 'Microphone access is off. Allow Satuwork to use the microphone in system settings.')
      : t('打不开麦克风：', 'Could not open the microphone: ') + (err?.message || err))
    render()
    return
  } finally {
    voiceStarting = false
  }
  if (!voiceRec) return
  voiceState = 'rec'
  paintVoice()
}

/**
 * 开录。回一个句柄：`seconds()` 录了多久、`stop()` 停下并回 WAV。到 `maxSeconds` 自己停、自己送去识别。
 *
 * 用 ScriptProcessor 而不是 AudioWorklet：后者要 addModule 一个脚本地址，手机壳的 CSP 不放 blob: 脚本；
 * ScriptProcessor 虽然标了过时，Android WebView 和 WKWebView 都还在，几秒钟的录音也不在乎它跑在主线程。
 */
async function startVoiceRecording(maxSeconds) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  let ctx, source, node
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    // 能直接开 16 kHz 就省一次重采样；不认的（老 WebKit）退回设备默认，停的时候再换算。
    try { ctx = new Ctx({ sampleRate: VOICE_RATE }) } catch { ctx = new Ctx() }
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
    source = ctx.createMediaStreamSource(stream)
    node = ctx.createScriptProcessor(4096, 1, 1)
  } catch (err) {
    // 麦克风已经开了：后面哪一步没搭起来都得把它关掉再报错，不然指示灯一直亮着。
    for (const track of stream.getTracks()) track.stop()
    if (ctx) void ctx.close().catch(() => {})
    throw err
  }
  const chunks = []
  let frames = 0
  const limit = maxSeconds * ctx.sampleRate
  let timer = null
  node.onaudioprocess = (e) => {
    if (frames >= limit) return
    const data = e.inputBuffer.getChannelData(0)
    chunks.push(new Float32Array(data))
    frames += data.length
    if (frames >= limit && voiceRec && voiceState === 'rec') void finishVoice()
  }
  source.connect(node)
  // 不连到 destination 的话，Chrome 不跑 onaudioprocess。输出是静音的（没往输出缓冲里写）。
  node.connect(ctx.destination)
  timer = setInterval(voiceTick, 250)
  const release = () => {
    clearInterval(timer)
    node.onaudioprocess = null
    try { source.disconnect(); node.disconnect() } catch {}
    for (const track of stream.getTracks()) track.stop()
    void ctx.close().catch(() => {})
  }
  return {
    botId: chatBotIdNow(),
    seconds: () => frames / ctx.sampleRate,
    cancel: release,
    stop() {
      release()
      return encodeWav(resample(joinFloat(chunks, Math.min(frames, limit)), ctx.sampleRate, VOICE_RATE), VOICE_RATE)
    },
  }
}

function joinFloat(chunks, total) {
  const out = new Float32Array(total)
  let at = 0
  for (const c of chunks) {
    const n = Math.min(c.length, total - at)
    if (n <= 0) break
    out.set(c.subarray(0, n), at)
    at += n
  }
  return out
}

/**
 * 换到 16 kHz。降采样按区间取平均（够当低通用），说话的频段在 8 kHz 以内，不会糊；设备只给得出
 * 更低的采样率（蓝牙耳机通话模式的 8 kHz）时线性插值升上去——按区间取平均那条路在这时大半区间是空的。
 */
function resample(input, from, to) {
  if (from === to) return input
  if (from < to) {
    const out = new Float32Array(Math.floor((input.length * to) / from))
    const step = from / to
    for (let i = 0; i < out.length; i++) {
      const x = i * step
      const j = Math.floor(x)
      const a = input[j] ?? 0
      const b = input[j + 1] ?? a
      out[i] = a + (b - a) * (x - j)
    }
    return out
  }
  const ratio = from / to
  const out = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]
    out[i] = end > start ? sum / (end - start) : 0
  }
  return out
}

/** 16 位单声道 PCM 的 WAV。Gateway 只认这一种（lib/speech.ts 的 canonicalWav）。 */
function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const ascii = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)) }
  ascii(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  ascii(36, 'data'); v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

/** 录音文件名：一眼看得出是语音、哪一刻录的。席位那头会再洗一遍（safeName）。 */
function voiceFileName(at = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `voice-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}.wav`
}

/**
 * 停下、当场画上、交给 Gateway。录到最长时长时由录音那头自己调进来。
 *
 * 停下的那一刻就回到空闲：发送键变回麦克风、输入框回来——下一句话不用等这一句送达。
 */
async function finishVoice() {
  const rec = voiceRec
  if (!rec || voiceState !== 'rec') return
  voiceRec = null
  voiceState = 'idle'
  const wav = rec.stop()
  paintVoice()
  // 太短的多半是误触：不传、不收钱，说一句就行。
  if (wav.size < 44 + VOICE_RATE * 2 * 0.5) {
    flash('err', t('说话时间太短了，没有发出。', 'Too short — not sent.'))
    render()
    return
  }
  const sessionId = state.chatSessionId
  if (!sessionId || chatBotIdNow() !== rec.botId) {
    flash('err', t('录音时切到了别的对话，这段没有发出。', 'You switched conversations while recording, so this was not sent.'))
    render()
    return
  }
  // 转写出来的字会交给模型：和打字发消息同一道 AI 共享许可（sendChat 里那道），没点过同意不发。
  const sharing = mobileAiSharingInfo()
  if (!mobileAiSharingAllowed(sharing) && !await requestMobileAiSharing(sharing)) return
  await sendVoice(sessionId, wav)
}

/**
 * 本地这条先画上，WAV 交给 Gateway。收下了（202）就记下录音在工作区里的文件名，等对话流把那条消息送回来
 * 时按它认领（core 的 mergePending）；没收下（没开通、没余额、录音不对）就撤掉本地这条、说清原因。
 */
async function sendVoice(sessionId, wav) {
  const seconds = (wav.size - 44) / 2 / VOICE_RATE
  // 本地副本的键：认领之前语音条就拿它放；认领之后按文件名接到真路径上（voiceUrlOf）。
  const local = 'local:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const url = URL.createObjectURL(wav)
  voiceUrls.set(local, url)
  const afterSeq = (state.chatEvents || []).reduce((m, ev) => (ev.seq > m ? ev.seq : m), -1)
  const pending = { sessionId, text: '', voice: { path: local, seconds }, voiceName: '', images: [], mentions: [], refs: [], at: Date.now(), afterSeq }
  state.chatPending = (state.chatPending || []).concat(pending)
  // 回执要从对话流回来：流断着就当场接上，和 sendChat 一样（见那边 reviveChatStream 的注释）。
  reviveChatStream(sessionId, state.chatBotId)
  if (state.chatSessionId === sessionId) followChatBottom(document.getElementById('chat-thread'))
  paintChat()
  const drop = (msg) => {
    if (!(state.chatPending || []).includes(pending)) return
    state.chatPending = state.chatPending.filter((p) => p !== pending)
    if (msg) flash('err', msg)
    render()
  }
  setTimeout(() => drop(t('这条语音没送到 Bot，请稍后再录一次。', 'This voice message did not reach the bot. Please record it again.')), VOICE_DELIVER_MS)
  try {
    const r = await api('POST', '/runtime/sessions/' + encodeURIComponent(sessionId) + '/voice', wav)
    pending.voiceName = String(r?.name || '')
    voiceUrls.set('name:' + pending.voiceName, url)
    // 回执可能比这个响应先到（Gateway 回完包就开始发）：配上名字之后重画一遍，让它当场认领。
    paintChat()
  } catch (err) {
    drop(t('语音没发出去：', 'Voice message not sent: ') + (err?.message || err))
  }
}

/**
 * Bot 正忙时这条语音进了队列：输入框上面那排队的一行接手，本地这条气泡撤掉（不然同一条话一行一个气泡
 * 摆两遍）。chat-stream.js 收到 `queue/change` 时调。
 */
function dropQueuedVoice(sessionId) {
  const queued = new Set()
  for (const row of chatQueues.get(sessionId) || []) {
    const vc = SatuCore.splitVoice(row && row.text)
    if (vc) queued.add(vc.voice.path.split('/').pop())
  }
  if (!queued.size) return false
  const before = (state.chatPending || []).length
  state.chatPending = (state.chatPending || []).filter((p) => !(p.sessionId === sessionId && p.voiceName && queued.has(p.voiceName)))
  return state.chatPending.length !== before
}

/**
 * 录音时每 250 ms 一拍：走秒，顺带看计时条还在不在。不在了就是人离开了对话页（换页、退出登录、
 * 换成了没开语音的环境）——那段录音扔掉，麦克风不能在人看不见的地方一直开着。
 */
function voiceTick() {
  if (voiceState === 'rec' && !document.getElementById('chat-voicebar')) cancelVoice()
  else paintVoice()
}

/** 垃圾桶、离开页面、切后台：扔掉正在录的那段，什么都不发。 */
function cancelVoice() {
  if (voiceRec) voiceRec.cancel()
  voiceRec = null
  if (voiceState === 'rec') voiceState = 'idle'
  paintVoice()
}

// 切到后台（锁屏、切应用）：系统多半会掐掉麦克风，留着半段不如扔掉，回来重按一次。
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && voiceState === 'rec') cancelVoice()
  })
}

// ── 对话里的语音条 ────────────────────────────────────────────────────

/** 工作区路径 → 能放的 blob 地址。自己刚录的在发出去时就放进来；别的第一次点播放时从席位取。 */
const voiceUrls = new Map()
/** 正在放的那一条。全页只放一条：点另一条就把这条停了。 */
let voicePlaying = null

/** 气泡里的语音条：播放键、进度、时长。点播放才去取录音，翻一屏历史不会一口气下载几十段。 */
function voiceNoteHtml(v) {
  return `<div class="sw-voicenote" data-path="${esc(v.path)}" data-seconds="${esc(String(v.seconds || 0))}">
    <button type="button" class="sw-voicenote-play" data-act="chat-voice-play" data-path="${esc(v.path)}"
      aria-label="${esc(t('播放语音', 'Play voice message'))}">${ICON_PLAY}</button>
    <span class="sw-voicenote-track"><i></i></span>
    <span class="sw-voicenote-time">${voiceClock(v.seconds || 0)}</span>
  </div>`
}

async function voiceUrlOf(path) {
  // 自己刚发的那条：认领之后路径换成了工作区里的，本地副本按文件名接上，不用再从席位取一遍。
  const hit = voiceUrls.get(path) || voiceUrls.get('name:' + path.split('/').pop())
  if (hit) return hit
  const sessionId = state.chatSessionId
  if (!sessionId) throw new Error(t('没有打开的对话', 'No open conversation'))
  const res = await swFetch('/runtime/sessions/' + encodeURIComponent(sessionId) + '/files?path=' + encodeURIComponent(path), { headers: authHeaders() })
  if (!res.ok) throw new Error(res.status === 404 ? t('录音已经不在工作区里了', 'The recording is no longer in the workspace') : 'HTTP ' + res.status)
  const blob = await res.blob()
  // 席位按扩展名给类型，老席位可能回 octet-stream：WebView 认不出就不放，这里按 WAV 重标一下。
  const url = URL.createObjectURL(blob.type.startsWith('audio/') ? blob : new Blob([blob], { type: 'audio/wav' }))
  voiceUrls.set(path, url)
  return url
}

/** 点了语音条的播放键：放、暂停、或者换一条放。 */
async function toggleVoiceNote(path) {
  if (voicePlaying && voicePlaying.path === path) {
    if (voicePlaying.audio.paused) await voicePlaying.audio.play().catch(() => {})
    else voicePlaying.audio.pause()
    paintVoiceNotes()
    return
  }
  stopVoiceNote()
  const entry = { path, audio: null, loading: true }
  voicePlaying = entry
  paintVoiceNotes()
  try {
    const audio = new Audio(await voiceUrlOf(path))
    if (voicePlaying !== entry) return
    entry.audio = audio
    entry.loading = false
    audio.addEventListener('timeupdate', paintVoiceNotes)
    audio.addEventListener('pause', paintVoiceNotes)
    audio.addEventListener('play', paintVoiceNotes)
    audio.addEventListener('ended', () => {
      if (voicePlaying === entry) voicePlaying = null
      paintVoiceNotes()
    })
    await audio.play()
  } catch (err) {
    if (voicePlaying === entry) voicePlaying = null
    flash('err', t('放不了这段语音：', 'Could not play this voice message: ') + (err?.message || err))
    render()
  }
  paintVoiceNotes()
}

function stopVoiceNote() {
  if (voicePlaying?.audio) voicePlaying.audio.pause()
  voicePlaying = null
}

/** 所有语音条的播放键和进度就地改，不重画气泡。 */
function paintVoiceNotes() {
  for (const box of document.querySelectorAll('.sw-voicenote')) {
    const path = box.getAttribute('data-path')
    const on = voicePlaying && voicePlaying.path === path ? voicePlaying : null
    const audio = on?.audio
    const playing = Boolean(audio && !audio.paused && !audio.ended)
    const face = on?.loading ? 'loading' : playing ? 'playing' : on ? 'paused' : 'idle'
    if (box.getAttribute('data-state') !== face) box.setAttribute('data-state', face)
    const btn = box.querySelector('.sw-voicenote-play')
    const icon = playing ? ICON_PAUSE : ICON_PLAY
    if (btn && btn.getAttribute('data-icon') !== (playing ? 'pause' : 'play')) {
      btn.setAttribute('data-icon', playing ? 'pause' : 'play')
      btn.innerHTML = icon
      btn.setAttribute('aria-label', playing ? t('暂停', 'Pause') : t('播放语音', 'Play voice message'))
    }
    const total = Number(box.getAttribute('data-seconds')) || 0
    const at = audio ? audio.currentTime : 0
    const dur = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : total
    const bar = box.querySelector('.sw-voicenote-track > i')
    if (bar) bar.style.width = (on && dur ? Math.min(100, (at / dur) * 100) : 0) + '%'
    const time = box.querySelector('.sw-voicenote-time')
    if (time) time.textContent = voiceClock(on && audio && at > 0 ? at : total)
  }
}
