/**
 * 手机端的语音消息（gateway/ui/chat-voice.js）在服务端那一半。
 *
 * 顺序是**先处理语音、文字一出来就给人看、再交给 Bot**。手机停下的那一刻就把这条语音画进对话、输入框
 * 立刻能接着用，WAV 交给 `POST /runtime/sessions/:id/voice` 之后：
 *
 *   1. 录音放进这条会话所在席位的工作区（`uploads/<会话>/voice-….wav`），和转写**同时**开始；
 *   2. 转写走平台配的识别模型（lib/speech.ts），按秒计费——**转好就把文字回给手机**，语音条下面当场补上，
 *      不等 Bot、也不等对话流；
 *   3. 回完包之后（afterResponse）等录音放好，按 core 的 composeVoice 拼成正文，作为这个人的一条消息发给
 *      席位——和手打的走同一个口子，Bot 忙着就排队。席位为语音一行不用改。
 *
 * 投递那一串在等转写之前就挂上 afterResponse：手机在转写那几秒里切走了、连接断了，消息照样送到。
 *
 * **转写失败也照发**，正文里写明没能转成文字：录音已经在对话里了，Bot 至少知道「人发了一段语音、我没听到
 * 内容」，会请人重说或打字；悄悄丢掉一条人已经看见发出去了的消息更糟。
 *
 * **录音经 Gateway 中转这一次是有意的。** 附件不经 Gateway（动辄几十 MB，撞 Vercel 的请求体上限），语音
 * 有长度上限，一分钟不到 2 MB；换来的是手机不必直连席位机器也能发、录完就放手。字节只在内存里过一下，
 * 不落 Gateway 的盘——对话内容只存在席位上，这条纪律不变。
 */
import { randomBytes } from 'node:crypto'
import { composeVoice } from '../../../core/src/chat/events.ts'
import type { Account, Db } from '../db.ts'
import { managerHeaders } from '../deploy/manager.ts'
import type { Meter } from './meter.ts'
import { seatBearer, seatFetchJson } from './runtime.ts'
import { type SpeechConfig, billedSeconds, transcribe } from './speech.ts'

/** 没能转成文字时正文里的那一句。模型读得懂，人看气泡也明白。 */
export const VOICE_UNHEARD = {
  zh: '（这段语音没能自动转成文字）',
  en: '(This voice message could not be transcribed automatically.)',
}

/**
 * 录音在工作区里的文件名。带一段随机：手机拿它认回自己那条（chat-voice.js 的回执按文件名配），
 * 同一秒发两条也不能撞名。
 */
export function voiceFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  return `voice-${stamp}-${randomBytes(3).toString('hex')}.wav`
}

export interface VoiceDelivery {
  db: Db
  meter: Meter
  account: Account
  /** seatTargetForSession 给的那台席位。 */
  target: { host: string; machineToken?: string }
  sessionId: string
  wav: Buffer
  seconds: number
  name: string
  cfg: SpeechConfig
}

/** 录音放进席位工作区，回它在工作区里的路径。和浏览器传附件是同一条席位接口，只是由这里替手机发。 */
async function uploadToSeat(base: string, bearer: string, machineToken: string | undefined, name: string, wav: Buffer): Promise<string> {
  const r = await fetch(`${base}/files`, {
    method: 'POST',
    headers: {
      authorization: bearer ? `Bearer ${bearer}` : '',
      accept: 'application/json',
      ...managerHeaders(machineToken),
      'content-type': 'application/octet-stream',
      'x-filename': encodeURIComponent(name),
    },
    body: new Uint8Array(wav),
    signal: AbortSignal.timeout(30_000),
  })
  const parsed = (await r.json().catch(() => null)) as { path?: unknown; error?: unknown } | null
  if (!r.ok || typeof parsed?.path !== 'string') throw new Error(`录音没放进席位工作区（HTTP ${r.status}${parsed?.error ? `：${String(parsed.error)}` : ''}）`)
  return parsed.path
}

/**
 * 开工：放录音和转写一起跑。回两个 promise——`heard` 是转出来的字（失败是空串，不抛），路由等它回给手机；
 * `delivered` 是整串（放好录音、拼正文、发给席位），交给 afterResponse。
 */
export function startVoice(o: VoiceDelivery): { heard: Promise<string>; delivered: Promise<void> } {
  const bearer = seatBearer(o.db, o.account.id)
  const base = `${o.target.host}/api/sessions/${encodeURIComponent(o.sessionId)}`
  const heard = transcribe(o.cfg, o.wav).then(
    async (text) => {
      await o.meter.charge({ kind: 'speech', account: o.account, status: 'ok', model: o.cfg.model, units: billedSeconds(o.seconds), refId: o.name })
      return text
    },
    async (e) => {
      await o.meter.charge({ kind: 'speech', account: o.account, status: 'failed', model: o.cfg.model, units: 0, refId: o.name })
      console.warn(`satuwork-gateway: 语音转写失败（${o.sessionId}）：${(e as Error).message}`)
      return ''
    },
  )
  const uploaded = bearer.then((tok) => uploadToSeat(base, tok, o.target.machineToken, o.name, o.wav))
  const delivered = Promise.all([uploaded, heard, bearer]).then(async ([path, text, tok]) => {
    const locale = o.account.locale === 'en' ? 'en' : 'zh'
    const body = composeVoice(locale, { path, seconds: o.seconds }, text || VOICE_UNHEARD[locale])
    // 发消息那一跳等久一点：Bot 正忙时席位要先把它排进队列再回话。
    const r = await seatFetchJson('POST', `${base}/messages`, { text: body, locale }, tok, o.target.machineToken, 30_000)
    if (!r.ok) throw new Error(`席位没收下这条语音（HTTP ${r.status}）`)
  })
  return { heard, delivered }
}
