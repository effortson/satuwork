import { Service, type Context } from '@deepseek-ai/cordis'
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { satuworkHome } from '../home.ts'
import {
  SESSION_FORMAT_VERSION,
  type EventEnvelope,
  type ChannelSessionMeta,
  type SessionEvent,
  type SessionEventMap,
  type SessionOrigin,
} from './types.ts'

export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessions: SessionService
  }
  interface Events {
    /** 每追加一条事件后广播。UI、投影、遥测都从这里派生，而不是各自埋点。 */
    'session/event'(sessionId: string, event: SessionEvent): void
  }
}

export interface Config {
  /** JSONL 落盘目录。默认 `$SATUWORK_HOME/sessions`（见 src/home.ts）。 */
  root?: string
}

export interface CreateSession {
  botId: string
  origin?: SessionOrigin
  remoteId?: string
  title?: string
  channel?: ChannelSessionMeta
  /**
   * `task` = 一次委派开出来的子会话（docs/delegation.md）。默认 `main`。
   *
   * **除了 `main` 之外的都不是「这个人的对话」**：不进 list()、不上报会话索引、
   * 不会被 ensureSession 认领成长会话。判据一律写成「是不是 main」，不是「是不是
   * task」——老日志里还有已经下线的 `card` 卡片会话，
   * 照后者写的每一处都会静默地把它当成主会话。
   */
  kind?: 'main' | 'task'
  /**
   * 谁开的。**非 `main` 的都必须给。**
   *
   * 卡片会话没有开它的那次工具调用（是 Gateway 派过来的），所以 `sessionId` / `callId`
   * 留空，`taskId` 写卡号。
   */
  parent?: { sessionId: string; callId: string; taskId: string }
}

/** 内存里最多留多少条会话（见 SessionService.cache）。一条主会话加几十条委派够用。 */
const CACHE_MAX = Math.max(8, Math.trunc(Number(process.env.SATUWORK_SESSION_CACHE_MAX) || 64))

interface SessionState {
  id: string
  events: SessionEvent[]
  seq: number
  file: string
}

/**
 * 追加式会话日志。
 *
 * 唯一的写入口是 `append`：内存态、落盘、广播三件事在这里成为一件事，
 * 不可能出现「发了事件但没落盘」或「落了盘但 UI 不知道」。
 *
 * 读取一律走事件列表的派生——不维护第二份可变状态，因为那必然会跟日志漂移。
 */
export class SessionService extends Service {
  /**
   * 内存里的会话，按最近使用排（Map 的插入序；每次命中都挪到末尾）。
   *
   * 有上限：一台席位能跑几周、委派几千次，每条子会话的全部事件都常驻的话只涨不落。
   * 超了先淘汰非 main 的（委派子会话读完结论就没人再碰），再淘汰最久没用的主会话。
   * 淘汰只丢内存态，下次访问从盘上重读。
   *
   * **两种不淘汰**（见 evictable）：这个进程里还开着一轮的，和还有追加没写完的。前者
   * 重读时会被 healDanglingTurn 当成上个进程的残局补一条假 turn/end；后者重读拿到的
   * seq 比内存里已经发出去的小，下一条就撞号。
   */
  private cache = new Map<string, SessionState>()
  /**
   * 正在读盘的会话。两个请求同时碰一条还没缓存的会话时，必须共用同一次 load——
   * 否则两份 SessionState 各自记 seq，各自往同一个文件写，事件会互相盖掉。
   */
  private loading = new Map<string, Promise<SessionState>>()
  /**
   * 每条会话的追加队尾。追加一条接一条地排：拿号、进内存、落盘、广播做完才轮下一条，
   * 于是 seq、文件行序、广播顺序是同一个顺序。队里有东西的会话不淘汰。
   */
  private tails = new Map<string, Promise<unknown>>()
  /**
   * 这个进程里写过 turn/start、还没写 turn/end 的会话。
   *
   * 「悬着的 turn」只有不在这里的才是上个进程留下的——在这里的是正跑着的一轮（比如
   * 委派子会话卡在一条长命令或一次审批上），补 turn/end 等于替它宣布结束。
   */
  private openTurns = new Set<string>()
  private root: string
  /**
   * 旧会话没有 botId 时挂到这个 Bot。
   *
   * 选「挂到默认 Bot」而不是标只读：这是单机单席位，旧对话仍是这个人的工作，
   * 挂上去就能接着聊。只改根事件，不删 JSONL。
   */
  fallbackBotId = 'default'

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessions')
    this.root = config.root ?? satuworkHome('sessions')
  }

  async create(opts: CreateSession): Promise<string> {
    if (!opts.botId) throw new Error('sessions: 创建会话必须带 botId')
    if (opts.kind && opts.kind !== 'main' && !opts.parent) throw new Error('sessions: 非主会话必须带 parent')
    await mkdir(this.root, { recursive: true })
    /**
     * 主会话 `s-`、委派子会话 `t-`（老日志里还有看板卡那批 `c-`）。
     *
     * **只为运维时 `ls` 一眼分得开**，代码里不许拿它做判断——事实源是根事件的 `kind`
     * （见 session/types.ts）。两个判据并存的话，它们迟早会分叉。
     */
    const id = `${opts.kind === 'task' ? 't' : 's'}-${randomUUID()}`
    const state: SessionState = { id, events: [], seq: 0, file: join(this.root, `${id}.jsonl`) }
    this.remember(state)
    await this.append(id, 'session', {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: Date.now(),
      title: opts.title,
      botId: opts.botId,
      origin: opts.origin ?? 'local',
      ...(opts.remoteId ? { remoteId: opts.remoteId } : {}),
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.kind && opts.kind !== 'main' ? { kind: opts.kind, parent: opts.parent } : {}),
    })
    return id
  }

  /**
   * 追加一条事件。返回落定的信封，调用方拿得到 seq——同一个 turn 内的关联
   * （比如 tool/result 指回 tool/call）靠业务 id，不靠 seq，但诊断时 seq 有用。
   */
  async append<T extends keyof SessionEventMap>(
    sessionId: string,
    type: T,
    data: SessionEventMap[T],
  ): Promise<EventEnvelope<T>> {
    const prev = this.tails.get(sessionId)
    const run = (prev ? prev.then(() => this.load(sessionId)) : this.load(sessionId)).then((state) =>
      this.write(state, type, data),
    )
    // 队尾吞掉错误：前一条写失败不该连累后面的。自己是队尾时顺手摘掉，不留空条目。
    const tail = run.catch(() => {})
    this.tails.set(sessionId, tail)
    void tail.then(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId)
    })
    return run
  }

  /** 真正的写：调用方保证同一条会话上不并发（append 的队列，或者 read 里的收口）。 */
  private async write<T extends keyof SessionEventMap>(
    state: SessionState,
    type: T,
    data: SessionEventMap[T],
  ): Promise<EventEnvelope<T>> {
    const event = { seq: ++state.seq, time: Date.now(), type, data } as EventEnvelope<T>
    state.events.push(event as SessionEvent)
    if (type === 'turn/start') this.openTurns.add(state.id)
    else if (type === 'turn/end') this.openTurns.delete(state.id)
    // 先落盘再广播：监听者看到事件时，它已经是持久的。
    await appendFile(state.file, JSON.stringify(event) + '\n', 'utf8')
    this.ctx.emit('session/event', state.id, event as SessionEvent)
    return event
  }

  /** 会话的全部事件，按 seq 升序。`after` 用于增量拉取（SSE 断线重连）。 */
  async events(sessionId: string, after = 0): Promise<SessionEvent[]> {
    const state = await this.load(sessionId)
    return after ? state.events.filter((e) => e.seq > after) : state.events.slice()
  }

  /**
   * 会话列表，按创建时间倒序。标题取 session/title，没有就回落到根记录。
   *
   * **默认只有主会话。** 委派开出来的（`task`）和看板卡（`card`）都不是「这个人的
   * 对话」，而这个列表的每一个调用方都是在问那个问题：侧栏画什么、认领哪条长会话
   * （registry 的 ensureSession）、往控制面报哪些索引。混进去的后果最狠的一条是认领
   * ——列表按创建时间**倒序**，它们永远比主会话新，于是席位重装、名册行上的
   * sessionId 丢了的那一刻，`mine[0]` 认回来的是某次委派、或者昨天某张卡的现场。
   *
   * **判据是「是不是 main」，不是「是不是 task」。** 照后者写的话，第三个取值出现的
   * 那天它会被静默地当成主会话——而卡是天天在跑的。
   *
   * 要连它们一起看（调试、清理）传 `{ tasks: true }`。
   *
   * **不进缓存。** 没缓存的会话只读盘取摘要，不 load：目录里常有几百条委派子会话，
   * 侧栏每刷一次都整份 load 一遍的话，缓存会被整个冲掉——正跑着的会话也跟着被挤出去。
   */
  async list(opts: { tasks?: boolean } = {}): Promise<
    { id: string; title: string; createdAt: number; botId?: string; kind?: 'main' | 'task' | 'card'; channel?: ChannelSessionMeta }[]
  > {
    if (!existsSync(this.root)) return []
    const files = (await readdir(this.root)).filter((f) => f.endsWith('.jsonl'))
    const rows = await Promise.all(
      files.map(async (f) => {
        const id = f.replace(/\.jsonl$/, '')
        // 一条会话读不出来（格式版本太新、文件损坏）只跳过它自己，不让整张列表 reject
        // ——那样侧栏会一条都画不出来，包括那些好好的。
        let events: SessionEvent[]
        try {
          events = this.cache.get(id)?.events ?? (await this.peek(id))
        } catch (e) {
          this.ctx.logger?.warn?.(`sessions: 列表跳过 ${id}：${(e as Error).message}`)
          return null
        }
        const root = events.find((e) => e.type === 'session')
        if (!root) return null
        const titled = [...events].reverse().find((e) => e.type === 'session/title')
        const data = root.data as {
          title?: string
          createdAt: number
          botId?: string
          agentId?: string
          kind?: 'main' | 'task' | 'card'
          channel?: ChannelSessionMeta
        }
        if (data.kind && data.kind !== 'main' && !opts.tasks) return null
        return {
          id,
          title:
            (titled?.data as { title: string } | undefined)?.title ??
            data.title ??
            '新会话',
          createdAt: data.createdAt,
          // 没缓存的是没迁移过的原样，旧会话在这里按 load 的规则补 botId。
          botId: data.botId ?? data.agentId ?? this.fallbackBotId,
          ...(data.kind ? { kind: data.kind } : {}),
          ...(data.channel ? { channel: data.channel } : {}),
        }
      }),
    )
    return rows.filter((r): r is NonNullable<typeof r> => Boolean(r)).sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * 扫一遍目录，把旧格式根事件改成 v2。
   *
   * 走 load()：迁移和日常读取是同一条路，不会出现「启动迁过了、读的时候又判版本失败」。
   * 坏文件只记一笔，不删。
   */
  async migrateAll(fallbackBotId: string): Promise<void> {
    this.fallbackBotId = fallbackBotId
    if (!existsSync(this.root)) return
    const files = (await readdir(this.root)).filter((f) => f.endsWith('.jsonl'))
    for (const f of files) {
      const id = f.replace(/\.jsonl$/, '')
      try {
        await this.load(id)
      } catch (e) {
        this.ctx.logger?.warn?.(`sessions: 迁移 ${id} 失败：${(e as Error).message}`)
      }
    }
  }

  /**
   * 只读盘、不缓存、不迁移、不收口，给 list() 取摘要用。坏行跳过；格式太新照样抛，
   * 和 load 一样由调用方跳过这一条。
   */
  private async peek(sessionId: string): Promise<SessionEvent[]> {
    const raw = await readFile(join(this.root, `${sessionId}.jsonl`), 'utf8')
    const events: SessionEvent[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let event: SessionEvent
      try {
        event = JSON.parse(line) as SessionEvent
      } catch {
        continue
      }
      if (event.type === 'session') {
        const version = (event.data as { version: number }).version
        if (version > SESSION_FORMAT_VERSION) {
          throw new Error(`sessions: ${sessionId} 是格式 v${version}，当前是 v${SESSION_FORMAT_VERSION}，需要迁移`)
        }
      }
      events.push(event)
    }
    return events
  }

  /** 惰性从磁盘恢复。进程重启后第一次访问某会话会走这里。并发进来的共用同一次。 */
  private async load(sessionId: string): Promise<SessionState> {
    const cached = this.cache.get(sessionId)
    if (cached) {
      // 命中挪到末尾：淘汰从头开始挑，这样丢的是最久没碰的那条。
      this.cache.delete(sessionId)
      this.cache.set(sessionId, cached)
      return cached
    }
    const inflight = this.loading.get(sessionId)
    if (inflight) return inflight
    const run = this.read(sessionId).finally(() => this.loading.delete(sessionId))
    this.loading.set(sessionId, run)
    return run
  }

  private async read(sessionId: string): Promise<SessionState> {
    const file = join(this.root, `${sessionId}.jsonl`)
    if (!existsSync(file)) throw new Error(`sessions: 未知会话 ${sessionId}`)

    const events: SessionEvent[] = []
    let rewritten = false
    const raw = await readFile(file, 'utf8')
    const lines = raw.split('\n')
    /**
     * 坏行跳过，不让整个会话读不出来。
     *
     * 最常见的坏行是**尾行截断**：进程正写到一半被杀（换版、断电），最后一行只剩半截
     * JSON。原来这里 `JSON.parse` 一抛，这条会话从此打不开——列表也跟着整个 reject。
     * 跳过的那行记进 seq 水位（见下面 badSeq），下一条事件不会和它撞号；文件末尾没有
     * 换行时先补一个，否则下一次 append 会接在半截行后面，把新事件也一起写坏。
     */
    let badSeq = 0
    let skipped = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (!line.trim()) continue
      let event: SessionEvent
      try {
        event = JSON.parse(line) as SessionEvent
      } catch {
        skipped++
        const n = Number(/"seq"\s*:\s*(\d+)/.exec(line)?.[1])
        if (Number.isFinite(n) && n > badSeq) badSeq = n
        const tail = i === lines.length - 1 && !raw.endsWith('\n')
        this.ctx.logger?.warn?.(`sessions: ${sessionId} 第 ${i + 1} 行不是合法 JSON，跳过（${tail ? '尾行截断' : '中间坏行'}）`)
        continue
      }
      // 更新的版本拒绝，不要猜。旧版本就地迁到当前：补 botId / origin，不丢文件。
      if (event.type === 'session') {
        const data = event.data as SessionEventMap['session'] & { agentId?: string }
        if (data.version > SESSION_FORMAT_VERSION) {
          throw new Error(
            `sessions: ${sessionId} 是格式 v${data.version}，当前是 v${SESSION_FORMAT_VERSION}，需要迁移`,
          )
        }
        if (data.version < SESSION_FORMAT_VERSION || !data.botId) {
          const { agentId: legacyId, ...rest } = data as SessionEventMap['session'] & { agentId?: string }
          event.data = {
            ...rest,
            version: SESSION_FORMAT_VERSION,
            botId: data.botId ?? legacyId ?? this.fallbackBotId,
            origin: data.origin ?? 'local',
          }
          rewritten = true
        }
      }
      events.push(event)
    }

    // 迁移要改的只有根事件，但 JSONL 只能整份重写。**先写临时文件再 rename**：
    // rename 在同一个目录里是原子的，写到一半断电也只会留下一个 .tmp，原文件仍然完整。
    if (rewritten) {
      const tmp = `${file}.${randomUUID()}.tmp`
      await writeFile(tmp, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
      await rename(tmp, file)
    } else if (skipped && raw && !raw.endsWith('\n')) {
      // 尾行截断且没重写：补个换行，让下一条 append 从新的一行开始（理由见上面）。
      await appendFile(file, '\n', 'utf8')
    }

    const state: SessionState = {
      id: sessionId,
      events,
      // 取**最大**的 seq，不是最后一行的。并发追加会让物理行序和 seq 序不一致（两个
      // writer 各自拿号、写入顺序由文件锁决定），迁移重写也可能改变行序。按最后一行
      // 恢复会把游标退回到一个已经用过的号上，下一条事件的 seq 就和历史撞号——SSE 的
      // ?after=N 游标从此认不出新事件。
      // 跳过的坏行里能认出 seq 的也计入水位：那个号已经在磁盘上出现过。
      seq: events.reduce((max, e) => {
        const n = Number((e as { seq?: unknown }).seq)
        return Number.isFinite(n) && n > max ? n : max
      }, badSeq),
      file,
    }
    // 先收口再进缓存：收口期间别的 load 还在等 loading 里这同一个 promise，不会拿到
    // 一份正在写的 state 去并发拿号。
    await this.healDanglingTurn(state)
    this.remember(state)
    return state
  }

  /** 还开着一轮、或者追加队里有东西的，不能丢（理由见 cache 上的说明）。 */
  private evictable(id: string): boolean {
    return !this.openTurns.has(id) && !this.tails.has(id)
  }

  /** 进缓存，超上限就淘汰（规则见 cache 上的说明）。刚放进去的这条不会被自己淘汰掉。 */
  private remember(state: SessionState): void {
    this.cache.delete(state.id)
    this.cache.set(state.id, state)
    const isMain = (s: SessionState) => {
      const root = s.events.find((e) => e.type === 'session')
      const kind = (root?.data as { kind?: string } | undefined)?.kind
      return !kind || kind === 'main'
    }
    while (this.cache.size > CACHE_MAX) {
      let victim: string | undefined
      for (const [id, s] of this.cache) {
        if (id === state.id || !this.evictable(id)) continue
        if (!isMain(s)) {
          victim = id
          break
        }
        victim ??= id
      }
      if (!victim) return
      this.cache.delete(victim)
    }
  }

  /**
   * 把上一个进程没写完的 turn 收口。
   *
   * `turn/end` 是在 `finally` 里写的，所以正常路径（成功、模型报错、用户中止）都收得
   * 住。收不住的只有一种：进程本身没了——崩溃、机器重启，以及**每一次「重新部署」**。
   * 那条 `turn/start` 于是永远悬在日志末尾，谁也不会再去关它。
   *
   * 后果不只是难看：界面拿「最后一条 turn/start 之后有没有 turn/end」判断这轮还在不在
   * 跑，一条悬着的记录会让会话永远显示「正在处理」——而那边其实什么都没在跑，等多久
   * 都不会变。用量归集也按 turn/end 触发，同样会漏掉这一轮。
   *
   * 从磁盘恢复的这一刻正是唯一能确定「那个进程已经死了」的时机：它写的东西我们读到
   * 了，而它自己不在了。所以在这里补一条 reason: 'error' 的 turn/end。
   *
   * **这个进程自己开着的那一轮除外**（openTurns）：它还在跑，只是会话被挤出了缓存。
   * 正常情况下开着一轮的会话不会被淘汰，这里是兜底。
   */
  private async healDanglingTurn(state: SessionState): Promise<void> {
    let lastStart = -1
    let lastEnd = -1
    for (let i = state.events.length - 1; i >= 0; i--) {
      const type = state.events[i].type
      if (lastStart < 0 && type === 'turn/start') lastStart = i
      if (lastEnd < 0 && type === 'turn/end') lastEnd = i
      if (lastStart >= 0 && lastEnd >= 0) break
    }
    if (lastStart < 0 || lastStart < lastEnd) return
    if (this.openTurns.has(state.id)) return
    const turn = Number((state.events[lastStart].data as { turn?: unknown }).turn) || 0
    this.ctx.logger?.warn?.(`sessions: ${state.id} 第 ${turn} 轮没有收口（上个进程没能写完），补一条 turn/end`)
    // 直接 write，不走 append：这里是 load 里面，append 的队列正等着这次 load。
    await this.write(state, 'turn/end', { turn, reason: 'error' })
  }
}

export const name = 'satu-sessions'

export function apply(ctx: Context, config: Config = {}) {
  ctx.plugin(SessionService, config)
}
