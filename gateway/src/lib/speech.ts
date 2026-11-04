/**
 * 语音输入：手机端对话框里按住麦克风说话，录下来的音频交给平台配的识别模型转成文字，填回输入框。
 *
 * 和知识库向量模型同一个分法（lib/knowledge-embedding.ts）：服务商、模型在平台「工具配置 → 语音」
 * 按区域选，存进平台设置的 `speech`；密钥进 platform_credentials 的 `speech:<预设>`（自定义的再钉上
 * 地址的 origin）。几家都是 OpenAI 兼容的 `POST /audio/transcriptions`（multipart：file + model）。
 *
 * **音频一律是 16 位单声道 PCM 的 WAV。** 页面自己录 PCM、自己封 WAV（gateway/ui/chat-voice.js），
 * 不用 MediaRecorder：那条路 Android 出 webm/opus、iOS 出 mp4/aac，智谱只认 wav/mp3。更要紧的是计费——
 * WAV 的时长由字节数算得出来（`wavSeconds`），按分钟收钱不用信客户端报的数，也不用等上游报。
 */
import type { Db, PlatformSettings, SpeechSettings } from '../db.ts'
import { parseSpeech } from '../db.ts'
import { HttpError } from '../http.ts'
import { WebToolError, safeFetch } from '../web-tools.ts'

/**
 * `maxSeconds`：这家单段最长收多少秒。智谱的 glm-asr 只收 30 秒以内；别的家远不止，统一按
 * `SPEECH_MAX_SECONDS` 截——一段 16 kHz 的 WAV 一分钟 1.9 MB，离 Vercel 4.5 MB 的请求体上限有余量。
 */
export interface SpeechPreset {
  id: string
  region: 'cn' | 'intl'
  label: string
  baseUrl: string
  model: string
  models: string[]
  maxSeconds: number
}

export const SPEECH_MAX_SECONDS = 60

export const SPEECH_PRESETS: readonly SpeechPreset[] = [
  { id: 'siliconflow', region: 'cn', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall', models: ['FunAudioLLM/SenseVoiceSmall', 'TeleAI/TeleSpeechASR'], maxSeconds: SPEECH_MAX_SECONDS },
  { id: 'zhipu', region: 'cn', label: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-asr-2512', models: ['glm-asr-2512'], maxSeconds: 30 },
  // gpt-4o-mini-transcribe / gpt-4o-transcribe / whisper-1 已被 OpenAI 弃用（2026-08-26 公布，2027-02-26 停用），
  // 默认换成接替它们的 gpt-transcribe（按分钟计价）；老的三个留在候选里，停用前还能选。
  { id: 'openai', region: 'intl', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-transcribe', models: ['gpt-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'], maxSeconds: SPEECH_MAX_SECONDS },
  { id: 'groq', region: 'intl', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', models: ['whisper-large-v3-turbo', 'whisper-large-v3'], maxSeconds: SPEECH_MAX_SECONDS },
  { id: 'siliconflow-intl', region: 'intl', label: 'SiliconFlow（国际站）', baseUrl: 'https://api.siliconflow.com/v1', model: 'FunAudioLLM/SenseVoiceSmall', models: ['FunAudioLLM/SenseVoiceSmall', 'TeleAI/TeleSpeechASR'], maxSeconds: SPEECH_MAX_SECONDS },
]

export const SPEECH_CUSTOM = 'custom'

/** 同 embeddingSecretName：按预设分开存，自定义的钉在 origin 上，改了地址旧密钥就取不到。 */
export function speechSecretName(provider: string, baseUrl = ''): string {
  if (provider !== SPEECH_CUSTOM) return `speech:${provider}`
  let origin = ''
  try { origin = new URL(baseUrl).origin } catch {}
  return `speech:${SPEECH_CUSTOM}:${origin}`
}

export function isSpeechSecret(name: string): boolean {
  return name.startsWith('speech:')
}

export function knownSpeechProvider(id: string): boolean {
  return id === SPEECH_CUSTOM || SPEECH_PRESETS.some((p) => p.id === id)
}

export interface SpeechConfig {
  provider: string
  base: string
  model: string
  maxSeconds: number
  token: string
  error: string
  /** 页面上填的自定义地址要过 SSRF 闸；本机测试开关放行（同 GATEWAY_KB_EMBEDDING_ALLOW_PRIVATE）。 */
  allowPrivate: boolean
}

function urlError(base: string): string {
  try {
    const url = new URL(base)
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error()
    return ''
  } catch { return '识别服务地址必须是 HTTPS（本机测试可用 HTTP），不能含凭据或查询参数' }
}

/** 页面上存的那份收成一份能直接调用的配置。纯函数。没有环境变量那条退路：这是新功能，没有老部署要接。 */
export function resolveSpeech(s: SpeechSettings, token: string, env: NodeJS.ProcessEnv = process.env): SpeechConfig {
  let base = '', model = '', maxSeconds = SPEECH_MAX_SECONDS, error = ''
  if (!s.provider) error = '还没有配置语音识别模型'
  else {
    const preset = SPEECH_PRESETS.find((p) => p.id === s.provider)
    if (preset) {
      base = preset.baseUrl
      model = s.model || preset.model
      maxSeconds = preset.maxSeconds
    } else if (s.provider === SPEECH_CUSTOM) {
      base = s.baseUrl
      model = s.model
    } else error = `不认识的识别服务：${s.provider}`
  }
  base = base.trim().replace(/\/+$/, '')
  model = model.trim()
  if (!error && !base) error = '缺少识别服务地址'
  if (!error) error = urlError(base)
  if (!error && !model) error = '缺少识别模型名'
  return { provider: s.provider, base, model, maxSeconds, token: token.trim(), error, allowPrivate: env.GATEWAY_SPEECH_ALLOW_PRIVATE === '1' }
}

/** 每次现读，不缓存：Vercel 上好几个实例，页面上一改，别的实例下一次就得跟上。 */
export async function loadSpeechConfig(db: Db, settings?: PlatformSettings): Promise<SpeechConfig> {
  const s = parseSpeech((settings ?? await db.platformSettings()).speech)
  const cred = s.provider ? await db.platformCredential(speechSecretName(s.provider, s.baseUrl)) : undefined
  return resolveSpeech(s, cred?.secret ?? '')
}

export function speechUsable(cfg: SpeechConfig): boolean {
  return !cfg.error && !!cfg.token
}

export function speechProblem(cfg: SpeechConfig): string {
  return cfg.error || (cfg.token ? '' : '还没有填识别服务的 API 密钥')
}

/**
 * 收下来的 WAV 重新封一遍：只留 `data` 里的 PCM，配一个标准的 44 字节头，连同它的时长（秒）一起回。
 * 只认页面录出来的那种：RIFF/WAVE、PCM（格式 1）、16 位、单声道、8–48 kHz。别的一律 400——这个数
 * 直接决定收多少钱，认不清就不收这段音频。
 *
 * **转给上游的就是计费的那一段。** 不重封的话，头里把 data 长度写小、后面照样塞满音频，读到文件尾的
 * 解码器会把多出来的也识别了，钱却只按头里那一截收。块按顺序找 `fmt ` 和 `data`；`data` 的长度按
 * 实际收到的字节截，写 0 的（流式写出、没回填长度）按收到的全部算。
 */
export function canonicalWav(buf: Buffer): { wav: Buffer; seconds: number } {
  const bad = () => new HttpError(400, '音频要是 16 位单声道 PCM 的 WAV')
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw bad()
  let at = 12
  let rate = 0
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4)
    const size = buf.readUInt32LE(at + 4)
    const body = at + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) throw bad()
      const format = buf.readUInt16LE(body)
      const channels = buf.readUInt16LE(body + 2)
      rate = buf.readUInt32LE(body + 4)
      const bits = buf.readUInt16LE(body + 14)
      if (format !== 1 || channels !== 1 || bits !== 16 || rate < 8000 || rate > 48000) throw bad()
    } else if (id === 'data') {
      if (!rate) throw bad()
      const got = buf.length - body
      let dataBytes = size === 0 ? got : Math.min(size, got)
      dataBytes -= dataBytes % 2
      return { wav: pcmWav(buf.subarray(body, body + dataBytes), rate), seconds: dataBytes / 2 / rate }
    }
    // 块长是奇数时后面补一个字节（RIFF 规矩）。
    at = body + size + (size % 2)
  }
  throw bad()
}

/** 16 位单声道 PCM 配上标准的 44 字节 WAV 头。 */
export function pcmWav(pcm: Buffer, rate: number): Buffer {
  const wav = Buffer.alloc(44 + pcm.length)
  wav.write('RIFF', 0, 'ascii'); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVE', 8, 'ascii')
  wav.write('fmt ', 12, 'ascii'); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36, 'ascii'); wav.writeUInt32LE(pcm.length, 40)
  pcm.copy(wav, 44)
  return wav
}

/** 收多少秒的钱：不足一秒按一秒，同各家按秒向上取整的口径。 */
export function billedSeconds(seconds: number): number {
  return Math.max(1, Math.ceil(seconds - 1e-9))
}

/** 手拼 multipart：safeFetch 走 undici 的固定连接，自己拼最不挑运行时。 */
function multipart(fields: Record<string, string>, file: Buffer): { body: Buffer; type: string } {
  const boundary = `----satuwork${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n`))
  parts.push(file, Buffer.from(`\r\n--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` }
}

/** 打一次识别。不重试：人在手机上等着，失败了自己再按一次比后台默默多等十几秒好。上游的正文和密钥都不回给页面。 */
export async function transcribe(cfg: SpeechConfig, wav: Buffer, timeoutMs = 30_000): Promise<string> {
  if (!speechUsable(cfg)) throw new HttpError(503, speechProblem(cfg))
  // 只带 model：智谱、硅基流动的文档里没有 response_format，各家不带时回的都是 {"text": …}。
  const form = multipart({ model: cfg.model }, wav)
  const init = {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': form.type },
    body: new Uint8Array(form.body),
  }
  const url = `${cfg.base}/audio/transcriptions`
  let response: Response
  try {
    response = cfg.allowPrivate
      ? await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
      : await safeFetch(url, { ...init, timeoutMs })
  } catch (e) {
    if (e instanceof WebToolError && /内网/.test(e.hint)) throw new HttpError(503, '识别服务地址指向内网，已拒绝')
    throw new HttpError(503, '识别服务连接失败或超时，稍后重试')
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new HttpError(503, `识别服务请求失败（HTTP ${response.status}），请检查模型权限、额度和服务状态`)
  }
  let result: { text?: unknown }
  try { result = await response.json() } catch { throw new HttpError(502, '识别服务返回了无效 JSON') }
  if (typeof result.text !== 'string') throw new HttpError(502, '识别服务没有返回文字')
  return result.text.trim()
}
