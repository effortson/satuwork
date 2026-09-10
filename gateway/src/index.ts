import { mkdirSync } from 'node:fs'
import { Db, SchemaBusyError, databaseUrl } from './db.ts'
import { hashPassword, loadChannelKey, loadKeys } from './crypto.ts'
import { Router, listen } from './http.ts'
import { gatewayHome } from './home.ts'
import { attach } from './routes.ts'
import { attachDesktopUpgrade } from './desktop.ts'
import { startRoutineScheduler } from './routines.ts'
import { startChannelDispatcher } from './channels.ts'

/**
 * Satuwork Gateway。控制面：公司、账号、套餐、席位、目录、JWT。
 *
 * 聊天不进这个进程。数据在 PostgreSQL；磁盘上只留 JWT/渠道包裹密钥和 Bot 发布包——
 * 这些重启不能变，也不适合塞进库里。
 */
const home = gatewayHome()
mkdirSync(home, { recursive: true })
const url = databaseUrl()
// 连接串里有口令，日志只留 host/库名。
const shown = url.replace(/\/\/[^@]*@/, '//')
console.log(`satuwork-gateway: 数据目录 ${home}${process.env.SATUWORK_GATEWAY_HOME ? '（来自 $SATUWORK_GATEWAY_HOME）' : ''}`)
console.log(`satuwork-gateway: 数据库 ${shown}${process.env.GATEWAY_PG_SCHEMA ? `（schema ${process.env.GATEWAY_PG_SCHEMA}）` : ''}`)

const db = new Db({ url })
/**
 * 迁移在对外服务**之前**跑完。
 *
 * 日志里要说清楚跑了什么：升级线上库时，「这次动了哪几条」是出事之后唯一能回溯的
 * 线索。一条都没跑就说一声「已是最新」，别静默——静默的时候人分不清「不用升」和
 * 「代码没带上新迁移」。
 */
let migrated
try {
  migrated = await db.init()
} catch (e) {
  /**
   * 迁移失败时**先说清楚库停在哪儿**，再把错抛出去。
   *
   * 这是运维当场最想知道的一件事：升级挂了，库现在是升过的还是没升过的？回滚代码
   * 安不安全？只打一条报错的话，人得自己连进库去 `select * from schema_migrations`，
   * 而那时候进程正在起停循环里刷屏。
   */
  // 「schema 被别人占着」不是迁移失败：库一个字都没动，打「库停在哪一号」只会
  // 把人往迁移那边引。那条错自己已经说清了该干什么。
  const state = e instanceof SchemaBusyError ? null : await db.migrations().catch(() => null)
  if (state) {
    console.error(
      `satuwork-gateway: 迁移失败。库停在 ${state.current ?? '（一条都没跑过）'}，` +
        `代码最新是 ${state.latest ?? '无'}，还差 ${state.pending.length ? state.pending.join(', ') : '无'}`,
    )
  }
  throw e
}
if (migrated.applied.length) {
  console.log(`satuwork-gateway: 已应用 ${migrated.applied.length} 条迁移：${migrated.applied.join(', ')}`)
} else {
  console.log(`satuwork-gateway: 数据库已是最新（${migrated.current ?? '空'}）`)
}

/**
 * 可选的自动播种。**没有它也能起**：一个 owner 都没有时，打开页面就是「创建系统
 * 管理员」那一屏。这条留给自动化（e2e、容器编排）在无人值守时把第一个人写进去。
 */
async function seedOwner() {
  if (process.env.GATEWAY_SEED_OWNER === '0') return
  if ((await db.owners()).length) return
  const password = process.env.GATEWAY_OWNER_PASSWORD
  if (!password) {
    console.log('satuwork-gateway: 还没有系统管理员，打开首页按提示创建')
    return
  }
  const email = (process.env.GATEWAY_OWNER_EMAIL || 'owner@satuwork.test').trim().toLowerCase()
  const passwordHash = await hashPassword(password)
  await db.insertAccount({ companyId: null, email, passwordHash, role: 'owner' })
  console.log(`satuwork-gateway: 已写入系统管理员 ${email}`)
}

async function liftCompanyData() {
  const lifted = await db.liftCompanyDataToPlatform()
  if (lifted.settings) console.log('satuwork-gateway: 已把公司日常/utility 提升为平台设置')
  for (const provider of lifted.providers) {
    console.log(`satuwork-gateway: 已把供应商 ${provider} 提升为平台密钥`)
  }
}

await seedOwner()
await liftCompanyData()

// 公司的订阅是订单算出来的：起来时对一遍，把到期没人碰的、以及旧规则（当时未付款也写
// 订阅）留下的脏值收干净。
const resynced = await db.syncAllPlansFromOrders()
if (resynced) console.log(`satuwork-gateway: 已按订单重算 ${resynced} 家公司的订阅`)

/**
 * 最后一道兜底：**一条请求处理不了，不该把整台服务带走。**
 *
 * Node 从 15 起，没人接的 Promise rejection 默认等同于未捕获异常——进程直接退出。
 * 这台服务上到处是 `void doSomething()`（反代、升级、上报、定时器），任何一条路上漏
 * 掉一个 `.catch` 都会变成「一条请求打停一个进程」。真出过：`Host: [` 这种畸形头让
 * Router 里的 `new URL` 抛在 try 外面，一条不需要登录的 TCP 请求就能反复把它打停。
 * 那处已经修好，但下一处不会自己不出现。
 *
 * 所以这里**只记不退**：打一条带栈的日志，让服务继续。真正坏掉的状态（库连不上、
 * 端口没了）会在各自的路径上以别的方式暴露出来，而不是靠进程自杀来告诉运维。
 *
 * 挂在最前面：它要覆盖到下面每一行的启动过程。
 */
process.on('unhandledRejection', (reason) => {
  const e = reason as Error
  console.error(`satuwork-gateway: 未处理的 rejection ${e?.stack ?? String(reason)}`)
})
process.on('uncaughtException', (e) => {
  console.error(`satuwork-gateway: 未捕获异常 ${e.stack ?? e.message}`)
})

const keys = loadKeys(home)
const channelKey = loadChannelKey(home)
const router = new Router()
attach(router, db, keys, channelKey)
const server = listen(router)
// 桌面的画面走 WebSocket，而升级请求不进 Router——它是 server 上的一个事件。
attachDesktopUpgrade(server, db, keys)
/**
 * 日常任务的调度器。**这是这个进程里唯一一个自己会动的定时器**，所以它挂在这儿而
 * 不是藏在某组路由里：停机时要有人明确地把它和它等着的那几条流一起掐掉。
 */
const stopRoutines = startRoutineScheduler(db)
const stopChannels = startChannelDispatcher(db, channelKey, keys)

let closing = false
/**
 * 收工。**光 `server.close()` 是关不掉的。**
 *
 * 它只做两件事：停止接受新连接、等**已有的**连接自己结束。而这台服务上挂着的恰恰
 * 都是不会自己结束的东西——对话的 SSE、桌面的 WebSocket、浏览器的 keep-alive。于是
 * 进程停在一个最坏的状态：端口已经不听了（谁来都是 connection refused），进程却还
 * 活着不退出。人在终端里按了 Ctrl-C，看着它不动，再按一次——上面那句 `if (closing)
 * return` 把第二下也吃掉了，只剩 kill -9。线上遇到过一次，界面全挂而进程列表里一切
 * 正常。
 *
 * 所以：连接**主动掐掉**，第二次按就立刻走，再加一道超时兜底（pg 池、定时器这些
 * 还吊着事件循环时，也不能无限期挂着）。
 */
function shutdown() {
  if (closing) {
    // 按第二下的人已经表达过一次「现在就停」，别再让他等。
    process.exit(1)
  }
  closing = true
  stopRoutines()
  stopChannels()
  server.close(() => {
    void db.close()
  })
  server.closeAllConnections?.()
  setTimeout(() => process.exit(0), 3000).unref?.()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
