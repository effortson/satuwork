/**
 * 语音输入（lib/speech.ts）。
 *
 * - `POST /me/transcribe`：手机端对话框的麦克风。请求体就是 WAV 本身（postRaw），回 `{ text, seconds }`。
 *   按音频秒数计费（meter 的 `speech`），先过余额闸；没成的也落一行（金额 0），同知识库检索。
 * - `/platform/speech*`：平台「工具配置 → 语音」。服务商、模型、单价进平台设置的 `speech`，密钥进
 *   platform_credentials（存进去不回显）。owner-only。
 */
import { randomUUID } from 'node:crypto'
import type { RouteCtx } from './ctx.ts'
import { type Db, type PlatformSettings, type SpeechSettings, parseSpeech } from '../db.ts'
import { HttpError, json, type Req, type Router } from '../http.ts'
import { requireOwnerUser, requireUser } from '../lib/guards.ts'
import { bodyOf, strField } from '../lib/validate.ts'
import {
  SPEECH_CUSTOM, SPEECH_MAX_SECONDS, SPEECH_PRESETS, billedSeconds, isSpeechSecret, knownSpeechProvider, loadSpeechConfig,
  canonicalWav, pcmWav, resolveSpeech, speechProblem, speechSecretName, speechUsable, transcribe,
} from '../lib/speech.ts'
import { WebToolError, guardUrl } from '../web-tools.ts'

/** 最长那一段（60 秒、48 kHz）再留点头的余量。页面录的是 16 kHz，一分钟不到 2 MB。 */
const WAV_MAX_BYTES = SPEECH_MAX_SECONDS * 48_000 * 2 + 4096
/** 短于这个多半是误触，不送去识别，也不收钱。 */
const MIN_SECONDS = 0.3

async function readWav(req: Req): Promise<Buffer> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
    n += chunk.length
    if (n > WAV_MAX_BYTES) throw new HttpError(413, `一段语音最长 ${SPEECH_MAX_SECONDS} 秒`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * 给 `/me` 用：页面据此决定画不画麦克风、录到几秒自动停。`provider` 是给人看的那家的名字——手机端第一次
 * 录音前要告诉人录音会发给谁（chat-voice.js 的同意弹框），同发消息那一版列模型服务商。自定义的只报
 * 「自定义」，不报地址：主机名是平台的部署细节，公司侧不该看到（同 orgSettings 的白名单）。
 */
export async function speechFeature(db: Db, settings?: PlatformSettings): Promise<SpeechFeature> {
  const cfg = await loadSpeechConfig(db, settings)
  if (!speechUsable(cfg)) return SPEECH_OFF
  const provider = SPEECH_PRESETS.find((p) => p.id === cfg.provider)?.label ?? '自定义语音识别服务'
  return { enabled: true, maxSeconds: cfg.maxSeconds, provider }
}

export interface SpeechFeature {
  enabled: boolean
  maxSeconds: number
  provider: string
}

export const SPEECH_OFF: SpeechFeature = { enabled: false, maxSeconds: SPEECH_MAX_SECONDS, provider: '' }

async function speechView(db: Db) {
  const s = parseSpeech((await db.platformSettings()).speech)
  const customKey = speechSecretName(SPEECH_CUSTOM, s.baseUrl)
  const keys: Record<string, { updatedAt: number }> = {}
  for (const c of await db.platformCredentials()) {
    if (!isSpeechSecret(c.provider)) continue
    // 自定义只报当前地址那一把，同向量模型那一屏。
    if (c.provider === customKey) keys[SPEECH_CUSTOM] = { updatedAt: c.updatedAt }
    else if (!c.provider.startsWith(speechSecretName(SPEECH_CUSTOM))) keys[c.provider.slice('speech:'.length)] = { updatedAt: c.updatedAt }
  }
  const cfg = await loadSpeechConfig(db)
  return { speech: s, presets: SPEECH_PRESETS, keys, ready: speechUsable(cfg), problem: speechProblem(cfg) }
}

async function customUrlOr400(next: SpeechSettings): Promise<void> {
  if (next.provider !== SPEECH_CUSTOM || process.env.GATEWAY_SPEECH_ALLOW_PRIVATE === '1') return
  try {
    await guardUrl(next.baseUrl)
  } catch (e) {
    throw new HttpError(400, e instanceof WebToolError ? e.hint : '识别服务地址不可用')
  }
}

export function attachSpeech(router: Router, ctx: RouteCtx) {
  const { db, keys, meter } = ctx

  router.postRaw('/me/transcribe', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const cfg = await loadSpeechConfig(db)
    if (!speechUsable(cfg)) throw new HttpError(503, '语音输入还没开通，请联系平台管理员')
    // 转给上游的是重新封过的那一份：计费的时长和识别的音频是同一段（canonicalWav）。
    const { wav, seconds } = canonicalWav(await readWav(req))
    if (seconds < MIN_SECONDS) throw new HttpError(400, '说话时间太短了')
    // 页面按 /me 报的 maxSeconds 自动停，多出来的一点是录音收尾的缓冲。
    if (seconds > cfg.maxSeconds + 1) throw new HttpError(413, `一段语音最长 ${cfg.maxSeconds} 秒`)
    const gate = await meter.gate(account, { kind: 'speech' })
    if (!gate.ok) {
      await meter.charge(
        { kind: 'speech', account, status: 'denied', model: cfg.model, units: 0 },
        { amountMicros: 0, unitPrice: {}, multiplier: 1, unpriced: false },
      )
      throw new HttpError(402, gate.reason)
    }
    let text: string
    try {
      text = await transcribe(cfg, wav)
    } catch (e) {
      await meter.charge({ kind: 'speech', account, status: 'failed', model: cfg.model, units: 0, refId: randomUUID() })
      throw e
    }
    // 转出来的文字**不进账本**：那是员工要发的话，和对话内容一个敏感级。
    const units = billedSeconds(seconds)
    await meter.charge({ kind: 'speech', account, status: 'ok', model: cfg.model, units, refId: randomUUID() })
    json(res, 200, { text, seconds: units })
  })

  router.get('/platform/speech', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    json(res, 200, await speechView(db))
  })

  /** 带哪个字段改哪个；`pricing` 整个换。配出来的组合必须能解析成一份合法配置，否则 400。 */
  router.put('/platform/speech', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const body = bodyOf(req)
    if ('region' in body && !['cn', 'intl'].includes(String(body.region))) throw new HttpError(400, '区域只能是 cn 或 intl')
    if ('pricing' in body) {
      const n = Number((body.pricing as Record<string, unknown> | null)?.minuteMils)
      if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new HttpError(400, '单价要是 0 到 1000000 之间的数（厘 / 分钟）')
    }
    const settings = await db.platformSettings()
    const cur = parseSpeech(settings.speech)
    const next = parseSpeech({ ...cur, ...body })
    if ('provider' in body && String(body.provider ?? '') !== next.provider) throw new HttpError(400, '识别服务 id 不合法')
    if (next.provider && !knownSpeechProvider(next.provider)) throw new HttpError(400, `不认识的识别服务：${next.provider}`)
    const preset = SPEECH_PRESETS.find((p) => p.id === next.provider)
    if ('provider' in body && preset && preset.region !== next.region) throw new HttpError(400, `${preset.label} 不在当前选的区域里，先切区域`)
    // 换了一家，上一家的模型名不该跟过来。
    if (next.provider !== cur.provider && !('model' in body)) next.model = ''
    if (next.provider && resolveSpeech(next, 'probe').error) throw new HttpError(400, resolveSpeech(next, 'probe').error)
    await customUrlOr400(next)
    await db.putPlatformSettings({ ...settings, speech: next })
    // 自定义地址换了 origin：旧地址那把密钥不会再被取到，删掉。
    const keep = speechSecretName(SPEECH_CUSTOM, next.baseUrl)
    for (const c of await db.platformCredentials()) {
      if (c.provider.startsWith(speechSecretName(SPEECH_CUSTOM)) && c.provider !== keep) await db.deletePlatformCredential(c.provider)
    }
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.speech.update', detail: { ...next } })
    json(res, 200, await speechView(db))
  })

  router.put('/platform/speech/key', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const body = bodyOf(req)
    const provider = strField(body, 'provider')
    if (!knownSpeechProvider(provider)) throw new HttpError(400, `不认识的识别服务：${provider}`)
    const secret = strField(body, 'secret').trim()
    if (!secret) throw new HttpError(400, '密钥不能为空')
    const s = parseSpeech((await db.platformSettings()).speech)
    if (provider === SPEECH_CUSTOM && (s.provider !== SPEECH_CUSTOM || !s.baseUrl)) throw new HttpError(400, '先保存自定义接口地址，再填密钥')
    await db.upsertPlatformCredential(speechSecretName(provider, s.baseUrl), secret)
    // **不带密钥**。
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.speech.key', detail: { provider } })
    json(res, 200, await speechView(db))
  })

  /** 自检：送一秒静音过去。不记用量——这是验配置，不是用。 */
  router.post('/platform/speech/test', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const cfg = await loadSpeechConfig(db)
    if (!speechUsable(cfg)) {
      json(res, 200, { ok: false, error: speechProblem(cfg) })
      return
    }
    const startedAt = Date.now()
    try {
      // 一秒静音：各家对静音回空字符串，能回就说明地址、模型、密钥都对。
      await transcribe(cfg, pcmWav(Buffer.alloc(32_000), 16_000), 15_000)
      json(res, 200, { ok: true, model: cfg.model, elapsedMs: Date.now() - startedAt })
    } catch (e) {
      json(res, 200, { ok: false, error: (e as Error).message })
    }
  })
}
