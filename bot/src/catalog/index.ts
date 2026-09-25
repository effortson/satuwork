import { Service, type Context } from '@deepseek-ai/cordis'
import { gatewayToken, gatewayUrl } from '../llm/gateway.ts'
import { browserOf, guardsOf, type BotRecord } from '../registry/index.ts'
import { mcpToolName, mcpToolRisk, McpHttpClient, type JsonRpcTool } from './mcp.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    catalog: CatalogService
  }
}

interface RemoteBot {
  id: string
  name: string
  description?: string
  prompt?: string
  icon?: string
  provider?: string
  model?: string
  enabled?: boolean
  origin?: 'company' | 'global' | 'local'
  skills?: string[]
  mcps?: string[]
  /**
   * 公司模版上的行为边界与转人工条件。
   *
   * **Gateway 一直在发**（见 gateway/src/lib/catalog.ts 的 publicBot），这边不声明就
   * 读进来即丢：管理员在界面上把开关拨了、版本号也跟着涨了，而席位上那三条边界纹丝
   * 不动——最难查的一类，因为每一处看起来都对。
   */
  guards?: Record<string, boolean>
  browser?: { on?: boolean; sites?: string[] }
  /** 模版上「让它自己记 Skill」那个开关。老 Gateway 不发，缺字段按**开**算。 */
  selfSkills?: boolean
  /**
   * 公司模版上的记忆策略。
   *
   * **Gateway 一直在发**（`publicBot` 里那一行 `memory: template.memory`），这边不声明
   * 就读进来即丢——和上面 `guards` 那段注释说的是同一个坑，只是这次连运行面都还没有
   * （docs/memory.md 开头）。
   */
  memory?: BotMemory
  escalate?: string
  templateVersion?: number
}

/**
 * 记忆策略。**只搬运，不解释**——判据在 Gateway（gateway/src/lib/memory.ts），这边
 * 只拿它决定两件事：注入哪几条、两把工具进不进工具表。
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

export interface ModelRole {
  provider: string
  model: string
  reasoningEffort: ReasoningEffort
}

export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const REASONING_EFFORTS = new Set<ReasoningEffort>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const EMPTY_ROLE: ModelRole = { provider: '', model: '', reasoningEffort: 'off' }

/** 老 Gateway 不带 models 字段，回落成空——空就由调用方自己回退，不在这里瞎猜。 */
function roleOf(raw: ModelRole | undefined): ModelRole {
  const effort = raw?.reasoningEffort
  return {
    provider: String(raw?.provider ?? ''),
    model: String(raw?.model ?? ''),
    reasoningEffort: effort && REASONING_EFFORTS.has(effort) ? effort : 'off',
  }
}

interface RemoteSkill {
  id: string
  name: string
  /**
   * 模型拿去 `skill_view` 的那个名字：重名时 Gateway 已经加过序号（「退款审核（2）」）。
   *
   * **不在这边自己算。** 两边各算一次，迟早在某个 Unicode 边界上分叉，而分叉的表现是
   * 模型照着索引里的名字调、席位说找不到（docs/skills.md §5）。
   */
  displayName?: string
  body?: string
  tags?: string[]
  source?: string
  enabled?: boolean
  fileName?: string
  /** `常驻` 全文进提示词，`按需` 只进索引。老 Gateway 不发这个字段，落 `常驻`。 */
  mode?: string
  /** 索引里那一句话。Gateway 从 frontmatter 或正文首段算好发下来。 */
  description?: string
  /** 带不带 ZIP 包的文件。真要用时按需拉（tools/skill.ts），不随目录下发。 */
  hasFiles?: boolean
  origin?: 'company' | 'global' | 'seat'
}

interface RemoteServer {
  id: string
  name: string
  kind?: string
  endpoint?: string
  env?: Record<string, string>
  perm?: string
  enabled?: boolean
  token?: string
  /** 目录可以给某一条单独定时限。连接器那几条是 60 秒（发邮件、查 CRM 都不快）。 */
  timeoutMs?: number
  /** 「仅 @ 时可用」：连上、也注册工具，但不进默认工具表。 */
  mentionOnly?: boolean
  /** 有值表示这是账号连接器合成的服务器；Web 的 @ 选单也只展示这一类。 */
  connector?: string
}

export interface CachedSkill {
  id: string
  name: string
  /** 见 RemoteSkill.displayName。Gateway 没发就退回 name。 */
  displayName: string
  body: string
  tags: string[]
  source: '手动编写' | '单文件 Skill' | 'ZIP 包'
  fileName?: string
  enabled: boolean
  /**
   * `常驻` = 正文每一轮都在提示词里（这套东西之前的样子）；`按需` = 只进索引。
   *
   * **老 Gateway 不发这个字段时落 `常驻`**：那些 Skill 是在「全文常驻」的年代写的，
   * 换个默认值等于趁人不注意改了它们的行为。
   */
  mode: '常驻' | '按需'
  description: string
  hasFiles: boolean
  origin: 'company' | 'global' | 'seat'
  createdAt: number
  updatedAt: number
}

/**
 * 库里读出来的那一行 → 补齐字段的 `CachedSkill`。
 *
 * **换版之后，缓存里躺着的是上一版写下的行**：那时还没有 displayName / description /
 * mode / hasFiles / origin 这几个键。而首次目录同步之前，提示词和三把工具就已经在读
 * 它们了——不补的话，系统提示词里会出现「## Skill: undefined」，`skills_list` 会在
 * `description.toLowerCase()` 上抛 TypeError（被兜成一句「工具执行失败」）。
 *
 * 缺省值的方向都往「和改之前一样」走：**mode 落常驻**（那些行本来就是全文进提示词的），
 * displayName 落 name，origin 落 company。
 */
export function cachedSkillOf(raw: Partial<CachedSkill> & { id: string; name?: string }): CachedSkill {
  const name = typeof raw.name === 'string' ? raw.name : raw.id
  const shown = typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName : name
  return {
    id: raw.id,
    name,
    displayName: shown,
    body: typeof raw.body === 'string' ? raw.body : '',
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    source: raw.source === '单文件 Skill' || raw.source === 'ZIP 包' ? raw.source : '手动编写',
    ...(raw.fileName ? { fileName: raw.fileName } : {}),
    enabled: raw.enabled !== false,
    mode: raw.mode === '按需' ? '按需' : '常驻',
    description: typeof raw.description === 'string' ? raw.description : '',
    hasFiles: raw.hasFiles === true,
    origin: raw.origin === 'global' || raw.origin === 'seat' ? raw.origin : 'company',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  }
}

/**
 * 这颗席位缓存里、启用着的全部 Skill。**读缓存只走这一条路**（补字段见 cachedSkillOf）。
 */
export function cachedSkills(ctx: Context): CachedSkill[] {
  return ctx.storage
    .collection<CachedSkill>('skills')
    .list()
    .map((r) => cachedSkillOf(r.value))
    .filter((s) => s.enabled !== false)
}

/** 按 id 取一条，同样补过字段。取不到或停用了都回 undefined。 */
export function cachedSkill(ctx: Context, id: string): CachedSkill | undefined {
  const row = ctx.storage.collection<CachedSkill>('skills').get(id)
  if (!row) return undefined
  const s = cachedSkillOf(row)
  return s.enabled === false ? undefined : s
}

/**
 * 席位缓存里的一条记忆。**唯一一份在 Gateway**，这儿是缓存，删了丢了都不算数据丢失。
 *
 * 形状照 `publicMemory` 下发的那一份（gateway/src/lib/memory.ts）：没有 accountId——
 * 席位只认得自己那一个账号，多带一列没人用的归属 id 只是多一份要跟着对齐的东西。
 */
export interface CachedMemory {
  id: string
  layer: 'bot' | 'self' | 'group' | 'company'
  kind: string
  text: string
  by: 'agent' | 'user'
  pii: string[]
  pinned: boolean
  /** null = 永久。到期只停止注入，不删（docs/memory.md §8）。 */
  expiresAt: number | null
  createdAt: number
  updatedAt: number
}

/**
 * 库里那一行 → 补齐字段的 `CachedMemory`。
 *
 * 换版之后缓存里躺着的是上一版写下的行，而装配提示词的地方在首次同步之前就在读它们了
 * ——同 `cachedSkillOf` 那段注释。缺省一律往「不改变行为」的方向落：认不出的层当
 * `bot`（最窄的一层），认不出的到期时间当永久（不因为一个缺字段就静静少注入一条）。
 */
export function cachedMemoryOf(raw: Partial<CachedMemory> & { id: string }): CachedMemory {
  const layer = raw.layer
  return {
    id: raw.id,
    layer: layer === 'self' || layer === 'group' || layer === 'company' ? layer : 'bot',
    kind: typeof raw.kind === 'string' ? raw.kind : '事实',
    text: typeof raw.text === 'string' ? raw.text : '',
    by: raw.by === 'user' ? 'user' : 'agent',
    pii: Array.isArray(raw.pii) ? raw.pii.map(String) : [],
    pinned: raw.pinned === true,
    expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : null,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  }
}

/** 这颗席位缓存里的全部记忆（四层都在）。**读缓存只走这一条路。** */
export function cachedMemories(ctx: Context): CachedMemory[] {
  return ctx.storage
    .collection<CachedMemory>('memories')
    .list()
    .map((r) => cachedMemoryOf(r.value))
}

interface CachedServer {
  id: string
  name: string
  kind: 'stdio' | 'SSE' | 'HTTP'
  endpoint: string
  env: Record<string, string>
  perm: '只读' | '可写' | '需审批'
  enabled: boolean
  timeoutMs?: number
  mentionOnly?: boolean
  connector?: string
  createdAt: number
  updatedAt: number
}

export interface ServerStatus {
  id: string
  name: string
  kind: string
  enabled: boolean
  connected: boolean
  tools: string[]
  /** 「仅 @ 时可用」。连着，但不进默认工具表。 */
  mentionOnly?: boolean
  /** 连接器 toolkit；普通公司 MCP 没有，不应进入用户的 @ 选单。 */
  connector?: string
  error?: string
}

const TOKEN_NS = 'mcp-tokens'
/**
 * 探针间隔。够快到「改完喝口水就生效」，又不至于让 Gateway 被一屋子席位刷。
 *
 * 下限 1 秒是给 e2e 用的（那条用例要在几秒内看到模版改动落到实例上）；生产上没人会
 * 去设它，默认一分钟。
 */
const POLL_MS = Math.max(1000, Math.trunc(Number(process.env.SATUWORK_CATALOG_POLL_MS) || 60000))
const KINDS = ['stdio', 'SSE', 'HTTP'] as const

type Dispose = () => unknown

/**
 * Gateway 目录缓存：启动时拉一次，写进本机 collection，把公司 Bot 钉到名册。
 * 定义只在 Gateway 改；这里只同步。
 */
export class CatalogService extends Service {
  static inject = ['storage', 'roster', 'tools']

  pulledAt: number | null = null
  lastError: string | null = null
  servers: ServerStatus[] = []
  /**
   * 平台钉的两个模型角色。**下发的，不是本机配的**：挑模型是平台的事，让席位的
   * cordis.yml 也能改，等于给了一条绕过平台配置的暗路。
   * 网页提取的摘要走 utility——廉价、大批量、不面对用户，正是它的定义。
   */
  models: { daily: ModelRole; utility: ModelRole; dailyAlternates: ModelRole[] } = { daily: EMPTY_ROLE, utility: EMPTY_ROLE, dailyAlternates: [] }

  /** 上一次拉到的公司模版版本号。给 /api/runtime/status 看，也用来打日志。 */
  templateVersion = 0
  /** 上一次探针给的指纹。变了才重拉整份目录。 */
  private stamp = ''
  private remoteBots: RemoteBot[] = []
  private mcpEffects: Dispose[] = []
  /** 工具名 → 所属服务器 id，用来按 Bot 的 mcps 过滤。 */
  private toolServer = new Map<string, string>()
  /** 「仅 @ 时可用」的服务器 id。连上了，但平时不进工具表。 */
  private mentionOnly = new Set<string>()
  private clients = new Map<string, McpHttpClient>()

  constructor(ctx: Context) {
    super(ctx, 'catalog')
  }

  get configured(): boolean {
    return Boolean(gatewayUrl() && gatewayToken())
  }

  /**
   * 这些服务器上的工具名。
   *
   * `mentionOnly` 的那几台**默认不算在内**——它们连着、工具也注册了，但不进工具表，
   * 除非这一轮被 `@` 点名（`mentioned` 里有它）。「个人邮箱只有我点名了你才能碰」
   * 就是靠这一层实现的；不连它是不行的：真被点名时再去握手就晚了。
   */
  toolNamesFor(serverIds: string[], mentioned: string[] = []): string[] {
    const allow = new Set(serverIds)
    const named = new Set(mentioned)
    const out: string[] = []
    for (const [name, sid] of this.toolServer) {
      if (!allow.has(sid)) continue
      if (this.mentionOnly.has(sid) && !named.has(sid)) continue
      out.push(name)
    }
    return out
  }

  /**
   * 这把工具属于哪台 MCP 服务器。策略要拿它去查「这台在不在这个 Bot 的允许集合里」
   * （见 policy/index.ts 的 checkExternal）。
   *
   * 单独开一个访问器而不是把 `toolServer` 放开：那张表是注册流程的内部账本，
   * 谁都能改的话，「工具属于哪台服务器」就有了第二个真相。
   */
  serverOf(toolName: string): string | undefined {
    return this.toolServer.get(toolName)
  }

  status() {
    return {
      gateway: this.configured ? gatewayUrl() : null,
      pulledAt: this.pulledAt,
      templateVersion: this.templateVersion,
      error: this.lastError,
      bots: this.ctx.roster.list().map((b) => ({
        id: b.id,
        name: b.name,
        origin: b.origin,
        remoteId: b.remoteId ?? null,
        enabled: b.enabled,
        /**
         * 这台席位上生效的行为边界。**排错时第一个要问的就是它**：管理员改了模版，
         * 席位跟没跟上、跟上的是哪一份，光看 templateVersion 只知道版本号对不对，
         * 看不出这三个开关到底是开是关。
         */
        guards: guardsOf(b),
        // 和 guards 同一个理由：管理员开了浏览器、席位跟没跟上，光看版本号看不出来。
        browser: browserOf(b),
        escalate: b.escalate ?? '',
      })),
      skills: this.ctx.storage.collection<CachedSkill>('skills').list().map((r) => ({
        id: r.value.id,
        name: r.value.name,
        enabled: r.value.enabled,
      })),
      servers: this.servers.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        enabled: s.enabled,
        connected: s.connected,
        tools: s.tools,
        ...(s.connector ? { connector: s.connector } : {}),
        ...(s.error ? { error: s.error } : {}),
      })),
    }
  }

  private inflight: Promise<boolean> | null = null
  /**
   * 刚由 `skill_manage` 写下、还没被任何一次目录同步确认过的那几条：id → 写下的时刻。
   *
   * 存在的理由是一次**真实的竞态**：轮询每分钟发一次 `/runtime/catalog`，而 `pull()`
   * 有单飞去重。模型在那一次请求**发出之后**写下一条 Skill，等那份（早于写入的）响应
   * 落地时，`syncSkills` 的剪枝会把它当成「目录里已经没有的」删掉——而 `skill_manage`
   * 刚跟模型说完「从下一轮开始出现在你的索引里」。要等下一次探针（最多一分钟）才自愈，
   * 中间那几轮里模型会转头告诉用户没保存上（docs/skills.md §7）。
   *
   * 判据是时刻，不是「有没有」：**只有发车早于这次写入的那份响应**才需要被豁免，
   * 更晚发车的响应里没有它就是真的被删了（管理员在界面上删的、或者晋升搬走了）。
   */
  private noted = new Map<string, number>()

  /** SATUWORK_BOT_ID 对应的那一颗已经钉进名册。 */
  get pinSucceeded(): boolean {
    const id = (process.env.SATUWORK_BOT_ID || '').trim()
    if (!id) return false
    return Boolean(this.pulledAt && this.ctx.roster.get(id))
  }

  async pull(): Promise<boolean> {
    if (this.inflight) return this.inflight
    this.inflight = this.runPull().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async runPull(): Promise<boolean> {
    if (!this.configured) {
      this.lastError = '未配置 GATEWAY_URL / GATEWAY_TOKEN'
      return false
    }
    const base = gatewayUrl()
    const token = gatewayToken()
    let body: {
      templateVersion?: number
      stamp?: string
      bots?: RemoteBot[]
      skills?: RemoteSkill[]
      servers?: RemoteServer[]
      models?: { daily?: ModelRole; utility?: ModelRole; dailyAlternates?: ModelRole[] }
      memories?: Partial<CachedMemory>[]
    }
    // **发车时刻要在 fetch 之前取**：豁免的判据就是「这份响应比那次写入更旧」。
    const startedAt = Date.now()
    const pinId = (process.env.SATUWORK_BOT_ID || '').trim()
    const catalogUrl = pinId
      ? `${base}/runtime/catalog?botId=${encodeURIComponent(pinId)}`
      : base + '/runtime/catalog'
    try {
      const r = await fetch(catalogUrl, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      })
      if (!r.ok) {
        const text = await r.text().catch(() => '')
        throw new Error(`HTTP ${r.status}${text ? ` ${text.slice(0, 160)}` : ''}`)
      }
      body = (await r.json()) as typeof body
    } catch (e) {
      this.lastError = (e as Error).message
      this.ctx.logger?.warn?.(`catalog: 拉取失败 ${this.lastError}`)
      return false
    }
    this.templateVersion = Number(body.templateVersion) || this.templateVersion
    // 这一份内容的指纹，跟着数据一起来。**基线取自这里**，不能等第一次探针——那两件事
    // 之间隔着一整轮插件启动，中间落地的改动会永远丢掉。但先攥在手里，等下面这一份
    // 真的落地了再写进 this.stamp（见函数末尾）。
    const stamp = typeof body.stamp === 'string' ? body.stamp : ''
    this.remoteBots = Array.isArray(body.bots) ? body.bots : []
    this.models = {
      daily: roleOf(body.models?.daily),
      utility: roleOf(body.models?.utility),
      // 会话在对话框里能换到的那几个（见 agents 的 dailyChoices）。老 Gateway 不带 = 空 = 没得换。
      dailyAlternates: (Array.isArray(body.models?.dailyAlternates) ? body.models.dailyAlternates : [])
        .map(roleOf)
        .filter((r) => r.provider && r.model),
    }
    this.syncSkills(Array.isArray(body.skills) ? body.skills : [], { since: startedAt })
    /** 没有 id 的那些当场丢掉：缓存是按 id 认的，一条没有 id 的记录进去就再也删不掉。 */
    const memories = (Array.isArray(body.memories) ? body.memories : []).filter(
      (m): m is Partial<CachedMemory> & { id: string } => typeof m?.id === 'string' && !!m.id,
    )
    this.syncMemories(memories, { since: startedAt })
    this.syncServers(Array.isArray(body.servers) ? body.servers : [])
    const pinned = this.pinBots(this.remoteBots)
    await this.connectMcp()
    if (!pinned) return false
    this.pulledAt = Date.now()
    /**
     * **指纹在这里才落。**
     *
     * 早一步写的话，中间任何一步抛错（storage 写不进去、pin 撞了本地同名 Bot）都会留下
     * 「指纹是新的、数据还是旧的」——之后每一轮探针都判定「没变」，这台席位就静悄悄地
     * 停在旧模版上，直到下次有人改模版或者进程重启。宁可重拉一次，也不能不声不响地停住。
     */
    if (stamp) this.stamp = stamp
    this.lastError = null
    return true
  }

  /**
   * 「底座换了没有」——探一下，变了才重拉。
   *
   * 公司的 Bot 模版一改，版本号就 +1，这台席位上的 Bot 得跟着换提示词和工具表；但
   * 目录那一份带着 MCP 明文 token 和全部 Skill 正文，每分钟整份拉一遍既费字节又让
   * 密钥白白多流动几十次。所以探针只回一个指纹，指纹没动就一个字节都不再取。
   *
   * 拉失败不清 stamp：下一轮还会再探到同一个新指纹，自然会重试。
   */
  async poll(): Promise<void> {
    if (!this.configured) return
    let next = ''
    try {
      const r = await fetch(this.probeUrl(), {
        headers: { authorization: `Bearer ${gatewayToken()}` },
        signal: AbortSignal.timeout(10000),
      })
      if (!r.ok) return
      const body = (await r.json()) as { stamp?: unknown }
      next = typeof body.stamp === 'string' ? body.stamp : ''
    } catch {
      // 探针失败不写 lastError：那一栏说的是「目录同步」的状态，一次网络抖动不该让
      // 界面上出现红字，而下一轮探针一分钟后就到。
      return
    }
    /**
     * 指纹没动，但上一轮有 MCP 没连上：到点自己再连一次。
     *
     * 不补这一条的话，一次几秒的握手失败会让那台服务器的工具一直缺着——runPull 照样
     * 走完、stamp 照样写成新的，而 poll 只在指纹变化时才做事，于是要等到有人改模版或
     * 者进程重启才恢复。
     */
    if (!next || next === this.stamp) {
      if (this.mcpRetryAt && Date.now() >= this.mcpRetryAt) {
        this.mcpRetryAt = 0
        this.ctx.logger?.info?.('catalog: 有 MCP 上一轮没连上，重试一次')
        await this.connectMcp().catch((e) => {
          this.ctx.logger?.warn?.(`catalog: MCP 重连失败 ${(e as Error).message}`)
        })
      }
      return
    }
    this.ctx.logger?.info?.(`catalog: 目录有变（${next}），重新拉取`)
    /**
     * **拉取的异常在这里就地收住。**
     *
     * runPull 只 catch 了 fetch 那一段；后面 syncSkills / pinBots / connectMcp 里任何一处
     * 抛出来（磁盘满、SQLite busy、pin 撞了同名 Bot）都会顺着这里冒成未处理的 Promise
     * 拒绝——Node 默认策略是直接终止进程，于是席位上的 bot 每分钟被自己杀一次，日志里
     * 只留一行栈。停在旧目录上是可以忍的，进程反复自杀不行。
     */
    let applied = false
    try {
      applied = await this.pull()
    } catch (e) {
      this.lastError = (e as Error).message
      this.ctx.logger?.warn?.(`catalog: 重新拉取失败 ${this.lastError}`)
      return
    }
    /**
     * **真换上了才报。** pull 返回 false 是「这一份没落地」（pin 没成），而 templateVersion
     * 在那之前就已经从响应里读进来了——这时候报上去，平台会以为这台跟上了，恰恰在它
     * 没跟上的时候。宁可下一轮再说。
     */
    if (!applied) return
    /**
     * 换完就**立刻**再探一次，只为把新版本号报上去（`?have=`，见下面 probeUrl）。
     *
     * 不这么做的话，平台那边要等下一轮探针才知道这台跟上了——加上发现改动本来就等了
     * 一轮，管理员按下保存后最坏要盯着「未同步」看两分钟，而那时候席位其实早换好了。
     * 一次多余的探针换掉这两分钟的谎，划算。
     *
     * 报不上去就算了：下一轮探针照样带着同一个数字，不必在这里重试，更不该让它冒出去
     * 变成一次未处理的拒绝。
     */
    await fetch(this.probeUrl(), {
      headers: { authorization: `Bearer ${gatewayToken()}` },
      signal: AbortSignal.timeout(10000),
    }).catch(() => {})
  }

  /**
   * 探针地址。`have` 是**这台席位这会儿真正跑着的模版版本**，捎给平台当同步状态用
   * （见 gateway 的 /runtime/catalog/version）。
   *
   * 没拉到过就不带（`templateVersion` 还是 0）：那不是「第 0 版」，是「还没报到过」，
   * 两者在界面上不是一回事。
   */
  private probeUrl(): string {
    const pinId = (process.env.SATUWORK_BOT_ID || '').trim()
    const q = new URLSearchParams()
    if (pinId) q.set('botId', pinId)
    if (this.templateVersion > 0) q.set('have', String(this.templateVersion))
    const qs = q.toString()
    return `${gatewayUrl()}/runtime/catalog/version${qs ? `?${qs}` : ''}`
  }

  async pinRemote(remoteId: string): Promise<BotRecord> {
    let bot = this.remoteBots.find((b) => b.id === remoteId)
    if (!bot && this.configured) {
      await this.pull()
      bot = this.remoteBots.find((b) => b.id === remoteId)
    }
    if (!bot) throw new Error(`目录里没有这个助理：${remoteId}`)
    return this.pinOne(bot)
  }

  /**
   * 把 Gateway 刚回过来的那一条 Skill 落进本地缓存。
   *
   * `skill_manage` 写完之后调它。**落进去的必须是 Gateway 回来的那一份**——名字怎么
   * 去重、`mode` 落成什么、正文被截了没有，全是那边说了算；席位自己拼一条等于两边
   * 各有一套归一化，而它们一定会分叉（docs/skills.md §15 不变量 4）。
   *
   * 注意它只补这一条：整份目录（连同别的席位改动）等下一次 `pull` 拉回来。
   */
  noteSkill(item: unknown) {
    const s = item as RemoteSkill
    if (!s || typeof s.id !== 'string' || !s.id) return
    // 先记时刻再落盘：万一此刻有一次早发车的 pull 正在途中，它落地时要认得出这一条
    // 是「刚写的」而不是「已经没了的」（见 noted 那段注释）。
    this.noted.set(s.id, Date.now())
    this.syncSkills([s], { prune: false })
  }

  /** 删掉一条本地缓存的 Skill。`skill_manage` 删完之后调它，不用等下一次同步。 */
  dropSkill(id: string) {
    this.noted.delete(id)
    this.ctx.storage.collection<CachedSkill>('skills').delete(id)
  }

  /**
   * 把 Gateway 刚回过来的那一条记忆落进本地缓存。
   *
   * `memory_write` 写完之后调它。**落进去的必须是 Gateway 回来的那一份**——判重怎么判、
   * `expiresAt` 落成什么，全是那边说了算（docs/memory.md 不变量 2）。
   *
   * 不等下一次 pull 是有具体理由的：探针一分钟一次，而模型很可能在**同一轮里**接着
   * `memory_list` 一次核对自己刚记的东西。那时候读不到，它会以为没写成。
   */
  noteMemory(item: unknown) {
    const m = item as Partial<CachedMemory> & { id?: unknown }
    if (!m || typeof m.id !== 'string' || !m.id) return
    // 先记时刻再落盘，同 noteSkill：此刻可能有一次早发车的 pull 正在途中。
    this.noted.set(m.id, Date.now())
    this.syncMemories([m as Partial<CachedMemory> & { id: string }], { prune: false })
  }

  /** 删掉一条本地缓存的记忆。`memory_write` 删完之后调它，不用等下一次同步。 */
  dropMemory(id: string) {
    this.noted.delete(id)
    this.ctx.storage.collection<CachedMemory>('memories').delete(id)
  }

  /**
   * 目录这一份里没有的，从本地缓存里删掉。记忆和 Skill 两条同步路共用。
   *
   * `since` 是这份响应的发车时刻：比它还新写下的行豁免掉——那不是「被删了」，是
   * 「它还没赶上这一班」。豁免记号（`noted`）**只在全量同步里清**：`noteSkill` 自己
   * 就是一次 `prune: false` 的同步，放到剪枝之外清会把刚设下的记号当场删掉，豁免
   * 等于没写（第一版真踩到过）。
   */
  private prune(
    col: { list(): { value: { id: string } }[]; delete(id: string): void },
    items: { id: string }[],
    since: number,
  ) {
    const live = new Set(items.map((i) => i.id))
    for (const row of col.list()) {
      if (live.has(row.value.id)) continue
      if ((this.noted.get(row.value.id) ?? 0) > since) continue
      col.delete(row.value.id)
    }
    for (const i of items) this.noted.delete(i.id)
  }

  /**
   * 把这一份记忆落进本地缓存。
   *
   * **默认按全集处理**：Gateway 上没有的那些要跟着删掉。少了这一步，人在界面上删掉
   * 一条之后，席位还带着它去组每一轮的提示词——而界面上它已经不在了。这条链路上
   * 没有别的补救：记忆不像 Skill 那样「用到才展开」，它每一轮都在。
   *
   * 剪枝的豁免口径和 `syncSkills` 共用同一个 `noted`（同一个 id 空间不会撞：都是 uuid）。
   */
  private syncMemories(
    items: (Partial<CachedMemory> & { id: string })[],
    opts: { prune?: boolean; since?: number } = {},
  ) {
    const col = this.ctx.storage.collection<CachedMemory>('memories')
    const now = Date.now()
    if (opts.prune !== false) {
      this.prune(col, items, opts.since ?? now)
    }
    for (const m of items) {
      const prev = col.get(m.id)
      col.put(m.id, {
        ...cachedMemoryOf(m),
        createdAt: typeof m.createdAt === 'number' ? m.createdAt : (prev?.createdAt ?? now),
        updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : now,
      })
    }
  }

  /**
   * 把这一份 Skill 落进本地缓存。
   *
   * **默认按全集处理**：目录里没有的那些要跟着删掉。少了这一步，管理员在界面上删掉
   * 一条、或者模型自己删掉一条，席位这边还留着——模型照着索引去 `skill_view`，读到的
   * 是一份已经不存在的东西。
   *
   * `prune: false` 是补一条（见 noteSkill）；`since` 是这份数据的发车时刻，用来豁免
   * 那之后才写下的行（见 noted）。
   */
  private syncSkills(items: RemoteSkill[], opts: { prune?: boolean; since?: number } = {}) {
    const col = this.ctx.storage.collection<CachedSkill>('skills')
    const now = Date.now()
    if (opts.prune !== false) {
      this.prune(col, items, opts.since ?? now)
    }
    for (const s of items) {
      const prev = col.get(s.id)
      const source =
        s.source === '单文件 Skill' || s.source === 'ZIP 包' ? s.source : ('手动编写' as const)
      col.put(s.id, {
        ...cachedSkillOf({ ...(s as Partial<CachedSkill>), id: s.id, source }),
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      })
    }
  }

  private syncServers(items: RemoteServer[]) {
    const col = this.ctx.storage.collection<CachedServer>('mcp-servers')
    const now = Date.now()
    for (const s of items) {
      const prev = col.get(s.id)
      const kind = (KINDS as readonly string[]).includes(s.kind || '') ? (s.kind as CachedServer['kind']) : 'SSE'
      col.put(s.id, {
        id: s.id,
        name: s.name,
        kind,
        endpoint: typeof s.endpoint === 'string' ? s.endpoint : '',
        env: s.env && typeof s.env === 'object' ? s.env : {},
        perm: s.perm === '可写' || s.perm === '需审批' ? s.perm : '只读',
        enabled: s.enabled !== false,
        ...(Number.isFinite(Number(s.timeoutMs)) && Number(s.timeoutMs) > 0 ? { timeoutMs: Math.trunc(Number(s.timeoutMs)) } : {}),
        ...(s.mentionOnly === true ? { mentionOnly: true } : {}),
        ...(typeof s.connector === 'string' && s.connector ? { connector: s.connector } : {}),
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      })
      const token = typeof s.token === 'string' ? s.token : ''
      this.ctx.storage.setSetting(TOKEN_NS, s.id, token || null)
    }
  }

  private pinBots(items: RemoteBot[]): boolean {
    const only = (process.env.SATUWORK_BOT_ID || '').trim()
    if (!only) {
      // GATEWAY_URL 已设才会走到这里。没有钉 id 就不钉整份目录，也不种 default。
      this.lastError = '未设 SATUWORK_BOT_ID，不钉目录'
      this.ctx.logger?.warn?.('catalog: 已配置 GATEWAY_URL 但未设 SATUWORK_BOT_ID，不钉目录')
      return false
    }
    const hit = items.find((b) => b.id === only)
    if (!hit) {
      this.lastError = `目录里没有这个助理：${only}`
      this.ctx.logger?.warn?.(`catalog: ${this.lastError}`)
      return false
    }
    this.pinOne(hit)
    this.ctx.roster.pruneExcept(only)
    return true
  }

  private pinOne(b: RemoteBot): BotRecord {
    const origin = b.origin === 'global' ? 'global' : 'company'
    return this.ctx.roster.pin({
      remoteId: b.id,
      origin,
      name: b.name,
      description: b.description,
      prompt: b.prompt,
      icon: b.icon,
      provider: b.provider,
      model: b.model,
      enabled: b.enabled !== false,
      skills: Array.isArray(b.skills) ? b.skills : [],
      mcps: Array.isArray(b.mcps) ? b.mcps : [],
      // 模版的三样。没有这一行，「保存即生效」对行为边界就是句空话。
      guards: b.guards,
      browser: b.browser && typeof b.browser === 'object'
        ? { on: b.browser.on === true, sites: Array.isArray(b.browser.sites) ? b.browser.sites : [] }
        : undefined,
      selfSkills: typeof b.selfSkills === 'boolean' ? b.selfSkills : undefined,
      // 记忆策略。**这一行就是那个坑的补丁**：Gateway 一直在发，之前这儿不接，
      // 于是模版上改的每一样在席位上都不生效（docs/memory.md 开头）。
      memory: b.memory && typeof b.memory === 'object' ? b.memory : undefined,
      escalate: b.escalate,
      templateVersion: typeof b.templateVersion === 'number' ? b.templateVersion : this.templateVersion,
    })
  }

  private dropMcpTools() {
    for (const name of this.toolServer.keys()) {
      this.ctx.tools.unregister(name)
    }
    for (const dispose of this.mcpEffects.splice(0)) {
      try {
        const r = dispose()
        if (r && typeof (r as Promise<unknown>).then === 'function') void (r as Promise<unknown>).catch(() => {})
      } catch {
        /* 卸工具失败不挡下一轮 */
      }
    }
    this.toolServer.clear()
    this.mentionOnly.clear()
    this.clients.clear()
  }

  /**
   * 有 MCP 服务器这一轮没连上，到点要再试一次。0 = 不用试。
   *
   * 光靠指纹是不够的：连接失败也照样走完 runPull、照样把 stamp 写成新的，于是那台
   * 服务器的工具一直缺着，直到下一次有人改模版或者进程重启——一次几秒的网络抖动能让
   * 工具消失好几天。
   */
  private mcpRetryAt = 0

  /** 连不上时隔多久再试。 */
  private static readonly MCP_RETRY_MS = 60_000

  private async connectMcp() {
    const rows = this.ctx.storage.collection<CachedServer>('mcp-servers').list()
    const statuses: ServerStatus[] = []
    /**
     * **先把该连的都连上，最后才换工具表。**
     *
     * 原先第一行就是 `dropMcpTools()`，然后挨个去握手——一台服务器一次 HTTP 往返，
     * 串着来就是好几秒，而这几秒里 `mcp_*` 全都不存在。正跑着的那一轮这时候调工具，
     * 拿到的是一句「未知工具」，模型只会当作这个工具坏了。
     *
     * 所以连接（会 await 的那部分）先做完，注册（纯同步）留到最后一起换。
     */
    const ready: { s: CachedServer; client: McpHttpClient; listed: JsonRpcTool[] }[] = []
    let failed = false
    for (const row of rows) {
      const s = row.value
      if (!s.enabled) {
        statuses.push({ id: s.id, name: s.name, kind: s.kind, enabled: false, connected: false, tools: [], ...(s.connector ? { connector: s.connector } : {}) })
        continue
      }
      if (s.kind === 'stdio') {
        this.ctx.logger?.info?.(`catalog: 跳过 stdio MCP ${s.name}`)
        statuses.push({
          id: s.id,
          name: s.name,
          kind: s.kind,
          enabled: true,
          connected: false,
          tools: [],
          error: 'stdio 不支持',
          ...(s.connector ? { connector: s.connector } : {}),
        })
        continue
      }
      const token = this.ctx.storage.getSetting<string>(TOKEN_NS, s.id) ?? ''
      const client = new McpHttpClient(s.endpoint, token, s.timeoutMs)
      try {
        await client.initialize()
        ready.push({ s, client, listed: await client.listTools() })
      } catch (e) {
        failed = true
        this.ctx.logger?.warn?.(`catalog: MCP ${s.name} 失败 ${(e as Error).message}`)
        statuses.push({
          id: s.id,
          name: s.name,
          kind: s.kind,
          enabled: true,
          connected: false,
          tools: [],
          error: (e as Error).message,
          ...(s.connector ? { connector: s.connector } : {}),
        })
      }
    }
    // ── 从这里往下不再 await：旧工具摘掉、新工具装上，中间没有空窗。──
    this.dropMcpTools()
    for (const { s, client, listed } of ready) {
      const names: string[] = []
      for (const tool of listed) {
        const name = mcpToolName(s.name, tool.name)
        if (this.ctx.tools.has(name)) {
          // 重名只可能是截断撞了。**要说出来**：静默跳过的表现是「某个工具时有时无」，
          // 而没有任何一行日志指向原因。
          this.ctx.logger?.warn?.(`catalog: ${s.name} 的 ${tool.name} 撞名 ${name}，这一个没注册`)
          continue
        }
        this.registerMcpTool(s.id, name, tool, client)
        names.push(name)
      }
      this.clients.set(s.id, client)
      if (s.mentionOnly) this.mentionOnly.add(s.id)
      statuses.push({
        id: s.id, name: s.name, kind: s.kind, enabled: true, connected: true, tools: names,
        ...(s.mentionOnly ? { mentionOnly: true } : {}),
        ...(s.connector ? { connector: s.connector } : {}),
      })
    }
    this.servers = statuses
    this.mcpRetryAt = failed ? Date.now() + CatalogService.MCP_RETRY_MS : 0
  }

  private registerMcpTool(serverId: string, name: string, tool: JsonRpcTool, client: McpHttpClient) {
    const parameters =
      tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {} }
    const remoteName = tool.name
    const perm = this.ctx.storage.collection<CachedServer>('mcp-servers').get(serverId)?.perm ?? '只读'
    const fork = this.ctx.tools.register({
      name,
      description: tool.description || remoteName,
      parameters,
      // 目录里配的 perm + 远端工具名里的动词，只叠加不相减（见 mcp.ts 的 mcpToolRisk）。
      // 不标注的话它们会落到 UNKNOWN_RISK 上——那是「外部 + 写」，于是**每一次** MCP
      // 调用都要弹一张确认卡。
      risk: mcpToolRisk(perm, remoteName),
      execute: async (args, call) => {
        try {
          /**
           * **三态，不是两态。** `undefined` = 这台席位这一刻答不上来「人点没点名」
           * （见 viaMentionOf）。以前它跟「没点名」是同一个值，那时无所谓——那个标记
           * 只用来给流水归因。现在 Gateway 拿它当「仅 @ 时可用」的判据，两者合成一个
           * false 就意味着：席位这边一次取不到服务，用户点了名的连接会被服务端拒掉，
           * 而错误信息说的是「这一轮没有点名它」。所以答不上来就**什么都不报**，
           * 让 Gateway 自己决定怎么办。
           */
          const viaMention = viaMentionOf(this.ctx, call.sessionId ?? '', serverId)
          const text = await client.callTool(
            remoteName,
            args,
            viaMention === undefined ? undefined : { viaMention },
          )
          return { text }
        } catch (e) {
          return { text: `MCP 调用失败：${(e as Error).message}`, failed: true }
        }
      },
    })
    this.mcpEffects.push(() => (fork as Dispose)())
    this.toolServer.set(name, serverId)
  }
}

/**
 * 这一次调用是不是用户 `@` 点名的这台服务器。
 *
 * 只有席位这一侧知道答案（点名决定的是这一轮的工具表），所以由这里带给 Gateway，
 * 让流水上记得住「人点的还是模型自己挑的」。目录插件**不能 inject `agents`**——
 * agents 那边 inject 了 catalog，绕一条依赖环回来两边都起不来。
 *
 * **`ctx.agents?.` 这种写法挡不住。** cordis 的 inject 守卫是在**取属性那一刻**抛的
 * （`cannot get property "agents" without inject`），`?.` 挡的是取到之后的 null，不是
 * 取的过程。线上就是这么坏的：Gmail 的每一次调用都返回这句英文，因为它在那个 try 里
 * 被当成了「MCP 调用失败」——一个流水上的附加标记，把整个工具打死了。
 *
 * 所以两层保险：`reflect.get` 直接查服务表、不走 inject 那一层；外面再包一个 catch，
 * **无论如何都不许从这里抛出去**。
 *
 * 取不到时返回 `undefined`——**不是 `false`**。这个区别现在有后果：Gateway 用这个标记
 * 强制「仅 @ 时可用」的连接（routes/mcp.ts），报 false 就等于替用户说「他没点名」，
 * 于是上面那次故障的后果从「流水少个标记」升级成「这把连接彻底用不了」。答不上来就
 * 什么都不报，让 Gateway 按「不知道」处理。
 */
export function viaMentionOf(ctx: Context, sessionId: string, serverId: string): boolean | undefined {
  try {
    const agents = (ctx as unknown as { reflect?: { get?: (name: string) => unknown } }).reflect?.get?.('agents') as
      | { mentionedIn?: (id: string) => Set<string> | undefined }
      | undefined
    const named = agents?.mentionedIn?.(sessionId)
    // **取不到 agents 就是 undefined，不是 false。** 这两个值现在有了不同的后果：
    // false 是「我看过了，人没点名」，undefined 是「我这会儿答不上来」。
    if (!named) return undefined
    return named.has(serverId)
  } catch {
    return undefined
  }
}

export const name = 'satu-catalog'
export const inject = ['storage', 'roster', 'tools', 'server']

export function apply(ctx: Context) {
  ctx.plugin(CatalogService)
  ctx.inject(['catalog'], (ctx: Context) => {
    // 启动那一次同样不能让异常冒出去：runPull 的 fetch 之外还有一截会抛（见 poll）。
    ctx.catalog.pull().catch((e: unknown) => ctx.logger?.warn?.(`catalog: 首次拉取失败 ${(e as Error).message}`))

    /**
     * 跟住 Gateway 上的改动。
     *
     * 以前只在启动时拉一次，于是公司改了 Bot 模版（或者管理员加了个 MCP），这台席位
     * 要等到下一次重新部署才知道——而那正是「模版改完全公司自动跟上」这条产品承诺
     * 落不了地的地方。一分钟一次的探针够快，又不至于让 Gateway 被几十台席位刷。
     */
    const timer = setInterval(() => {
      ctx.catalog.poll().catch((e: unknown) => ctx.logger?.warn?.(`catalog: 探针失败 ${(e as Error).message}`))
    }, POLL_MS)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer))

    ctx.server.get('/api/runtime/status', async (req, res) => {
      res.json(ctx.catalog.status())
    })

    ctx.server.post('/api/bots/pin', async (req, res) => {
      if ((process.env.SATUWORK_BOT_ID || '').trim()) {
        res.status = 410
        res.json({ error: 'Bot 配置在 Gateway' })
        return
      }
      const body = (await req.json().catch(() => ({}))) as { remoteId?: string }
      const remoteId = typeof body.remoteId === 'string' ? body.remoteId.trim() : ''
      if (!remoteId) {
        res.status = 400
        res.json({ error: 'remoteId 不能为空' })
        return
      }
      try {
        res.json({ bot: await ctx.catalog.pinRemote(remoteId) })
      } catch (e) {
        const msg = (e as Error).message
        res.status = msg.startsWith('目录里没有') ? 404 : 400
        res.json({ error: msg })
      }
    })
  })
}
