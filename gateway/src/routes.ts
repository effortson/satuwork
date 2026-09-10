import { desktopIntercept } from './desktop.ts'
import { createLlm } from './llm.ts'
import { createMeter } from './lib/meter.ts'
import type { Db } from './db.ts'
import type { JwtKeys } from './crypto.ts'
import type { Router } from './http.ts'
import { attachV1 } from './v1.ts'
import type { RouteCtx } from './routes/ctx.ts'
import { attachAuth } from './routes/auth.ts'
import { attachPlatform } from './routes/platform.ts'
import { attachPlatformOrgs } from './routes/platform-orgs.ts'
import { attachMachines } from './routes/machines.ts'
import { attachCompany } from './routes/company.ts'
import { attachRuntime } from './routes/runtime.ts'
import { attachHandoffs } from './routes/handoffs.ts'
import { attachRoutines } from './routes/routines.ts'
import { attachCatalog } from './routes/catalog.ts'
import { attachConnectors } from './routes/connectors.ts'
import { attachConnectorMcp } from './routes/mcp.ts'
import { attachBotTemplate } from './routes/bot-template.ts'
import { attachSessions } from './routes/sessions.ts'
import { attachCharges } from './routes/charges.ts'
import { attachInternal } from './routes/internal.ts'
import { attachChannels } from './routes/channels.ts'
import { attachWorker } from './routes/worker.ts'

/**
 * 把控制面的路由挂上去。
 *
 * **这个文件只做组装。** 它以前是 5700 行：前 1900 行是各种帮手，后面 3600 行是一个
 * 叫 `attach` 的函数，里面挂着 170 条路由，`db` / `keys` / `llm` 靠闭包捕获，于是任何
 * 一条都拆不出去——平台账单的改动和聊天反代的改动会在同一个文件里冲突。
 *
 * 现在帮手在 `lib/`（按主题分七个文件），路由在 `routes/`（按边界分九组），每组收一个
 * 显式的 `RouteCtx`。
 *
 * **注册顺序有意义。** 路由器按段精确匹配、先注册的先中，所以段数相同、更具体的路径
 * 要排在带参数的前面（`/orgs/:id/bots/options` 必须在 `/orgs/:id/bots/:botId` 之前）。
 * 那类相邻关系都在各自的模块里，跨模块之间段数不同、互不相抢。
 */
export function attach(router: Router, db: Db, keys: JwtKeys, channelKey: Buffer) {
  // 桌面反代。`/desktop/:seatId/*` → 管家的 noVNC。注册成拦截器而不是路由：它要拿
  // 原始 req 当流用，不能让路由器先把 body 读掉，路径也是通配的。
  router.intercept(desktopIntercept(db, keys))

  const llm = createLlm(db)
  const ctx: RouteCtx = { db, keys, channelKey, llm, meter: createMeter(db) }
  attachV1(router, db, keys, llm, ctx.meter)

  attachAuth(router, ctx)
  attachPlatform(router, ctx)
  attachPlatformOrgs(router, ctx)
  attachMachines(router, ctx)
  attachCompany(router, ctx)
  attachRuntime(router, ctx)
  attachHandoffs(router, ctx)
  attachRoutines(router, ctx)
  attachWorker(router, ctx)
  attachChannels(router, ctx)
  attachCatalog(router, ctx)
  attachConnectors(router, ctx)
  attachConnectorMcp(router, ctx)
  attachBotTemplate(router, ctx)
  attachSessions(router, ctx)
  attachCharges(router, ctx)
  attachInternal(router, ctx)
}
