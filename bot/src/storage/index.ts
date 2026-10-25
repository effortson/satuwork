import { Service, type Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { satuworkHome } from '../home.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    storage: StorageService
  }
  interface Events {
    /** 某个设置项写入之后。改了模型、改了提示词的插件靠这个自我更新。 */
    'settings/change'(namespace: string, key: string, value: unknown): void
  }
}

export interface Config {
  /** 数据库路径。默认 `$SATUWORK_HOME/satuwork.db`。 */
  path?: string
}

/** 文档集合：一张表存一类东西，值是 JSON。 */
export interface Collection<T> {
  get(id: string): T | undefined
  put(id: string, value: T): void
  delete(id: string): boolean
  list(): { id: string; value: T; updatedAt: number }[]
}

/**
 * 运行时配置与非会话数据。
 *
 * 用 Node 24 内置的 `node:sqlite`——零依赖、不需要编译原生模块，装机器上就有。
 *
 * **会话日志不在这里**：那是追加式 JSONL，可 grep、可直接拷走备份、格式由我们自己
 * 定版本。这里放的是需要被**查询**的东西：设置、Agent 定义、定时任务、连接器。
 * 两种数据的访问形态不一样，硬塞进一处只会两边都别扭。
 */
export class StorageService extends Service {
  private db: DatabaseSync

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'storage')
    const path = config.path ?? satuworkHome('satuwork.db')
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    // WAL：读不挡写。SSE 长连接会一直读，写入不该被它拖住。
    this.db.exec('pragma journal_mode = WAL')
    this.db.exec(`
      create table if not exists settings (
        namespace text not null,
        key       text not null,
        value     text not null,
        updatedAt integer not null,
        primary key (namespace, key)
      );
      create table if not exists documents (
        collection text    not null,
        id         text    not null,
        value      text    not null,
        updatedAt  integer not null,
        primary key (collection, id)
      );
    `)
    // 服务卸载时关掉句柄——WAL 文件不收尾会留下 -wal/-shm。
    ctx.effect(() => () => this.db.close())
  }

  // ── 运行时配置 ────────────────────────────────────────────────────────
  //
  // namespace 按插件划分（'agent'、'llm'…），避免一个扁平命名空间里撞名。

  getSetting<T>(namespace: string, key: string): T | undefined {
    const row = this.db
      .prepare('select value from settings where namespace = ? and key = ?')
      .get(namespace, key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : undefined
  }

  /** 写入并广播。**先落库再广播**，监听者看到通知时值已经是持久的。 */
  setSetting(namespace: string, key: string, value: unknown): void {
    this.db
      .prepare(
        'insert into settings values (?,?,?,?) on conflict(namespace,key) do update set value=excluded.value, updatedAt=excluded.updatedAt',
      )
      .run(namespace, key, JSON.stringify(value), Date.now())
    this.ctx.emit('settings/change', namespace, key, value)
  }

  // ── 文档 ──────────────────────────────────────────────────────────────

  collection<T>(name: string): Collection<T> {
    const db = this.db
    return {
      get(id) {
        const row = db
          .prepare('select value from documents where collection = ? and id = ?')
          .get(name, id) as { value: string } | undefined
        return row ? (JSON.parse(row.value) as T) : undefined
      },
      put(id, value) {
        db.prepare(
          'insert into documents values (?,?,?,?) on conflict(collection,id) do update set value=excluded.value, updatedAt=excluded.updatedAt',
        ).run(name, id, JSON.stringify(value), Date.now())
      },
      delete(id) {
        return (
          db.prepare('delete from documents where collection = ? and id = ?').run(name, id)
            .changes > 0
        )
      },
      list() {
        const rows = db
          .prepare('select id, value, updatedAt from documents where collection = ? order by updatedAt desc')
          .all(name) as { id: string; value: string; updatedAt: number }[]
        return rows.map((r) => ({ id: r.id, value: JSON.parse(r.value) as T, updatedAt: r.updatedAt }))
      },
    }
  }
}

export const name = 'satu-storage'

export function apply(ctx: Context, config: Config = {}) {
  ctx.plugin(StorageService, config)
}
