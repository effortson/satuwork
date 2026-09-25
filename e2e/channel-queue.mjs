/**
 * 渠道事件的队列：**一方堆着的活，挤不掉另一方的名额**；函数形态也有人收投递。
 *
 * 取到期事件的那一句（db.dueChannelEvents）以前不分谁来领，一律取全平台最老的 N 条，
 * 工人那条再按机器挑、Gateway 的扫描再跳过归工人的——被跳过的行照旧到期、下一轮还排在
 * 最前面。于是：
 *
 *   · 一台机器的工人挂了，它那几十个会话的消息一堆，别的机器的工人就再也领不到活；
 *   · 同样那一堆会挤满 Gateway 扫描的十个名额，已经有回复、只差投递的（和它们的重试）
 *     全平台一起停摆。
 *
 * 还有一件只在函数形态（Vercel）上出现的：那里没有渠道分发器的定时器，`/cron/tick` 又没
 * 管渠道，于是已经有回复、投递失败过一次的事件永远卡在 retry，连带挡住那个会话之后的每一条。
 *
 * 数据直接往库里插：一家公司只能经接口绑一个 Telegram（假 Telegram 只有一个 bot），而要
 * 验的是「好几个会话、好几台机器」。绑定的密文从经接口绑出来的那一个抄过来，投递就打得到
 * 假 Telegram 上。
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { createCompany } from './org.mjs'
import { pairMachine } from './pair.mjs'
import { freePorts } from './ports.mjs'
import { closeServer } from './probe.mjs'
import { TOKEN as TG_TOKEN, mockTelegram } from './channels.mjs'

const SCHEMA = schemaOf('e2e_channel_queue')
/** 挂掉的那台机器上堆着多少个会话。比两边的名额（工人 20、Gateway 10）都多。 */
const STUCK = 25
const CRON_SECRET = 'cron-channel-queue'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function runChannelQueue({ gwRoot, test, req, start, waitHttp, assert, log }) {
  log('\n# channel-queue')

  const GW_HOME = tmpOf('satuwork-e2e-channel-queue')
  rmSync(GW_HOME, { recursive: true, force: true })
  const [GW_PORT, FN_PORT] = await freePorts(2)
  const gwBase = `http://127.0.0.1:${GW_PORT}`
  const fnBase = `http://127.0.0.1:${FN_PORT}`
  const telegram = await mockTelegram()

  // 常驻进程和函数形态接同一个库，钥匙也得是同一套：渠道密文要解得开，登录票要认得。
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const shared = {
    GATEWAY_DATABASE_URL: PG_URL,
    GATEWAY_PG_SCHEMA: SCHEMA,
    GATEWAY_ACCESS_HOST: 'satuwork.com',
    SATUWORK_GATEWAY_HOME: GW_HOME,
    GATEWAY_JWT_PRIVATE_KEY: pair.privateKey,
    GATEWAY_JWT_PUBLIC_KEY: pair.publicKey,
    GATEWAY_CHANNEL_KEY: randomBytes(32).toString('base64'),
    TELEGRAM_API_BASE: telegram.url,
    // 长轮询不在这一套里验，扫一次就够（绑定是后插的，扫不到它们）。
    GATEWAY_CHANNEL_POLL_SCAN_MS: '600000',
  }

  const gw = start('channel-queue-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      ...shared,
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: 'owner@queue.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-queue',
      SATUWORK_DEPLOY_STUB: '1',
      GATEWAY_CHANNEL_TICK_MS: '300',
    },
  })
  let fn = null

  const withPg = async (fn) => {
    const { createRequire } = await import('node:module')
    const require = createRequire(new URL('../gateway/package.json', import.meta.url))
    const pg = require('pg')
    const client = new pg.Client({ connectionString: PG_URL })
    await client.connect()
    try {
      await client.query(`set search_path to ${SCHEMA}`)
      return await fn(client)
    } finally {
      await client.end().catch(() => {})
    }
  }

  /** 一条已经有回复、投递失败过一次、到点该重试的事件。 */
  const retryEvent = (id, bindingId, conv, reply) =>
    withPg((c) =>
      c.query(
        `insert into channel_events (id,"bindingId","externalEventId","externalConversationId","remoteUserId","remoteDisplayName",title,text,status,attempts,"nextTryAt","leaseUntil","leaseToken","sessionId",reply,files,handoffs,"lastError","createdAt","updatedAt","deliveredAt")
         values ($1,$2,$3,$4,$4,'Yan','','你好','retry',1,$5,null,'','s-y',$6,'[]','[]','Telegram 429',$5,$5,null)`,
        [id, bindingId, `tg:${id}`, conv, Date.now() - 1000, reply],
      ),
    )
  const eventRow = async (id) =>
    (await withPg((c) => c.query('select status, "lastError" from channel_events where id = $1', [id]))).rows[0]
  const sentTo = (chat) =>
    telegram.seen.sent.find((s) => String(s.chat_id) === chat)
  const textOf = (s) => String(s?.text || s?.rich_message?.markdown || '')

  try {
    await waitHttp(`${gwBase}/health`, { child: gw, what: 'channel-queue gateway' })
    const reg = await createCompany(req, gwBase, {
      ownerEmail: 'owner@queue.test',
      ownerPassword: 'test-owner-queue',
      email: 'admin@queue.test',
      password: 'correct-horse',
      companyName: 'QueueCo',
      slug: 'queueco',
      seats: 2,
    })
    const adminTok = reg.token
    const ownerTok = reg.ownerToken
    const orgId = reg.company.id

    // 经接口绑一个，拿到一份真的密文（解出来是假 Telegram 认的那个 token）。
    const bound = await req(gwBase, 'POST', '/channels/telegram', { token: adminTok, body: { token: TG_TOKEN } })
    assert(bound.status === 201, `绑定 ${bound.status} ${bound.text}`)
    const cipher = (await withPg((c) => c.query('select "credentialCiphertext" from channel_bindings where id = $1', [bound.json.channel.id])))
      .rows[0].credentialCiphertext

    // 两台机器，都够新到让工人跑渠道那一轮。A 的工人挂了（没人来领），B 的好好的。
    const machineA = await pairMachine({ req, gwBase, ownerTok, orgId, managerPort: 18991 })
    const machineB = await pairMachine({ req, gwBase, ownerTok, orgId, managerPort: 18992 })
    assert(machineA.machineId !== machineB.machineId, '两次配对落到了同一台机器上')
    await withPg((c) => c.query('update machines set protocol = 10 where id = any($1)', [[machineA.machineId, machineB.machineId]]))

    const now = Date.now()
    const binding = async (id, accountId, botId, machineId, slot) => {
      await withPg(async (c) => {
        await c.query(
          `insert into channel_bindings (id,"companyId","accountId","botId",kind,status,"externalBotId","externalUsername","credentialCiphertext","webhookSecretHash","publicId","createdAt","updatedAt")
           values ($1,$2,$3,$4,'telegram','active',$5,'',$6,'',$7,$8,$8)`,
          [id, orgId, accountId, botId, `ext-${id}`, cipher, `pub-${id}`, now],
        )
        await c.query(
          `insert into seat_runtimes ("accountId","botId","companyId","linuxUser","seatId","machineId",slot,display,"vncPort","novncPort","botPort","vncPassword",status,"updatedAt")
           values ($1,$2,$3,$4,$5,$6,$7,$7,$8,$8,$8,'x',$9,$10)`,
          [accountId, botId, orgId, `sw-${id}`, `seat-${id}`, machineId, slot, 30000 + slot, 'ready', now],
        )
      })
    }
    await binding('bind-a', 'acct-a', 'bot-a', machineA.machineId, 91)
    await binding('bind-b', 'acct-b', 'bot-b', machineB.machineId, 92)

    // A 上堆着的活：STUCK 个会话，每个会话一条，都比下面 B 的那条早，而且早就过了「没人来领」的线。
    await withPg(async (c) => {
      for (let i = 0; i < STUCK; i++) {
        const at = now - 10 * 60_000 + i
        await c.query(
          `insert into channel_events (id,"bindingId","externalEventId","externalConversationId","remoteUserId","remoteDisplayName",title,text,status,attempts,"nextTryAt","leaseUntil","leaseToken","sessionId",reply,files,handoffs,"lastError","createdAt","updatedAt","deliveredAt")
           values ($1,'bind-a',$2,$3,$3,'Ann','','在吗','pending',0,$4,null,'',null,'','[]','[]',null,$4,$4,null)`,
          [`ev-a-${i}`, `tg:a-${i}`, `conv-a-${i}`, at],
        )
      }
      await c.query(
        `insert into channel_events (id,"bindingId","externalEventId","externalConversationId","remoteUserId","remoteDisplayName",title,text,status,attempts,"nextTryAt","leaseUntil","leaseToken","sessionId",reply,files,handoffs,"lastError","createdAt","updatedAt","deliveredAt")
         values ('ev-b-1','bind-b','tg:b-1','conv-b-1','conv-b-1','Bo','','帮我看看','pending',0,$1,null,'',null,'','[]','[]',null,$1,$1,null)`,
        [now],
      )
    })

    await test('工人：别的机器堆着的活，挤不掉这台机器自己的', async () => {
      const due = await req(gwBase, 'GET', '/worker/channels/events/due', { token: machineB.token })
      assert(due.status === 200, `due ${due.status} ${due.text}`)
      const ids = (due.json.jobs || []).map((j) => j.eventId)
      assert(ids.includes('ev-b-1'), `机器 B 该领到自己的那条，实际领到 ${JSON.stringify(ids)}`)
      assert(ids.every((id) => !String(id).startsWith('ev-a-')), `机器 B 不该领到 A 的活：${JSON.stringify(ids)}`)
      // A 的活原样还在，等 A 自己的工人。
      const a0 = await eventRow('ev-a-0')
      assert(a0.status === 'pending', `A 的活被动了：${JSON.stringify(a0)}`)
    })

    await test('Gateway 的扫描：归工人没人领的堆满十几个会话，只差投递的照样发出去', async () => {
      await retryEvent('ev-b-2', 'bind-b', 'conv-b-2', '重试的这条回复')
      let row = null
      for (let i = 0; i < 50; i++) {
        row = await eventRow('ev-b-2')
        if (row?.status === 'delivered') break
        await sleep(100)
      }
      assert(row?.status === 'delivered', `该投递出去，实际 ${JSON.stringify(row)}`)
      assert(textOf(sentTo('conv-b-2')).includes('重试的这条回复'), `假 Telegram 没收到：${JSON.stringify(telegram.seen.sent)}`)
    })

    await test('归工人却没人领的，照旧报到绑定上', async () => {
      let lastError = ''
      for (let i = 0; i < 50; i++) {
        lastError = (await withPg((c) => c.query('select "lastError" from channel_bindings where id = $1', ['bind-a']))).rows[0].lastError || ''
        if (lastError) break
        await sleep(100)
      }
      assert(lastError.includes('satuwork-worker'), `A 的绑定上该说清楚没人来领，实际 ${JSON.stringify(lastError)}`)
      const b = (await withPg((c) => c.query('select "lastError" from channel_bindings where id = $1', ['bind-b']))).rows[0].lastError
      assert(!String(b || '').includes('satuwork-worker'), `B 的工人在领活，不该被报：${b}`)
    })

    // ── 函数形态：没有分发器，靠 /cron/tick ─────────────────────────────
    gw.kill('SIGTERM')
    for (let i = 0; i < 100 && !gw._exited; i++) await sleep(100)
    fn = start('channel-queue-fn', ['--import', 'tsx', join(gwRoot, 'scripts/serve-serverless.mjs')], {
      cwd: gwRoot,
      env: { ...shared, CRON_SECRET, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(FN_PORT) },
    })
    await waitHttp(`${fnBase}/health`, { child: fn, what: 'channel-queue gateway (serverless)' })

    await test('函数形态：/cron/tick 把只差投递的重试发出去，不去碰还要跑一轮的', async () => {
      await retryEvent('ev-b-3', 'bind-b', 'conv-b-3', '函数形态的这条回复')
      const tick = await req(fnBase, 'GET', '/cron/tick', { token: CRON_SECRET, timeout: 60000 })
      assert(tick.status === 200, `cron ${tick.status} ${tick.text}`)
      // 这一拍返回时投递已经做完了：函数一回响应就冻住，等不到下一拍。
      const row = await eventRow('ev-b-3')
      assert(row?.status === 'delivered', `cron 这一拍该把它投递出去，实际 ${JSON.stringify(row)}`)
      assert(textOf(sentTo('conv-b-3')).includes('函数形态的这条回复'), `假 Telegram 没收到：${JSON.stringify(telegram.seen.sent)}`)
      // 还要跑一轮的（A 堆着的）函数形态跑不了，一条都不该碰。
      const a0 = await eventRow('ev-a-0')
      assert(a0.status === 'pending', `函数形态不该去跑一轮：${JSON.stringify(a0)}`)
    })
  } finally {
    fn?.kill('SIGTERM')
    if (!gw._exited) gw.kill('SIGTERM')
    await closeServer(telegram.server).catch(() => {})
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
