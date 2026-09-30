import { Service, type Context } from '@deepseek-ai/cordis'
import type { Collection } from '../storage/index.ts'
import type { SessionOrigin } from '../session/types.ts'
import { gatewayUrl } from '../llm/gateway.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    roster: AgentRegistry
  }
}

/** 本机 Bot。origin: local 是自建；company / global 是从 Gateway 钉下来的。 */
export interface BotRecord {
  id: string
  name: string
  /** 侧栏下一行的短描述。 */
  description?: string
  /** 系统提示词。空则回落到全局 agent.system。 */
  prompt?: string
  icon: string
  /** 发消息用这一对，不是进程全局默认。 */
  provider: string
  model: string
  enabled: boolean
  origin: SessionOrigin
  remoteId?: string
  /** 这个 Bot 的长会话。打开 /a/:id 复用，不每次新建。 */
  sessionId?: string
  /** 挂上的 Skill / MCP 目录 id。公司 Bot 从 Gateway 同步下来。 */
  skills?: string[]
  mcps?: string[]
  /**
   * 公司模版上的行为边界。**只存开关**，标题和说明留在界面那边（见
   * gateway/src/lib/catalog.ts 的 BOT_GUARD_IDS）。
   *
   * 没有这个字段（老 Gateway、或者本机自建的 Bot）时按**全开**算，不是全关：
   * 降级成「一条都不拦」等于让一次版本回退悄悄拆掉全公司的边界。
   */
  guards?: Record<string, boolean>
  /**
   * 浏览器能力。**缺字段按关算**，和 guards 那条正好相反——它不是一道边界，是一把
   * 握着员工登录态的工具。Gateway 那边出厂已经是开着的（而且一直明写着下发），所以
   * 缺字段只剩「本机自建、没有模版」和「目录里读坏了」两种，都该往不给的方向走。
   */
  browser?: BotBrowser
  /**
   * 席位桌面能力（`desktop_*` 进不进工具表）。**缺字段按开算**，同 selfSkills：模版上
   * 它默认就是开的，「老 Gateway 没发」的正确读法是「这家公司没关过它」。窗口里跑的
   * 命令和 terminal 走同一套拦截，给错了方向的代价只是桌面上多开一个窗口。
   */
  desktop?: BotDesktop
  /**
   * 让它自己记 Skill（`skill_manage` 进不进工具表）。**缺字段按开算**。
   *
   * 和 browser 那条相反：老 Gateway 不发这个字段时，正确的读法是「这家公司没关过它」
   * ——模版上它默认就是开的（gateway/src/lib/catalog.ts 的 defaultBotTemplate）。
   */
  selfSkills?: boolean
  /**
   * 记忆策略。**缺字段按 Gateway 的出厂默认算**（见 memoryOf），不按关算——
   * 「目录里这个字段暂时没了」表现成记忆被静静关掉的话，症状是模型突然什么都不记了，
   * 而每一处看起来都对。
   */
  memory?: BotMemory
  /** 什么情况下该转人工。模版上的一段自由文本，进系统提示词，也是硬触发的说明。 */
  escalate?: string
  /** 这份底座是模版的第几版。排错时回答「这台跟上了没有」。 */
  templateVersion?: number
  createdAt: number
}

/**
 * 浏览器能力。和 Gateway 的 BotBrowser 是同一个形状（gateway/src/lib/catalog.ts），
 * 改一边就要改另一边——两个包各自打包，中间没有共享类型。
 */
export interface BotBrowser {
  on: boolean
  /** 裸域名，匹配含子域。空 = 除硬黑名单外全拦，不是全放。 */
  sites: string[]
}

/** 认不出来时的值：关着，一条站点都没有。Gateway 的出厂值（开、`*.*`）不在这里——见 browserOf。 */
export const DEFAULT_BROWSER: BotBrowser = { on: false, sites: [] }

/** 席位桌面能力。和 Gateway 的 BotDesktop 是同一个形状（gateway/src/lib/catalog.ts）。 */
export interface BotDesktop {
  on: boolean
}

/** 这个 Bot 能不能在席位桌面上开窗口。缺字段、认不出来都按开算（见 BotRecord.desktop）。 */
export function desktopOf(bot: { desktop?: BotDesktop } | undefined): BotDesktop {
  const raw = bot?.desktop
  return { on: !(raw && typeof raw === 'object' && raw.on === false) }
}

/**
 * 记忆策略。和 Gateway 的 `BotMemory` 是同一个形状（gateway/src/lib/catalog.ts），
 * 改一边就要改另一边——两个包各自打包，中间没有共享类型。
 *
 * 席位只用得上其中三样：`on`（两把工具进不进表）、`cap` / `scope` / `kinds`（注入时
 * 挑哪几条）、`pii` / `confirm`（写入前扫不扫、拦不拦）。`ttl` 是 Gateway 算到期时间
 * 用的，这边不碰——**算两遍就会分叉**。
 */
export interface BotMemory {
  on: boolean
  scope: string
  kinds: string[]
  ttl: string
  cap: number
  confirm: boolean
  pii: boolean
}

/**
 * 这个 Bot 的浏览器能力。**认不出来一律按关算。**
 *
 * `guards` 那边缺字段按全开（宁可多拦），这边缺字段按关（宁可不给）——两条都是往严了
 * 走，只是「严」在两件事上指向相反的默认值。
 */
export function browserOf(bot: { browser?: BotBrowser } | undefined): BotBrowser {
  const raw = bot?.browser
  if (!raw || typeof raw !== 'object' || raw.on !== true) return { ...DEFAULT_BROWSER, sites: [] }
  const sites = Array.isArray(raw.sites) ? raw.sites.filter((s): s is string => typeof s === 'string' && !!s.trim()) : []
  return { on: true, sites: sites.map((s) => s.trim().toLowerCase()) }
}

/** 行为边界的出厂值：三条全开。和 Gateway 的 DEFAULT_BOT_GUARDS 是同一套键。 */
export const DEFAULT_GUARDS: Record<string, boolean> = { 'high-risk': true, pii: true, 'no-external': true }

/** 这个 Bot 的行为边界。缺字段一律按开算——见 BotRecord.guards 上的说明。 */
export function guardsOf(bot: { guards?: Record<string, boolean> } | undefined): Record<string, boolean> {
  const raw = bot?.guards
  const out: Record<string, boolean> = { ...DEFAULT_GUARDS }
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(out)) {
      if (typeof raw[key] === 'boolean') out[key] = raw[key]
    }
  }
  return out
}

/**
 * 记忆策略的出厂值。**和 Gateway 的 `DEFAULT_BOT_MEMORY` 是同一套键、同一组默认。**
 *
 * 缺字段一律按「Gateway 那边的默认」算，不按最严算——这份东西的缺字段几乎只出现在
 * 「老 Gateway 还没发这个字段」那一种情形，而那时它的真实状态就是出厂默认。
 */
export const DEFAULT_MEMORY: BotMemory = {
  on: true,
  scope: '所属分组',
  kinds: ['偏好', '事实'],
  ttl: '90 天',
  cap: 20,
  confirm: true,
  pii: true,
}

/**
 * 这个 Bot 的记忆策略。
 *
 * 同 `guardsOf`：**缺字段沿用默认，不当成「关掉了」**。一次「目录里这个字段暂时没了」
 * 表现成记忆被静静关掉的话，症状是模型突然什么都不记了，而每一处看起来都对。
 */
export function memoryOf(bot: { memory?: Partial<BotMemory> } | undefined): BotMemory {
  const raw = bot?.memory
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_MEMORY, kinds: [...DEFAULT_MEMORY.kinds] }
  return {
    on: typeof raw.on === 'boolean' ? raw.on : DEFAULT_MEMORY.on,
    scope: typeof raw.scope === 'string' && raw.scope ? raw.scope : DEFAULT_MEMORY.scope,
    kinds: Array.isArray(raw.kinds) ? raw.kinds.filter((k): k is string => typeof k === 'string') : [...DEFAULT_MEMORY.kinds],
    ttl: typeof raw.ttl === 'string' && raw.ttl ? raw.ttl : DEFAULT_MEMORY.ttl,
    cap: Number.isFinite(Number(raw.cap)) && Number(raw.cap) > 0 ? Math.trunc(Number(raw.cap)) : DEFAULT_MEMORY.cap,
    confirm: typeof raw.confirm === 'boolean' ? raw.confirm : DEFAULT_MEMORY.confirm,
    pii: typeof raw.pii === 'boolean' ? raw.pii : DEFAULT_MEMORY.pii,
  }
}

const ICONS = new Set(['bot', 'chat', 'chart', 'pen', 'deal', 'code'])

function pinnedBotId(): string {
  return (process.env.SATUWORK_BOT_ID || '').trim()
}
export const DEFAULT_BOT_ID = 'default'
export const DEFAULT_PROVIDER = 'deepseek'
export const DEFAULT_MODEL = 'deepseek-v4-flash'

const DEFAULT_PROMPT =
  '你是 Satuwork 的 AI 员工。用简洁、专业的中文回答。需要当前时间、查看或修改文件、执行命令时调用工具，不要凭猜测。'

/**
 * 本机 Bot 名册。
 *
 * 定义落 `storage.collection('bots')`，会话属于 Bot。
 * 本机不提供配置后台：钉公司 Bot、种默认 Bot。改定义只在 Gateway。
 */
export class AgentRegistry extends Service {
  static inject = ['storage', 'sessions']
  private col: Collection<BotRecord>

  constructor(ctx: Context) {
    super(ctx, 'roster')
    this.col = ctx.storage.collection<BotRecord>('bots')
    this.migrateFromAgents(ctx)
  }

  /** 旧 collection 名是 agents。有数据且 bots 为空时搬过来，并补上 provider+model。 */
  private migrateFromAgents(ctx: Context) {
    if (this.col.list().length) {
      for (const row of this.col.list()) {
        const v = row.value as BotRecord & { model?: string; provider?: string }
        if (!v.provider || !v.model) {
          this.col.put(row.id, { ...v, provider: v.provider || DEFAULT_PROVIDER, model: v.model || DEFAULT_MODEL })
        }
      }
      return
    }
    const legacy = ctx.storage.collection<BotRecord>('agents')
    for (const row of legacy.list()) {
      const v = row.value as BotRecord & { model?: string; provider?: string }
      this.col.put(row.id, {
        ...v,
        provider: v.provider || DEFAULT_PROVIDER,
        model: v.model || DEFAULT_MODEL,
      })
    }
  }

  /** 库是空的就下一颗默认助理。id 固定为 `default`，旧会话迁移挂在它上面。
   *  SATUWORK_BOT_ID 已设、或已配 GATEWAY_URL 时不种默认。 */
  seed(): BotRecord {
    const existing = this.col.get(DEFAULT_BOT_ID)
    if (existing) return existing
    if (this.col.list().length) {
      return this.col.list()[0].value
    }
    if (pinnedBotId()) {
      throw new Error('SATUWORK_BOT_ID 已设，不种默认助理')
    }
    if (gatewayUrl()) {
      throw new Error('已配置 GATEWAY_URL 但未设 SATUWORK_BOT_ID，不种默认助理')
    }
    const agent: BotRecord = {
      id: DEFAULT_BOT_ID,
      name: 'Satuwork',
      description: '默认助理',
      prompt: DEFAULT_PROMPT,
      icon: 'chat',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      enabled: true,
      origin: 'local',
      createdAt: Date.now(),
    }
    this.col.put(agent.id, agent)
    return agent
  }

  defaultId(): string {
    if (this.col.get(DEFAULT_BOT_ID)) return DEFAULT_BOT_ID
    const rows = this.col.list()
    if (rows.length) return (rows.find((r) => r.value.enabled) ?? rows[0]).id
    const pin = pinnedBotId()
    if (pin) return pin
    if (gatewayUrl()) {
      throw new Error('已配置 GATEWAY_URL 但未设 SATUWORK_BOT_ID，不种默认助理')
    }
    return this.seed().id
  }

  list(): BotRecord[] {
    if (!this.col.list().length && !pinnedBotId() && !gatewayUrl()) this.seed()
    return this.col.list().map((r) => r.value)
  }

  get(id: string): BotRecord | undefined {
    return this.col.get(id)
  }

  /**
   * 物化一条全局/公司 Bot。本机 id 跟远程 id 相同。不覆盖 sessionId。
   * 每次同步更新提示词、模型、Skill/MCP；会话仍是这一条。
   */
  pin(input: {
    remoteId: string
    origin: 'company' | 'global'
    name: string
    description?: string
    prompt?: string
    icon?: string
    provider?: string
    model?: string
    enabled?: boolean
    skills?: string[]
    mcps?: string[]
    guards?: Record<string, boolean>
    browser?: BotBrowser
    desktop?: BotDesktop
    selfSkills?: boolean
    memory?: BotMemory
    escalate?: string
    templateVersion?: number
  }): BotRecord {
    const id = input.remoteId
    const current = this.col.get(id)
    if (current && current.origin === 'local' && !current.remoteId) {
      throw new Error(`本机已有同名 id 的自建助理：${id}`)
    }
    const next: BotRecord = {
      id,
      name: input.name,
      description: input.description?.trim() || undefined,
      prompt: input.prompt?.trim() || undefined,
      icon: ICONS.has(input.icon ?? '') ? input.icon! : current?.icon || 'bot',
      provider: input.provider?.trim() || current?.provider || DEFAULT_PROVIDER,
      model: input.model?.trim() || current?.model || DEFAULT_MODEL,
      enabled: input.enabled !== false,
      origin: input.origin,
      remoteId: input.remoteId,
      sessionId: current?.sessionId,
      skills: Array.isArray(input.skills) ? input.skills : current?.skills,
      mcps: Array.isArray(input.mcps) ? input.mcps : current?.mcps,
      // 没下发就沿用上一次同步到的那份，再没有才回落全开（guardsOf 干的活）。
      // 一次「目录里这个字段暂时没了」不该表现成边界被拆掉。
      guards: input.guards ?? current?.guards,
      // 同上：没下发就沿用上一次同步到的那份。一次「字段暂时没了」不该表现成
      // 浏览器能力被悄悄关掉——那会让一个跑了一半的任务在下一次调用时突然被拦。
      browser: input.browser ?? current?.browser,
      desktop: input.desktop ?? current?.desktop,
      // 同上：没下发就沿用上一次同步到的那份。缺字段不该表现成「记忆被关掉了」。
      memory: input.memory ?? current?.memory,
      selfSkills: typeof input.selfSkills === 'boolean' ? input.selfSkills : current?.selfSkills,
      escalate: typeof input.escalate === 'string' ? input.escalate : current?.escalate,
      templateVersion:
        typeof input.templateVersion === 'number' ? input.templateVersion : current?.templateVersion,
      createdAt: current?.createdAt ?? Date.now(),
    }
    this.col.put(id, next)
    return next
  }

  /** 部署实例只留钉住的那一颗，其余从名册删掉。 */
  pruneExcept(keepId: string): void {
    for (const row of this.col.list()) {
      if (row.id !== keepId) this.col.delete(row.id)
    }
  }

  /** 把一条已有会话认领为该 Bot 的长会话。迁移用，不新建。 */
  bindSession(id: string, sessionId: string): void {
    const current = this.col.get(id)
    if (!current || current.sessionId) return
    this.col.put(id, { ...current, sessionId })
  }

  /**
   * 一个 Bot 一条长会话。有就复用，文件没了再造一条。
   * 不在这里上报索引——那是 M5 的事。
   */
  async ensureSession(botId: string): Promise<{ sessionId: string; created: boolean }> {
    const agent = this.col.get(botId)
    if (!agent) throw new Error(`没有这个助理：${botId}`)
    if (agent.sessionId) {
      try {
        await this.ctx.sessions.events(agent.sessionId)
        return { sessionId: agent.sessionId, created: false }
      } catch {
        // 文件没了：再造一条，不把旧 id 留在名册上。
      }
    }
    // 启动迁移可能刚把旧文件挂到这个 Bot，但还没来得及 bindSession。
    // list() 会走 load()，旧文件当场迁完，这里就能认领，不必另开一条。
    // 渠道用户有自己的长会话，绝不能在席位重装后被认成 Bot 的网页主会话。
    const mine = (await this.ctx.sessions.list()).filter((s) => s.botId === agent.id && !s.channel)
    if (mine[0]) {
      this.bindSession(agent.id, mine[0].id)
      return { sessionId: mine[0].id, created: false }
    }
    const sessionId = await this.ctx.sessions.create({
      title: agent.name,
      botId: agent.id,
      origin: agent.origin,
      remoteId: agent.remoteId,
    })
    this.col.put(agent.id, { ...this.col.get(agent.id)!, sessionId })
    return { sessionId, created: true }
  }
}

export const name = 'satu-agent-registry'
export const inject = ['storage', 'sessions', 'server']

export function apply(ctx: Context) {
  ctx.plugin(AgentRegistry)

  ctx.inject(['roster'], (ctx: Context) => {
    const { roster, sessions } = ctx
    if (!pinnedBotId() && !gatewayUrl()) {
      const seeded = roster.seed()
      void sessions.migrateAll(seeded.id).then(async () => {
        // 旧会话挂到默认 Bot 之后，若它还没有长会话，把最近一条认领过来。
        const agent = roster.get(seeded.id)
        if (!agent || agent.sessionId) return
        const mine = (await sessions.list()).filter((s) => s.botId === agent.id && !s.channel)
        if (mine[0]) roster.bindSession(agent.id, mine[0].id)
      })
    } else if (gatewayUrl() && !pinnedBotId()) {
      ctx.logger?.warn?.('名册: 已配置 GATEWAY_URL 但未设 SATUWORK_BOT_ID，不种 default，也不钉整份目录')
    }

    const fail = (res: { status: number }, status: number, error: string) => {
      res.status = status
      return { error }
    }

    ctx.server.get('/api/bots', async (req, res) => {
      res.json({
        bots: roster.list().map((b) => ({
          ...b,
          skillCount: (b.skills ?? []).length,
          mcpCount: (b.mcps ?? []).length,
          usage: '—',
        })),
      })
    })

    // 配置后台在 Gateway。本机只读名册、钉公司 Bot、开长会话。
    ctx.server.get('/api/bots/options', async (req, res) => {
      res.status = 410
      res.json({ error: 'Bot 配置在 Gateway' })
    })

    ctx.server.post('/api/bots', async (req, res) => {
      res.status = 410
      res.json({ error: 'Bot 配置在 Gateway' })
    })

    ctx.server.get('/api/bots/:id/session', async (req, res) => {
      try {
        res.json(await roster.ensureSession(req.params.id))
      } catch (e) {
        res.json(fail(res, 404, (e as Error).message))
      }
    })

    ctx.server.get('/api/bots/:id', async (req, res, next) => {
      // options / pin 留给别的插件。:id 不能把它们吞掉。
      if (req.params.id === 'options' || req.params.id === 'pin') return next()
      const bot = roster.get(req.params.id)
      if (!bot) {
        res.json(fail(res, 404, `没有这个助理：${req.params.id}`))
        return
      }
      res.json({ bot })
    })

    ctx.server.patch('/api/bots/:id', async (req, res) => {
      res.status = 410
      res.json({ error: 'Bot 配置在 Gateway' })
    })
  })
}
