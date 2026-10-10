/**
 * 全局 state，外加围着它转的那些小工具：转义、金额与时间、角色判断、路径解析。
 *
 * 都是纯函数，不发请求、不碰 DOM——发请求的在 data.js，画东西的在 pages-*.js。
 */
const state = {
  me: null,
  path: '/',
  rail: false,
  /** 窄屏上侧栏抽屉开着没有（见 render.js 的 appView）。宽屏用不到它，那一档看 rail。 */
  drawer: false,
  /**
   * 公司管理员侧栏各分类的展开状态。
   *
   * **键没写进来的一律当展开**（render.js 里那句 `!== false`），以后新增分类不用
   * 回这儿补一行。「公司」是唯一一个明写 false 的：那八条是管理员偶尔才去一趟的
   * 后台（席位、审计、账单…），而侧栏上面就是每天要点的 Bot 名单——默认摊开八行，
   * 名单会被挤得只剩两三个，每次进来都得先滚一段才看得见自己的 Bot。
   *
   * 折不折是**这一次会话里的事**，不落盘：展开之后刷新一下又收回去。这条如果哪天
   * 要改成记住，改的是这里的取值来源，不是上面那条 `!== false`。
   */
  navGroupOpen: { company: false },
  /** Desktop 壳的升级状态（self_update.rs 的 UpdateView）。浏览器里永远是 null，见 shell.js 的 desktopUpdateBridge。 */
  desktopUpdate: null,
  busy: false,
  loginError: '',
  loginEmail: '',
  loginPassword: '',
  needsSetup: false,
  setupError: '',
  setupEmail: '',
  setupName: '',
  error: '',
  notice: '',
  catalog: [],
  /** 模型自动发现的状态；null = 没拿到（非 owner，或接口挂了）。 */
  discovery: null,
  /** 能挑的生图模型（/platform/image-models）；null = 没拿到（非 owner，或接口挂了）。 */
  imageModels: null,
  creds: [],
  settings: {
    daily: { provider: '', model: '', reasoningEffort: 'off' },
    utility: { provider: '', model: '', reasoningEffort: 'off' },
  },
  selectedProvider: '',
  accounts: [],
  seats: { total: 0, used: 0 },
  events: [],
  sessions: [],
  sessionDetail: null,
  sessionEvents: null,
  sessionPullError: '',
  auditItems: [],
  /**
   * 审计总结的翻页：游标栈，最后一个是当前页的起点（null = 第一页）。和计费明细同一种做法，
   * 往回翻是弹栈，不用接口支持「上一页」。换筛选条件时整个栈清回第一页。
   */
  auditCursors: [null],
  auditNextCursor: null,
  auditLoading: false,
  auditFilterOptions: { accounts: [], bots: [] },
  auditAccountId: '',
  auditBotId: '',
  auditFrom: '',
  auditTo: '',
  auditItemDetail: null,
  auditCoverage: [],
  auditSettings: null,
  sessionAccountId: '',
  sessionFrom: '',
  sessionTo: '',
  org: null,
  plan: null,
  orgs: [],
  users: [],
  addOpen: false,
  orgCreateOpen: false,
  // 建公司的报错留在弹窗里。弹窗盖着列表，flash 画在列表上等于没画。
  orgCreateError: '',
  planSkus: [],
  orders: [],
  /** null = 不开；{ id: '' } = 新建；{ id: '<id>' } = 改这条。 */
  orderEdit: null,
  orderError: '',
  /** 某家公司的充值记录（公司详情用）。充值单付款后才会有。 */
  orgTopups: [],
  /** 公司详情的两笔余额：套餐赠送（跟套餐到期）与单独充值（不过期）。 */
  balance: null,
  /**
   * null = 不开；{ id: '' } = 新增；{ id: '<id>' } = 改这条。
   * `draft` 只在保存失败后才有：重名被打回来时得把人刚填的留在框里，
   * 不然 render 会拿库里的旧值把它盖掉，报着「已存在」却显示旧名字。
   */
  planSkuEdit: null,
  planSkuError: '',
  tests: {},
  /** 平台工具配置（/platform/tools/web 的整份响应）。null = 还没拉。 */
  webTools: null,
  toolsTab: 'web',
  savingMultiplier: false,
  savingDefaultRate: false,
  /** 统计页：窗口口径、选中的公司、选中的月份，以及接口回来的那份数据。 */
  statsRange: 'today',
  statsMonth: '',
  statsCompany: '',
  stats: null,
  statsLoading: false,
  /** 自定义供应商（pi-ai createProvider 的形状），来自 /platform/providers。 */
  customProviders: [],
  customApis: [],
  /** 「添加自定义供应商」弹窗里那份草稿；null 表示没开。 */
  providerDraft: null,
  providerError: '',
  /** 正在编模型清单的那个自定义供应商 id。 */
  modelsFor: '',
  modelDraft: null,
  /** 改价弹层：{ key, catalog, input, output, cacheRead, cacheWrite }。 */
  priceDraft: null,
  priceError: '',
  /** 改一行金额的弹层：{ id, subject, createdAt, amountMicros, amount（美元字符串）, note }。 */
  chargeEdit: null,
  chargeEditError: '',
  /** 按筛选重算的弹层：{ filter, preview（接口回的预览）, applying }。 */
  recalc: null,
  inviteOpen: false,
  inviteLink: '',
  inviteEmail: '',
  inviteExpiresAt: 0,
  inviteCopied: false,
  inviteError: '',
  inviteForm: { name: '', email: '', role: 'member', ttlDays: 7 },
  editing: null,
  editForm: { name: '', role: 'member', status: 'active' },
  editLink: '',
  editCopied: false,
  menu: null,
  menuFlip: false,
  confirm: null,
  secret: null,
  joinInvite: { loading: true, valid: false, email: '', name: '', expiresAt: 0, error: '' },
  joinForm: { name: '', password: '', confirm: '' },
  joinError: '',
  groups: [],
  accountsTab: 'members',
  groupDialog: null,
  groupForm: { name: '', desc: '', icon: 'chat', role: 'member', members: [] },
  groupError: '',
  profileDraft: null,
  profileSaved: false,
  profileError: '',
  pwOpen: false,
  pwForm: { current: '', next: '', confirm: '' },
  pwError: '',
  notifyOff: [],
  bots: [],
  bot: null,
  botDraft: null,
  botOptions: { skills: [], mcps: [], groups: [], kbs: [] },
  /** 公司的 Bot 模版（已生效的那一版）与手上这份草稿。 */
  template: null,
  templateDraft: null,
  templateOptions: { skills: [], mcps: [] },
  // 席位跟上模版没有。接口只给管理员，所以 null = 没有这一格，不是「一台席位都没有」。
  templateSync: null,
  /** 「新建 Bot」弹窗那份表单；null 表示没开。 */
  newBot: null,
  newBotError: '',
  skills: [],
  mcpServers: [],
  skillTags: [],
  skillsTab: 'Skill',
  skillDialog: null,
  skillForm: null,
  skillError: '',
  skillFile: null,
  skillEntries: null,
  skillTagManage: false,
  skillTagAdding: false,
  skillFailure: '',
  billing: null,
  billingTab: 'sub',
  /**
   * 计费明细一页。**服务端分页**，不是前端切页——账本一家公司一天就能几千行。
   *
   * `cursors` 是往回翻用的游标栈：游标分页只知道「下一页从哪开始」，不记着来路就
   * 只能单向走。栈顶是当前页的起点，null 表示第一页。
   */
  charges: null,
  chargesLoading: false,
  chargesKind: '',
  chargesCursors: [null],
  billingAutoRenew: null,
  usage: null,
  usageRange: null,
  runtimeBots: [],
  /**
   * 公司名下有没有配对好的运行机器（GET /runtime/bots 的 hasMachine）。`null` = 还没拉到，
   * 那时一律按「有」对待——拿不准的时候不藏东西、不改默认。
   */
  runtimeHasMachine: null,
  runtimeError: '',
  machine: null,
  /** 这台机器上现在跑着什么：管家版本、各 bot 版本的席位数、有没有更新的版本。 */
  /** 这家公司的机器列表（每台带负载和版本）。 */
  machines: [],
  machineCapacity: null,
  /** 平台机器管理页：全平台的机器列表 + 汇总。和上面那个 machines（某家公司的）分开存，
      不然从公司详情点回列表会看到上一家公司剩下的那几台。 */
  allMachines: [],
  machineTotals: null,
  /** 列表页的通联筛选：'' = 全部，其余就是 machineLink 的四个值。 */
  machineFilter: '',
  /**
   * 各张长列表翻到第几页，按列表的名字存（见 pageSlice）。
   *
   * 存在这里而不是各页自己留一个字段，是因为「翻到第几页」和筛选、tab 一样是**看的
   * 姿势**，不是数据：从列表点进详情再退回来，人要回到刚才那一页，而不是被扔回第一页。
   * 一整份对象重置的时机只有一个——退出登录（见 app.js 里 act === 'logout' 那一段，
   * 它逐条清掉上一个账号留下的东西），那时翻到第几页也跟着作废。
   */
  listPage: {},
  /** 机器详情页那一份：卡片、席位清单、可改派的公司清单。 */
  machineDetail: null,
  /**
   * 机器负载那一块看的是哪一档：`live`（机器自报的最近一份）| `day`（按分钟归的档）。
   *
   * 和列表的筛选、翻页一样是**看的姿势**，不是数据——从详情退回列表再进来，人还想
   * 停在刚才那一档上。
   */
  machineLoadTab: 'live',
  /** 日视图看哪一天（`YYYY-MM-DD`，浏览器本地日历）。空 = 今天，跨了零点也不会僵住。 */
  machineLoadDate: '',
  /**
   * 拉回来的分钟格，连同它是**给谁拉的**（`机器|day|日期`）。
   *
   * 带着 key 存，是因为换机器、换日期之后旧数据还在内存里：不比对的话，新的一份没
   * 到之前会拿上一天的曲线顶着画一整屏——那比空着糟得多（同 machineDetail 那条）。
   */
  machineLoadMinutes: null,
  machineLoadBusy: false,
  machineLoadError: '',
  botLatest: null,
  /** 平台钉的 Bot 版本（机器配置页那一格），空 = 跟最新走。 */
  botDesired: '',
  managerLatest: null,
  managerReleases: null,
  /** 机器配置页当前 tab：manager | bot。 */
  machineTab: 'manager',
  /** 哪个 kind 的「新增版本」是展开的。提交失败时保持展开，不然填的东西白填了。 */
  addRelease: '',
  /** 刚生成的配对码。只在内存里——刷新就没了，界面上也是这么说的。 */
  pairingCode: null,
  seatMember: null,
  seatRuntime: null,
  seatRuntimes: [],
  seatReveal: false,
  seatError: '',
  userDetail: null,
  userReveal: { apiKey: false, accessToken: false },
  runtimeMachine: null,
  desktopRuntime: null,
  /** 桌面票签发的时刻。票只有五分钟，内嵌那块屏要重挂时得先看看它还新不新。 */
  desktopRuntimeAt: 0,
  /** 内嵌桌面是不是正撑成全屏。侧栏那块是预览，点开才接管键鼠。 */
  deskFull: false,
  deploying: false,
  /**
   * 运行日志面板。null 表示没开着；开着时是
   * `{ title, active, sources: [{ key, label, url }] }`——见 chat.js 的 openLogs。
   */
  logsOpen: null,
  logLines: [],
  logError: '',
  deployHint: '',
  /**
   * 正在装的那颗 Bot 的安装进度：
   * `{ botId, status, phase, elapsedMs, since, lastError, stale, step: {…} | null }`。
   *
   * **带着 botId**：这一份是轮询回来的，人在两次回执之间换了 Bot 是常事，不认名字就会
   * 把上一个 Bot 的进度画在这一页上（见 chat.js 的 deployProgressNow）。
   *
   * `since` 是**本地**锚点（`Date.now() - elapsedMs`，收到那一刻算一次）。服务端给的是
   * 年龄不是时刻——两台钟差几分钟是常事，而读秒正是个时间问题（见 pollDeployProgress）。
   */
  deployProgress: null,
  releases: [],
  latestRelease: null,
  updatingRuntime: false,
  sessionsHasMore: false,
  sessionsLimit: 0,
  sessionsCursor: '',
  sessionsLoadingMore: false,
  chatBotId: '',
  chatSessionId: '',
  chatEvents: [],
  chatDraft: '',
  chatStatus: '',
  /** 对话里子代理任务详情的展开状态：taskId → true。 */
  taskOpen: {},
  /**
   * 按下停止之后、这一轮真停下来之前的那一段。
   *
   * **停止不是当场生效的**：点一下只是把中止下发下去（界面 → Gateway → 席位 →
   * bot 的 `agent.abort()`），Bot 收到之后还要把手上那一步收尾，`turn/end` 才回来。
   * 中间快则几百毫秒，撞上一个正跑着的工具就是几秒到十几秒，而那期间流上一个事件
   * 都不会来——不记这一格的话，界面上跟没点过一模一样。
   *
   * 记的是**会话 id** 而不是布尔：切到别的 Bot 时那边不忙，一个布尔会被当场清掉，
   * 切回来就丢了。另一格是起点，那行小字的读秒照它算。
   */
  chatStopping: '',
  chatStoppingAt: 0,
  chatFiles: [],
  /** 这一条还没发出去的消息引用了什么（docs/chat-references.md）。 */
  chatRefs: [],
  /** botId → 没发出去的草稿。切走再切回来，打了一半的话还在。 */
  /** 已经发出去、还没从流里回来的那几条。见 chat.js 的 mergePending。 */
  chatPending: [],
  chatDrafts: {},
  /** 正在重放历史。期间只收不画，见 startChatStream。 */
  chatReplaying: false,
  /**
   * 右栏那棵工作区文件树（见 chat.js 的 workspacePanel）。
   * `wsDirs` 是「路径 → 这一层的内容」，`wsOpen` 是「哪几层展开着」。根目录的 key 是空串。
   *
   * `wsSession` 记着**这棵树是给哪条会话取的**。空串也是一个值——「那会儿还没接上
   * 席位」。少了它，一次「还没接上」就会被当成取过了：席位十几秒后接上，那一屏还停在
   * 空的，得有人去按刷新（见 ensureWorkspaceTree）。
   */
  wsDirs: {},
  wsOpen: {},
  wsSession: '',
  /**
   * 每一层「第几茬」：路径 → 一个只增不减的计数。删掉一层就给它和它的上一层各 +1。
   *
   * 在途的那一趟回来时要对一次（见 loadWorkspaceDir）。**只看会话不够**：删一个目录
   * 和「刷新正在取它」撞在一起时会话根本没变，那一趟回来会把刚删掉的那份内容原样
   * 写回缓存——人看不见（那一行已经没了），直到 Bot 又建出一个同名目录，展开它看到
   * 的是上一茬的文件，点开全是「文件不存在」。
   */
  wsGen: {},
  /**
   * 日常任务（右栏那一列）。`routinesBotId` 记着这几条是谁的——换 Bot 时先按它清空，
   * 免得上一颗 Bot 的任务留在屏上被人点。
   */
  routines: [],
  routinesBotId: '',
  /**
   * 转人工待办（见 docs/handoff.md）。`handoffs` 是清单，`handoffCount` 是顶栏那个数
   * ——**两者不是一回事**：清单里还有别人接走的、已经交还等 Bot 消化的，而那个数只算
   * 「要我处理、还没处理完」的。让界面自己去数的话，两处口径迟早会漂。
   */
  handoffs: [],
  /** 外部消息渠道。第一版一个账号至多一条 Telegram 绑定。 */
  channels: [],
  channelBindOpen: false,
  channelBindError: '',
  handoffCount: 0,
  /** 近 30 天的概览（开了几张、还欠着几张、多久有人接）。空 = 还没拉到。 */
  handoffStats: null,
  /** 待办页上那两颗筛选：全部 / 要我处理的。 */
  handoffScope: 'all',
  /** 待办页上展开的是哪一条（别人名下的 Bot 打不开对话，就地处理，见 pages-handoffs.js）。 */
  handoffOpenId: '',
  /** 单号 → 席位那边的正文。`null` = 拉过但席位没应答；`undefined` = 还没拉。 */
  handoffDetail: {},
  /**
   * 席位那边「这几张单还在不在」的一次快照：`{ sessionId, ids, upto }`。
   * 比它早、又不在 ids 里的卡片画成失效（见 chat.js 的 handoffDead）。
   */
  chatHandoffs: null,
  /** 打开的那条的 id。空 = 右栏是列表形态。 */
  routineOpen: '',
  routineRuns: [],
  routineError: '',
  /** 输入框那条「上下文占了多少」的浮层开着没有。 */
  chatCtxOpen: false,
}

/**
 * 浏览器里的票只活在当前标签页；桌面壳没有「标签页」这个边界，关窗口再打开仍是同一
 * 个应用，所以由壳注入标记后改存 localStorage。这样不会顺手把网页版也变成长期登录。
 *
 * token() 还认一次旧的 sessionStorage：用户在桌面端已经登录、Gateway 热更新到这一版
 * 时，当前窗口里的旧票会无感迁过去，不必平白再登录一次。显式退出则两边都清，不能让
 * 迁移留下的副本把人自动登回来。
 */
function desktopShell() {
  return window.__SATUWORK_DESKTOP__ === true
}

function token() {
  if (!desktopShell()) return sessionStorage.getItem(TOKEN_KEY)
  try {
    const saved = localStorage.getItem(TOKEN_KEY)
    if (saved) return saved
  } catch {}
  const legacy = sessionStorage.getItem(TOKEN_KEY)
  if (legacy) {
    try {
      localStorage.setItem(TOKEN_KEY, legacy)
      sessionStorage.removeItem(TOKEN_KEY)
    } catch {}
  }
  return legacy
}

function setToken(t) {
  if (desktopShell()) {
    try {
      localStorage.setItem(TOKEN_KEY, t)
      sessionStorage.removeItem(TOKEN_KEY)
      return
    } catch {}
  }
  sessionStorage.setItem(TOKEN_KEY, t)
}

function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY)
  if (!desktopShell()) return
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {}
}

/** 列表画不出东西时那一格。三张账单表 + 用量表共用，别再各抄一份。 */
function emptyBox(msg) {
  return `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${esc(msg)}</div>`
}

/* ══ 转接到 core.js ═══════════════════════════════════════════════════
   下面这些以前就写在这个文件里，都是纯函数（转义、时区、金额、从地址里取 id）。现在住在
   core/src/format.ts 与 core/src/paths.ts，经 gateway/scripts/build-core.mjs 打进 core.js，
   这里一行一个接回原来的名字——调用点一个没改。要改实现去 core/src，改完重打 core.js。

   `usd` 和 `tokens` 两个有点不同：usd 的千分位按语言分，以前直接读 prefs.js 的
   localeMode，core 不认那个全局，所以在这儿传进去；tokens 在 core 里叫 fmtTokens，
   是为了不和下一步要搬进去的「票」（TokenStore）撞名。
   ══════════════════════════════════════════════════════════════════ */
const esc = SatuCore.esc
const SATU_TZ = SatuCore.SATU_TZ
const tzOffsetMs = SatuCore.tzOffsetMs
const tzDayStart = SatuCore.tzDayStart
const tzDayKey = SatuCore.tzDayKey
const fmtTime = SatuCore.fmtTime
const dayStart = SatuCore.dayStart
const dayEnd = SatuCore.dayEnd
const money = SatuCore.money
function usd(mils) {
  return SatuCore.usd(mils, localeMode)
}
const tokens = SatuCore.fmtTokens
const connectorIdOfPath = SatuCore.connectorIdOfPath
const botIdOfPath = SatuCore.botIdOfPath
const companyIdOfPath = SatuCore.companyIdOfPath
const machineIdOfPath = SatuCore.machineIdOfPath
const userIdOfPath = SatuCore.userIdOfPath
const sessionIdOfPath = SatuCore.sessionIdOfPath
const auditItemIdOfPath = SatuCore.auditItemIdOfPath

function capTags(m) {
  const input = Array.isArray(m.input) ? m.input : []
  const vision = input.includes('image')
  const tags = []
  if (m.reasoning) tags.push(`<span class="tag tag-neutral">${t('推理')}</span>`)
  if (vision) tags.push(`<span class="tag tag-neutral">${t('识图')}</span>`)
  if (!tags.length) tags.push(`<span class="tag tag-neutral">${t('对话')}</span>`)
  // 「自动发现」不是能力，是**来源**：这条不在 pi-ai 的内置快照里，是运行时从
  // models.dev 补进来的，没经过 pi 的逐个实测。挨着能力标签放，是因为选模型的人
  // 就在这一行做决定，让他当场看见比藏进详情页有用。
  if (m.source === 'discovered') tags.push(`<span class="tag tag-warn" title="${t('目录里没有、运行时从 models.dev 发现的。参数按同供应商同协议的模型推导，建议先做一次连通性测试。', 'Not in the built-in catalog; discovered from models.dev at runtime. Its settings are inferred from a sibling model on the same provider and protocol, so probe it before relying on it.')}">${t('自动发现', 'discovered')}</span>`)
  return tags.join('')
}

function orgId() {
  return state.me?.company?.id
}

/**
 * Bot / Skill / MCP 的接口前缀。
 *
 * owner 管的是全局那份（所有公司可见），公司管理员管自己公司那份。两边的页面是
 * 同一套，只有这个前缀不同——所以别在页面里到处判角色，判这一处就够了。
 * 拿不到前缀（成员账号）就返回空串，调用方据此直接不发请求。
 */
function catalogBase() {
  if (isOwner()) return '/platform'
  const id = orgId()
  return id ? `/orgs/${encodeURIComponent(id)}` : ''
}

/**
 * 这一条能不能改。
 *
 * 公司侧只有**自己建的** Bot 改得动：全局 Bot 由平台维护，公司那一批是模版改版时
 * 停用掉的老条目（只能看和删）。Skill / MCP 没有 scope 这一维，还是按 origin 判。
 * owner 在平台页面里管的就是全局项，不受这条限制。
 */
function readOnlyItem(item) {
  if (isOwner() || !item) return false
  if (item.scope) return item.scope !== 'user'
  return item.origin === 'global'
}

/** 自己建的那种 Bot。它是唯一一种员工自己编辑得了的。 */
function isMyBot(bot) {
  return bot?.scope === 'user'
}

/**
 * 那几个开关和输入框改的是哪一份草稿。
 *
 * Bot 详情页改的是这个 Bot（`botDraft`），模版页改的是公司模版（`templateDraft`）。
 * 两页共用同一套控件和 data-act——行为边界、记忆、Skill 勾选在两处长得一模一样，
 * 抄一套出来只会开始漂。由路径来选是哪一份，控件本身不必知道自己在谁的页面上。
 */
function editingDraft() {
  return state.path === '/bots' ? state.templateDraft : state.botDraft
}

function setEditingDraft(next) {
  if (state.path === '/bots') state.templateDraft = next
  else state.botDraft = next
}

function currentRole() {
  return state.me?.account?.role || ''
}

function isOwner() {
  return currentRole() === 'owner'
}

function isAdmin() {
  return currentRole() === 'admin'
}

function navForRole() {
  const role = currentRole()
  if (role === 'owner') return OWNER_NAV
  if (role === 'admin') return ADMIN_NAV
  return MEMBER_NAV
}

/**
 * 侧栏真正画的那一份：分好组的。
 *
 * navForRole() 给的是拍平的名单，回答「能去哪儿」；这一份多带了组的划分和标题，
 * 回答「怎么摆」。两者同源（见 OWNER_NAV 的定义），不会各自漂开。
 */
function navGroupsForRole() {
  const role = currentRole()
  if (role === 'owner') return OWNER_NAV_GROUPS
  if (role === 'admin') return ADMIN_NAV_GROUPS
  return MEMBER_NAV_GROUPS
}

function allowedHrefs() {
  // '/' 不在导航里也必须可达：公司侧它就是对话页，是这些人的落点。
  // '/download' 同理不在导航里：入口在个人设置，老的 /download 链接登录之后也落这儿。
  const set = new Set([...navForRole().map((n) => n.href), '/profile', '/download', '/'])
  // 全局 Bot 从 owner 的菜单里撤了（见 OWNER_NAV），但**页面没撤**：撤的是入口，
  // 不是功能。少了这一行，owner 直接输 /bots 会被 pathAllowed 踢回首页，全局 Bot
  // 目录就此没人改得动了——而他是唯一改得动的人。
  if (isOwner()) set.add('/bots')
  // 员工菜单里没有连接器了（入口是名单底下那颗「插件」，见 MEMBER_NAV），但那两个页面
  // 必须还进得去：OAuth 授权完，供应商把浏览器送回 /connectors/:id，落地就在这儿。
  if (!isOwner()) set.add('/connectors')
  // 转人工待办的入口在**顶栏**那颗按钮上，不在侧栏菜单里（员工那份菜单是空的，
  // 见 MEMBER_NAV）。所以这里单独放行，否则点那颗按钮会被 pathAllowed 踢回首页。
  if (!isOwner()) set.add('/handoffs')
  // **`/providers` 对公司侧一律不放行。** 那一页曾经对员工开着（只读，看得见哪些
  // 供应商配了、用的是谁的密钥），现在密钥只由平台配，公司这一侧没有任何一维是他
  // 答得上或改得动的。菜单里没有、直接输地址也会被踢回首页。
  if (!isOwner()) set.add('/channels')
  // 知识库同理：入口在名单底下那颗「更多」里，不在侧栏菜单里（docs/knowledge-base.md §11.1）。
  if (!isOwner()) set.add('/knowledge')
  return set
}

/**
 * 在不在对话页。**`/` 对公司侧的人也算**（见 memberChatHome）：以前这里不认 `/`，
 * 而 render.js 的 onChatPage 认，于是落在 `/` 上时顶栏和右栏按对话页画、正文那边
 * 的事件却不重绘、会话也不去拿——半个对话页。判据只留这一处，别处都调它。
 */
function isChatPath(p) {
  if (typeof p !== 'string') return false
  return p === '/chat' || p.startsWith('/a/') || (p === '/' && memberChatHome())
}

function chatBotIdOf(p) {
  // `/` 上没有 Bot id，它就是「上次看的那个」——和 chatPage / chatBotIdNow 的回落一致。
  if (p === '/' && memberChatHome()) return state.chatBotId || ''
  if (!p || !p.startsWith('/a/')) return ''
  return decodeURIComponent(p.slice('/a/'.length).split('/')[0] || '')
}

/**
 * 「/ 就是对话页」的角色。
 *
 * 公司侧不再有概览页——那一屏说的都是别处已经说过的话，而人进来是为了看 Bot。
 * 去掉它之后，管理员和员工的落点是一样的：首页直接是对话。只有 owner 例外，
 * 他管的是平台，没有席位也进不了对话。
 */
function memberChatHome() {
  return !isOwner()
}

function pathAllowed(p) {
  if (p === '/costs') p = '/billing'
  if (allowedHrefs().has(p)) return true
  // /bots/:id 跟 /profile 一样不在侧栏，但管理员能进。
  // 员工进不了 /bots（那是管理员的模版页），但进得了自己那个 Bot 的详情页。
  if (p.startsWith('/bots/') && (allowedHrefs().has('/bots') || !isOwner())) return true
  // 连接器详情不在侧栏，但装了连接器的人都要进得去。
  if (p.startsWith('/connectors/') && allowedHrefs().has('/connectors')) return true
  if (p.startsWith('/knowledge/') && allowedHrefs().has('/knowledge')) return true
  if (p.startsWith('/companies/') && allowedHrefs().has('/companies')) return true
  if (p.startsWith('/users/') && allowedHrefs().has('/users')) return true
  if (p.startsWith('/machines/') && allowedHrefs().has('/machines')) return true
  if (p.startsWith('/audit/summary/') && allowedHrefs().has('/audit')) return true
  if (isChatPath(p)) return !isOwner()
  return false
}

/**
 * `/bots/:id` 指的是不是**我自己那个 Bot**。
 *
 * 同一个地址底下坐着两种东西：公司/全局那几个（从 `/bots` 那一页点进来），和我自己
 * 建的那个（从对话里的「Bot 设置」点进来）。它们的上一级不是同一处——自己的那个属于
 * 对话，跟公司模版没有从属关系，所以面包屑和侧栏高亮都得先问一句这是谁的。
 *
 * 先认名单：`runtimeBots` 是「我有哪几个 Bot」，一进来就有。名单还没到（比如直接
 * 输地址进来）再看已经载到的那份详情，认不出来就当成公司那边的，宁可少收一格。
 */
function ownBotPath(p) {
  const id = botIdOfPath(p || '')
  if (!id) return false
  if ((state.runtimeBots || []).some((b) => b.id === id)) return true
  return Boolean(state.bot && state.bot.id === id && isMyBot(state.bot))
}

/**
 * 地址里那颗 Bot 的已载详情；对不上就是 null。
 *
 * Bot 详情页上的按钮（保存、删除、记忆的删 / 钉 / 推）一律从这儿取对象，**不直接读
 * state.bot**：/bots/A 切到 /bots/B、B 还没到（或者 403 了）的那段时间里，state.bot
 * 可能还是 A，按下去打的就是 A。
 */
function routeBot() {
  const id = botIdOfPath(state.path)
  return id && state.bot && state.bot.id === id ? state.bot : null
}

/** 一级页面头上那个标题。二级页面走 crumbsOf()，不经过这里。 */
function pageTitle(path) {
  if (isChatPath(path)) return t('对话')
  // owner 在这两个页面上管的是全局那份，标题得说清楚，别跟公司页混起来。
  if (isOwner() && PATHS[path]?.ownerTitle) return t(PATHS[path].ownerTitle)
  return t(PATHS[path]?.title || 'Satuwork')
}

/**
 * 二级页面的面包屑：`{ href, parent, current }`；一级页面返回 null，头上照旧只有一个标题。
 *
 * 上一级只看路径，不看是从哪儿点进来的——同一个地址不管怎么进来，面包屑和那个返回
 * 都指向同一处，不会把人送回一个不相干的页面。
 *
 * 当前这一级用的是**已经载到的那条数据**的名字，且要求 id 跟地址里的对得上：
 * 页面之间 state.bot / state.org 这些是留在内存里的，不比对就会在新的一条还没到时
 * 顶着上一条的名字。对不上就退回一个泛称，宁可少说一句，不能说错。
 */
function crumbsOf(path) {
  if (path.startsWith('/bots/')) {
    const bot = state.bot && state.bot.id === botIdOfPath(path) ? state.bot : null
    // 员工没有 Bot 列表页可回——他的落点是对话，返回就该回那儿。
    // 管理员同理：他点开的要是自己那个 Bot，来处也是对话，不是公司模版那一页。
    if ((!isOwner() && !isAdmin()) || ownBotPath(path)) return { href: '/', parent: t('对话'), current: bot?.name || t('Bot 详情') }
    return { href: '/bots', parent: isOwner() ? t('全局 Bot') : t('Bot 模版'), current: bot?.name || t('Bot 详情') }
  }
  if (path.startsWith('/connectors/') && path !== '/connectors') {
    const d = state.connectorDetail?.connector
    const one = d && d.id === connectorIdOfPath(path) ? d : null
    return { href: '/connectors', parent: t('连接器'), current: one?.name || t('连接器详情') }
  }
  if (path.startsWith('/knowledge/')) {
    const d = state.kbDetail && state.kbDetail.id === kbIdOfPath(path) ? state.kbDetail : null
    return { href: '/knowledge', parent: t('知识库'), current: d?.knowledge?.name || t('知识库详情', 'Knowledge base') }
  }
  if (path.startsWith('/companies/') && path !== '/companies') {
    const org = state.org && state.org.id === companyIdOfPath(path) ? state.org : null
    return { href: '/companies', parent: t('公司'), current: org?.name || t('公司详情') }
  }
  if (path.startsWith('/machines/') && path !== '/machines') {
    const id = machineIdOfPath(path)
    const one = state.machineDetail?.machine?.id === id ? state.machineDetail : null
    return { href: '/machines', parent: t('机器管理'), current: machineTitleOf(one) || t('机器详情') }
  }
  if (path.startsWith('/users/') && path !== '/users') {
    const acc = state.userDetail?.account
    const one = acc && acc.id === userIdOfPath(path) ? acc : null
    return { href: '/users', parent: t('用户'), current: one?.name || one?.email || t('账号详情') }
  }
  // 入口在个人设置里，上一级就回那儿。
  if (path === '/download') return { href: '/profile', parent: t('个人设置'), current: t('下载桌面端') }
  if (path.startsWith('/audit/summary/')) {
    const item = state.auditItemDetail?.item
    const id = auditItemIdOfPath(path)
    const one = item && item.id === id ? item : null
    return { href: '/audit', parent: t('审计'), current: one?.taskSummary || t('审计总结') }
  }
  return null
}

/** Bot 详情页的图标格里那份草稿还没落库，层级要从当前页面的角色推。 */
function draftOrigin() {
  return state.bot?.origin || (isOwner() ? 'global' : 'company')
}

/**
 * 账单/充值那几张表的外壳：标题、表头、行，没行时一句空态。
 *
 * 三处（公司账单的两个 tab、平台侧公司详情）本来各写一遍，表头的格数还必须和
 * `.satu-billhead` 的 grid-template-columns 对上——抄一份就多一次对不上的机会。
 */
function billTable(title, heads, rows, emptyMsg) {
  const cells = heads.map((h) => `<span>${esc(h)}</span>`).join('')
  return `<div style="display: flex; flex-direction: column; gap: var(--space-3);">
      <h2 style="font-size: 18px; margin: 0;">${esc(title)}</h2>
      <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
        <div class="satu-billhead">${cells}</div>
        ${rows || emptyBox(emptyMsg)}
      </div>
    </div>`
}

/**
 * 一期订阅账单那一行。最后一格由调用方给：公司那边摆「发票」按钮（还没做，禁着），
 * 平台侧那张只读表留空。
 */
function invoiceRow(b, tail = '<span></span>') {
  return `<div class="satu-billrow">
      <span style="font-size: 13.5px;">${esc(b.period)}</span>
      <span style="font-size: 13.5px;">${esc(b.amount)}</span>
      <span class="tag tag-accent-2">${esc(b.status)}</span>
      <span style="font-size: 13px; color: var(--muted-foreground);">${esc(b.paid)}</span>
      ${tail}
    </div>`
}

/** 一条 SSE 拆成一个个事件。实现在 core/src/chat/sse.ts；名册流和日志流共用。 */
const sseEvents = SatuCore.sseEvents

function svg(paths, size = 17) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round">${paths
    .map((d) => `<path d="${esc(d)}"/>`)
    .join('')}</svg>`
}

function pathOf() {
  const p = location.pathname
  if (p === '/ui' || p === '/ui/' || p === '/index.html') return '/'
  if (p.startsWith('/join/')) return p
  if (p === '/bots' || p.startsWith('/bots/')) return p
  if (p === '/companies' || p.startsWith('/companies/')) return p
  if (p === '/users' || p.startsWith('/users/')) return p
  if (p === '/audit' || p.startsWith('/audit/summary/')) return p
  if (p === '/chat' || p.startsWith('/a/')) return p
  if (p === '/costs') return '/billing'
  return PATHS[p] ? p : '/'
}

function joinToken() {
  if (!state.path.startsWith('/join/')) return ''
  return decodeURIComponent(state.path.slice('/join/'.length).split('/')[0] || '')
}

/** 导航序号：每次换页（go() 或前进后退）加一。loadPage 回来时序号已经变了，说明人又点去了别处。 */
let navSeq = 0

function go(href) {
  if (location.pathname !== href) history.pushState({}, '', href)
  state.path = href
  enterPath()
}

/**
 * 换页之后那一套：清掉上一页的提示和弹层、加载、按序号决定画不画。
 *
 * **go() 和浏览器的前进后退共用这一条。** popstate 以前自己写了一份 `loadPage().then(render)`：
 * 不加序号、不清提示——连按两下后退，慢的那一页晚回来会把快的那一页盖掉，上一页的报错
 * 也跟着带到新页面上。调用前 state.path 要已经是新地址。
 */
function enterPath() {
  state.error = ''
  state.notice = ''
  state.addOpen = false
  // 预览摆在对话页的右栏里，是那一颗 Bot 的东西：离开它的对话就不该再挂着。
  if (typeof leavePreview === 'function') leavePreview()
  if (typeof closeMemberUi === 'function') closeMemberUi()
  if (typeof closeSkillDialog === 'function') closeSkillDialog()
  state.seatMember = null
  state.seatRuntime = null
  state.seatRuntimes = []
  state.userReveal = { apiKey: false, accessToken: false }
  state.seatReveal = false
  state.seatError = ''
  // 慢的那一页回来时人已经点到下一页去了：那次 render 会把新页面盖成旧页面的内容，
  // 所以序号不对就不画。loadPage 自己写的共享字段由它内部各自把关（详情页那三份见
  // data.js 的 detailSeq），这里只保证「不重画」这一条最小闸。
  const seq = ++navSeq
  const load = state.path.startsWith('/join/') ? loadInvite() : loadPage()
  load.then(() => {
    if (seq === navSeq) render()
  })
}
