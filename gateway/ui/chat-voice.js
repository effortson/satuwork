/**
 * 手机端对话框的语音输入：点一下麦克风开始录，再点一下（或到了最长时长）停，录音交给 Gateway 的
 * `POST /me/transcribe`，转出来的字插到输入框光标处——**不直接发**，人看过、改过再按发送。
 *
 * 只在手机壳里画（`mobileShell()`），而且平台在「工具配置 → 语音」配好了识别模型（`/me` 的
 * `speech.enabled`）。浏览器和桌面壳里不画：桌面有键盘，桌面壳也没申请麦克风权限。
 *
 * **自己录 PCM、自己封 WAV，不用 MediaRecorder。** MediaRecorder 在 Android WebView 出 webm/opus、
 * iOS 出 mp4/aac，几家识别服务认的格式不一样；WAV 谁都认，而且时长由字节数算得出来——Gateway
 * 按分钟计费就靠这个，不用信页面报的数（gateway/src/lib/speech.ts 的 wavSeconds）。16 kHz 单声道
 * 一分钟不到 2 MB。
 *
 * 录音发给的是第三方识别服务，和发消息给模型一样要先问过人（chat-composer.js 的
 * requestMobileAiSharing，同一个弹框、同一个本机许可前缀，退出登录一起撤回）。
 */
const ICON_MIC =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><path d="M12 18v4"/></svg>'

const VOICE_RATE = 16000

/** 正在录的那一段。同一时刻只有一段。 */
let voiceRec = null
/** 'idle' | 'rec' | 'busy'。按钮的面孔跟着它（paintVoiceButton）。 */
let voiceState = 'idle'
/**
 * 正在开麦（等系统权限框、等 getUserMedia）。这几百毫秒里按钮还是空闲的面孔，不挡的话再点一下会
 * 开出第二路，第一路的麦克风永远关不掉。
 */
let voiceStarting = false

function voiceEnabled() {
  return mobileShell() && state.me?.speech?.enabled === true && !!navigator.mediaDevices?.getUserMedia
}

/** 输入框那一排里的麦克风。不该有的时候是空串，连位置都不占。 */
function chatVoiceButtonHtml() {
  if (!voiceEnabled()) return ''
  return `<button type="button" class="sw-iconbtn sw-voice" id="chat-voice" data-act="chat-voice" data-state="${voiceState}"
    aria-label="${esc(t('语音输入', 'Voice input'))}" title="${esc(t('语音输入', 'Voice input'))}">${ICON_MIC}<span class="sw-voice-time" id="chat-voice-time"></span></button>`
}

function paintVoiceButton() {
  const btn = document.getElementById('chat-voice')
  if (!btn) return
  btn.setAttribute('data-state', voiceState)
  const label = voiceState === 'rec' ? t('停止并转成文字', 'Stop and transcribe') : voiceState === 'busy' ? t('正在识别…', 'Transcribing…') : t('语音输入', 'Voice input')
  btn.setAttribute('aria-label', label)
  btn.title = label
  const time = document.getElementById('chat-voice-time')
  if (time) time.textContent = voiceState === 'rec' && voiceRec ? voiceClock(voiceRec.seconds()) : ''
}

function voiceClock(s) {
  const n = Math.floor(s)
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`
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
  body: ['为了把你说的话转成文字，Satuwork 会把这段录音交给组织配置的语音识别服务。转出来的文字先填进输入框，由你确认后再发送。', 'To turn your speech into text, Satuwork sends the recording to the speech recognition service configured by your organization. The text goes into the input box and is only sent when you choose to.'],
  sub: ['请先了解录音会发送到哪里。', 'Review where your recording will be sent.'],
  recipients: ['组织配置的语音识别服务：', 'Organization-configured speech service:'],
  note: ['服务商的保留与训练政策可能不同。录音时请不要说出你无权共享的个人信息或机密。识别出的文字要你确认后才会发出；退出登录会撤回本机许可。', 'Provider retention and training practices may differ. Do not say personal or confidential information you are not authorized to share. Transcribed text is only sent after you confirm it; signing out revokes permission on this device.'],
  allow: ['同意并录音', 'Allow and record'],
  cancel: ['暂不使用', 'Not now'],
  info: () => voiceSharingInfo(),
}

async function toggleVoice() {
  if (voiceState === 'busy' || voiceStarting) return
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
  paintVoiceButton()
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

/** 16 位单声道 PCM 的 WAV。Gateway 只认这一种（lib/speech.ts 的 wavSeconds）。 */
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

async function finishVoice() {
  const rec = voiceRec
  if (!rec || voiceState !== 'rec') return
  voiceRec = null
  voiceState = 'busy'
  paintVoiceButton()
  try {
    const wav = rec.stop()
    // 太短的多半是误触：不送、不收钱，也不吵人。
    if (wav.size < 44 + VOICE_RATE * 2 * 0.3) return
    const text = await transcribeVoice(wav)
    if (text) insertVoiceText(rec.botId, text)
    else flash('err', t('没听清，再说一次试试。', 'Could not make that out. Try again.'))
  } catch (err) {
    flash('err', err?.message || t('语音识别失败', 'Transcription failed'))
  } finally {
    voiceState = 'idle'
    // 失败要 render 才看得见 flash；成功时插字已经就地改了输入框，这里 render 也不会冲掉它（草稿在 state 里）。
    render()
  }
}

/** api() 收 Blob 时原样发（core/src/api.ts）：登录过期、报错翻译都和别的请求同一条路。 */
async function transcribeVoice(wav) {
  const data = await api('POST', '/me/transcribe', wav)
  return String(data?.text || '').trim()
}

/**
 * 插到光标处，前后按需补空格（中文不补）。录音那几秒里人可能切到了别的 Bot：那就接到原来那颗 Bot
 * 的草稿末尾，不塞进眼前这颗的输入框。
 */
function insertVoiceText(botId, text) {
  const input = document.getElementById('chat-input')
  if (botId && chatBotIdNow() !== botId) {
    const cur = state.chatDrafts[botId] || { text: '', files: [] }
    state.chatDrafts[botId] = { ...cur, text: joinVoice(String(cur.text || ''), text, '') }
    flash('ok', t('语音已转成文字，放回了原来那个对话的输入框。', 'Transcribed into the draft of the conversation you started in.'))
    return
  }
  if (!input) {
    state.chatDraft = joinVoice(state.chatDraft || '', text, '')
    return
  }
  const start = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? start
  const before = input.value.slice(0, start)
  const after = input.value.slice(end)
  const head = joinVoice(before, text, after)
  input.value = head + after
  const caret = head.length
  input.focus()
  input.setSelectionRange(caret, caret)
  // 走输入框自己那条 input 处理：存草稿、长高、@ 选单。
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** `before` + 识别出的字，必要时在两头补一个空格：两边都是拉丁字母或数字才补。 */
function joinVoice(before, text, after) {
  const latin = /[A-Za-z0-9]/
  const lead = before && latin.test(before.slice(-1)) && latin.test(text[0]) ? ' ' : ''
  const tail = after && latin.test(text.slice(-1)) && latin.test(after[0]) ? ' ' : ''
  return before + lead + text + tail
}

/**
 * 录音时每 250 ms 一拍：走秒，顺带看按钮还在不在。不在了就是人离开了对话页（换页、退出登录、
 * 换成了没开语音的环境）——那段录音扔掉，麦克风不能在人看不见的地方一直开着。
 */
function voiceTick() {
  if (voiceState === 'rec' && !document.getElementById('chat-voice')) cancelVoice()
  else paintVoiceButton()
}

function cancelVoice() {
  if (voiceRec) voiceRec.cancel()
  voiceRec = null
  if (voiceState === 'rec') voiceState = 'idle'
  paintVoiceButton()
}

// 切到后台（锁屏、切应用）：系统多半会掐掉麦克风，留着半段不如扔掉，回来重按一次。
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && voiceState === 'rec') cancelVoice()
  })
}
