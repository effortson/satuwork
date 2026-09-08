/**
 * 和 Gateway 说话的那一层：api() 与所有 load*，外加 loadPage()——「这一页要哪几份数据」。
 *
 * 视图一律不自己 fetch：要什么数据在这里说清楚，画的时候只读 state。
 */
async function api(method, path, body) {
  const headers = { accept: 'application/json' }
  // 别叫 t——下面 401 那支要用上面那个文案函数。
  const tok = token()
  if (tok) headers.authorization = 'Bearer ' + tok
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  if (res.status === 401 && tok && path !== '/auth/login' && !path.startsWith('/invites/')) {
    clearToken()
    state.me = null
    state.loginError = t('登录已过期，请重新登录')
    render()
    throw new Error((json && json.error) || t('需要登录'))
  }
  // 服务端只发中文。在这里翻一次，调用方无论是丢给 flash 还是直接塞进 state
  // （state.planSkuError、state.inviteError 这些）拿到的都已经是当前语言。
  if (!res.ok) {
    const err = new Error(errText((json && json.error) || text || 'HTTP ' + res.status))
    // 状态码挂在错误上：调用方要判断 404 就看这个，别去猜文案——文案是会被翻译的。
    err.status = res.status
    throw err
  }
  return json
}

/**
 * 提示条自己走人的时限。
 *
 * 它说的都是**刚刚那一下的回执**：已下发停止、已压缩、已开始新对话、这条没发出去。
 * 看过就没用了，而没人会专门去点掉一条已经读完的话——不设时限的话，对话页顶上那条
 * 「已压缩」能一直挂到下次刷新，挡着的是消息流本身。10 秒是「一眼看完还够再看一遍」
 * 与「别赖着不走」之间的位置。
 */
const FLASH_TTL = 10000
let flashTimer = 0

/**
 * 提示条。翻译在这里做一次，而不是散在上百个调用点上——
 * 消息既有界面自己的文案，也有服务端原样带回来的中文，两者查的是同一张表。
 *
 * `ttl` 传 0 就一直挂着，留给那种「不读完不能走」的话。今天没有这样的调用方，
 * 但这个口子比让某一处自己另画一条提示条便宜。
 */
function flash(kind, msg, ttl = FLASH_TTL) {
  const text = errText(msg)
  state.error = kind === 'err' ? text : ''
  state.notice = kind === 'ok' ? text : ''
  clearTimeout(flashTimer)
  flashTimer = 0
  // 空消息不算一条提示（`flash('ok', '')` 等于把两格都清空），别为它排一次定时。
  if (!ttl || !(state.error || state.notice)) return
  flashTimer = setTimeout(dismissFlash, ttl)
}

/**
 * 撤掉当前这条提示：右上角那颗 × 和上面那个定时器走的是同一条路。
 *
 * **就地把节点摘掉，不整页重绘。** 对话页上人多半正在输入框里打字，而 render() 会把
 * 整个 #app 换一遍——焦点、光标位置、还没同步进 state 的那半句一起没。页面上找不到
 * 提示条的节点（还没画、或在别处画的）才退回 render()。
 */
function dismissFlash() {
  clearTimeout(flashTimer)
  flashTimer = 0
  if (!state.error && !state.notice) return
  state.error = ''
  state.notice = ''
  const rows = document.querySelectorAll('[data-flash]')
  if (!rows.length) return render()
  for (const row of rows) row.remove()
}

/** 删除先回 202 跑终审；兼容完成态回执仍展示拆席位留下的墓碑。 */
function flashDeletedBot(data) {
  if (data && data.deleting) {
    return flash(
      'ok',
      t(
        '已停止接收新任务，正在完成删除前终审；终审成功后会自动删除。',
        'New work is stopped. The final audit is running and the bot will be deleted automatically when it succeeds.',
      ),
    )
  }
  const orphans = (data && data.orphans) || []
  if (!orphans.length) return flash('ok', '已删除')
  flash(
    'err',
    t(
      `Bot 已删除，但机器上还有 ${orphans.length} 个席位没拆干净：${orphans[0].error || ''}`,
      `The bot is deleted, but ${orphans.length} seat(s) could not be torn down: ${orphans[0].error || ''}`,
    ),
  )
}

function groupCatalog(rows) {
  const map = new Map()
  for (const m of rows || []) {
    const provider = m.provider || m.owned_by || ''
    if (!provider) continue
    if (!map.has(provider)) map.set(provider, { provider, name: provider, models: [] })
    map.get(provider).models.push({
      id: m.model || (typeof m.id === 'string' && m.id.includes('/') ? m.id.slice(m.id.indexOf('/') + 1) : m.id),
      name: m.name || m.model || m.id,
      reasoning: !!m.reasoning,
      reasoningLevels: Array.isArray(m.reasoning_levels) ? m.reasoning_levels : (m.reasoning ? ['off', 'minimal', 'low', 'medium', 'high'] : ['off']),
      input: Array.isArray(m.input) ? m.input : ['text'],
      contextWindow: m.context_window,
      maxTokens: m.max_tokens,
      cost: m.cost,
      source: m.source || 'builtin',
    })
  }
  return [...map.values()]
}

function configuredSet() {
  return new Set((state.creds || []).filter((c) => c.configured).map((c) => c.provider))
}

function roleLabel(role) {
  const r = state.settings?.[role]
  if (!r?.provider || !r?.model) return t('未设置')
  return `${r.provider} / ${r.model}`
}

// 局部变量不能叫 t——那是上面那个文案函数，遮住它这里就成了「t is not a function」。
function testMark(kind, id) {
  const res = state.tests[`${kind}:${id}`]
  if (!res) return ''
  if (res.status === 'busy') return `<span style="font-size: 12px; color: var(--muted-foreground);">${t('测试中…')}</span>`
  if (res.status === 'ok') return `<span style="font-size: 12px; color: var(--color-accent-2-800);">${esc(res.text)}</span>`
  return `<span style="font-size: 12px; color: var(--color-accent-800);">${esc(res.text)}</span>`
}

function adoptAccountPrefs(account) {
  if (!account) return
  // 本机已有偏好就用本机的；空着才从账号接过来——换台机器第一次登录会跟过去。
  if (!localStorage.getItem(THEME_KEY) && account.theme) setTheme(account.theme)
  if (!localStorage.getItem(LOCALE_KEY) && account.locale) setLocale(account.locale)
}

async function loadMe() {
  state.me = await api('GET', '/me')
  if (state.me?.settings) state.settings = state.me.settings
  adoptAccountPrefs(state.me?.account)
}

async function loadCatalog() {
  const data = await api('GET', '/v1/models')
  state.catalog = groupCatalog(data.data || [])
}

/**
 * 模型自动发现的状态。**owner 才有这个接口**，所以失败一律吞掉当没有——
 * 管理员进模型页时拿不到它是正常的，不该在页面上弹一条红。
 */
async function loadDiscovery() {
  try {
    state.discovery = await api('GET', '/platform/models/discovery')
  } catch {
    state.discovery = null
  }
}

/** 当前月份，YYYY-MM。月份选择器留空时用它。 */
function thisMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 统计窗口 → [from, to]（unix 毫秒）。
 *
 * 在浏览器里算：「今日」「本月」是相对**用户所在时区**的，服务端不知道那是哪个
 * 时区，自己切会错一整天。服务端只按 from/to 过滤。
 */
function statsWindow() {
  const now = new Date()
  if (state.statsRange === 'month') {
    const [y, m] = (state.statsMonth || thisMonth()).split('-').map(Number)
    const from = new Date(y, m - 1, 1, 0, 0, 0, 0).getTime()
    // 下个月 1 号减 1 毫秒 = 本月最后一刻。别去数这个月有几天。
    const to = new Date(y, m, 1, 0, 0, 0, 0).getTime() - 1
    return { from, to }
  }
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime()
  if (state.statsRange === '7d') {
    // 近 7 天含今天，所以往回退 6 天。
    return { from: startOfToday - 6 * 86400000, to: now.getTime() }
  }
  return { from: startOfToday, to: now.getTime() }
}

async function loadStats() {
  const { from, to } = statsWindow()
  const q = new URLSearchParams({ from: String(from), to: String(to) })
  if (state.statsCompany) q.set('companyId', state.statsCompany)
  state.statsLoading = true
  render()
  try {
    state.stats = await api('GET', `/platform/stats?${q}`)
  } catch (err) {
    state.stats = null
    flash('err', err.message)
  } finally {
    state.statsLoading = false
    render()
  }
}

/** 自定义供应商只有 owner 能看能改；别的角色这份留空，界面上就不出自定义那部分。 */
async function loadCustomProviders() {
  if (!isOwner()) {
    state.customProviders = []
    return
  }
  const data = await api('GET', '/platform/providers')
  state.customProviders = data.providers || []
  state.customApis = data.apis || []
}

function customProvider(id) {
  return (state.customProviders || []).find((p) => p.id === id)
}

async function loadCreds() {
  if (isOwner()) {
    const data = await api('GET', '/platform/credentials')
    state.creds = data.credentials || []
    return
  }
  const id = orgId()
  if (!id) return
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}/credentials`)
  state.creds = data.credentials || []
}

/**
 * 连接器：供应商、上架清单、市场。
 *
 * 市场（`/connectors`）是公司里所有人都读得到的那一份；上架清单（`/platform/connectors`）
 * 只有 owner 读得到。两份分开，是因为员工那一份**不带 authConfigId**。
 */
async function loadConnectorVendors() {
  state.connectorVendors = (await api('GET', '/platform/connector-vendors')).vendors || []
}

async function loadConnectors() {
  state.connectors = (await api('GET', '/platform/connectors')).connectors || []
}

async function loadConnectorToolkits() {
  state.connectorToolkits = (await api('GET', '/platform/connector-toolkits')).toolkits || []
}

async function loadOrgConnectors() {
  const id = orgId()
  const [list, stats] = await Promise.all([
    api('GET', `/orgs/${encodeURIComponent(id)}/connectors`),
    api('GET', `/orgs/${encodeURIComponent(id)}/connector-stats`).catch(() => null),
  ])
  state.orgConnectors = list.connectors || []
  state.connectorStats = stats
}

async function loadMarket() {
  state.market = (await api('GET', '/me/connectors')).connectors || []
}

/**
 * 一个连接器的详情：我的安装、我的几把连接、可开的工具。
 *
 * 工具清单是现拉的（Gateway 那边去问供应商），所以这一条会慢一点；拉不到时后端给
 * `toolsError`，界面照样能装能连。
 */
async function loadConnectorDetail(id) {
  state.connectorDetail = await api('GET', `/me/connectors/${encodeURIComponent(id)}`)
}

/**
 * 插件弹窗那一份详情。**和页面那份分开存**：弹窗能盖在 `/connectors/:id` 上面，共用
 * 一个字段的话，在弹窗里翻了别的插件，关掉之后底下那页画的是别人的账号。
 *
 * **晚到的那一份不落盘。** 在弹窗里翻得快时两次请求会乱序回来（进 A、退出来、再进 B，
 * A 的响应后到），而渲染那边是按 id 认的——盖错了就永远停在「加载中…」，且已经没有
 * 请求在飞，只能退出去重进。弹窗中途被关掉也走这一条：state.plugins 没了，就别再往
 * 一个已经不存在的屏上写数据。
 */
async function loadPluginDetail(id) {
  const detail = await api('GET', `/me/connectors/${encodeURIComponent(id)}`)
  if (state.plugins?.id !== id) return
  state.pluginDetail = detail
}

async function loadSettings() {
  if (isOwner()) {
    state.settings = await api('GET', '/platform/settings')
    return
  }
  if (state.me?.settings) state.settings = state.me.settings
}

/** 平台工具配置。只有 owner 拿得到——里面有价目，也有「哪家配了密钥」。 */
async function loadWebTools() {
  if (!isOwner()) return
  state.webTools = await api('GET', '/platform/tools/web')
}

async function loadOrgs() {
  const data = await api('GET', '/platform/orgs')
  state.orgs = data.orgs || []
}

async function loadOrders() {
  const data = await api('GET', '/platform/orders')
  state.orders = data.orders || []
}

async function loadOrgTopups(id) {
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}/topups`)
  state.orgTopups = data.topups || []
}

async function loadPlanSkus() {
  const data = await api('GET', '/platform/plans')
  state.planSkus = data.plans || []
}

async function loadUsers() {
  const data = await api('GET', '/platform/accounts')
  state.users = data.accounts || []
}

async function loadUserDetail(id) {
  if (!id) {
    flash('err', t('账号不存在'))
    state.path = '/users'
    history.replaceState({}, '', '/users')
    await loadUsers()
    return
  }
  try {
    state.userDetail = await api('GET', `/platform/accounts/${encodeURIComponent(id)}`)
    state.userReveal = { apiKey: false, accessToken: false }
  } catch (err) {
    flash('err', err.message)
    if (err.status === 404) {
      state.path = '/users'
      history.replaceState({}, '', '/users')
      await loadUsers()
    }
  }
}

async function loadOrg() {
  const id = orgId()
  if (!id) return
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}`)
  state.org = data.company
  state.plan = data.plan
}

async function loadAccounts() {
  const id = orgId()
  if (!id) return
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}/accounts`)
  state.accounts = data.members || data.accounts || []
  state.groups = data.groups || []
  state.seats = data.seats || { total: 0, used: 0 }
  if (data.me) state.memberMe = data.me
}

async function loadReleases() {
  const [data, mgr] = await Promise.all([
    api('GET', '/platform/bot-releases'),
    api('GET', '/platform/manager-releases').catch(() => null),
  ])
  state.releases = data.releases || []
  state.latestRelease = data.latest || null
  state.managerReleases = mgr
}

/**
 * 平台机器管理页的列表。
 *
 * 和公司详情里那份（`/platform/orgs/:id/machine`）不是一回事：这一份是**全平台**的，
 * 包括没派给任何公司的机器——按公司去列永远列不到它们，而落单的机器最需要被看见。
 */
async function loadAllMachines() {
  const data = await api('GET', '/platform/machines')
  state.allMachines = data.machines || []
  state.machineTotals = data.totals || null
  state.botLatest = data.botLatest || null
  state.managerLatest = data.managerLatest || null
}

async function loadMachineDetail(id) {
  if (!id) {
    flash('err', t('机器不存在'))
    state.path = '/machines'
    history.replaceState({}, '', '/machines')
    await loadAllMachines()
    return
  }
  try {
    const data = await api('GET', `/platform/machines/${encodeURIComponent(id)}`)
    state.machineDetail = data
    state.botLatest = data.botLatest || null
    state.managerLatest = data.managerLatest || null
    // 负载停在「日」那一档时，把那天的归档也带上。**这一份是另一条接口**：上面那条
    // 只有「现在怎么样」。不在这儿拉的话，直接打开地址、或者按一下刷新，那一档会挂在
    // 「载入中」上不动——因为没有任何人去拉。
    if (state.machineLoadTab !== 'live') await loadMachineMetrics(id)
  } catch (err) {
    flash('err', err.message)
    if (err.status === 404) {
      state.machineDetail = null
      state.path = '/machines'
      history.replaceState({}, '', '/machines')
      await loadAllMachines().catch(() => {})
    }
  }
}

/** GET /platform/orgs/:id/machine 那一份响应 → state。整页加载和单独刷新走的是同一条。 */
function applyMachineRes(res) {
  state.machine = res && res.machine ? res.machine : null
  state.machines = (res && res.machines) || []
  state.machineCapacity = (res && res.capacity) || null
  state.botLatest = (res && res.botLatest) || null
  state.managerLatest = (res && res.managerLatest) || null
}

/**
 * 只重新拉机器那一块，不动这一页的其它数据。
 *
 * 卡片上的心跳、管家版本、bot 版本都是**机器自报**的，Gateway 这边只是存着——下指令
 * 之后要等下一轮心跳（≤30 秒）才变。所以要有一条比整页重载轻的路给人手动催一下。
 *
 * 失败时**不动 state**：把机器列表清空会让一次网络抖动看起来像「机器全没了」。
 */
async function loadMachines(id) {
  if (!id) return
  applyMachineRes(await api('GET', `/platform/orgs/${encodeURIComponent(id)}/machine`))
}

async function loadCompanyDetail(id) {
  resetChargePaging()
  if (!id) {
    flash('err', t('公司不存在'))
    state.path = '/companies'
    history.replaceState({}, '', '/companies')
    await loadOrgs()
    return
  }
  try {
    const [org, accounts, billing, machineRes, botsRes] = await Promise.all([
      api('GET', `/orgs/${encodeURIComponent(id)}`),
      api('GET', `/orgs/${encodeURIComponent(id)}/accounts`),
      api('GET', `/orgs/${encodeURIComponent(id)}/billing`),
      api('GET', `/platform/orgs/${encodeURIComponent(id)}/machine`).catch(() => ({ machine: null })),
      // 这里是 owner 在看**某一家公司**的 Bot，不是全局那份。
      api('GET', `/orgs/${encodeURIComponent(id)}/bots`).catch(() => ({ bots: [] })),
      loadReleases().catch(() => { state.releases = []; state.latestRelease = null }),
      // 订阅那一栏要按价目表画下拉；拉不到就只剩「未设置」，不挡住整页。
      loadPlanSkus().catch(() => { state.planSkus = [] }),
      // 充值记录：只有已付款的充值单才有，拉不到就当空的，不挡整页。
      loadOrgTopups(id).catch(() => { state.orgTopups = [] }),
      // 这家公司的计费明细。owner 在这一屏要回答的是「这家的钱花在哪了」，
      // 而那个问题在汇总数字上答不了。
      loadCharges('org', id).catch(() => { state.charges = null }),
    ])
    state.org = org.company
    state.plan = org.plan
    state.balance = org.balance || null
    state.accounts = accounts.members || accounts.accounts || []
    state.seats = accounts.seats || { total: 0, used: 0 }
    state.billing = billing
    applyMachineRes(machineRes)
    if (botsRes && Array.isArray(botsRes.bots)) state.bots = botsRes.bots
  } catch (err) {
    flash('err', err.message)
    if (err.status === 404) {
      state.path = '/companies'
      history.replaceState({}, '', '/companies')
      await loadOrgs()
    }
  }
}

async function loadInvite() {
  const token = joinToken()
  state.joinInvite = { loading: true, valid: false, email: '', name: '', expiresAt: 0, error: '' }
  state.joinError = ''
  if (!token) {
    state.joinInvite = { loading: false, valid: false, email: '', name: '', expiresAt: 0, error: '' }
    return
  }
  try {
    const data = await api('GET', `/invites/${encodeURIComponent(token)}`)
    state.joinInvite = {
      loading: false,
      valid: !!data.valid,
      email: data.email || '',
      name: data.name || '',
      expiresAt: data.expiresAt || 0,
      error: '',
    }
    state.joinForm = { name: data.name || '', password: '', confirm: '' }
  } catch (err) {
    state.joinInvite = { loading: false, valid: false, email: '', name: '', expiresAt: 0, error: err.message }
  }
}


async function loadBots() {
  const base = catalogBase()
  if (!base) return
  const data = await api('GET', `${base}/bots`)
  state.bots = data.bots || []
  state.bot = null
  state.botDraft = null
}

/**
 * 模版草稿和 Bot 草稿共有的那一段：行为边界、浏览器、Skill 开关、记忆设置。
 *
 * 这十一格两边**必须**一模一样——它们提交回去走的是同一套字段。分开写过一阵子，
 * 结果是加一档记忆 TTL 只改了其中一边，公司模版那一屏存下去就把值悄悄改回默认。
 */
function behaviorDraft(src) {
  const saved = src.guards && typeof src.guards === 'object' ? src.guards : {}
  const br = src.browser && typeof src.browser === 'object' ? src.browser : {}
  const mem = src.memory && typeof src.memory === 'object' ? src.memory : {}
  return {
    // 行为边界：文案在这边（要跟着界面语言走），开关从服务端来，按 id 贴回去。
    guards: DEFAULT_BOT_GUARDS.map((g) => ({ ...g, on: typeof saved[g.id] === 'boolean' ? saved[g.id] : g.on })),
    // 站点在草稿里是一整段文本（一行一个），保存时才切成数组——输入框里敲到一半的
    // 那一行不该在每次按键时都被切一次、归一化一次，光标会跳。
    browserOn: br.on === true,
    browserSites: (Array.isArray(br.sites) ? br.sites : []).join('\n'),
    // 缺字段按开算：老模版没存过这个键，而它在服务端的默认就是开的。
    selfSkills: src.selfSkills !== false,
    memoryOn: mem.on !== false,
    scope: MEMORY_SCOPES.includes(mem.scope) ? mem.scope : '所属分组',
    kinds: Array.isArray(mem.kinds) ? mem.kinds.filter((k) => MEMORY_KINDS.includes(k)) : ['偏好', '事实'],
    ttl: MEMORY_TTLS.includes(mem.ttl) ? mem.ttl : '90 天',
    cap: Number.isFinite(Number(mem.cap)) && mem.cap ? Number(mem.cap) : 20,
    confirmOn: mem.confirm !== false,
    piiOn: mem.pii !== false,
  }
}

/**
 * 公司的 Bot 模版。管理员那一页编辑的就是它，员工那边只读着看「我的 Bot 继承了什么」。
 *
 * 草稿和 state.template 分开放：改了一半还没保存的时候，版本号那一栏要显示的是**已经
 * 生效**的那一版，不是手上这份。
 */
async function loadBotTemplate() {
  const base = catalogBase()
  if (!base) return
  const data = await api('GET', `${base}/bot-template`)
  state.template = data.template || null
  state.templateOptions = { skills: data.options?.skills || [], mcps: data.options?.mcps || [] }
  state.templateDraft = draftFromTemplate(state.template)
  // 员工那边这一份是空的（接口只给管理员），所以是 null 不是空对象——「没有这一格」和
  // 「一台席位都没有」在界面上不是一回事。
  state.templateSync = data.sync || null
  // 有席位没跟上就自己隔一会儿再问一次（见 pages-bots.js）。走 wake 而不是 poll：静默
  // 计数是模块级的，上一次逛这一页攒下的次数不该算在这一次头上。
  tplSyncWake()
}

function draftFromTemplate(tpl) {
  if (!tpl) return null
  return {
    prompt: tpl.prompt || '',
    escalate: tpl.escalate || '',
    escalateTo: tpl.escalateTo || 'owner',
    skills: Array.isArray(tpl.skills) ? tpl.skills.slice() : [],
    mcps: Array.isArray(tpl.mcps) ? tpl.mcps.slice() : [],
    ...behaviorDraft(tpl),
  }
}

async function loadSkills() {
  const base = catalogBase()
  if (!base) return
  const data = await api('GET', `${base}/skills`)
  state.skills = data.skills || []
  state.mcpServers = data.servers || []
  state.skillTags = data.tags || []
}

function draftFromBot(bot) {
  return {
    name: bot.name || '',
    description: bot.description || '',
    prompt: bot.prompt || '',
    icon: bot.icon || 'bot',
    provider: bot.provider || 'deepseek',
    model: bot.model || '',
    enabled: bot.enabled !== false,
    greeting: bot.greeting || '',
    skills: Array.isArray(bot.skills) ? bot.skills.slice() : [],
    mcps: Array.isArray(bot.mcps) ? bot.mcps.slice() : [],
    groups: [],
    kbs: [],
    escalate: bot.escalate || '',
    escalateTo: bot.escalateTo || 'owner',
    /**
     * **不在这儿垫一个空 memories 数组。** 垫了的话「还没拉过记忆」和「真的一条都没有」
     * 就长得一模一样，而「已存记忆」那一格照着它画出来的空列表是假的——公司模版那一屏
     * 和 owner 那条路都不拉记忆，人看到的会是一句斩钉截铁的「还没有记下任何事实」。
     * 留成 undefined，那一格自己就不画了（见 pages-bots.js 的 storedMemories）。
     */
    ...behaviorDraft(bot),
  }
}

async function loadBotDetail(botId) {
  if (!botId) return
  // 不再拉 /v1/models：模型由平台指定，这一页没有可挑的下拉了。
  if (isOwner()) {
    const [one, opts] = await Promise.all([
      api('GET', `/platform/bots/${encodeURIComponent(botId)}`),
      api('GET', '/platform/bots/options'),
    ])
    state.bot = one.bot
    state.botDraft = draftFromBot(one.bot)
    state.botOptions = { skills: opts.skills || [], mcps: opts.mcps || [], groups: opts.groups || [], kbs: opts.kbs || [] }
    return
  }
  /**
   * 公司侧一律走 /runtime/bots/:id——**员工也进得来这一页**，而 /orgs/:id/bots/:id 是
   * 管理员接口。那条给出的也是合成之后的样子（提示词已经拼上模版那一段），正是这一页
   * 要显示的东西。
   */
  /**
   * 记忆那一份**单拉一条**，不塞进 `/runtime/bots/:id`。
   *
   * 那条路是每次打开这一页都要走的，而记忆是一张会长的表；更要紧的是它会变——
   * Bot 在对话里刚记下的一条，人切回这一页就该看见。拉不到不挡这一页：少的是一格
   * 列表，而人来这儿多半是改提示词的。
   */
  const [one, tpl, mems] = await Promise.all([
    api('GET', `/runtime/bots/${encodeURIComponent(botId)}`),
    api('GET', `${catalogBase()}/bot-template`).catch(() => null),
    api('GET', `/runtime/bots/${encodeURIComponent(botId)}/memories`).catch(() => null),
  ])
  state.bot = one.bot
  state.botDraft = {
    ...draftFromBot(one.bot),
    extraPrompt: one.bot.extraPrompt || '',
    memories: mems?.items || [],
    memoryUsed: mems?.used ?? 0,
    memoryMax: mems?.max ?? 0,
  }
  state.template = tpl?.template || state.template
  state.botOptions = {
    skills: tpl?.options?.skills || [],
    mcps: tpl?.options?.mcps || [],
    groups: [],
    kbs: [],
  }
}

async function loadAudit() {
  const id = orgId()
  if (!id) return
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}/audit`)
  state.events = data.events || []
}

async function loadConversationAudits() {
  const id = orgId()
  if (!id) return
  const q = new URLSearchParams()
  if (state.auditAccountId) q.set('accountId', state.auditAccountId)
  if (state.auditBotId) q.set('botId', state.auditBotId)
  const from = dayStart(state.auditFrom)
  const to = dayEnd(state.auditTo)
  if (from !== '') q.set('from', String(from))
  if (to !== '') q.set('to', String(to))
  const qs = q.toString()
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}/conversation-audits${qs ? '?' + qs : ''}`)
  state.auditItems = data.items || []
  state.auditFilterOptions = data.filters || state.auditFilterOptions || { accounts: [], bots: [] }
}

async function loadConversationAuditCoverage() {
  const id = orgId()
  if (!id) return
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}/conversation-audit-coverage`)
  state.auditCoverage = data.coverage || []
}

async function loadConversationAuditSettings() {
  const id = orgId()
  if (!id) return
  state.auditSettings = await api('GET', `/orgs/${encodeURIComponent(id)}/conversation-audit-settings`)
}

async function saveConversationAuditRole(modelRole) {
  const id = orgId()
  if (!id) return
  state.auditSettings = await api('PATCH', `/orgs/${encodeURIComponent(id)}/conversation-audit-settings`, { modelRole })
}

async function loadConversationAuditItem(itemId) {
  const id = orgId()
  if (!id || !itemId) return
  state.auditItemDetail = await api(
    'GET',
    `/orgs/${encodeURIComponent(id)}/conversation-audits/${encodeURIComponent(itemId)}`,
  )
}

async function loadSessions(append = false) {
  const id = orgId()
  if (!id) return
  const q = new URLSearchParams()
  if (state.sessionAccountId) q.set('accountId', state.sessionAccountId)
  const from = dayStart(state.sessionFrom)
  const to = dayEnd(state.sessionTo)
  if (from !== '') q.set('from', String(from))
  if (to !== '') q.set('to', String(to))
  // 追加下一页时带上游标；不带就是从头拉第一页（筛选条件变了要从头来）。
  if (append && state.sessionsCursor) q.set('cursor', state.sessionsCursor)
  const qs = q.toString()
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}/sessions${qs ? '?' + qs : ''}`)
  const got = data.sessions || []
  state.sessions = append ? (state.sessions || []).concat(got) : got
  // 接口是分页的。不把这几个字段带出来，一份被截断的列表看起来和「就这么多」一模一样，
  // 管理员会据此以为更早的会话不存在。
  state.sessionsHasMore = Boolean(data.hasMore)
  state.sessionsLimit = Number(data.limit) || state.sessions.length
  state.sessionsCursor = data.nextCursor || ''
}

async function loadSessionDetail(sessionId) {
  const id = orgId()
  if (!id || !sessionId) return
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}`)
  state.sessionDetail = data.session || null
  state.sessionEvents = data.events == null ? null : data.events
  state.sessionPullError = data.pullError || ''
}

async function loadBilling() {
  const id = orgId()
  if (!id) return
  state.billing = await api('GET', `/orgs/${encodeURIComponent(id)}/billing`)
}

/**
 * 计费明细。`where` 决定打哪条接口：平台看全平台，公司看自己家，员工看自己。
 *
 * 翻页靠游标栈（state.chargesCursors）：数组最后一个是当前页的起点。
 * 「下一页」压入服务端给的 nextCursor，「上一页」弹掉栈顶。
 */
async function loadCharges(where, forOrg) {
  const cursor = state.chargesCursors[state.chargesCursors.length - 1]
  const q = new URLSearchParams()
  if (state.chargesKind) q.set('kind', state.chargesKind)
  if (cursor) q.set('cursor', cursor)
  // 时间窗跟着这一屏上面那块走。**明细和汇总必须问同一个范围**——同屏两张表各说各的
  // 时间段，人只会以为数字错了。
  const range = chargesWindow(where)
  if (range) {
    q.set('from', String(range.from))
    q.set('to', String(range.to))
  }
  if (where === 'platform' && state.statsCompany) q.set('companyId', state.statsCompany)
  const path =
    where === 'platform'
      ? `/platform/charges?${q}`
      : where === 'me'
        ? `/me/charges?${q}`
        : `/orgs/${encodeURIComponent(forOrg || orgId())}/charges?${q}`
  state.chargesLoading = true
  render()
  try {
    state.charges = await api('GET', path)
  } catch (err) {
    state.charges = null
    flash('err', err.message)
  } finally {
    state.chargesLoading = false
    render()
  }
}

/**
 * 明细该问哪个时间窗。
 *
 * - `/stats`：跟统计那三颗胶囊 + 月份选择器走。
 * - `/usage`：跟那一屏自己的范围胶囊走。
 * - 别处（账单页、平台的公司详情）：没有范围控件，就是全时段。
 */
function chargesWindow(where) {
  if (where === 'platform') return statsWindow()
  if (state.path === '/usage') return usageRangeMs(state.usageRange || '近 30 天')
  return null
}

/** 换筛选、换时间窗都要回到第一页——停在第 3 页筛完只剩两页的话，那一下是空的。 */
function resetChargePaging() {
  state.chargesCursors = [null]
}

/** 统计屏的一次刷新：汇总和明细一起，用同一个窗口。 */
async function reloadStatsPage() {
  resetChargePaging()
  await Promise.all([loadStats(), loadCharges('platform')])
}

/** 用量屏的一次刷新：同上。 */
async function reloadUsagePage() {
  resetChargePaging()
  // owner 没有自己的公司，`/orgs//charges` 是条打不通的地址——那时看自己的。
  await Promise.all([loadUsage(), loadCharges((isAdmin() || isOwner()) && orgId() ? 'org' : 'me')])
}

function usageRangeMs(range) {
  const now = Date.now()
  if (range === '近 7 天') return { from: now - 7 * 24 * 3600 * 1000, to: now }
  if (range === '本月') {
    // 本地日历的 1 号零点，和 statsWindow() 一个算法：这一屏的日线也是按看的人的
    // 时区切的（见 loadUsage 传的 tz），月初按 UTC 算的话东八区月初那八小时会算到上个月。
    const d = new Date()
    return { from: new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime(), to: now }
  }
  return { from: now - 30 * 24 * 3600 * 1000, to: now }
}

async function loadUsage() {
  const range = state.usageRange || '近 30 天'
  const { from, to } = usageRangeMs(range)
  // 日线要按**看的人所在时区**切天，服务端不知道那是哪个时区。传的是
  // getTimezoneOffset() 的相反数（东八区 +480），跟 from/to 由前端算好是同一个道理。
  const tz = -new Date().getTimezoneOffset()
  const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&tz=${encodeURIComponent(tz)}`
  if (isAdmin() || isOwner()) {
    const id = orgId()
    if (!id) return
    state.usage = await api('GET', `/orgs/${encodeURIComponent(id)}/usage?${q}`)
    return
  }
  state.usage = await api('GET', `/me/stats?${q}`)
}

async function loadPage() {
  if (state.path.startsWith('/join/')) return
  if (!state.me) return
  if (!pathAllowed(state.path)) {
    state.path = '/'
    history.replaceState({}, '', '/')
  }
  // **Bot 名单在每一页都要有。** 它现在是侧栏的顶层，不再是「对话」页的附属——
  // 而 loadRuntimeBots 一直只在 loadChatPage 里跑，于是管理员一进概览页，名单就空了。
  // owner 没有席位，/runtime/bots 会 403，跳过它。
  if (!isOwner()) {
    await loadRuntimeBots().catch(() => {})
    // 状态点和摘要也不该只在对话页才有：人切到账单页等 Bot 干完活，正是要看着它。
    //
    // **一条通道管所有 Bot**（见 chat.js 的 startRosterStream），所以在这儿起没有关系
    // ——它只占一个连接。这里以前是一个 Bot 一条流，十几条抢在正文前面开，画出消息的
    // 那条 `/runtime/sessions/:id/history` 只能排在后面干等，刷新一次十几秒才见到消息。
    void startRosterStream()
    /**
     * 转人工待办同理，而且理由更硬：**它多半不是在你眼前发生的**——半夜的日常任务
     * 卡住了，开出来的单子只有这一份清单说得出来（见 docs/handoff.md §6）。
     * 每一页都拉，顶栏那个数才是随时可信的。
     */
    void loadHandoffs()
    startHandoffPoll()
    // 「这颗 Bot 的机器还在不在」同理，而且更硬：机器失联多半发生在人已经坐在对话页
    // 上的时候，不定期再问一次的话，那盏灯会一直停在他进来时的样子。见 startSeatWatch。
    startSeatWatch()
  }
  try {
    if (state.path === '/channels') {
      await loadChannels().catch(() => { state.channels = state.channels || [] })
      return
    }
    if (state.path === '/') {
      if (isOwner()) {
        await Promise.all([
          loadMe(),
          loadOrgs().catch(() => { state.orgs = [] }),
          loadUsers().catch(() => { state.users = [] }),
          loadCreds().catch(() => { state.creds = [] }),
          loadSettings().catch(() => {}),
        ])
      } else {
        // 管理员和员工的 / 都是对话页。管理员还要 loadOrg——右栏的运行环境要用。
        /**
         * **`/me` 不 await。**
         *
         * 走到这儿 `state.me` 必然已经有了（这个函数开头那句 `if (!state.me) return`
         * 就是这么保证的，而刷新时是 boot 刚拉的），下面的 isAdmin() 读的就是它。
         * 再 await 一次，等的是一份手上已经有的东西——刷新一次白挡一个 RTT，而正文
         * 排在这后面。留着这一跳是为了让「换了角色 / 改了资料」在切回首页时能刷新，
         * 那件事晚一帧到没有任何影响。
         */
        void loadMe().catch(() => {})
        if (isAdmin()) await Promise.all([loadOrg().catch(() => {}), loadSettings().catch(() => {})])
        await loadChatPage()
      }
    } else if (state.path === '/models') {
      await Promise.all([loadCatalog(), loadCreds(), loadSettings(), loadDiscovery()])
      const configured = configuredSet()
      if (!state.selectedProvider || !configured.has(state.selectedProvider)) {
        const dailyP = state.settings.daily?.provider
        const utilP = state.settings.utility?.provider
        state.selectedProvider =
          (dailyP && configured.has(dailyP) && dailyP) ||
          (utilP && configured.has(utilP) && utilP) ||
          [...configured][0] ||
          ''
      }
    } else if (state.path === '/stats') {
      await reloadStatsPage()
    } else if (state.path === '/tools') {
      await loadWebTools()
    } else if (state.path.startsWith('/connectors/')) {
      await loadConnectorDetail(connectorIdOfPath(state.path))
    } else if (state.path === '/connectors') {
      if (isOwner()) {
        // 上架清单、供应商状态、单价一起要：没有密钥时那颗「上架」按钮是灰的。
        await Promise.all([loadConnectorVendors(), loadConnectors(), loadSettings()])
      } else if (isAdmin()) {
        await loadOrgConnectors()
      } else {
        await loadMarket()
      }
    } else if (state.path === '/providers') {
      await Promise.all([loadCatalog(), loadCreds(), loadCustomProviders().catch(() => { state.customProviders = [] })])
    } else if (state.path === '/company') {
      await loadOrg()
    } else if (state.path === '/accounts') {
      await loadAccounts()
    } else if (state.path === '/audit') {
      await Promise.all([
        loadConversationAudits().catch(() => { state.auditItems = state.auditItems || [] }),
        loadConversationAuditCoverage().catch(() => { state.auditCoverage = state.auditCoverage || [] }),
        loadConversationAuditSettings().catch(() => { state.auditSettings = null }),
      ])
    } else if (state.path.startsWith('/audit/summary/')) {
      await loadConversationAuditItem(auditItemIdOfPath(state.path))
    } else if (state.path === '/machines') {
      await loadAllMachines()
    } else if (state.path.startsWith('/machines/')) {
      await loadMachineDetail(machineIdOfPath(state.path))
    } else if (state.path === '/releases') {
      await loadReleases()
    } else if (state.path === '/orders') {
      // 订单表单要选公司和套餐，两份列表都得先有。
      await Promise.all([loadOrders(), loadPlanSkus(), loadOrgs()])
    } else if (state.path === '/plans') {
      await loadPlanSkus()
    } else if (state.path === '/companies') {
      await loadOrgs()
    } else if (state.path.startsWith('/companies/')) {
      await loadCompanyDetail(companyIdOfPath(state.path))
    } else if (state.path.startsWith('/users/') && state.path !== '/users') {
      await loadUserDetail(userIdOfPath(state.path))
    } else if (state.path === '/users') {
      await loadUsers()
    } else if (state.path === '/profile') {
      await loadMe()
    } else if (state.path === '/bots') {
      // owner 管的是全局 Bot 名录；公司管理员这一页是模版，底下还列着全局那几个和
      // 停用掉的老公司 Bot，所以两份都要。
      if (isOwner()) await loadBots()
      // 员工名册也要拉：模版上「转人工交给谁」那一格里的「指定某个人」是从它出的。
      else await Promise.all([loadBotTemplate(), loadBots(), loadAccounts().catch(() => {})])
    } else if (state.path.startsWith('/bots/')) {
      await loadBotDetail(botIdOfPath(state.path))
    } else if (state.path === '/skills') {
      await loadSkills()
    } else if (state.path === '/billing' || state.path === '/costs') {
      if (location.pathname === '/costs') history.replaceState({}, '', '/billing')
      state.path = '/billing'
      resetChargePaging()
      // 余额和明细一起拉：这一屏要回答「还剩多少、都花在哪了」，分两次拉会在界面上
      // 短暂地互相矛盾。
      await Promise.all([loadBilling(), loadCharges('org')])
    } else if (state.path === '/usage') {
      await reloadUsagePage()
    } else if (isChatPath(state.path)) {
      await loadChatPage()
    }
  } catch (err) {
    flash('err', err.message)
  }
}
