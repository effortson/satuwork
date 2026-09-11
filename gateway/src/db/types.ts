/**
 * 库里那些行长什么样，以及跟着它们走的常量和纯函数。
 *
 * 单独一个文件，是因为**几乎每个模块都要 import 这里的类型**，而它们和连接、SQL、
 * 事务没有任何关系。放在 db.ts 里的时候，routes 那边一条 `import type { Account }`
 * 会把整个 3000 行的 Db 类拖进依赖图。
 */

import type { MachineTelemetry } from '../lib/telemetry.ts'

export type { MachineTelemetry }

export type Role = 'owner' | 'admin' | 'member'

/**
 * 目录项的层级。
 *
 * `user` 是第三层：员工自己建的 Bot，只有他自己看得见（`accountId` 就是他）。
 * 它没有自己的一整份配置——底座来自本公司那份 **Bot 模版**，这一层只存身份
 * （名字、头像、简介、开场白、一段追加提示词）。
 */
export type Scope = 'global' | 'company' | 'user'
export type CatalogKind = 'model' | 'skill' | 'mcp' | 'bot' | 'bot-template' | 'provider' | 'connector'

export type CompanyStatus = 'active' | 'disabled'

export interface Company {
  id: string
  slug: string
  name: string
  /** 停用的公司整家进不来：本公司的人一律登不上，也刷不动 API。 */
  status: CompanyStatus
  /** 对接人。建公司时必填，出问题先找这个人。 */
  contactName: string
  contactPhone: string
  contactEmail: string
  /** 地址和网站可留空，留空存空串而不是 null。 */
  address: string
  website: string
  machineId: string | null
  accessUrl: string | null
  /**
   * 转人工的对外通知地址（飞书 / 企微 / Slack 机器人的 webhook）。空 = 不发。
   *
   * 它是「人不在场」那一层唯一的出路：站内的红点和侧栏那颗点都要有人开着浏览器
   * 才看得见，而最需要被叫醒的恰恰是没人看着的时候（见 docs/handoff.md §6）。
   */
  handoffWebhook: string | null
  createdAt: number
  updatedAt: number
}

export type AccountStatus = 'active' | 'disabled' | 'invited'

export type Theme = 'light' | 'dark' | 'system'
export type Locale = 'zh' | 'en'

export interface Account {
  id: string
  companyId: string | null
  email: string
  name: string
  title: string
  phone: string
  theme: Theme
  locale: Locale
  passwordHash: string
  role: Role
  status: AccountStatus
  lastSeenAt: number | null
  passwordChangedAt: number | null
  /** 早于此时签发的 JWT 一律作废。Gateway 没有会话表，靠这个补「立刻踢下线」。 */
  tokenRevokedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface Invite {
  id: string
  userId: string
  companyId: string
  createdBy: string
  createdAt: number
  expiresAt: number
}

export interface Plan {
  companyId: string
  seats: number
  /** 订的是价目表里的哪一条。null = 还没定套餐，只有席位。 */
  skuId: string | null
  /** 到期时间。null = 不限期。 */
  expiresAt: number | null
  updatedAt: number
}

/**
 * 套餐 SKU：owner 维护的价目表，一条 = 一个可卖的套餐。
 * 跟 `Plan` 不是一回事——`Plan` 是某家公司**当前**的席位额度，这里是「卖什么」。
 */
/** 套餐周期。存英文枚举当键，界面按语言翻——中文名进库以后没法换语言。 */
export type PlanPeriod = 'month' | 'quarter' | 'year'
export const PLAN_PERIODS: PlanPeriod[] = ['month', 'quarter', 'year']

/**
 * 订单：某公司买了什么。**买套餐和充值走同一张表**——都是「一笔钱 + 一个付款状态」，
 * 分两张表只会让「这家公司一共下过几单」变成两处查。
 *
 * 套餐单：套餐内容在下单时**抄一份存进来**（planName/seats/金额/赠送/周期）。
 * 价目表随时会改，但已经签出去的订单不能跟着变——查历史订单要看到当时卖的是什么。
 * planId 只用来追溯是哪条 SKU，不作为展示来源。
 *
 * 充值单：只有金额和备注，seats/bonus 是 0，`endAt` 等于 `startAt`（充值没有账期）。
 */
export type OrderKind = 'plan' | 'topup'

/** 付款状态。只有这两种：钱到了没有。退款、部分付款这些还没有，别提前造。 */
export type PayStatus = 'unpaid' | 'paid'

export interface PlanOrder {
  id: string
  companyId: string
  kind: OrderKind
  planId: string | null
  planName: string
  planNameEn: string
  /** 充值单的备注。套餐单留空。 */
  note: string
  period: PlanPeriod
  seats: number
  amountMils: number
  bonusMils: number
  startAt: number
  endAt: number
  payStatus: PayStatus
  createdAt: number
  updatedAt: number
}

/**
 * 单独充值：给某家公司加一笔额度。
 *
 * 跟套餐赠送分开记，因为两者的规矩不一样：赠送的跟着套餐有效期走，套餐一到期没用完就清零；
 * 充值的**不过期**，用完为止。所以它们不能合成一个数存，得各算各的。
 */
export interface Topup {
  id: string
  companyId: string
  /** 是哪笔充值单付款之后开出来的。只有付了款才会有这条记录。 */
  orderId: string | null
  amountMils: number
  note: string
  /** 谁充的。账号删了就留 null，记录本身不跟着走。 */
  createdBy: string | null
  createdAt: number
}

/**
 * 账单：一条订单开一张。金额和账期在开单时抄下来——订单改了要跟着改，
 * 但账单是「这段时间该收多少钱」的凭据，不去实时算。
 */
export interface Invoice {
  id: string
  companyId: string
  orderId: string | null
  planName: string
  planNameEn: string
  amountMils: number
  periodStart: number
  periodEnd: number
  status: PayStatus
  paidAt: number | null
  createdAt: number
  updatedAt: number
}

export interface PlanSku {
  id: string
  /** 套餐名是**数据**，不是界面文案——译表翻不了它，只能两种语言各存一份。 */
  name: string
  nameEn: string
  /** 金额存「厘」（千分之一元）。钱不进浮点数；用厘是为了留出分以下的定价精度。 */
  amountMils: number
  seats: number
  /** 月包 / 季包 / 年包。默认月包。 */
  period: PlanPeriod
  /**
   * 赠送额度，跟金额一样按「厘」存、按美元显示。
   * 它是一笔钱（可以拿去买 token），不是 token 个数——所以要小数和 $ 符号。
   */
  bonusMils: number
  createdAt: number
  updatedAt: number
}

export interface Group {
  id: string
  companyId: string
  name: string
  desc: string
  icon: string
  role: 'admin' | 'member'
  members: string[]
  agents: string[]
  createdAt: number
}

export interface Machine {
  id: string
  /** 机器管家的基址 `http://<ip>:8443`。**Gateway 打这台机器的唯一入口。** */
  host: string | null
  /**
   * **浏览器**打这台机器的地址，`https://m001.example.com`。为空 = 不走直连。
   *
   * 只用在一个地方：桌面。填上之后 novncUrlOf 给出的是这台机器的绝对地址，像素
   * 直接从席位机器流到浏览器，不再经过 Gateway（实测那是整条链上最贵的一股）。
   *
   * 和 host 的要求完全不同，所以是两列（见迁移 0038）：这一列必须公网可达、必须
   * https（Gateway 的页面是 https，混合内容会被浏览器静默拦掉），而且最好和 Gateway
   * 同一个可注册域——SameSite 判的是 site 不是 origin，同站时管家那张 Lax cookie
   * 在 iframe 子框里才带得上。
   */
  directUrl: string | null
  companyId: string | null
  lastHeartbeatAt: number | null
  createdAt: number
  /** 配对完成的时刻。为空 = 还没装管家，部署会被挡下。 */
  pairedAt: number | null
  managerVersion: string | null
  /** 管家握手协议版本。整数，不解析 semver——太旧就不给它下发部署。 */
  protocol: number
  /** 管家上报的最近一次故障（升级失败等）。给界面看，不参与判定。 */
  lastError: string | null
  /**
   * 管家自报的 CPU 架构（`process.arch`，如 `x64` / `arm64`）。
   *
   * 发布包里带 esbuild 的原生二进制，装错架构起不来。选包按它过滤。
   * 为空 = 还没心跳过（老管家不报），那时退回「不按架构挑」的老行为。
   */
  arch: string | null
  /**
   * 这台机器最多承载几个**激活账号**。
   *
   * 计的是账号不是席位：一个员工的所有 bot 共用一个 uid 和 `~/work`，必须落在同一
   * 台机器上，所以调度单位只能是账号。账号名下再加 bot 不多占容量。
   */
  maxAccounts: number
  /**
   * 这台机器要用的时区（IANA 名，如 `Asia/Shanghai`）。空 = 不管，跟机器现状走。
   *
   * 和 `desiredManagerVersion` 一样是**期望值**：写在这里只是下指令，真正改的是
   * 管家（`timedatectl set-timezone`）。改完了没有由 `currentTimezone` 说了算。
   */
  timezone: string | null
  /** 管家心跳自报的机器**实际**时区。期望和实际分开，界面才说得清「改上了没有」。 */
  currentTimezone: string | null
  /**
   * 管家心跳自报的负载与日志占用（CPU、内存、各块盘、出网流量、journal 有多大）。
   *
   * 只存**最近一份**，不建流水表：这一格答的是「这台机器现在怎么样」。按 30 秒一行
   * 存下去，一台机器一个月就是八万多行，换来的是一条谁也不会去查的曲线——要趋势那
   * 是监控系统的活儿。
   *
   * 空 = 还没报过（老管家，或者刚起来还没采到第一份）。**心跳里两份都缺时整格不
   * 动**，不写一份空的进来盖掉上一轮（见 telemetryOf）。
   */
  telemetry: MachineTelemetry | null
  /**
   * 上面那份是什么时候**收到**的（Gateway 的钟），不是机器自报的采样时刻。
   *
   * 和 heartbeatAge 同一个理由：机器的钟可能是歪的，而界面上那句「3 分钟前」必须准。
   */
  telemetryAt: number | null
  /**
   * 这台机器的 journal 上限，MB。超过了管家自己清（`journalctl --vacuum-size`）。
   *
   * 和 `timezone`、`desiredManagerVersion` 一样是**期望值**：写在这里只是下指令，
   * 真正动手的是机器上的管家，心跳把它带下去。
   *
   * 空 = 没人指定过，跟管家的默认走（1 GB）；`0` = 明确不要它动 journal。两者不能
   * 合并——空当成 0 就把清理静默关掉了，而盘写满时连日志都写不进去。
   */
  logCapMb: number | null
  /**
   * 这台机器要追的管家版本。空 = 跟平台的全局期望版本走。
   *
   * 存在的理由是灰度：先把一台机器钉到新版本看几天，再改全局。没有它，「升级这台
   * 机器」这个按钮只能改全局设置，一按就是全机队。
   */
  desiredManagerVersion: string | null
  /**
   * 被移除的时刻。null = 在册。
   *
   * **这是一块墓碑，不是一台机器。** 平台上按「移除」之后，这一行对所有面向界面的
   * 查询等于不存在（见下面那批 `removedAt is null`），留着只为一件事：把「你被移除
   * 了」这个消息送到机器上——心跳是机器主动打的，Gateway 没有别的路子找它。
   *
   * 为什么不直接删了了事：删掉之后机器票就查不到，心跳只会拿到 401，而 401 是**否
   * 定式**信号（「我不认识你」）。Gateway 回滚版本、库恢复到旧快照、DNS 指错，都会
   * 让整个机队同时收到 401——管家要是据此自毁，那就是全机队自杀。墓碑让信号变成
   * **肯定式**的：我认识你，并且我告诉你你被移除了。
   *
   * 管家收拾完会回执（POST /internal/machines/:id/removed），那时才真删。它一直不
   * 来收信的话，超过 MACHINE_TOMBSTONE_TTL 由 sweepRemovedMachines 收掉。
   */
  removedAt: number | null
  token: string
}

/**
 * 一台机器某一分钟的负载归档（见迁移 0012）。
 *
 * 存的是 sum + samples 而不是平均值，累加才能是纯 `+`；平均值在读的时候除出来。
 * 峰值单独一列——一分钟里也可能一笔 5%、一笔 95%。
 */
export interface MachineMetricMinute {
  machineId: string
  /** 这一格的起点，**UTC 整分**的 epoch 毫秒。按哪本日历分天由界面决定。 */
  minuteStart: number
  /** 这一分钟收到几笔有效采样（心跳 30 秒一轮，通常 2 笔）。没有行 = 没有数据，不是 0%。 */
  samples: number
  cpuSum: number
  cpuMax: number
  memSum: number
  memMax: number
  diskSum: number
  diskMax: number
  /** 这一分钟**走了多少字节**（增量，不是计数器快照），可以直接相加成一小时、一天。 */
  txBytes: number
  rxBytes: number
}

export interface MachinePairing {
  code: string
  companyId: string
  createdBy: string | null
  createdAt: number
  expiresAt: number
  usedAt: number | null
  machineId: string | null
}

/** 新机器默认能装几个账号。够一个小团队，超了在界面上改。 */
export const DEFAULT_MAX_ACCOUNTS = 10

export type SeatRuntimeStatus = 'none' | 'deploying' | 'ready' | 'error'

/**
 * `status = 'deploying'` 这段里，**Gateway 自己知道的**那两档。
 *
 * - `queued`：席位行登记好了（槽位、端口都定了），还没把规格发给机器管家。
 * - `installing`：已经发出去了，机器上在装——十几分钟里的绝大部分都停在这一档。
 *
 * 机器**里面**那几步（装桌面包、装浏览器、起单元）不在这里：那是管家看得见、Gateway
 * 看不见的东西，现问现答（见 routes/runtime.ts 的 `/runtime/deploy/progress`），不落库。
 */
export type SeatDeployPhase = 'queued' | 'installing'

export interface SeatRuntime {
  accountId: string
  botId: string
  companyId: string
  /** 员工的 Linux 账号。同一员工的多个 bot **共用**它——共享文件靠的就是这个。 */
  linuxUser: string
  /** 席位标识：systemd 实例名与席位私有目录名。公司内唯一。 */
  seatId: string
  /**
   * 这个席位落在哪台机器上。
   *
   * 同一个账号的所有席位**必须**在同一台机器上——它们共用一个 uid 和 `~/work`，
   * 拆到两台机器上「共享文件」就不成立了。调度因此以账号为单位。
   */
  machineId: string
  slot: number
  display: number
  vncPort: number
  novncPort: number
  botPort: number
  vncPassword: string
  status: SeatRuntimeStatus
  lastError: string | null
  deployedAt: number | null
  updatedAt: number
  botVersion: string | null
  /**
   * 这台席位**自己报的**模版版本，以及 Gateway 收到那次汇报的时刻。
   *
   * 空 = 从来没报到过（老行、刚部署完还没探第一轮），不是「第 0 版」。
   *
   * **这两列不走 upsertSeatRuntime**：部署那条路只写它自己知道的东西，席位跑到第几版
   * 不在其中。要写用 db.noteSeatTemplate——否则每次重铺都会把席位刚报上来的数字盖成
   * 部署那一刻的旧值。
   */
  tplVersion: number | null
  tplSyncedAt: number | null
  /**
   * 这一次部署走到哪一档、从什么时候开始的。**只在 `status = 'deploying'` 期间有意义**，
   * 落地（ready / error）时一起清空。
   *
   * `deployStartedAt` 不能用 `updatedAt` 顶：那一列每写一次行都会动，答不了「已经装了
   * 多久」；也不是 `deployedAt`——那个记的是上一次**装完**的时刻。
   */
  deployPhase: SeatDeployPhase | null
  deployStartedAt: number | null
}

/**
 * 发布包的种类。
 *
 * `local-bot` 不能复用服务器的 `bot`：两者都带 esbuild 原生依赖，前者按 Desktop 的
 * 操作系统 + 架构构建，后者永远是 Linux 席位包。
 */
export type ReleaseKind = 'bot' | 'manager' | 'local-bot'

/**
 * 计费明细一页的默认条数与硬上限。
 *
 * 默认 20，和平台那四张长表的分页粒度一致（commit 06b4349）——那是「一屏能看清多少行」
 * 的答案，跟数据在哪切没关系。上限 200：再多的话一页的 JSON 比人一次能看的多一个数量级。
 */
export const CHARGE_PAGE_DEFAULT = 20
export const CHARGE_PAGE_MAX = 200

/** 会话索引一页的默认条数与硬上限。调用方可以调小，调不大。 */
export const SESSION_PAGE_DEFAULT = 500
export const SESSION_PAGE_MAX = 2000

/** 把调用方给的 limit 收进合法区间。路由和 db 用同一套，免得两边各算各的。 */
export function sessionPageLimit(raw?: number): number {
  const n = Math.trunc(raw ?? SESSION_PAGE_DEFAULT)
  if (!Number.isFinite(n)) return SESSION_PAGE_DEFAULT
  return Math.min(Math.max(n, 1), SESSION_PAGE_MAX)
}

/**
 * 从版本号尾巴认架构：`…-x64` / `…-arm64`。
 *
 * 架构是打包时定死的（包里带 esbuild 的原生二进制），而版本号是唯一跟着包走到机器上
 * 的东西，所以约定把它编进版本号尾巴——CI 和本地出包都这么打。
 * 认不出来返回 undefined，意思是「不知道」，不是「通用」：调用方按未知处理，
 * 别当成匹配任意架构。
 */
export function releaseArch(version: string): string | undefined {
  const m = /-(x64|arm64)$/.exec(String(version || ''))
  return m ? m[1] : undefined
}

export interface BotRelease {
  kind: ReleaseKind
  version: string
  sha256: string
  size: number
  createdAt: number
  note: string
  /**
   * 包的下载地址。空 = 字节在 Gateway 本机磁盘上（CI 传上来的那种）。
   *
   * 非空时 Gateway 不存字节，下发时从这个地址现取并流式转出去——**转而不是 302**，
   * 因为 `x-bot-sha256` 那个校验头要跟着响应走，重定向之后管家就拿不到了。
   */
  url: string
}

export interface CatalogItem {
  id: string
  kind: CatalogKind
  scope: Scope
  companyId: string | null
  /** `scope: 'user'` 时是这条的主人。别的层级为 null。 */
  accountId: string | null
  /**
   * 私有档 Skill 归哪颗 Bot。**只有 `kind='skill'` 且 `scope='user'` 时有值。**
   *
   * 一颗 Bot 攒下的方法，另一颗看不见——它们的活不一样，把客服学到的话术塞给数据
   * 分析那颗，是在用一条谁都没同意过的路径改它的行为。
   */
  botId: string | null
  name: string
  definition: unknown
  /** 删除前终审开始的时刻。非空时不再出现在可聊天名册里。 */
  deletingAt: number | null
  createdAt: number
  updatedAt: number
}

export interface Credential {
  id: string
  companyId: string
  provider: string
  secret: string
  createdAt: number
  updatedAt: number
}

export interface AuditEvent {
  id: string
  companyId: string
  accountId: string | null
  action: string
  detail: unknown
  createdAt: number
}

export type ConversationAuditModelRole = 'daily' | 'utility'
export type ConversationAuditBatchKind = 'scheduled' | 'pre_delete'
export type ConversationAuditBatchStatus = 'queued' | 'leased' | 'processing' | 'succeeded' | 'empty' | 'retry' | 'dead'
export type ConversationAuditOutcome = 'completed' | 'partial' | 'failed' | 'blocked' | 'answered' | 'unknown'

export interface ConversationAuditSettings {
  enabled: boolean
  timezone: string
  /** 第一版固定 09:00。 */
  anchor: '09:00'
  /** 第一版固定 480，即每天三个不重叠窗口。 */
  windowMinutes: 480
  modelRole: ConversationAuditModelRole
  retentionDays: number
  promptVersion: number
}

export function emptyConversationAuditSettings(): ConversationAuditSettings {
  return {
    enabled: true,
    timezone: 'UTC',
    anchor: '09:00',
    windowMinutes: 480,
    modelRole: 'daily',
    retentionDays: 180,
    promptVersion: 1,
  }
}

export function parseConversationAuditSettings(raw: unknown): ConversationAuditSettings {
  const base = emptyConversationAuditSettings()
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const retention = Math.trunc(Number(o.retentionDays))
  const version = Math.trunc(Number(o.promptVersion))
  return {
    enabled: o.enabled !== false,
    timezone: typeof o.timezone === 'string' && o.timezone.trim() ? o.timezone.trim() : base.timezone,
    anchor: '09:00',
    windowMinutes: 480,
    modelRole: o.modelRole === 'utility' ? 'utility' : 'daily',
    retentionDays: Number.isFinite(retention) ? Math.min(3650, Math.max(30, retention)) : base.retentionDays,
    promptVersion: Number.isFinite(version) && version > 0 ? version : base.promptVersion,
  }
}

export interface ConversationAuditBatch {
  id: string
  companyId: string
  accountId: string
  botId: string
  sessionId: string
  deletionRequestId: string | null
  kind: ConversationAuditBatchKind
  windowStart: number
  windowEnd: number
  timezone: string
  fromSeq: number
  toSeq: number
  eventCount: number
  turnCount: number
  status: ConversationAuditBatchStatus
  attempts: number
  leaseUntil: number | null
  nextTryAt: number | null
  lastError: string | null
  modelRole: ConversationAuditModelRole
  provider: string
  model: string
  reasoningEffort: ReasoningEffort
  promptVersion: number
  redactionVersion: number
  sourceHash: string
  resultHash: string
  createdAt: number
  startedAt: number | null
  completedAt: number | null
}

export interface ConversationAuditItem {
  id: string
  batchId: string
  companyId: string
  accountId: string
  botId: string
  sessionId: string
  botNameSnapshot: string
  accountNameSnapshot: string
  itemKey: string
  firstSeq: number
  lastSeq: number
  startedAt: number | null
  endedAt: number | null
  taskSummary: string
  timeline: { at: number; action: string }[]
  userQuestion: string
  modelAnswer: string
  finalResult: string
  outcome: ConversationAuditOutcome
  modelScore: number | null
  scoreBreakdown: Record<string, number>
  scoreConfidence: number | null
  evidence: string[]
  riskFlags: string[]
  createdAt: number
  expiresAt: number
}

export type BotDeletionStatus = 'freezing' | 'auditing' | 'ready_to_purge' | 'purging' | 'completed' | 'failed'
export interface BotDeletionRequest {
  id: string
  companyId: string
  accountId: string | null
  botId: string
  botNameSnapshot: string
  requestedBy: string
  status: BotDeletionStatus
  cutoffAt: number
  targetCount: number
  auditedCount: number
  attempts: number
  nextTryAt: number | null
  lastError: string | null
  orphans: { seatId: string; error: string }[]
  requestedAt: number
  auditCompletedAt: number | null
  deletedAt: number | null
}

/** Gateway 只存指针。正文永远不该出现在这张表里。 */
export interface SessionIndex {
  sessionId: string
  companyId: string
  accountId: string
  botId: string | null
  machineId: string | null
  origin: string | null
  remoteId: string | null
  messageCount: number | null
  title: string | null
  createdAt: number
  updatedAt: number
}

export type ChannelKind = 'telegram' | 'wechat_official' | 'wecom'
export type ChannelBindingStatus = 'binding' | 'active' | 'paused' | 'error'

export interface ChannelBinding {
  id: string
  companyId: string
  accountId: string
  botId: string
  kind: ChannelKind
  status: ChannelBindingStatus
  externalBotId: string
  externalUsername: string
  /** AES-GCM 密文；任何 public mapper 都不得带出去。 */
  credentialCiphertext: string
  webhookSecretHash: string
  publicId: string
  /** 一次性配对码只留摘要；明文和 token 一起放在 AES-GCM 密文里供本人页面读取。 */
  pairingCodeHash: string
  /** Telegram getUpdates 下一次要带的 offset，以及多 Gateway 之间的长轮询租约。 */
  pollOffset: number
  pollLeaseUntil: number | null
  lastPolledAt: number | null
  pollLastError: string | null
  config: { allowGroups?: boolean }
  lastReceivedAt: number | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface ChannelIdentity {
  id: string
  bindingId: string
  externalUserId: string
  externalUsername: string
  externalDisplayName: string
  pairedEventId: string
  pairedAt: number
  lastSeenAt: number
}

export type ChannelEventStatus = 'pending' | 'processing' | 'ready' | 'retry' | 'delivered' | 'dead'

/** 一轮渠道消息新开的转人工卡；随回复一起落盘，保证 Gateway 重启后仍能投递按钮。 */
export interface ChannelHandoffPrompt {
  id: string
  state: 'open' | 'claimed'
  reason: string
  ask: string
  summary?: string
  blocking: boolean
  repeats: number
  createdAt: number
  updatedAt: number
}

export interface ChannelEvent {
  id: string
  bindingId: string
  externalEventId: string
  externalConversationId: string
  remoteUserId: string
  remoteDisplayName: string
  title: string
  text: string
  status: ChannelEventStatus
  attempts: number
  nextTryAt: number | null
  leaseUntil: number | null
  /** 当前处理者的 fencing token；只有持有者可以续租和提交结果。 */
  leaseToken: string
  /** 最近一次发到 Telegram 的待审批短键与消息 id；用于重启接管时去重。 */
  approvalKey: string
  approvalMessageId: number | null
  sessionId: string | null
  reply: string
  /** 这一轮工具明确报出的产出文件；路径相对该席位工作区。 */
  files: { path: string; name: string }[]
  /** 这一轮新开的转人工卡；和 reply/files 一起可靠投递。 */
  handoffs: ChannelHandoffPrompt[]
  lastError: string | null
  createdAt: number
  updatedAt: number
  deliveredAt: number | null
}

export interface Instance {
  accountId: string
  botId: string
  companyId: string | null
  host: string
  lastReadyAt: number
}

export interface AccountSecrets {
  accountId: string
  apiKey: string
  accessToken: string
  createdAt: number
}

/**
 * 连接器：上架的那一条（`catalog_items` `kind='connector'`）的定义形状。
 *
 * **工具子集不在这里。** 开哪几个工具是**安装**上的选择——同一个 Gmail，行政要发邮件，
 * 研发只想读。放在上架定义里等于让 owner 替全平台所有人做这个决定。
 */
export interface ConnectorDef {
  vendor: string
  /** 供应商侧的 toolkit slug。上架之后会进流水表，不能改。 */
  toolkit: string
  /** 供应商侧的 auth config id。owner 配，公司和员工都看不见。 */
  authConfigId: string
  name: string
  description: string
  logo: string
  category: string
  multiAccount: boolean
  /** 沿用 MCP 的三档，只标注不拦截（和现有 MCP 的现状一致，不新造半成品）。 */
  perm: string
  enabled: boolean
  /**
   * 安装时默认开哪几个工具。owner 上架时挑。
   *
   * 空 = 不挑，安装时照旧写 `[]`（= 全开）。**这一格存在的理由是防线一**：GitHub 有
   * 500 个工具，默认全开的界面上员工要点 485 次才能剩下 15 个——「员工自己关」这条
   * 防线被默认值架空了（docs/tool-search.md §2）。
   */
  recommendedTools: string[]
}

/**
 * 公司那一层只存**否定**：默认放行，admin 可以禁。
 *
 * `connectorId` 指向全局那一条。**不靠 `name` 认亲**——名字是给人看的，会被改。
 */
export interface ConnectorBlockDef {
  connectorId: string
  blocked: boolean
  reason: string
}

export type ConnectionScope = 'user' | 'company'
export type ConnectionStatus = 'pending' | 'active' | 'failed' | 'revoked'

/** label 会进工具名前缀，所以限长限字符集。 */
export const CONNECTION_LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/
export const DEFAULT_CONNECTION_LABEL = 'default'
/** 公司共用那把的 label 固定，不可改、不可断（只能由 admin 删）。 */
export const COMPANY_CONNECTION_LABEL = 'company'

export interface ConnectorInstall {
  id: string
  connectorId: string
  accountId: string
  companyId: string
  /** 空数组 = 全开。存开着的那些，不是关掉的那些。 */
  enabledTools: string[]
  createdAt: number
  updatedAt: number
}

export interface ConnectorConnection {
  id: string
  connectorId: string
  vendor: string
  scope: ConnectionScope
  label: string
  accountId: string | null
  companyId: string
  externalUserId: string
  externalId: string | null
  status: ConnectionStatus
  /** 打开 = 不进默认工具表，只有本轮被 @ 点名才注入。 */
  mentionOnly: boolean
  lastError: string | null
  connectedAt: number | null
  createdAt: number
  updatedAt: number
}

export type ConnectorCallStatus = 'ok' | 'failed' | 'timeout' | 'denied' | 'error'

export interface ConnectorCall {
  id: string
  companyId: string | null
  accountId: string
  connectionId: string | null
  botId: string | null
  sessionId: string | null
  vendor: string
  connector: string
  label: string
  tool: string
  status: ConnectorCallStatus
  /** 微元（百万分之一美元）。这一笔一共收了多少。 */
  amountMicros: number
  /**
   * `amountMicros` 里由**套餐赠送**承担的部分，剩下的算充值。
   *
   * 分开记是因为赠送有账期、充值没有：合成一个数的话，套餐一到期，它已经花掉的部分
   * 会从充值余额上再被扣一遍（见迁移 0005）。
   */
  bonusMicros: number
  latencyMs: number
  viaMention: boolean
  createdAt: number
}

/** 我们这边的用户标识。**不用邮箱**：会变，而且是 PII，进了供应商侧就删不掉了。 */
export function externalUserIdOf(scope: ConnectionScope, id: string): string {
  return scope === 'company' ? `swc_${id}` : `sw_${id}`
}

export interface LlmCall {
  id: string
  accountId: string
  companyId: string | null
  provider: string
  model: string
  /** 整个提示词，含命中缓存的部分。 */
  promptTokens: number
  completionTokens: number
  /** promptTokens 里命中缓存的那一截，是子集不是加项。 */
  cachedTokens: number
  /**
   * promptTokens 里**这次写进缓存**的那一截。也是子集，也不是加项。
   *
   * 和 cachedTokens 分开记，因为单价不同：缓存读便宜一个数量级，缓存写反而比普通输入
   * 贵（Anthropic 是 1.25 倍）。混成一项的话，一次「写了 4000 token 缓存」的调用会
   * 按最便宜的那档收。
   */
  cacheWriteTokens: number
  createdAt: number
}

export type WebCallKind = 'search' | 'extract'

export interface WebCall {
  id: string
  accountId: string
  companyId: string | null
  kind: WebCallKind
  backend: string
  /** search 恒为 1；extract 记**真打了后端且抓成功**的条数——失败和命中缓存都不算。 */
  units: number
  /** 写行那一刻的报价，整数「厘」。 */
  mils: number
  createdAt: number
}

export interface LlmUsageByAccount {
  accountId: string
  calls: number
  promptTokens: number
  completionTokens: number
  lastAt: number | null
}

export interface LlmUsage {
  calls: number
  promptTokens: number
  completionTokens: number
  byAccount: LlmUsageByAccount[]
}

/** 平台统计的底表行。companyId 为 null 的是 owner 自己发起的调用。 */
export interface CompanyModelUsage {
  companyId: string | null
  provider: string
  model: string
  calls: number
  /** 整个提示词，**含**命中缓存的那一截。 */
  promptTokens: number
  completionTokens: number
  /** promptTokens 里命中缓存的那一截。是子集，不是加项——计价时要按缓存读的单价单算。 */
  cachedTokens: number
  /** promptTokens 里写进缓存的那一截。同样是子集，单价又是另一档。 */
  cacheWriteTokens: number
  /**
   * 这一组里账本上没有对应行的调用数。
   *
   * 金额只从账本来之后，「收了 $0」和「压根没记过账」在数字上长得一样，而后者是
   * 升级前所有历史调用的样子。界面要据此喊出来，别让 $0.00 被读成免费。
   */
  unledgeredCalls: number
  lastAt: number | null
}

export interface ModelRole {
  provider: string
  model: string
  /** pi-ai 的通用推理档位；off 保持旧配置「不启用推理」的行为。 */
  reasoningEffort: ReasoningEffort
}

export const REASONING_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = typeof REASONING_EFFORTS[number]

export function parseReasoningEffort(v: unknown): ReasoningEffort {
  return typeof v === 'string' && (REASONING_EFFORTS as readonly string[]).includes(v)
    ? v as ReasoningEffort
    : 'off'
}

export interface CompanySettings {
  daily: ModelRole
  utility: ModelRole
  conversationAudit: ConversationAuditSettings
}

export interface PlatformSettings {
  daily: ModelRole
  utility: ModelRole
  enabledModels?: string[]
  /** 对外报价相对模型原价的倍率。1 就是按原价，1.2 就是加两成。 */
  priceMultiplier?: number
  /**
   * 连接器的按次单价。
   *
   * 单位是**微元**（百万分之一美元）整数，不是别处那个厘（`amountMils`）——一次调用值
   * 半厘、三分之一厘都很正常，用厘存会被舍成 0，一整年的调用加起来收零块钱。
   * 换算只有一处：1 mil = 1000 micros。
   *
   * **这里没有倍率。** 模型那边有 `priceMultiplier`，是因为模型有原价（目录里的每百万
   * token 多少钱）可以加成；连接器没有——供应商收我们的是按席位按月的订阅，不是按次。
   * 硬套一个倍率只会让人以为存在一个不存在的成本基准。
   */
  connectorPricing?: { defaultMicros: number; byToolkit: Record<string, number> }
  /**
   * 全机队期望的管家版本。留空 = 跟最新发布走。
   *
   * 灰度就靠改这一个数字：心跳时下发，机器自己去换。回滚同理——把它改回上一版，
   * 下一轮心跳各台机器自己退回去。
   */
  managerVersion?: string
  /** 网页搜索/提取的后端与价目。密钥不在这里，在 platform_credentials。 */
  webTools?: WebToolsSettings
  /**
   * 模型单价的**平台覆盖**，键是 `provider/model`。
   *
   * 目录里的价（pi-ai 内置、自定义供应商自己填的）是默认值，这张表压在它上面。
   * 存在的理由有两个，都是真事：pi-ai 没收录价格的模型（zai 那批，目录里四项全是 0）
   * 得有地方补；上游调价的那天不该等 pi-ai 发版才能跟上。
   */
  modelPricing?: ModelPricing
  /** 熔断与透支。见 docs/billing.md §6。 */
  billing?: BillingSettings
}

/** 每 100 万 token 多少美元。四项，和 pi-ai 内置目录的 `cost` 同口径。 */
export interface ModelRate {
  input: number
  output: number
  /** 命中缓存读出来的那一截。Anthropic 是输入价的十分之一。 */
  cacheRead: number
  /** 这次写进缓存的那一截。Anthropic 是输入价的 1.25 倍——**比普通输入贵**。 */
  cacheWrite: number
}

/** 键是 `provider/model`（和 `enabledModels`、`/v1/models` 里的 id 一致）。 */
export type ModelPricing = Record<string, ModelRate>

export function emptyModelRate(): ModelRate {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

/** 单价一律收成非负有限数。负价和 NaN 都不是价，是手滑。 */
export function parseModelRate(raw: unknown): ModelRate {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const one = (v: unknown) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }
  return { input: one(o.input), output: one(o.output), cacheRead: one(o.cacheRead), cacheWrite: one(o.cacheWrite) }
}

/**
 * 覆盖表。**四项全是 0 的那条会被丢掉**——它和「没有覆盖」等价，留着只会让界面上
 * 多出一条看不出有什么用的记录，而删掉它的办法还得另找。
 */
export function parseModelPricing(raw: unknown): ModelPricing {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out: ModelPricing = {}
  for (const [k, v] of Object.entries(o)) {
    const key = String(k).trim()
    if (!key) continue
    const rate = parseModelRate(v)
    if (rate.input || rate.output || rate.cacheRead || rate.cacheWrite) out[key] = rate
  }
  return out
}

/**
 * 熔断开关。
 *
 * `enforce` 默认**开**：余额见底就拦。关掉它就是「影子计费」——照样落账，一律放行，
 * 用来在真开始收钱之前对一个账期的账。
 *
 * `graceMicros` 是允许透支多少。默认 0。它接的是这么一类情况：套餐昨天到期、续费的
 * 单子今天才走完流程，中间那半天不该整家公司哑掉。
 */
export interface BillingSettings {
  enforce: boolean
  graceMicros: number
}

export function emptyBilling(): BillingSettings {
  return { enforce: true, graceMicros: 0 }
}

export function parseBilling(raw: unknown): BillingSettings {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const grace = Math.trunc(Number(o.graceMicros))
  return {
    // 老库里没有这个字段。回落成**开**：默认值是拍板定的，不能因为库里是空的就变成关。
    enforce: o.enforce == null ? true : o.enforce === true,
    graceMicros: Number.isFinite(grace) && grace > 0 ? grace : 0,
  }
}

/** 一次计费调用是哪一类。第四类出现时加在这里，账本表的 check 也要跟着改。 */
export type ChargeKind = 'llm' | 'connector' | 'web'

/** 和 ConnectorCallStatus 同一套值，故意的：三条路的结局分类必须能横着比。 */
export type ChargeStatus = ConnectorCallStatus

/**
 * 账本的一行 = 一次计费调用。**钱只在这里**，领域表只记事实。
 *
 * 金额在写行那一刻定死，之后只 sum，绝不按当前单价重算——单价是我们改得动的东西，
 * 重算意味着上个月的账单每天都不一样（同 connectors.md §9）。
 */
export interface UsageCharge {
  id: string
  /** null = owner 自己的调用：记账，但没有公司余额可扣。 */
  companyId: string | null
  accountId: string
  botId: string | null
  sessionId: string | null
  kind: ChargeKind
  /** 人读得懂的收费对象：`anthropic/claude-haiku-4-5` / `gmail:GMAIL_SEND_EMAIL`。 */
  subject: string
  status: ChargeStatus
  /** 计量。llm 是四项 token，web 是 `{ units }`，connector 是空对象（恒为一次）。 */
  quantity: Record<string, number>
  /** 写行那一刻的单价快照。llm 是 ModelRate，另两条是 `{ unit }`。 */
  unitPrice: Record<string, number>
  multiplier: number
  amountMicros: number
  /** amountMicros 里由套餐赠送承担的部分，差额算充值。 */
  bonusMicros: number
  /** 查不到单价。金额 0，但不是免费——界面要说出来。 */
  unpriced: boolean
  refId: string | null
  createdAt: number
}

/** 能挂网页工具的后端。`firecrawl` 只占位，还没接。 */
export const WEB_BACKENDS = ['tavily', 'searxng', 'duckduckgo', 'firecrawl'] as const
export type WebBackendId = (typeof WEB_BACKENDS)[number]

/**
 * PDF / Word / Excel 是 Gateway **自己**取回来的，提取后端一次都没被调用。
 *
 * 所以它不能记在提取后端头上：`web_calls.backend` 写着 tavily、而 Tavily 根本没跑，
 * 统计里「按后端」那张表就在撒谎。给它一个自己的名字和自己的单价——真实成本是我们
 * 的带宽和内存，跟买来的搜索额度不是一回事，本来也该分开定价。
 */
export const WEB_DOCUMENT = 'document'

/** 能定价的条目 = 后端 ∪ 自取文档。**不是**能选的后端，document 不进那两个下拉。 */
export const WEB_PRICEABLE = [...WEB_BACKENDS, WEB_DOCUMENT] as const

/** 单价，整数「厘」（千分之一美元），每次调用。和账单那套的单位一致。 */
export interface WebToolPrice {
  search: number
  extract: number
}

export interface WebToolsSettings {
  /** 空 = 没配。**不做自动检测**：配了哪把密钥就悄悄换一家后端，界面和实际会对不上。 */
  searchBackend: WebBackendId | ''
  extractBackend: WebBackendId | ''
  /** 自托管 SearXNG 的实例地址。不是密文，所以不进凭证表。 */
  searxngUrl: string
  pricing: Record<string, WebToolPrice>
  /** 一家公司一天最多几次调用。0 = 不限。防的是跑飞，不是精确计费。 */
  dailyLimit: number
}

export function emptyWebTools(): WebToolsSettings {
  return { searchBackend: '', extractBackend: '', searxngUrl: '', pricing: {}, dailyLimit: 0 }
}

function parseWebPrice(raw: unknown): WebToolPrice {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const mils = (v: unknown) => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) && n >= 0 ? n : 0
  }
  return { search: mils(o.search), extract: mils(o.extract) }
}

export function parseWebTools(raw: unknown): WebToolsSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const backend = (v: unknown): WebBackendId | '' =>
    WEB_BACKENDS.includes(v as WebBackendId) ? (v as WebBackendId) : ''
  const pricing: Record<string, WebToolPrice> = {}
  const rawPricing = (o.pricing && typeof o.pricing === 'object' ? o.pricing : {}) as Record<string, unknown>
  for (const id of WEB_PRICEABLE) {
    if (rawPricing[id] != null) pricing[id] = parseWebPrice(rawPricing[id])
  }
  const limit = Math.round(Number(o.dailyLimit))
  return {
    searchBackend: backend(o.searchBackend),
    extractBackend: backend(o.extractBackend),
    searxngUrl: typeof o.searxngUrl === 'string' ? o.searxngUrl.trim() : '',
    pricing,
    dailyLimit: Number.isFinite(limit) && limit > 0 ? limit : 0,
  }
}

/** 倍率的合法区间。0 会把报价抹平成免费，上限挡住一个手滑多打的零。 */
export const PRICE_MULTIPLIER_MIN = 0.01
export const PRICE_MULTIPLIER_MAX = 100

export function parsePriceMultiplier(v: unknown, fallback = 1): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n < PRICE_MULTIPLIER_MIN || n > PRICE_MULTIPLIER_MAX) return fallback
  return n
}

export function emptySettings(): CompanySettings {
  return {
    daily: { provider: '', model: '', reasoningEffort: 'off' },
    utility: { provider: '', model: '', reasoningEffort: 'off' },
    conversationAudit: emptyConversationAuditSettings(),
  }
}

export function emptyPlatformSettings(): PlatformSettings {
  return {
    daily: { provider: '', model: '', reasoningEffort: 'off' },
    utility: { provider: '', model: '', reasoningEffort: 'off' },
    enabledModels: [],
    priceMultiplier: 1,
    connectorPricing: emptyConnectorPricing(),
    managerVersion: '',
    webTools: emptyWebTools(),
    modelPricing: {},
    billing: emptyBilling(),
  }
}

/** 默认不收钱。定价是商务决定，代码不替它拍一个数。 */
export function emptyConnectorPricing(): { defaultMicros: number; byToolkit: Record<string, number> } {
  return { defaultMicros: 0, byToolkit: {} }
}

/** 单价一律收成非负整数微元。负价和小数都不是价，是手滑。 */
export function parseConnectorPricing(v: unknown): { defaultMicros: number; byToolkit: Record<string, number> } {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  const micros = (x: unknown) => {
    const n = Number(x)
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0
  }
  const raw = o.byToolkit && typeof o.byToolkit === 'object' && !Array.isArray(o.byToolkit) ? (o.byToolkit as Record<string, unknown>) : {}
  const byToolkit: Record<string, number> = {}
  for (const [k, val] of Object.entries(raw)) {
    const key = String(k).trim().toLowerCase()
    if (key) byToolkit[key] = micros(val)
  }
  return { defaultMicros: micros(o.defaultMicros), byToolkit }
}

// ── 日常任务（routine）────────────────────────────────────────────────

/**
 * 一个触发器。
 *
 * 现在只有 `schedule` 一种，但它是**判别联合**而不是几个平铺的字段：Slack 消息、
 * Git 事件、Webhook 这些迟早要进来，它们和「每天九点」除了「都会让这条 routine 跑
 * 起来」以外没有任何共同字段。判别联合让新一种只是多一个成员，老的那种一个字段都
 * 不用动；平铺的话，第二种进来的当天，一半的列对一半的行是空的。
 */
export interface RoutineSchedule {
  kind: 'schedule'
  /** 多久一次。`hour` 只看分钟，`week` 看 `weekday`，`month` 看 `day`。 */
  every: 'hour' | 'day' | 'week' | 'month'
  /** 本地时间的 `HH:MM`（24 小时制）。`hour` 只用它的分钟部分。 */
  at: string
  /** 周几，0 = 周日。`every: 'week'` 才用得上。 */
  weekday: number
  /** 几号。`every: 'month'` 才用得上；该月没有这一天就落在最后一天。 */
  day: number
  /**
   * 这个「九点」是哪儿的九点，IANA 名。
   *
   * **存在触发器里，不是运行时去问机器。** 人设的是他自己的九点；机器时区是运维
   * 后来可能改的东西，让它决定已经设好的任务什么时候跑，等于某天早上所有人的日报
   * 都提前了八小时，而界面上那行字一个字都没变。
   */
  tz: string
}

export type RoutineTrigger = RoutineSchedule

/**
 * 这一条到点了用哪个模型跑。
 *
 * - `utility` —— 平台钉的 utility 模型。**默认就是它**：定时任务是「一天一次、没人
 *   在等着看」的活，而它每天都跑；把它压在便宜的那一档上，省下来的是每个人、每条
 *   任务、每一天的一份 token。
 * - `daily` —— **不覆盖**，跟这个 Bot 平时聊天用的那个模型走（那个模型本身没指定时
 *   才回落到平台的日常模型，见 lib/catalog.ts 的 defaultBotModel）。写「跟平时一样」
 *   而不是「钉到平台日常模型」，是因为管理员给某颗 Bot 单独挑过模型的话，那句挑选
 *   同样该在定时任务里作数——人选这一档要的就是「和我自己问它时一模一样」。
 */
export type RoutineModelRole = 'daily' | 'utility'

/** 认不出来的一律当 utility——这个字段只有两种值，而默认那一档是省钱的那个。 */
export function parseRoutineModelRole(v: unknown): RoutineModelRole {
  return String(v ?? '') === 'daily' ? 'daily' : 'utility'
}

export interface Routine {
  id: string
  botId: string
  accountId: string
  companyId: string
  name: string
  instruction: string
  active: boolean
  triggers: RoutineTrigger[]
  /** 用哪个模型跑。默认 utility——理由见 RoutineModelRole。 */
  modelRole: RoutineModelRole
  /** 下一次什么时候跑。null = 不排（停用、没触发器、或者算不出来）。 */
  nextRunAt: number | null
  /**
   * 欠着的那次重试排在什么时候。null = 不欠（绝大多数时候的样子）。
   *
   * **和 `nextRunAt` 分开两列**，不是把重试写回下一次那一格：写回去的话，一次失败
   * 会把「每天 21:00」挪成「21:05」，而界面上那行「下一次」也跟着变——人看到的是
   * 自己设的时间被系统改掉了。重试是这一次的补救，排期是排期，两件事。
   */
  retryAt: number | null
  /** 这一串已经补跑过几次。跑成了、或者到点开始新的一次，都归零（见 routines.ts）。 */
  retryCount: number
  /**
   * **没有 `lastRunAt` 这一列。** 「上一次是什么时候、跑成没跑成」的唯一出处是
   * `routine_runs`。在这儿再存一份的话，它只能记「上一次被调度器抢到」——而抢到之后
   * 还可能因为指令空着、错过太久、上一轮没跑完而根本没跑，于是这个字段会在界面上
   * 说一件不曾发生的事。
   */
  createdAt: number
  updatedAt: number
}

/**
 * 一条长期记忆（见 docs/memory.md）。
 *
 * **是"事实"不是"方法"**：一句话说得完的进这里，有步骤有分支的进私有档 Skill
 * （docs/memory.md §1）。判据是"要不要展开"——一段流程值得单独打开来读，一句事实
 * 展开了还是它自己。
 *
 * 每一条都会**逐字进入系统提示词**，而且是每一轮。所以这张表上的每个上限（正文长度、
 * 条数）都不是洁癖，是每轮都要付一次的钱。
 */
export type MemoryLayer = 'bot' | 'self' | 'group' | 'company'
/**
 * **没有「流程」。** 界面上「记录哪些内容」那一格里的「流程」不是一种存法，它决定的是
 * "撞上一段流程时说哪一句话"——因为流程根本不存进这张表（docs/memory.md §6）。
 */
export const MEMORY_ITEM_KINDS = ['偏好', '事实', '联系人'] as const
export type MemoryKind = (typeof MEMORY_ITEM_KINDS)[number]

export interface Memory {
  id: string
  layer: MemoryLayer
  companyId: string
  /** layer = bot/self 时是本人；上面两层为 null。 */
  accountId: string | null
  /** **只有 layer = 'bot' 有。** self 层留空，理由见迁移 0018 的文件头。 */
  botId: string | null
  groupId: string | null
  kind: MemoryKind
  text: string
  /** 谁写的。审计和界面要分得出人和 Bot。 */
  by: 'agent' | 'user'
  /** 哪条会话里记下的（by = 'agent' 时有）。用来回答"它怎么知道这件事的"。 */
  sourceSessionId: string | null
  /** 席位扫出来的敏感类型。**Gateway 只存不判**，判据在 bot/src/policy/pii.ts。 */
  pii: string[]
  /** 钉住的不参与注入上限的挤压、也不过期。 */
  pinned: boolean
  /** null = 永久。到期只停止注入，不删。 */
  expiresAt: number | null
  createdAt: number
  updatedAt: number
}

export function parseMemoryLayer(v: unknown): MemoryLayer {
  const s = typeof v === 'string' ? v.trim() : ''
  return s === 'self' || s === 'group' || s === 'company' ? s : 'bot'
}

export function parseMemoryKind(v: unknown): MemoryKind {
  const s = typeof v === 'string' ? v.trim() : ''
  return (MEMORY_ITEM_KINDS as readonly string[]).includes(s) ? (s as MemoryKind) : '事实'
}

/** 敏感类型标记。**不解释、不判断**，原样搬运，最多留 8 个。 */
export function parseMemoryPii(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()))].slice(0, 8)
}

/**
 * 一张转人工的交接单（见 docs/handoff.md）。
 *
 * **`accountId` 是这颗 Bot 归谁，`assignee` 是该谁处理，`claimedBy` 是谁真的接了。**
 * 三个都存着，因为它们经常不是同一个人——而事后要问的恰恰是「这件事本该谁做、
 * 实际谁做了」。
 */
export interface Handoff {
  id: string
  sessionId: string
  botId: string
  accountId: string
  companyId: string
  machineId: string | null
  state: HandoffState
  /** 指派解算之后的结果。**null = 全体管理员**。 */
  assignee: string | null
  claimedBy: string | null
  blocking: boolean
  repeats: number
  reason: string
  ask: string
  /** 催办推到第几档：0 没推过，1 推过一次，2 已升级给管理员。 */
  notifyStep: number
  createdAt: number
  claimedAt: number | null
  returnedAt: number | null
  closedAt: number | null
  updatedAt: number
}

export type HandoffState = 'open' | 'claimed' | 'returned' | 'closed' | 'expired' | 'cancelled'

/** 还没闭合的那几个状态。待办页、催办扫描、日常任务抑制看的都是这一组。 */
export const HANDOFF_LIVE: HandoffState[] = ['open', 'claimed', 'returned']

export const HANDOFF_STATES: HandoffState[] = [...HANDOFF_LIVE, 'closed', 'expired', 'cancelled']

export type RoutineRunStatus = 'running' | 'ok' | 'error'
/**
 * 这一次是谁敲的。
 *
 * `retry` 单独算一种，不并进 `schedule`：流水那一列上，「到点跑的」和「上一次砸了
 * 补的」是两件要分得开的事——一条每天都要补跑一次才成的任务，并在一起看就是一列
 * 正常的绿勾，而它其实每天都在第一跳上摔一次。
 */
export type RoutineRunTrigger = 'schedule' | 'manual' | 'retry'

export interface RoutineRun {
  id: string
  routineId: string
  botId: string
  accountId: string
  companyId: string
  trigger: RoutineRunTrigger
  status: RoutineRunStatus
  sessionId: string | null
  error: string | null
  startedAt: number
  endedAt: number | null
  /**
   * 该由谁跑这一次：机器 id，或本地 Bot 的 `desktop:<accountId>`。null = 谁都跑不了、Gateway
   * 直接记成 error 的那种（管家太旧、Bot 没部署，routines.ts 的 noteUnrunnable）。见迁移 0039。
   */
  machineId: string | null
  /**
   * 租约到期时刻。null 且 status = running = 试跑登记了、还没人来领（requestManualRun）；
   * 领走那一刻填上，此后到点没续就记成「机器没回报」。
   */
  leaseUntil: number | null
}

/** 一条 routine 最多挂几个触发器。多到这个数就不是「什么时候跑」，是另一个功能了。 */
export const ROUTINE_MAX_TRIGGERS = 8
/** 运行流水只留最近这么多条，再往前的定时删掉——它是「昨晚跑没跑」，不是审计。 */
export const ROUTINE_RUNS_KEEP = 50

/**
 * jsonb 里那一坨 → 触发器数组。**认不出来的一律丢掉，不抛。**
 *
 * 这条既是读库时的解析，也是写库前的校验——两边同一个函数，库里就不会出现一种
 * 「存得进去、读出来是别的东西」的形状。丢掉而不是报错，是因为读的那一路没人接得住
 * 异常：一条脏数据会让整个列表打不开，而它本该只是少一个触发器。
 */
export function parseRoutineTriggers(v: unknown): RoutineTrigger[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? safeArray(v) : []
  const out: RoutineTrigger[] = []
  for (const item of raw.slice(0, ROUTINE_MAX_TRIGGERS)) {
    const o = (item ?? {}) as Record<string, unknown>
    if (String(o.kind ?? '') !== 'schedule') continue
    const every = String(o.every ?? 'day')
    if (every !== 'hour' && every !== 'day' && every !== 'week' && every !== 'month') continue
    /**
     * **没写的字段给默认值，写了但不对的一律丢掉。** 这两件事必须分开：
     *
     * 前者是省事（每天那一档用不上 `weekday`，不该逼调用方填一个假的）；后者一旦
     * 也当成「给个默认值」，`weekday: 7`（把周日写成 7 是最自然的手滑）就会静静地
     * 变成周一——接口回 200，界面上写着「每周一」，人只会以为是自己记错了。丢掉之后
     * 条数对不上，路由层那一关就会把它变成 400（见 routes/routines.ts 的 triggersOf）。
     */
    const at = o.at == null ? '09:00' : String(o.at)
    if (!/^\d{1,2}:\d{2}$/.test(at)) continue
    const [h, m] = at.split(':').map((x) => Number(x))
    if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) continue
    const weekday = o.weekday == null ? 1 : Math.trunc(Number(o.weekday))
    if (!(weekday >= 0 && weekday <= 6)) continue
    const day = o.day == null ? 1 : Math.trunc(Number(o.day))
    if (!(day >= 1 && day <= 31)) continue
    out.push({
      kind: 'schedule',
      every,
      at: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
      weekday,
      day,
      tz: canonicalTimezone(String(o.tz ?? '')) || 'UTC',
    })
  }
  return out
}

function safeArray(s: string): unknown[] {
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/**
 * IANA 时区名 → 规范拼写；认不出来返回空串。
 *
 * 判据是「Intl 认不认」而不是一张名单：名单会过期（时区数据库每年都在改），而
 * 认不认得出来这件事，唯一有资格回答的就是待会儿真要拿它算时间的那个 Intl。归一到
 * 规范拼写是必须的（`asia/shanghai` → `Asia/Shanghai`）——机器那边「改上了没有」是按
 * 字符串比的，两边不走同一套拼法就永远判错（见 deploy.ts 的 normalizeTimezone）。
 *
 * 字符集和长度先挡一道：这个值会被拼进机器上的 `timedatectl set-timezone`。
 */
export function canonicalTimezone(raw: string): string {
  const tz = (raw || '').trim()
  if (!tz) return ''
  if (tz.length > 64 || !/^[A-Za-z0-9+_-]+(\/[A-Za-z0-9+_-]+)*$/.test(tz) || tz.includes('..')) return ''
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone || tz
  } catch {
    return ''
  }
}
