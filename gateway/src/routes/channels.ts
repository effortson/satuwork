import { randomBytes, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Router } from '../http.ts'
import { bodyOf, strField } from '../lib/validate.ts'
import { requireUser } from '../lib/guards.ts'
import { requireSeat, pairRuntime, proxyDownload, seatBearer, seatTargetForSession } from '../lib/runtime.ts'
import { encryptChannelSecret, decryptChannelSecret, verifyArtifactTicket } from '../crypto.ts'
import { startSeatDeploy } from '../deploy.ts'
import { botContext, publicBot } from '../lib/catalog.ts'
import { newPairingCode, pairingCodeHash } from '../channels/pairing.ts'
import { TelegramError, telegramGetMe, telegramSetMyCommands } from '../channels/telegram.ts'
import { ensureTelegramInbound, telegramWebhookSecretOk } from '../channels/inbound.ts'
import { processTelegramUpdate } from '../channels.ts'
import { USER_BOT_QUOTA_LOCK } from './runtime.ts'

const MAX_USER_BOTS = Math.max(1, Math.trunc(Number(process.env.GATEWAY_MAX_USER_BOTS) || 10))
// 绑渠道顺手建的那颗 Bot 和 POST /runtime/bots 数的是同一个配额，锁也得是同一把（键定义在那边）。
const CHANNEL_BIND_LOCK = USER_BOT_QUOTA_LOCK

interface StoredSecret { token: string; pairingCode: string }

function htmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function channelPreviewKind(path: string): 'html' | 'markdown' | 'pdf' | 'text' | 'unknown' {
  if (/\.html?$/i.test(path)) return 'html'
  if (/\.(?:md|markdown)$/i.test(path)) return 'markdown'
  if (/\.pdf$/i.test(path)) return 'pdf'
  if (/\.txt$/i.test(path)) return 'text'
  return 'unknown'
}

function channelPreviewPage(name: string, path: string, kind: ReturnType<typeof channelPreviewKind>, rawUrl: string): string {
  const safeName = htmlAttr(name || '文档')
  const safePath = htmlAttr(path)
  const safeKind = htmlAttr(kind)
  const safeRawUrl = htmlAttr(rawUrl)
  const tabs = kind === 'markdown' || kind === 'html'
    ? `<div class="sw-preview-tabs" id="preview-tabs">
        <button type="button" class="sw-preview-tab" data-mode="view" data-on="1">预览</button>
        <button type="button" class="sw-preview-tab" data-mode="source">原文</button>
      </div>`
    : '<div id="preview-tabs" hidden></div>'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeName} · Satuwork</title><meta property="og:title" content="${safeName}"><meta property="og:type" content="website">
<meta property="og:description" content="Satuwork 生成文档预览">
<link rel="icon" type="image/png" href="/assets/satuwork-logo.png">
<link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/chat.css">
</head><body class="sw-channel-preview-page" data-kind="${safeKind}" data-name="${safeName}" data-raw-url="${safeRawUrl}">
<main class="gw-modal sw-preview sw-channel-preview">
  <div class="sw-preview-head">
    <div class="sw-preview-title"><h2>${safeName}</h2><p><code>${safePath}</code><span id="preview-size"></span></p></div>
    <div class="sw-preview-acts">${tabs}
      <button type="button" class="btn btn-secondary" id="preview-download">下载</button>
      <button type="button" class="btn btn-ghost btn-icon" id="preview-close" aria-label="关闭">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18"></path><path d="M6 6l12 12"></path></svg>
      </button>
    </div>
  </div>
  <div class="sw-preview-body" id="preview-body" data-flow="center"><p class="sw-preview-note"><span class="sw-preview-spin" aria-hidden="true"></span>正在取文件…</p></div>
</main>
<script src="/markdown.js"></script><script src="/channel-preview.js"></script>
</body></html>`
}

function publicBinding(row: Awaited<ReturnType<RouteCtx['db']['channelBinding']>>, bot?: unknown, runtime?: unknown, pairingCode = '', identity?: Awaited<ReturnType<RouteCtx['db']['channelIdentity']>>) {
  if (!row) return null
  return {
    id: row.id, kind: row.kind, status: row.status, botId: row.botId,
    externalBotId: row.externalBotId, externalUsername: row.externalUsername,
    allowGroups: false, lastReceivedAt: row.lastReceivedAt,
    lastPolledAt: row.lastPolledAt, lastError: row.lastError || row.pollLastError, createdAt: row.createdAt, updatedAt: row.updatedAt,
    paired: Boolean(identity),
    ...(identity ? { pairedIdentity: {
      externalUserId: identity.externalUserId, externalUsername: identity.externalUsername,
      externalDisplayName: identity.externalDisplayName, pairedAt: identity.pairedAt, lastSeenAt: identity.lastSeenAt,
    } } : {}),
    ...(pairingCode ? { pairingCode } : {}),
    ...(bot ? { bot } : {}), ...(runtime !== undefined ? { runtime } : {}),
  }
}

async function fullBinding(ctx: RouteCtx, row: NonNullable<Awaited<ReturnType<RouteCtx['db']['channelBinding']>>>) {
  const item = await ctx.db.catalog(row.botId)
  const account = await ctx.db.account(row.accountId)
  let bot: unknown = undefined
  let runtime: unknown = null
  if (item && account?.companyId) {
    const { pinned, tpl } = await botContext(ctx.db, account.companyId)
    bot = publicBot(item, pinned, tpl)
    runtime = await pairRuntime(ctx.db, account, item.id).catch(() => null)
  }
  const identity = await ctx.db.channelIdentity(row.id)
  let pairingCode = ''
  if (!identity && row.pairingCodeHash) {
    try { pairingCode = decryptChannelSecret<StoredSecret>(ctx.channelKey, row.credentialCiphertext).pairingCode } catch {}
  }
  return publicBinding(row, bot, runtime, pairingCode, identity)
}

export function attachChannels(router: Router, ctx: RouteCtx) {
  const { db, keys, channelKey } = ctx

  /**
   * Telegram 消息里的限时预览链接。票只授权 session + path 这一对；这里再确认会话仍属于
   * 同一账号，然后沿现有工作区反代读取，不能借一张票列目录或换 path。
   *
   * 顶层返回和 Web 对话一致的预览壳；壳内用同一 URL 的 `?raw=1` 取字节。原始响应仍带
   * 下载反代的 CSP/nosniff，HTML 到浏览器后再进入无 allow-* 的 sandbox iframe。
   */
  router.get('/channel-artifacts/:ticket/:name', async (req, res) => {
    const ticket = verifyArtifactTicket(keys, req.params.ticket)
    if (!ticket) throw new HttpError(404, '预览链接不存在或已过期')
    const account = await db.account(ticket.accountId)
    if (!account || account.status !== 'active') throw new HttpError(404, '预览链接不存在或已过期')
    const target = await seatTargetForSession(db, account, ticket.sessionId)
      .catch(() => { throw new HttpError(404, '预览链接不存在或已过期') })
    const upstream = `${target.host}/api/workspace/file?path=${encodeURIComponent(ticket.path)}`
    const token = await seatBearer(db, account.id)
    const name = basename(ticket.path) || req.params.name || '文档'
    if (req.query.get('raw') === '1') {
      await proxyDownload(req, res, upstream, token, target.machineToken)
      return
    }
    const rawUrl = `/channel-artifacts/${encodeURIComponent(req.params.ticket)}/${encodeURIComponent(req.params.name)}?raw=1`
    const page = channelPreviewPage(name, ticket.path, channelPreviewKind(ticket.path), rawUrl)
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(page)),
      'content-security-policy': "default-src 'none'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:; connect-src 'self' https://cdn.jsdelivr.net; img-src 'self' data: blob: https:; media-src data: blob: https:; frame-src blob:; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors *",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'cache-control': 'private, no-store',
    })
    res.end(page)
  })

  /**
   * Telegram 推过来的 update（webhook 模式，见 channels/inbound.ts）。
   *
   * 不鉴权用户：来的是 Telegram。认它靠两样——路径里的 publicId（随机 18 字节，绑定时生成）
   * 和头上的 secret_token（设 webhook 时随机一把，只存散列）。任何一样对不上一律 404，不区分
   * 原因。处理逻辑和长轮询那条一字不差：同一个 processTelegramUpdate。
   *
   * 回什么状态码决定 Telegram 会不会重送：
   *   · 处理成功 → 200
   *   · 不可重试的 Telegram 4xx（过期的 callback_query 之类）→ **也回 200**：重送只会再撞一次，
   *     而 Telegram 在拿到 2xx 之前会一直重送这一条、堵住后面的（长轮询那边同一个道理，见
   *     pollOne 的「毒消息」注释）
   *   · 其余错误（库抖了、席位够不着）→ 500，让 Telegram 稍后重送。insertChannelEvent 按
   *     externalEventId 去重，重送不会入两条
   */
  router.post('/channels/telegram/hook/:publicId', async (req, res) => {
    const binding = await db.channelBindingByPublicId(req.params.publicId)
    const secret = String(req.headers['x-telegram-bot-api-secret-token'] || '')
    if (!binding || binding.status !== 'active' || !telegramWebhookSecretOk(binding, secret)) {
      throw new HttpError(404, '没有这个入口')
    }
    const raw = req.body
    if (!raw || typeof raw !== 'object') throw new HttpError(400, '不是 Telegram update')
    try {
      await processTelegramUpdate(db, channelKey, binding, raw)
    } catch (e) {
      const tg = e instanceof TelegramError ? e : null
      if (!tg || tg.retryable) throw e
      console.warn(`satuwork-gateway: Telegram 推送的 update 引发不可重试的 ${tg.method || 'API 调用'}，跳过：${tg.message}`)
    }
    await db.updateChannelBinding(binding.id, { lastReceivedAt: Date.now() })
    json(res, 200, { ok: true })
  })

  router.get('/channels', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const rows = await db.channelBindings(account.id)
    json(res, 200, { channels: await Promise.all(rows.map((r) => fullBinding(ctx, r))) })
  })

  router.post('/channels/telegram', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const body = bodyOf(req)
    const token = strField(body, 'token').trim()
    if (token.length < 20 || token.length > 256) throw new HttpError(400, 'Telegram token 格式不对')
    const info = await telegramGetMe(token).catch((e: Error) => { throw new HttpError(400, `Telegram token 验证失败：${e.message}`) })
    if (!info.is_bot) throw new HttpError(400, '这个 token 不是 Telegram Bot')
    const pairingCode = newPairingCode()
    const publicId = randomBytes(18).toString('base64url')

    const created = await db.tx(async () => {
      await db.lockExclusive(CHANNEL_BIND_LOCK)
      if (await db.channelBindingForAccount(account.id, 'telegram')) throw new HttpError(409, '你已经绑定了 Telegram 渠道')
      const usedElsewhere = await db.channelBindingByExternal('telegram', String(info.id))
      if (usedElsewhere) throw new HttpError(409, '这个 Telegram Bot 已被其他账号绑定')
      if (await db.countUserBots(account.id) >= MAX_USER_BOTS) throw new HttpError(409, `最多建 ${MAX_USER_BOTS} 个 Bot，请先释放一个名额`)
      const bot = await db.insertCatalog({
        kind: 'bot', scope: 'user', companyId: account.companyId, accountId: account.id,
        name: 'telegram bot',
        definition: {
          description: '通过 Telegram 渠道接收和回复消息', greeting: '', extraPrompt: '',
          icon: 'c-chat', enabled: true,
        },
      })
      const binding = await db.insertChannelBinding({
        id: randomUUID(), companyId: account.companyId!, accountId: account.id, botId: bot.id,
        kind: 'telegram', status: 'binding', externalBotId: String(info.id),
        externalUsername: String(info.username || ''), publicId,
        credentialCiphertext: encryptChannelSecret(channelKey, { token, pairingCode } satisfies StoredSecret),
        webhookSecretHash: '', pairingCodeHash: pairingCodeHash(pairingCode),
        config: { allowGroups: false },
      })
      return { bot, binding }
    })

    let status: 'active' | 'error' = 'active'
    let lastError: string | null = null
    // 收信方式按当前模式来：有 https 公网地址就设 webhook，没有就清掉旧 webhook 走长轮询
    // （见 channels/inbound.ts）。两者互斥，哪一种都得显式对齐一次。
    try {
      await ensureTelegramInbound(db, created.binding, token)
      await telegramSetMyCommands(token)
    } catch (e) {
      status = 'error'
      lastError = (e as Error).message.slice(0, 300)
    }
    const binding = await db.updateChannelBinding(created.binding.id, { status, lastError })
    let deployError = ''
    try {
      const started = await startSeatDeploy(db, account, { botId: created.bot.id })
      if (!started.ok) deployError = started.error
    } catch (e) { deployError = (e as Error).message }
    await db.audit({
      companyId: account.companyId!, accountId: account.id, action: 'channel.telegram.bind',
      detail: { id: binding.id, botId: binding.botId, externalBotId: binding.externalBotId, status },
    })
    json(res, 201, { channel: await fullBinding(ctx, binding), pairingCode, deployError })
  })

  router.post('/channels/:id/reconnect', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const binding = await db.channelBinding(req.params.id)
    if (!binding || binding.accountId !== account.id) throw new HttpError(404, '渠道不存在')
    const secret = decryptChannelSecret<StoredSecret>(channelKey, binding.credentialCiphertext)
    await telegramGetMe(secret.token).catch((e: Error) => { throw new HttpError(502, e.message) })
    await ensureTelegramInbound(db, binding, secret.token).catch((e: Error) => { throw new HttpError(502, e.message) })
    await telegramSetMyCommands(secret.token).catch((e: Error) => { throw new HttpError(502, e.message) })
    const next = await db.updateChannelBinding(binding.id, { status: 'active', lastError: null, pollLastError: null, pollLeaseUntil: null })
    json(res, 200, { channel: await fullBinding(ctx, next) })
  })

  /** 换 Telegram 身份：旧身份立即失效，新码仍然只允许在私聊里消费一次。 */
  router.post('/channels/:id/pairing-code', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const binding = await db.channelBinding(req.params.id)
    if (!binding || binding.accountId !== account.id) throw new HttpError(404, '渠道不存在')
    const old = decryptChannelSecret<StoredSecret>(channelKey, binding.credentialCiphertext)
    const pairingCode = newPairingCode()
    await db.tx(async () => {
      await db.lockChannelBinding(binding.id)
      await db.deleteChannelIdentities(binding.id)
      await db.updateChannelBinding(binding.id, {
        pairingCodeHash: pairingCodeHash(pairingCode),
        credentialCiphertext: encryptChannelSecret(channelKey, { token: old.token, pairingCode } satisfies StoredSecret),
        status: 'active', lastError: null,
      })
    })
    await db.audit({
      companyId: account.companyId!, accountId: account.id, action: 'channel.telegram.pairing.reset',
      detail: { id: binding.id, botId: binding.botId },
    })
    json(res, 200, { channel: await fullBinding(ctx, (await db.channelBinding(binding.id))!), pairingCode })
  })

  router.delete('/channels/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const binding = await db.channelBinding(req.params.id)
    if (!binding || binding.accountId !== account.id) throw new HttpError(404, '渠道不存在')
    await db.deleteChannelBinding(binding.id)
    await db.audit({
      companyId: account.companyId!, accountId: account.id, action: 'channel.telegram.unbind',
      detail: { id: binding.id, botId: binding.botId, externalBotId: binding.externalBotId },
    })
    json(res, 200, { deleted: true, botId: binding.botId })
  })
}
