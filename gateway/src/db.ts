/**
 * 类型、常量和行解析都在 `db/` 底下；这里原样再导出，调用点仍然
 * `import { type Account, type Db } from './db.ts'`，一行都不用改。
 */
export * from './db/types.ts'
export * from './db/rows.ts'
export { type DbOptions, SchemaBusyError, databaseUrl, migrateDatabaseUrl, safeSchema } from './db/core.ts'
export { MAX_BOT_DELETION_ATTEMPTS } from './db/sessions.ts'
export { RoutineBusyError } from './db/routines.ts'
import { DbCore } from './db/core.ts'
import { OrgDb } from './db/org.ts'
import { UsageDb } from './db/usage.ts'
import { KnowledgeDb } from './db/knowledge.ts'
import { KnowledgeVectorDb } from './db/knowledge-vector.ts'
import { PlansDb } from './db/plans.ts'
import { MachinesDb } from './db/machines.ts'
import { SeatsDb } from './db/seats.ts'
import { CatalogDb } from './db/catalog.ts'
import { SettingsDb } from './db/settings.ts'
import { ChannelsDb } from './db/channels.ts'
import { SessionsDb } from './db/sessions.ts'
import { RoutinesDb } from './db/routines.ts'
import { HandoffsDb } from './db/handoffs.ts'
import { NotificationsDb } from './db/notifications.ts'

/**
 * Gateway 自己的库（PostgreSQL）。跟 Bot 的 satuwork.db 不是同一份——
 * 聊天正文永远不该出现在这里。
 *
 * 驼峰列名一律加引号：PG 不加引号会折成小写，而 `select *` 的结果直接喂给 db/rows.ts 那些
 * mapper。加了引号，写漏的那一刻 PG 就报 column does not exist，不会静默变 undefined。
 *
 * **对外只有这一个类。** 连接、事务、查询原语在 db/core.ts（DbCore）；方法按领域分在 db/ 底下
 * 各一个类，**都只 extends DbCore、互不依赖**，在这里拼到 Db 上：
 *
 *   OrgDb        db/org.ts        公司、账号、席位密钥、分组、邀请
 *   UsageDb      db/usage.ts      模型/网页调用流水、用量汇总、连接器、账本
 *   KnowledgeDb  db/knowledge.ts  知识库
 *   PlansDb      db/plans.ts      套餐、价目、订单、充值、账单
 *   MachinesDb   db/machines.ts   机器、负载归档、配对码、登录节流、推送
 *   SeatsDb      db/seats.ts      实例、席位运行态与部署排队、发布包
 *   CatalogDb    db/catalog.ts    目录、侧栏分类、主 Bot、派活
 *   SettingsDb   db/settings.ts   平台密钥、审计、公司/平台设置、模型角色
 *   ChannelsDb   db/channels.ts   外部渠道
 *   SessionsDb   db/sessions.ts   会话索引、自动对话审计、Bot 删除
 *   RoutinesDb   db/routines.ts   长期记忆、日常任务
 *   HandoffsDb   db/handoffs.ts   转人工交接单
 *
 * 调用点照旧 `import { Db } from './db.ts'`、`new Db({ url, schema })`，不用知道这些。
 * 加方法时放进它所属的那个领域文件；要调别的领域，写 `this.db.xxx()`（见 DbCore.db）。
 */
export class Db extends DbCore {}
export interface Db
  extends OrgDb, UsageDb, KnowledgeDb, KnowledgeVectorDb, PlansDb, MachinesDb, SeatsDb, CatalogDb,
    SettingsDb, ChannelsDb, SessionsDb, RoutinesDb, HandoffsDb, NotificationsDb {}

/**
 * 把各领域的方法挂到 Db.prototype 上。**撞名直接炸**：两个领域各写了一个同名方法，后挂的
 * 会悄悄盖掉先挂的——宁可启动时就报出来。
 */
for (const domain of [OrgDb, UsageDb, KnowledgeDb, KnowledgeVectorDb, PlansDb, MachinesDb, SeatsDb, CatalogDb, SettingsDb, ChannelsDb, SessionsDb, RoutinesDb, HandoffsDb, NotificationsDb]) {
  for (const name of Object.getOwnPropertyNames(domain.prototype)) {
    if (name === 'constructor') continue
    if (Object.prototype.hasOwnProperty.call(Db.prototype, name)) {
      throw new Error(`db: ${domain.name}.${name} 和别的领域撞名了`)
    }
    Object.defineProperty(Db.prototype, name, Object.getOwnPropertyDescriptor(domain.prototype, name)!)
  }
}
