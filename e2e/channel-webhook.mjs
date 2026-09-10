/**
 * Telegram 走 webhook（gateway/src/channels/inbound.ts）。
 *
 * channels 那一套是长轮询模式，这里把 GATEWAY_TELEGRAM_WEBHOOK_BASE 指向 Gateway 自己，
 * 钉住另一种模式：绑定时设 webhook 而不轮询；推送认 publicId + secret；处理逻辑和长轮询
 * 同一条（配对、入队、去重）；模式切换双向自愈。
 */
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { createCompany } from './org.mjs'
import { closeServer } from './probe.mjs'
import { TOKEN, mockTelegram } from './channels.mjs'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function runChannelWebhook({ gwRoot, test, req, start, waitHttp, assert, log }) {
  log('\n# channel-webhook')
  const GW_HOME = tmpOf('satuwork-e2e-channel-webhook')
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`
  const schema = schemaOf('e2e_channel_webhook')
  rmSync(GW_HOME, { recursive: true, force: true })

  const telegram = await mockTelegram()
  const env = {
    SATUWORK_GATEWAY_HOME: GW_HOME,
    GATEWAY_DATABASE_URL: PG_URL,
    GATEWAY_PG_SCHEMA: schema,
    GATEWAY_PG_RESET: '1',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_PORT: String(GW_PORT),
    GATEWAY_ACCESS_HOST: 'satuwork.com',
    GATEWAY_SEED_OWNER: '1',
    GATEWAY_OWNER_EMAIL: 'owner@hook.test',
    GATEWAY_OWNER_PASSWORD: 'test-owner-hook',
    TELEGRAM_API_BASE: telegram.url,
    GATEWAY_CHANNEL_TICK_MS: '600000',
    GATEWAY_CHANNEL_POLL_SCAN_MS: '250',
    GATEWAY_CHANNEL_POLL_TIMEOUT_SECONDS: '1',
    GATEWAY_TELEGRAM_WEBHOOK_BASE: base,
  }
  let gw = start('channel-webhook-gw', ['--import', 'tsx', `${gwRoot}/src/index.ts`], { cwd: gwRoot, env })
  await waitHttp(`${base}/health`, { child: gw, what: 'channel-webhook gateway' })

  const require = createRequire(new URL('../gateway/package.json', import.meta.url))
  const pg = require('pg')
  const withPg = async (fn) => {
    const client = new pg.Client({ connectionString: PG_URL })
    await client.connect()
    try {
      return await fn(client)
    } finally {
      await client.end().catch(() => {})
    }
  }
  const hook = (publicId, secret, update) =>
    fetch(`${base}/channels/telegram/hook/${encodeURIComponent(publicId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) },
      body: JSON.stringify(update),
    })

  try {
    const reg = await createCompany(req, base, {
      ownerEmail: 'owner@hook.test',
      ownerPassword: 'test-owner-hook',
      email: 'admin@hook.test',
      password: 'correct-horse',
      companyName: 'HookCo',
      slug: 'hookco',
      seats: 2,
    })
    const token = reg.token
    let pairingCode = ''
    let bindingId = ''
    let publicId = ''

    await test('绑定时设 webhook 而不是清掉它，之后一次 getUpdates 都不发', async () => {
      const r = await req(base, 'POST', '/channels/telegram', { token, body: { token: TOKEN } })
      assert(r.status === 201, `绑定 ${r.status} ${r.text}`)
      pairingCode = r.json.pairingCode
      bindingId = r.json.channel.id
      assert(r.json.channel.status === 'active', `状态 ${r.json.channel.status} ${r.json.channel.lastError}`)
      assert(telegram.seen.webhook, '没有设 webhook')
      assert(telegram.seen.deleteWebhook === 0, '设了 webhook 又去删')
      const row = await withPg((c) => c.query(`select "publicId","webhookSecretHash" from "${schema}".channel_bindings where id = $1`, [bindingId]))
      publicId = row.rows[0].publicId
      assert(telegram.seen.webhook.url === `${base}/channels/telegram/hook/${encodeURIComponent(publicId)}`, `webhook 地址 ${telegram.seen.webhook.url}`)
      assert(telegram.seen.webhook.secret.length >= 20, 'secret 太短')
      assert(row.rows[0].webhookSecretHash && row.rows[0].webhookSecretHash !== telegram.seen.webhook.secret, '库里该存散列，不是明文')
      assert(telegram.seen.webhook.allowed.includes('callback_query'), 'allowed_updates 要和 getUpdates 那边一致')
      await sleep(1200)
      assert(telegram.seen.polls.length === 0, `webhook 模式下还在 getUpdates：${telegram.seen.polls.length} 次`)
    })

    await test('推送认 publicId 和 secret：错一样就 404，对了走和长轮询同一条处理', async () => {
      const secret = telegram.seen.webhook.secret
      const msg = (id, text, chatId = 456) => ({
        update_id: id,
        message: { message_id: id, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false, first_name: 'Alice', username: 'alice' }, text },
      })
      const badId = await hook('nope', secret, msg(1, pairingCode))
      assert(badId.status === 404, `错 publicId ${badId.status}`)
      const badSecret = await hook(publicId, 'wrong', msg(1, pairingCode))
      assert(badSecret.status === 404, `错 secret ${badSecret.status}`)
      const noSecret = await hook(publicId, '', msg(1, pairingCode))
      assert(noSecret.status === 404, `无 secret ${noSecret.status}`)
      // 陌生人先来猜：不入队，只回一句「尚未配对」。
      const stranger = await hook(publicId, secret, msg(2, '猜错了', 999))
      assert(stranger.status === 200, `陌生人 ${stranger.status}`)
      const textOf = (s) => String(s.text || (s.rich_message && s.rich_message.markdown) || '')
      assert(telegram.seen.sent.some((s) => String(s.chat_id) === '999' && textOf(s).includes('尚未配对')), '没提示未配对')
      // 正确配对码：配对成功。
      const paired = await hook(publicId, secret, msg(3, pairingCode))
      assert(paired.status === 200, `配对 ${paired.status} ${await paired.text()}`)
      const channels = await req(base, 'GET', '/channels', { token })
      assert(channels.json.channels[0].paired === true, '没配上')
      // 配对后的消息入账本；同一条 update 重送不入两条（Telegram 拿不到 2xx 会重送）。
      const first = await hook(publicId, secret, msg(4, '你好'))
      assert(first.status === 200, `入队 ${first.status}`)
      const again = await hook(publicId, secret, msg(4, '你好'))
      assert(again.status === 200, `重送 ${again.status}`)
      const events = await withPg((c) => c.query(`select count(*)::int as n from "${schema}".channel_events where "bindingId" = $1`, [bindingId]))
      assert(events.rows[0].n === 1, `账本该只有 1 条，有 ${events.rows[0].n}`)
    })

    await test('重连仍是 webhook；模式关掉重启后自己删 webhook、回到长轮询', async () => {
      const re = await req(base, 'POST', `/channels/${bindingId}/reconnect`, { token })
      assert(re.status === 200, `重连 ${re.status} ${re.text}`)
      assert(telegram.seen.webhook && telegram.seen.deleteWebhook === 0, '重连不该删 webhook')
      const before = telegram.seen.webhook.secret
      // 关掉模式，换一个不带 WEBHOOK_BASE 的 Gateway 起来。
      gw.kill('SIGTERM')
      await sleep(500)
      const { GATEWAY_TELEGRAM_WEBHOOK_BASE: _off, GATEWAY_PG_RESET: _keep, ...rest } = env
      gw = start('channel-poll-gw', ['--import', 'tsx', `${gwRoot}/src/index.ts`], { cwd: gwRoot, env: rest })
      await waitHttp(`${base}/health`, { child: gw, what: 'channel-poll gateway' })
      const deadline = Date.now() + 8000
      while (Date.now() < deadline && !(telegram.seen.deleteWebhook >= 1 && telegram.seen.polls.length > 0)) await sleep(100)
      assert(telegram.seen.deleteWebhook >= 1, '模式关掉后没有删 webhook')
      assert(telegram.seen.polls.length > 0, '模式关掉后没有恢复长轮询')
      const row = await withPg((c) => c.query(`select "webhookSecretHash" from "${schema}".channel_bindings where id = $1`, [bindingId]))
      assert(row.rows[0].webhookSecretHash === '', '散列没清掉')
      // 旧 secret 再来敲，不认。
      const stale = await hook(publicId, before, { update_id: 9, message: { message_id: 9, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false, first_name: 'Alice' }, text: 'x' } })
      assert(stale.status === 404, `轮询模式下推送该 404：${stale.status}`)
    })
  } finally {
    gw.kill('SIGTERM')
    await closeServer(telegram.server)
  }
}
