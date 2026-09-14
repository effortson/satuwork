/**
 * 偏好与常量：主题、语言、图标、路径表、侧栏定义。
 *
 * **必须第一个加载**：这里有唯一一段「加载即执行」的代码（applyPrefs），后面几个文件
 * 都从它铺好的全局量上接着写。它自己不依赖任何后面的东西——别往这里加会调用别处函数
 * 的顶层语句，那在拼成一个文件的年代能跑，拆开之后就是 ReferenceError。
 */
const TOKEN_KEY = 'satuwork.gateway.token'
const THEME_KEY = 'satu.theme'
const LOCALE_KEY = 'satu.locale'

const ASIDE_KEY = 'satu.aside'
/**
 * 右侧运行环境栏的宽度与折叠状态。
 *
 * 落 localStorage：它是「工作台的形状」，不是页面状态——换个 Bot、切一次页面就恢复
 * 默认宽度会很烦人。
 */
const asidePref = (() => {
  // tab 决定这一栏现在摆的是哪一屏：运行环境（env）还是工作区文件（files）。
  // 一起记下来，因为「我上次在看文件」和「我把它收起来了」是同一类偏好。
  const tab = (raw) => (raw === 'files' ? 'files' : 'env')
  try {
    const raw = JSON.parse(localStorage.getItem(ASIDE_KEY) || '{}')
    return {
      open: raw.open !== false,
      width: Math.min(520, Math.max(200, Number(raw.width) || 280)),
      tab: tab(raw.tab),
    }
  } catch {
    return { open: true, width: 280, tab: 'env' }
  }
})()

function saveAside() {
  try {
    localStorage.setItem(ASIDE_KEY, JSON.stringify(asidePref))
  } catch {}
}

let themeMode = localStorage.getItem(THEME_KEY) || 'system'
let localeMode = localStorage.getItem(LOCALE_KEY) || 'zh'

const darkMq = matchMedia('(prefers-color-scheme: dark)')

/** system 在 CSS 里不存在：解析成 light/dark 再落到 <html data-theme>。 */
function paintTheme() {
  const resolved = themeMode === 'system' ? (darkMq.matches ? 'dark' : 'light') : themeMode
  document.documentElement.setAttribute('data-theme', resolved)
  // mermaid 的配色是渲染那一刻烧进 SVG 的，不跟 CSS 变量走——主题换了要重画。
  if (window.satuMd) satuMd.retheme()
}

function setTheme(mode) {
  themeMode = mode
  localStorage.setItem(THEME_KEY, mode)
  paintTheme()
}

function setLocale(key) {
  localeMode = key
  localStorage.setItem(LOCALE_KEY, key)
  document.documentElement.lang = key === 'en' ? 'en' : 'zh-CN'
}

/**
 * 界面文案。两种用法：
 *   t('保存')              查 i18n.js 的译表
 *   t('保存', 'Save')      就地给译文，优先于译表
 * 查不到就原样返回中文——露出一句没翻的，好过显示空白。
 */
function t(zh, en) {
  if (localeMode !== 'en') return zh
  if (en != null) return en
  const dict = window.SATU_I18N || {}
  if (dict[zh] != null) return dict[zh]
  // 文案两边的空格是排版用的，不该进译表的键——剥掉再查，查到了再贴回去。
  const trimmed = String(zh).trim()
  const hit = dict[trimmed]
  if (hit == null) return zh
  const lead = zh.slice(0, zh.indexOf(trimmed[0]))
  const tail = zh.slice(zh.indexOf(trimmed[0]) + trimmed.length)
  return `${lead}${hit}${tail}`
}

/**
 * 服务端错误。它只发中文，英文界面下按整句查表。
 * 带变量的（「口令至少 10 位」里的位数）先按模板归一化再查。
 */
function errText(msg) {
  if (localeMode !== 'en' || !msg) return msg
  const dict = window.SATU_I18N || {}
  if (dict[msg]) return dict[msg]
  const pw = msg.match(/^口令至少 (\d+) 位$/)
  if (pw) return `Password must be at least ${pw[1]} characters`
  // 带数字的那几句进不了字典（键是变的），在这里按模式翻。
  const queued = msg.match(/^还有 (\d+) 条消息排着队，先取消它们再开新对话$/)
  if (queued) return `${queued[1]} message(s) are still queued — cancel them before starting a new conversation.`
  return msg
}

function applyPrefs() {
  paintTheme()
  document.documentElement.lang = localeMode === 'en' ? 'en' : 'zh-CN'
}

darkMq.addEventListener('change', () => {
  if (themeMode === 'system') paintTheme()
})

applyPrefs()


const PATHS = {
  '/': { title: '概览' },
  // 登录页。放进表里只为让 pathOf() 认得这个地址（不认就一律折回 `/`）——它画的是
  // loginView，从来走不到 appView 的标题栏，登录之后 pathAllowed 会把人送回 `/`。
  '/login': { title: '登录' },
  // 隐私政策和服务条款（pages-legal.js）。同样只为让 pathOf() 认得这两个地址——它们
  // 画的是 legalView，和登录状态无关，从来走不到 appView 的标题栏。
  '/privacy': { title: '隐私政策' },
  '/terms': { title: '服务条款' },
  '/models': { title: '模型配置' },
  '/tools': { title: '工具配置' },
  '/providers': { title: '供应商' },
  '/company': { title: '公司/席位' },
  '/accounts': { title: '员工' },
  '/audit': { title: '审计' },
  '/companies': { title: '公司' },
  '/machines': { title: '机器管理' },
  '/releases': { title: '机器配置' },
  '/users': { title: '用户' },
  '/plans': { title: '套餐' },
  '/orders': { title: '购买与充值' },
  '/stats': { title: '统计' },
  '/billing': { title: '账单' },
  '/usage': { title: '用量统计' },
  '/costs': { title: '账单' },
  '/catalog': { title: '公司目录' },
  '/profile': { title: '个人设置' },
  '/bots': { title: 'Bot 模版', ownerTitle: '全局 Bot' },
  '/skills': { title: 'Skill 与 MCP', ownerTitle: '全局 Skill 与 MCP' },
  '/chat': { title: '对话' },
  '/handoffs': { title: '转人工待办' },
  '/channels': { title: '渠道' },
}

const ICONS = {
  overview: ['M3 10.5 12 3l9 7.5', 'M5 10v10h5v-6h4v6h5V10'],
  models: [
    'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
    'M9 9h6v6H9z',
    'M9 3v2',
    'M15 3v2',
    'M9 19v2',
    'M15 19v2',
  ],
  providers: ['M21 2l-2 2', 'M7 14a5 5 0 1 0 0 0.01', 'M12.5 8.5 21 2', 'M16 7l3 3'],
  company: ['M3 21h18', 'M5 21V7l7-4 7 4v14', 'M9 21v-6h6v6'],
  // 扳手：工具配置。和 providers 那把钥匙区分得开，都是单色描边。
  tools: ['M14.7 6.3a4 4 0 0 0 5.3 5.2l-8.5 8.5a2.1 2.1 0 0 1-3-3l8.5-8.5a4 4 0 0 0-2.3-2.2z', 'M15 4.5 19.5 9'],
  accounts: ['M2 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2', 'M8 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M19 8v6', 'M22 11h-6'],
  audit: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  plans: ['M4 7h16', 'M4 12h16', 'M4 17h10'],
  stats: ['M4 19V5', 'M4 19h16', 'M8 15v4', 'M12 11v8', 'M16 8v11'],
  billing: ['M2 5h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M1 10h22'],
  usage: ['M3 12h4l3 8 4-16 3 8h4'],
  catalog: ['M4 6h7v7H4z', 'M13 6h7v7h-7z', 'M4 15h7v5H4z', 'M13 15h7v5h-7z'],
  bots: ['M3 8h18a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z', 'M12 4v4', 'M8 14h.01', 'M16 14h.01'],
  // 机架：两层横条 + 各自一盏指示灯。跟 bots 那个「有触角的盒子」在 17px 下也分得开。
  machines: [
    'M4 4h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
    'M4 14h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z',
    'M7 7.5h.01',
    'M7 17.5h.01',
  ],
  skills: ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'],
  chat: ['M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-4l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'],
  // 插座：侧栏那颗「插件」。和 providers 那把钥匙分得开——一个是「密钥」，一个是「插上去」。
  plugins: ['M9 2v6', 'M15 2v6', 'M6 8h12v4a6 6 0 0 1-6 6 6 6 0 0 1-6-6z', 'M12 18v4'],
}

/**
 * Bot 头像。两个层级各八个，两套不重合。
 *
 * 底板形状就是层级：公司是圆角方牌，全局是六边牌 + 一圈内环。混在同一张列表里
 * （公司的 Bot 页会同时列出两种）扫一眼就能分开，不用去看那个「全局」小标。
 * 颜色只是帮衬——深浅主题下色相会变，形状不会。
 *
 * 每个头像是一整张图（底板填色 + 上面的线条），不是一枚线框图标；所以外面不用再
 * 套一层带背景的 .satu-providermark。
 */
const BOT_AVATAR_TILE = {
  // 圆角方牌。
  company: '<rect x="2" y="2" width="36" height="36" rx="11"/>',
  // 六边牌：顶点朝上下，和方牌在任何尺寸下都不会看混。
  global: '<path d="M20 1.8 35.8 10.9v18.2L20 38.2 4.2 29.1V10.9z"/>',
}

/** 全局那套多一圈内环，进一步跟公司那套拉开。 */
const BOT_AVATAR_RING = '<path d="M20 6.6 31.1 13v12.8L20 32.2 8.9 25.8V13z" fill="none" stroke-width="1.4" opacity="0.45"/>'

const BOT_AVATARS = {
  // ── 公司：日常岗位。─────────────────────────────────────────────
  'c-bot': { family: 'company', label: '助理', glyph: ['M13 16h14v10a2 2 0 0 1-2 2H15a2 2 0 0 1-2-2z', 'M20 11v5', 'M20 9.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z', 'M17 21h.02', 'M23 21h.02'] },
  'c-chat': { family: 'company', label: '客服', glyph: ['M11 14h18v10h-4l-5 4v-4h-9z', 'M16 19h.02', 'M20 19h.02', 'M24 19h.02'] },
  'c-chart': { family: 'company', label: '分析', glyph: ['M12 27h16', 'M16 27v-7', 'M20 27V13', 'M24 27v-10'] },
  'c-pen': { family: 'company', label: '文案', glyph: ['M12 28h16', 'M25.5 11.5a2.1 2.1 0 0 1 3 3L18 25l-4 1 1-4z'] },
  'c-deal': { family: 'company', label: '销售', glyph: ['M12 24l5-5 4 4 7-8', 'M23 15h5v5'] },
  'c-code': { family: 'company', label: '研发', glyph: ['M16 15l-5 5 5 5', 'M24 15l5 5-5 5', 'M22 13l-4 14'] },
  'c-flow': { family: 'company', label: '调度', glyph: ['M13 13h6v6h-6z', 'M21 21h6v6h-6z', 'M16 19v5h5'] },
  'c-book': { family: 'company', label: '知识', glyph: ['M12 13h7a3 3 0 0 1 3 3v12a3 3 0 0 0-3-3h-7z', 'M28 13h-6a3 3 0 0 0-3 3v12a3 3 0 0 1 3-3h6z'] },

  // ── 全局：平台级能力。──────────────────────────────────────────
  'g-core': { family: 'global', label: '核心', glyph: ['M20 15.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z', 'M20 11v3', 'M20 26v3', 'M14.3 14.3l2.1 2.1', 'M23.6 23.6l2.1 2.1', 'M25.7 14.3l-2.1 2.1', 'M16.4 23.6l-2.1 2.1'] },
  'g-relay': { family: 'global', label: '中转', glyph: ['M13 17.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z', 'M27 17.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z', 'M20 10.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z', 'M20 24.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z', 'M15.4 20h9.2', 'M20 15.4v9.2'] },
  'g-shield': { family: 'global', label: '守卫', glyph: ['M20 11l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9v-6z', 'M17 20l2.2 2.2L23.5 18'] },
  'g-globe': { family: 'global', label: '通用', glyph: ['M20 11.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M11.5 20h17', 'M20 11.5c2.4 2.6 3.6 5.4 3.6 8.5s-1.2 5.9-3.6 8.5c-2.4-2.6-3.6-5.4-3.6-8.5s1.2-5.9 3.6-8.5z'] },
  'g-spark': { family: 'global', label: '加速', glyph: ['M21.5 10.5 13.5 21h6l-1 8.5 8-10.5h-6z'] },
  'g-grid': { family: 'global', label: '编排', glyph: ['M13 13h5.5v5.5H13z', 'M21.5 13H27v5.5h-5.5z', 'M13 21.5h5.5V27H13z', 'M21.5 21.5H27V27h-5.5z'] },
  'g-beacon': { family: 'global', label: '广播', glyph: ['M20 17.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M15.4 15.4a6.5 6.5 0 0 0 0 9.2', 'M24.6 15.4a6.5 6.5 0 0 1 0 9.2', 'M12.6 12.6a10.5 10.5 0 0 0 0 14.8', 'M27.4 12.6a10.5 10.5 0 0 1 0 14.8'] },
  'g-vault': { family: 'global', label: '归档', glyph: ['M12.5 13h15v14h-15z', 'M12.5 18.5h15', 'M18 15.7h4', 'M18 23h4'] },
}

const COMPANY_AVATAR_KEYS = ['c-bot', 'c-chat', 'c-chart', 'c-pen', 'c-deal', 'c-code', 'c-flow', 'c-book']
const GLOBAL_AVATAR_KEYS = ['g-core', 'g-relay', 'g-shield', 'g-globe', 'g-spark', 'g-beacon', 'g-grid', 'g-vault']

/** 改版前存的那六个键，画之前先落到新的一套上。 */
const LEGACY_AVATARS = { bot: 'c-bot', chat: 'c-chat', chart: 'c-chart', pen: 'c-pen', deal: 'c-deal', code: 'c-code' }

function avatarKeysFor(origin) {
  return origin === 'global' ? GLOBAL_AVATAR_KEYS : COMPANY_AVATAR_KEYS
}

/**
 * 画一个头像。origin 决定层级（拿不准就按 key 前缀猜），key 决定画哪一个。
 * 颜色走主题变量，深浅色都成立。
 */
function botAvatar(key, size = 34, origin) {
  const k = LEGACY_AVATARS[key] || key
  const a = BOT_AVATARS[k]
  const fam = a ? a.family : origin === 'global' || String(k).startsWith('g-') ? 'global' : 'company'
  const def = a || BOT_AVATARS[fam === 'global' ? 'g-core' : 'c-bot']
  const bg = fam === 'global' ? 'var(--color-accent-2-200)' : 'var(--color-accent-200)'
  const fg = fam === 'global' ? 'var(--color-accent-2-800)' : 'var(--color-accent-800)'
  const tile = BOT_AVATAR_TILE[fam].replace('/>', ` fill="${bg}"/>`)
  const ring = fam === 'global' ? BOT_AVATAR_RING.replace('stroke-width', `stroke="${fg}" stroke-width`) : ''
  const glyph = def.glyph.map((d) => `<path d="${esc(d)}"/>`).join('')
  return `<svg width="${size}" height="${size}" viewBox="0 0 40 40" role="img" aria-label="${esc(t(def.label))}" style="flex: none; display: block;">
    ${tile}${ring}
    <g fill="none" stroke="${fg}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</g>
  </svg>`
}

const MEMORY_SCOPES = ['仅本人', '所属分组', '全公司']
const MEMORY_KINDS = ['偏好', '事实', '流程', '联系人']
const MEMORY_TTLS = ['30 天', '90 天', '180 天', '永久保留']
const DEFAULT_BOT_GUARDS = [
  { id: 'high-risk', title: '高风险操作需确认', desc: '对外发送、改写数据或付款前先征求同意', on: true },
  { id: 'pii', title: '拦截个人敏感信息', desc: '手机号、证件号、银行卡等不写入记忆、不外发', on: true },
  { id: 'no-external', title: '禁止访问未授权的外部系统', desc: '只允许调用已勾选的 MCP 与连接器', on: true },
]


/** 二级页面头上那个返回。 */
const BACK_ARROW = ['M19 12H5', 'M12 19l-7-7 7-7']

/** 收起右栏。对话 header 上那颗独立的收起按钮画的就是它。 */
const CHEVRON_RIGHT = ['M9 18l6-6-6-6']

/**
 * 树上那个展开/收起的小三角。**和 CHEVRON_RIGHT 是同一条路径**，两个名字留着是因为
 * 用处不同（这个配 12px，那个配 16px），改形状时两处都要动。
 */
const CHEVRON_SMALL_RIGHT = ['M9 18l6-6-6-6']
const CHEVRON_SMALL_DOWN = ['M6 9l6 6 6-6']

/** 重新取一次。工作区那一屏用它——文件是 Bot 在背后写的，界面自己不知道什么时候变。 */
const REFRESH = ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 4v5h-5']

/** 工作区文件那一屏的开关。一个文件夹——它说的就是「这里面是这台席位上的文件」。 */
const FOLDER = [
  'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
]

/**
 * 运行环境那一屏的图标。**一台显示器**——它说的是「这里面是这台席位的桌面」。
 *
 * 早先这颗按钮是两态两个图标（收着画显示器、展开画收起箭头），想的是「展开之后要说
 * 的是点了会怎样」。那个设计已经撤了：同一个位置上的图标一开一关是两个意思，而人是
 * 照位置去点的——要收起，得先想起来「现在开着的是哪一屏」。现在切屏那两颗永远画自己
 * 那一屏，收起是旁边独立的一颗（见 render.js 的 asideToggle）。
 */
const MONITOR = [
  'M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  'M12 16v3',
  'M8.5 19h7',
]

const GEAR = [
  'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
]

/**
 * 平台侧栏。**分组的，不是一条长名单。**
 *
 * 这一侧有十几个入口，平铺下来是一根找不到落点的柱子：机器、模型、套餐、公司混在
 * 一起，每次都得从头读一遍才知道要点哪个。按「这一屏在管什么」切开之后，找东西先
 * 认组再认条，一眼就能跳过四分之三。
 *
 * 组内顺序仍然有讲究，见各组注释；组的顺序按「多久看一次」排：先是客户和机器（天天
 * 看），然后是能力（改一次管很久），最后是钱（月末才翻）。
 *
 * 第一组没有标题——「概览」就一条，给它盖个名字只是多一行字。
 */
const OWNER_NAV_GROUPS = [
  { label: '', items: [{ href: '/', label: '概览', icon: 'overview' }] },
  {
    // 公司和用户是同一件事的两个粒度：一家公司里坐着哪些人。查一个人多半是从他所在
    // 的公司找过去的，反过来也一样，所以这两条挨着。
    label: '客户',
    items: [
      { href: '/companies', label: '公司', icon: 'company' },
      { href: '/users', label: '用户', icon: 'accounts' },
    ],
  },
  {
    // 机器管理在机器配置**上面**：先是「平台上有哪些机器、哪台出事了」，然后才是
    // 「给它们发什么版本的包」。发布包那一页是给这一页服务的，不是反过来。
    label: '基础设施',
    items: [
      { href: '/machines', label: '机器管理', icon: 'machines' },
      { href: '/releases', label: '机器配置', icon: 'bots' },
    ],
  },
  {
    // 这一组答的是同一个问题：**Bot 能用什么**。供应商是模型从哪来，模型配置是上了
    // 哪些脑子，工具配置和全局 Skill / MCP 是手，连接器是它能登进哪些外部账号。
    // 全局 Skill / MCP 跟公司侧共用同一套页面，差别只在 catalogBase() 给出的接口前缀。
    label: '能力',
    items: [
      { href: '/providers', label: '供应商', icon: 'providers' },
      { href: '/models', label: '模型配置', icon: 'models' },
      { href: '/tools', label: '工具配置', icon: 'tools' },
      { href: '/skills', label: '全局 Skill 与 MCP', icon: 'skills' },
      { href: '/connectors', label: '连接器', icon: 'providers' },
    ],
  },
  {
    // 钱：卖什么、收了多少、用掉多少。统计留在这一组而不是跟着「概览」，是因为翻它
    // 的时候多半正在对账，而不是在看今天平台好不好。
    label: '经营',
    items: [
      { href: '/plans', label: '套餐', icon: 'plans' },
      { href: '/orders', label: '购买与充值', icon: 'billing' },
      { href: '/stats', label: '统计', icon: 'stats' },
    ],
  },
]

/**
 * 拍平的那一份。allowedHrefs() 只关心「这个角色能去哪些地址」，不关心分组；分了组
 * 之后它照旧从这里读，省得每处都去展一遍。
 *
 * **「全局 Bot」不在这份菜单里。** 平台这一侧管的是公司、机器、模型和钱，Bot 名录
 * 是公司侧的东西；把它摆在平台菜单里，每次进来都要先分辨「这是全局的还是某家公司
 * 的」。页面本身没有撤——全局 Bot 目录还得有人维护，而 owner 是唯一改得动它的人，
 * 所以 allowedHrefs 里单独补了 /bots，直接输地址仍然进得去。
 */
const OWNER_NAV = OWNER_NAV_GROUPS.flatMap((g) => g.items)

const ADMIN_NAV = [
  { href: '/company', label: '公司/席位', icon: 'company' },
  { href: '/accounts', label: '员工', icon: 'accounts' },
  { href: '/audit', label: '审计', icon: 'audit' },
  { href: '/billing', label: '账单', icon: 'billing' },
  { href: '/usage', label: '用量统计', icon: 'usage' },
  { href: '/bots', label: 'Bot 模版', icon: 'bots' },
  // 公司自己的模型密钥：配了就优先于平台共用那把，没配的供应商用平台的。
  { href: '/providers', label: '供应商', icon: 'providers' },
  { href: '/skills', label: 'Skill 与 MCP', icon: 'skills' },
  { href: '/connectors', label: '连接器', icon: 'providers' },
]

/**
 * 员工侧栏又空了。
 *
 * 连接器曾经是这里唯一一行，现在它的入口是名单底下那颗「插件」按钮（render.js 的
 * appView + pluginsModal）——装插件是为了把话说完，入口就该挨着 Bot，而不是在一条
 * 菜单里。同一件事留两个并排的入口，只会让人问「这两个有什么不一样」。
 *
 * **页面没有撤**：`/connectors` 和 `/connectors/:id` 还在，OAuth 回调就落在那儿
 * （`gateway/src/routes/connectors.ts` 的 302），所以 allowedHrefs() 里单独放行。
 */
const MEMBER_NAV = []

/**
 * 公司侧还是一整组，但这组可以整段折叠。
 *
 * 公司管理员那八条本来就同属一件事（「我这家公司」），再切一刀只会切出「两条一组」
 * 这种没有信息量的堆。侧栏只认这一种形状，所以这里把它包成一组；`key` 是折叠状态的
 * 稳定标识，不能拿会随语言变化的 label 代替。
 *
 * 员工那一份是**空数组，不是一个空组**：包一层的话侧栏会照画那条分隔线和一个空 div，
 * 名单底下凭空多出一道横线。
 */
const ADMIN_NAV_GROUPS = [{ key: 'company', label: '公司', collapsible: true, items: ADMIN_NAV }]
const MEMBER_NAV_GROUPS = []
