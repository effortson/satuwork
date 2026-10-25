/**
 * 类型、常量和行解析都在 `db/` 底下；这里原样再导出，调用点仍然
 * `import { type Account, type Db } from './db.ts'`，一行都不用改。
 */
export * from './db/types.ts'
export * from './db/rows.ts'
export { type DbOptions, SchemaBusyError, databaseUrl, migrateDatabaseUrl, safeSchema } from './db/core.ts'
export { MAX_BOT_DELETION_ATTEMPTS } from './db/sessions.ts'
export { RoutineBusyError } from './db/routines.ts'
import { HandoffsDb } from './db/handoffs.ts'

/**
 * Gateway 自己的库（PostgreSQL）。跟 Bot 的 satuwork.db 不是同一份——
 * 聊天正文永远不该出现在这里。
 *
 * 驼峰列名一律加引号：PG 不加引号会折成小写，而 `select *` 的结果直接喂给 db/rows.ts 那些
 * mapper。加了引号，写漏的那一刻 PG 就报 column does not exist，不会静默变 undefined。
 *
 * **对外只有这一个类。** 方法按领域分在 db/ 底下，一层层 extends 成一条链（后面的可以调
 * 前面的，反过来不行）：
 *
 *   DbCore       db/core.ts
 *   OrgDb        db/org.ts
 *   UsageDb      db/usage.ts
 *   KnowledgeDb  db/knowledge.ts
 *   PlansDb      db/plans.ts
 *   MachinesDb   db/machines.ts
 *   SeatsDb      db/seats.ts
 *   CatalogDb    db/catalog.ts
 *   SettingsDb   db/settings.ts
 *   ChannelsDb   db/channels.ts
 *   SessionsDb   db/sessions.ts
 *   RoutinesDb   db/routines.ts
 *   HandoffsDb   db/handoffs.ts
 *
 * 调用点照旧 `import { Db } from './db.ts'`、`new Db({ url, schema })`，不用知道这条链。
 * 加方法时放进它所属的那个领域文件；要调后面那层的方法，说明它该往后挪。
 */
export class Db extends HandoffsDb {}
