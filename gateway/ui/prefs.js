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
 * 右栏的两档宽度。
 *
 * **文件预览单独记一个宽度。** 平时那一栏摆的是一列状态和一棵树，280 正好；预览摆的是
 * 一整页 PDF、一张图、一份 HTML，280 宽什么也看不清。共用一个数的话，人每次打开预览都
 * 要拖宽、关掉再拖窄——两件事各记各的，拖一次就记住。
 */
const ASIDE_PREVIEW_WIDTH = 560

function asideWidthOf(raw, preview) {
  return preview
    ? Math.min(1600, Math.max(320, Number(raw) || ASIDE_PREVIEW_WIDTH))
    : Math.min(520, Math.max(200, Number(raw) || 280))
}

/**
 * 右栏的宽度、折叠状态和正摆着哪一屏。
 *
 * 落 localStorage：它是「工作台的形状」，不是页面状态——换个 Bot、切一次页面就恢复
 * 默认宽度会很烦人。
 */
const asidePref = (() => {
  // tab 决定这一栏现在摆的是哪一屏：运行环境（env）、工作区文件（files）还是转人工
  // 待办（handoffs）。一起记下来，因为「我上次在看文件」和「我把它收起来了」是同一类偏好。
  const tab = (raw) => (raw === 'files' || raw === 'handoffs' ? raw : 'env')
  try {
    const raw = JSON.parse(localStorage.getItem(ASIDE_KEY) || '{}')
    return {
      open: raw.open !== false,
      width: asideWidthOf(raw.width, false),
      previewWidth: asideWidthOf(raw.previewWidth, true),
      tab: tab(raw.tab),
    }
  } catch {
    return { open: true, width: 280, previewWidth: ASIDE_PREVIEW_WIDTH, tab: 'env' }
  }
})()

function saveAside() {
  try {
    localStorage.setItem(ASIDE_KEY, JSON.stringify(asidePref))
  } catch {}
}

/**
 * 手机那一档。侧栏收成抽屉、右栏盖在对话上（见 app.css 末尾那段）。**断点和 CSS 里是
 * 同一个数**，改一处要改两处。
 */
const narrowMq = matchMedia('(max-width: 760px)')

function narrowScreen() {
  return Boolean(narrowMq.matches)
}

/**
 * 窄屏上右栏开没开，另记一份、不落盘。
 *
 * asidePref.open 是桌面上记下来的「工作台的形状」，默认就是开着的。手机上照它来，一进
 * 对话页右栏就整块盖在对话上——人得先找到那颗收起，才看得见自己在跟谁说话。而且在手机
 * 上收一下也不该把电脑上的右栏一起收掉。
 */
let narrowAsideOpen = false

function asideOpen() {
  return narrowScreen() ? narrowAsideOpen : asidePref.open
}

function setAsideOpen(open) {
  if (narrowScreen()) {
    narrowAsideOpen = open
    return
  }
  asidePref.open = open
  saveAside()
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
 * 界面文案与服务端错误的翻译。实现在 core/src/i18n/t.ts（查的是同一份译表），这里只把
 * 当前语言传进去：
 *   t('保存')              查译表
 *   t('保存', 'Save')      就地给译文，优先于译表
 */
function t(zh, en) {
  return SatuCore.t(localeMode, zh, en)
}

function errText(msg) {
  return SatuCore.errText(localeMode, msg)
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
  // 应用内的「下载桌面端」（pages-landing.js 的 downloadPage），登录之后才走得到——没登录
  // 的人被 app.js 的 foldDownload 折到首页那一段。
  '/download': { title: '下载桌面端' },
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
  '/knowledge': { title: '知识库' },
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
 * 公司 Bot 是有表情和配饰的小角色；全局 Bot 仍用六边牌 + 内环表示平台能力。
 * 键沿用旧值，已经选过头像的 Bot 会直接看到新版插画。
 *
 * 每个头像是一整张图（底板填色 + 上面的线条），不是一枚线框图标；所以外面不用再
 * 套一层带背景的 .satu-providermark。
 */
const BOT_AVATAR_TILE = '<path d="M20 1.8 35.8 10.9v18.2L20 38.2 4.2 29.1V10.9z"/>'

/** 全局那套多一圈内环，进一步跟公司那套拉开。 */
const BOT_AVATAR_RING = '<path d="M20 6.6 31.1 13v12.8L20 32.2 8.9 25.8V13z" fill="none" stroke-width="1.4" opacity="0.45"/>'

// 公司头像是完整的小插画。轮廓和五官都画在 40px 画布上，缩到列表里的 30px 也能辨认。
const COMPANY_AVATAR_ART = {
  'c-bot': `<rect x="2" y="2" width="36" height="36" rx="12" fill="#FFE8D9"/>
    <path d="M11 33c1-5 5-7 9-7s8 2 9 7v5H11z" fill="#F28A70"/>
    <path d="M20 10V7" stroke="#714A48" stroke-width="2" stroke-linecap="round"/>
    <circle cx="20" cy="6" r="2.3" fill="#F7B650"/>
    <rect x="8" y="13" width="24" height="17" rx="8" fill="#FFF9F1" stroke="#714A48" stroke-width="1.5"/>
    <circle cx="7.5" cy="21" r="2" fill="#F7B650"/><circle cx="32.5" cy="21" r="2" fill="#F7B650"/>
    <circle cx="15" cy="21" r="1.5" fill="#493C44"/><circle cx="25" cy="21" r="1.5" fill="#493C44"/>
    <circle cx="11.5" cy="25" r="2" fill="#FFB5AB"/><circle cx="28.5" cy="25" r="2" fill="#FFB5AB"/>
    <path d="M17 25c1.6 2 4.4 2 6 0" fill="none" stroke="#714A48" stroke-width="1.5" stroke-linecap="round"/>`,
  'c-chat': `<rect x="2" y="2" width="36" height="36" rx="12" fill="#DDF3F5"/>
    <path d="M10 37c0-6 4-9 10-9s10 3 10 9" fill="#76B8C7"/>
    <circle cx="20" cy="20" r="11" fill="#FFF8EE"/>
    <path d="M9 21v-3a11 11 0 0 1 22 0v3" fill="none" stroke="#428BA5" stroke-width="3" stroke-linecap="round"/>
    <rect x="7" y="19" width="4" height="8" rx="2" fill="#428BA5"/><rect x="29" y="19" width="4" height="8" rx="2" fill="#428BA5"/>
    <circle cx="16" cy="21" r="1.5" fill="#3F4A55"/><circle cx="24" cy="21" r="1.5" fill="#3F4A55"/>
    <path d="M17 26c2 1.5 4 1.5 6 0M30 27c0 3-3 4-6 4" fill="none" stroke="#428BA5" stroke-width="1.6" stroke-linecap="round"/>
    <circle cx="23.5" cy="31" r="1.5" fill="#428BA5"/>`,
  'c-chart': `<rect x="2" y="2" width="36" height="36" rx="12" fill="#FFF1CE"/>
    <path d="M10 38c0-6 4-9 10-9s10 3 10 9" fill="#E8B65C"/>
    <circle cx="11" cy="14" r="4" fill="#C47E49"/><circle cx="29" cy="14" r="4" fill="#C47E49"/>
    <rect x="9" y="11" width="22" height="20" rx="10" fill="#F8D9A8"/>
    <circle cx="16" cy="21" r="4" fill="#FFFDF5" stroke="#66514B" stroke-width="1.5"/>
    <circle cx="24" cy="21" r="4" fill="#FFFDF5" stroke="#66514B" stroke-width="1.5"/>
    <path d="M20 20h0" stroke="#66514B" stroke-width="1.5"/>
    <circle cx="16" cy="21" r="1.2" fill="#443C3C"/><circle cx="24" cy="21" r="1.2" fill="#443C3C"/>
    <path d="M18 27q2 2 4 0" fill="none" stroke="#66514B" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M17 34v3m3-5v5m3-2v2" stroke="#FFF7E4" stroke-width="1.4" stroke-linecap="round"/>`,
  'c-pen': `<rect x="2" y="2" width="36" height="36" rx="12" fill="#EFE6FA"/>
    <path d="M9 38c0-6 5-9 11-9s11 3 11 9" fill="#A991CF"/>
    <path d="M10 16c0-7 4-11 10-11s10 4 10 11" fill="#684E86"/>
    <circle cx="20" cy="21" r="11" fill="#FFE9D3"/>
    <path d="M9 17c1-8 6-11 12-11 4 0 8 3 10 9-5-2-7-4-8-6-2 4-7 7-14 8" fill="#684E86"/>
    <path d="M15 22h2m6 0h2" stroke="#4D3E50" stroke-width="2" stroke-linecap="round"/>
    <path d="M18 27q2 2 4 0" fill="none" stroke="#9B5B66" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M27 35l6-9 2 2-6 9-3 1z" fill="#F5B85A" stroke="#684E86" stroke-width="1"/>`,
  'c-deal': `<rect x="2" y="2" width="36" height="36" rx="12" fill="#FFE5DC"/>
    <path d="M10 38c0-6 4-9 10-9s10 3 10 9" fill="#E97D69"/>
    <path d="M9 20 10 9l7 5m14 6L30 9l-7 5" fill="#D56A52" stroke="#985244" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M10 17c2-6 6-8 10-8s8 2 10 8l1 7c-2 5-6 8-11 8s-9-3-11-8z" fill="#F6A477"/>
    <path d="M12 23c1-3 4-4 8-2 4-2 7-1 8 2-1 5-4 8-8 8s-7-3-8-8" fill="#FFF6E9"/>
    <path d="M14 21h3m6 0h3" stroke="#5B4341" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M18 25h4l-2 2z" fill="#6B4B48"/>
    <circle cx="15" cy="26" r="1.5" fill="#F7B4A9"/><circle cx="25" cy="26" r="1.5" fill="#F7B4A9"/>`,
  'c-code': `<rect x="2" y="2" width="36" height="36" rx="12" fill="#DEF4E8"/>
    <path d="M9 38c0-6 5-9 11-9s11 3 11 9" fill="#75BCA4"/>
    <path d="M9 16c0-6 5-9 11-9s11 3 11 9v7c0 6-5 10-11 10S9 29 9 23z" fill="#E6BC91"/>
    <path d="M8 17c0-7 5-11 12-11s12 4 12 11c-4-1-7-3-9-6-3 4-8 6-15 6" fill="#3C655F"/>
    <rect x="11" y="19" width="8" height="6" rx="2.5" fill="#FFFDF4" stroke="#3C655F" stroke-width="1.4"/>
    <rect x="21" y="19" width="8" height="6" rx="2.5" fill="#FFFDF4" stroke="#3C655F" stroke-width="1.4"/>
    <path d="M19 21h2" stroke="#3C655F" stroke-width="1.4"/>
    <circle cx="15" cy="22" r="1.1" fill="#344640"/><circle cx="25" cy="22" r="1.1" fill="#344640"/>
    <path d="M18 28q2 1.5 4 0" fill="none" stroke="#76594B" stroke-width="1.4" stroke-linecap="round"/>
    <path d="m16 34-2 2 2 2m8-4 2 2-2 2" fill="none" stroke="#F5FFF9" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`,
  'c-flow': `<rect x="2" y="2" width="36" height="36" rx="12" fill="#E5ECFF"/>
    <path d="M10 38c0-6 4-9 10-9s10 3 10 9" fill="#899EDD"/>
    <circle cx="8" cy="22" r="3" fill="#8198D6"/><circle cx="32" cy="22" r="3" fill="#8198D6"/>
    <rect x="9" y="11" width="22" height="21" rx="8" fill="#F8F7FF" stroke="#6279BA" stroke-width="1.5"/>
    <path d="M14 10V7m12 3V7" stroke="#6279BA" stroke-width="1.7" stroke-linecap="round"/>
    <circle cx="14" cy="6" r="2" fill="#F2B96E"/><circle cx="26" cy="6" r="2" fill="#F2B96E"/>
    <rect x="13" y="19" width="5" height="5" rx="2.5" fill="#6279BA"/>
    <rect x="22" y="19" width="5" height="5" rx="2.5" fill="#6279BA"/>
    <path d="M17 27q3 2 6 0" fill="none" stroke="#6279BA" stroke-width="1.4" stroke-linecap="round"/>
    <circle cx="20" cy="35" r="2" fill="#F2B96E"/>`,
  'c-book': `<rect x="2" y="2" width="36" height="36" rx="12" fill="#FCECD9"/>
    <path d="M9 38c0-6 4-9 11-9s11 3 11 9" fill="#B08C77"/>
    <path d="M9 17 7 8l9 4m15 5 2-9-9 4" fill="#8E6D61"/>
    <path d="M9 19c0-7 5-11 11-11s11 4 11 11v4c0 6-5 10-11 10S9 29 9 23z" fill="#CFAB8B"/>
    <path d="M11 20c0-4 3-6 7-5l2 3 2-3c4-1 7 1 7 5-1 6-4 10-9 10s-8-4-9-10" fill="#FFF5E8"/>
    <circle cx="16" cy="21" r="2" fill="#4E4544"/><circle cx="24" cy="21" r="2" fill="#4E4544"/>
    <path d="m18 25 2 2 2-2z" fill="#E7A063"/>
    <path d="M14 34c3-1 5 0 6 2 1-2 3-3 6-2v4c-3-1-5 0-6 1-1-1-3-2-6-1z" fill="#FFF9ED" stroke="#8E6D61" stroke-width="1"/>`,
}

const BOT_AVATARS = {
  // ── 公司：日常岗位。─────────────────────────────────────────────
  'c-bot': { family: 'company', label: '助理' },
  'c-chat': { family: 'company', label: '客服' },
  'c-chart': { family: 'company', label: '分析' },
  'c-pen': { family: 'company', label: '文案' },
  'c-deal': { family: 'company', label: '销售' },
  'c-code': { family: 'company', label: '研发' },
  'c-flow': { family: 'company', label: '调度' },
  'c-book': { family: 'company', label: '知识' },

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
 * 公司头像用固定的插画配色；全局头像沿用主题色。
 */
function botAvatar(key, size = 34, origin) {
  const k = LEGACY_AVATARS[key] || key
  const a = BOT_AVATARS[k]
  const fam = a ? a.family : origin === 'global' || String(k).startsWith('g-') ? 'global' : 'company'
  const def = a || BOT_AVATARS[fam === 'global' ? 'g-core' : 'c-bot']
  if (fam === 'company') {
    const art = COMPANY_AVATAR_ART[a?.family === 'company' ? k : 'c-bot']
    return `<svg width="${size}" height="${size}" viewBox="0 0 40 40" role="img" aria-label="${esc(t(def.label))}" style="flex: none; display: block;">${art}</svg>`
  }
  const bg = 'var(--color-accent-2-200)'
  const fg = 'var(--color-accent-2-800)'
  const tile = BOT_AVATAR_TILE.replace('/>', ` fill="${bg}"/>`)
  const ring = BOT_AVATAR_RING.replace('stroke-width', `stroke="${fg}" stroke-width`)
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
  // 「供应商」撤了：模型密钥只由系统管理员在平台那一屏配，全平台共用，公司这一侧
  // 既配不了也看不了（见 state.js 的 allowedHrefs、gateway/src/llm.ts 的 secret）。
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
