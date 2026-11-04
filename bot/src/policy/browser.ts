/**
 * 浏览器那几把工具的判据。**纯函数**，不碰 CDP 也不碰上下文——策略要在工具执行的
 * 关键路径上调它们，一次超时就是一次卡住的对话（和 shell.ts 同一条理由）。
 *
 * 两件事：
 *
 *  1. 这个地址能不能开（硬黑名单 + 公司白名单）
 *  2. 这次动作算不算「提交」，要不要人拍板
 */

/** 只走 http/https。file:// 能读整块盘，chrome:// 和 devtools:// 能改浏览器自己。 */
const SCHEME = /^https?:$/

/**
 * 这些后缀指的都是这台机器或这个内网。
 *
 * 和 Gateway 那份 LOCAL_SUFFIX 是同一套（gateway/src/lib/catalog.ts），改一边就要改
 * 另一边——两个包各自打包，中间没有共享类型。
 */
const LOCAL_SUFFIX = ['.local', '.localhost', '.internal', '.home.arpa']

/**
 * 取主机名。**用 URL 解析，不用正则切**——`https://evil.com@127.0.0.1/` 这种写法里，
 * 正则切出来的是 `evil.com`，而浏览器真正会去连的是 `127.0.0.1`。判错方向恰好是最坏
 * 的那个方向。
 */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(String(url || '').trim())
    if (!SCHEME.test(u.protocol)) return null
    // IPv6 字面量带方括号，去掉再判。
    // 末尾那个点也去掉：`localhost.` 和 `localhost` 解析到同一台机器，但下面每一条
    // 判据都是按字符串比的，带点的那种写法能从它们全部旁边走过去。
    return u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  } catch {
    return null
  }
}

function ipv4Private(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 127 || a === 0 || a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  // 169.254/16 里住着云厂商的 metadata（169.254.169.254），那是一把机器凭据。
  if (a === 169 && b === 254) return true
  // 100.64/10（CGNAT，Tailscale 这类）也不是「外部系统」。
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/**
 * IPv6 → 8 组 16 位整数。展不开返回 null。
 *
 * 只为 `ipv6Private` 服务，不追求通用：`::` 补零、末尾的点分四段折成两组、`%eth0`
 * 这类 zone id 丢掉。
 *
 * **和 Gateway 那份 `ipv6Groups` 是同一套**（gateway/src/web-tools.ts），改一边就要改
 * 另一边——两个包各自打包，中间没有共享类型，同 LOCAL_SUFFIX。
 */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, '')
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s)
  if (dotted) {
    const p = dotted[1]!.split('.').map(Number)
    if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    s = s.slice(0, dotted.index) + (((p[0]! << 8) | p[1]!).toString(16) + ':' + ((p[2]! << 8) | p[3]!).toString(16))
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0]!.split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1]!.split(':') : []
  if (halves.length === 1 && head.length !== 8) return null
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0) return null
  const parts = [...head, ...Array<string>(fill).fill('0'), ...tail]
  if (parts.length !== 8) return null
  const out = parts.map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? Number.parseInt(h, 16) : NaN))
  return out.some((n) => !Number.isInteger(n)) ? null : out
}

/**
 * 这个 IPv6 地址是不是本机 / 内网。**按 8 组数值判，不按字符串前缀判。**
 *
 * 原先是三条正则：`^f[cd][0-9a-f]{2}:`、`^fe[89ab][0-9a-f]:`，以及一条只认**点分**写法
 * 的映射地址 `:(\d+\.\d+\.\d+\.\d+)$`。问题出在最后那条——同一个地址有两种写法，而这
 * 一层拿到的是什么写法**不由我们决定**：
 *
 * · `blockedHost` 那条路上，主机名来自 `new URL().hostname`，而 WHATWG 的 IPv6 序列化
 *   只做十六进制压缩——`http://[::ffff:127.0.0.1]/` 到这儿就是 `::ffff:7f00:1`，点分那
 *   条正则一次都配不上。
 * · `privateAddress` 那条路上，地址是 Chrome 经 CDP 报上来的 `remoteIPAddress`，形态
 *   随平台和版本走。
 *
 * **今天它被两层意外挡着，两层都不该指望：** `blockedHost` 末尾那条「不带点的一律拒」
 * 顺手把 `::ffff:7f00:1` 拦了（但回的是一句「认不出这是哪个站点」，和真正的原因毫无
 * 关系——正是这个文件反复在防的那种误导）；而 `privateAddress` **压根没有那条兜底**，
 * 它不能有：一个公网 IPv6 里本来就没有点，那正是把这两个函数拆开的全部理由。也就是说
 * DNS rebinding 那道最后的闸，挡不挡得住取决于 Chrome 打印地址时用了哪种写法。
 *
 * 展开成 8 组之后，「写法」这个变量就从判据上拿掉了：点分和十六进制是同一串数。
 */
function ipv6Private(host: string): boolean {
  if (!host.includes(':')) return false
  const g = ipv6Groups(host)
  // 展不开的一律当内网拒：这一层宁可多拦，见 policy/index.ts 里 checkBrowser 的取向。
  if (!g) return true
  const [a, b, c, d, e, f] = g as [number, number, number, number, number, number, number, number]
  const zeroPrefix = a === 0 && b === 0 && c === 0 && d === 0 && e === 0
  // ::/128 与 ::1/128
  if (zeroPrefix && f === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true
  if ((a & 0xffc0) === 0xfe80) return true // fe80::/10 链路本地
  if ((a & 0xfe00) === 0xfc00) return true // fc00::/7 唯一本地
  /**
   * 末 32 位是一个 v4 地址的那几种前缀，按它内嵌的 v4 再判一遍：`::ffff:0:0/96`
   * （IPv4 映射）、`::/96`（已废弃的 IPv4 兼容写法）、`64:ff9b::/96`（NAT64）。
   * 三者都会让内核把包发到那个 v4 地址上。
   */
  const embedsV4 =
    (zeroPrefix && f === 0xffff) || (zeroPrefix && f === 0) || (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0)
  if (embedsV4) return ipv4Private(`${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`)
  return false
}

/**
 * 这个**地址**（已经解析出来的 IP）是不是内网 / 回环。
 *
 * **和 `blockedHost` 分开，是因为它们判的不是一种东西。** 那一个收的是 URL 里写着的
 * 主机名，所以带着一堆只对主机名成立的启发式——尤其是「不带点的一律拒」（内网机器
 * 多半就叫 `gitlab`、`nas` 这样一个词）。
 *
 * 拿它去判一个 IP 就会出事，而且是往最坏的方向出：**一个公网 IPv6 里没有点**
 * （`2606:4700::6810:84e5`，Cloudflare 那段），照那条规则会被当成内网机器名拦下来。
 * 线上撞过——所有 https 站点全部打不开，报的还是一句和原因毫无关系的
 * 「只能打开 http / https 的地址」。
 *
 * 所以这里只判地址本身：回环、私有段、链路本地、CGNAT、云厂商的 metadata。
 */
export function privateAddress(ip: string): string | null {
  const host = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return null
  if (ipv4Private(host) || ipv6Private(host)) return '本机或内网地址'
  return null
}

/**
 * 这个主机**永远**不许打开，不受任何开关控制。
 *
 * 拦的不是「越权访问外部系统」——那是 no-external 那条开关的事，它可以被管理员关掉。
 * 这里防的是**用浏览器回头打自己**：席位上听着 bot 口（3200+N）、CDP 口（9222+N）和
 * 管家的口，src/guard/index.ts 顶上那段注释已经为「员工在桌面里打得到
 * 127.0.0.1:<botPort>」删过一整套账号体系。从浏览器这边把同一个洞再开一次，Bot 就能
 * 给自己发指令、读自己的席位票、或者直接跟管家说话。
 *
 * 返回一句给人看的话，没问题时返回 null。
 */
export function blockedHost(host: string | null): string | null {
  if (!host) return '只能打开 http / https 的地址'
  if (host === 'localhost' || host.endsWith('.localhost')) return '本机地址不许打开'
  if (LOCAL_SUFFIX.some((suffix) => host.endsWith(suffix))) return '内网地址不许打开'
  if (ipv4Private(host) || ipv6Private(host)) return '本机或内网地址不许打开'
  /**
   * **不带点的主机名一律拒。** 内网里的机器多半就叫 `gitlab`、`nas`、`erp` 这样一个词，
   * 靠 DNS 搜索域补全出全名——那正是一条绕开上面全部判据的路。
   */
  if (!host.includes('.')) return '认不出这是哪个站点（主机名里没有域名）'
  return null
}

/**
 * 一条带 `*` 的站点 → 正则。
 *
 * **`*` 只在一段标签之内顶字符，不跨点。** 这是整条通配符设计的全部安全性所在：跨点的话
 * `*.com` 就等于整个互联网，而它在界面上看起来只是一条普通的白名单。所以 `*` 展开成
 * `[a-z0-9-]+`（域名标签的字符集），点保持是点。
 *
 * 顺带一条：**至少配一个字符**，不是零个。`*.example.com` 不该把 `.example.com` 或者
 * `example.com` 本身算进去——想连自己一起覆盖就写裸域名，那是另一种写法，语义更宽也更
 * 直白。
 */
function wildcardRe(site: string): RegExp {
  const body = site
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[a-z0-9-]+')
  return new RegExp(`^${body}$`)
}

/** 全部放开的两种写法。Gateway 那边把单个 `*` 归一到 `*.*`，这里两种都认。 */
const ALL = new Set(['*', '*.*'])

/**
 * 这个主机在公司白名单里吗。
 *
 * 一条规则贯穿所有写法：**按标签配，配上了就连它的子域一起算。**
 *
 * | 写的 | 配得上 | 配不上 |
 * | --- | --- | --- |
 * | `example.com` | 它自己、`app.example.com`、`a.b.example.com` | `evil-example.com` |
 * | `*.example.com` | `app.example.com`、`a.b.example.com` | `example.com` 自己 |
 * | `erp-*.corp.com` | `erp-hz.corp.com` | `erp.corp.com` |
 * | `example.*` | `example.cn`、`app.example.com` | `notexample.cn` |
 * | `*.*` | 什么都行 | — |
 *
 * `*` 顶的是**一段标签之内**的字符（`[a-z0-9-]+`），不跨点；跨点的活由「配上了含子域」
 * 那一半去干。两件事分开之后，`*.example.com` 是「至少一层子域」，而 `example.com` 是
 * 「它自己和所有子域」——差别在要不要主站，而不是层数。
 *
 * **这份名单只管「能去哪些外部站点」。** 回环、内网、非 http 由 `blockedHost` 单独拦，
 * 那一层跑在这之前、谁都关不掉——所以哪怕这儿写着 `*.*`，放开的也是整个公网，不是这台
 * 机器自己。两件事分层的意义就在这儿：宽窄归管理员定，「打不打得到自己」不归。
 *
 * 名单是从目录同步下来的，**不假设它一定过过 Gateway 的 `botSiteOf`**——同步下来的东西
 * 不该被当成已经验过。`*` 不跨点这一条在这儿是独立成立的。
 */
export function siteAllowed(host: string, sites: readonly string[]): boolean {
  for (const raw of sites) {
    const site = String(raw || '').trim().toLowerCase()
    if (!site) continue
    if (ALL.has(site)) return true
    if (site.includes('*')) {
      const re = wildcardRe(site)
      // 配上本身，或者它的子域——和裸域名那条是同一个口径。
      if (re.test(host)) return true
      const dot = host.indexOf('.')
      for (let i = dot; i > 0; i = host.indexOf('.', i + 1)) {
        if (re.test(host.slice(i + 1))) return true
      }
      continue
    }
    if (host === site) return true
    if (host.endsWith(`.${site}`)) return true
  }
  return false
}

/** 这次动作作用在什么东西上。由浏览器服务提供，策略只读不写。 */
export interface ActionContext {
  /** 目标元素的可访问名（按钮上印的字）。取不到就没有这一项。 */
  label?: string
  /** 目标元素的角色（button / link / textbox…）。 */
  role?: string
  /** 目标元素是一个密码框（`<input type=password>`）。 */
  secret?: boolean
  /** 这次 browser_dialog 面对的是哪种原生对话框。 */
  dialog?: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  /** 那个对话框上写的话。「确认支付 ¥388？」这种要靠它认。 */
  dialogText?: string
  /** 当前页面地址。没有 url 参数的那几把工具靠它判域名。 */
  url?: string
}

function argsOf(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 按钮上印着这些字，就当它是在登录。 */
const LOGIN_WORDS = /(登录|登入|登陆|sign\s*in|log\s*in|signin|login)/i
/** 「退出登录」里也有「登录」两个字，但它不是在用谁的身份进门。 */
const LOGOUT_WORDS = /(退出|注销|登出|sign\s*out|log\s*out|signout|logout)/i
/** 输入框的名字像密码框（有些页面的密码框不是 type=password，而是自己画的）。 */
const SECRET_WORDS = /(密码|口令|password|passcode|passwd)/i
/**
 * 按钮上（或确认框里）印着这些字，就当它是在付钱。
 *
 * 英文要按词边界认：裸写 `pay` 的话 `Display`、`buy` 的话 `Buyer` 都会撞上。宁可多问几张
 * （「支付宝」那种链接也会弹），也不能让一次真付款从缝里过去。
 */
const PAY_WORDS =
  /(支付|付款|付钱|结算|结账|下单|购买|转账|充值|打款|\bpay(ment)?\b|\bpay\s*now\b|\bcheck\s*out\b|\bcheckout\b|\bpurchase\b|\bbuy\b|\bplace\s+order\b|\btransfer\b)/i

/**
 * 共享托管的后缀：这些域名下面**每一个子域都是不同的主人**（alice.github.io 和 bob.github.io
 * 毫无关系）。按「最后两段」算的话，批准一个就放行了全部。
 */
const SHARED_SUFFIXES = [
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app',
  'firebaseapp.com', 'appspot.com', 'herokuapp.com', 'azurewebsites.net', 'cloudfront.net',
  's3.amazonaws.com', 'blogspot.com', 'onrender.com', 'fly.dev', 'glitch.me', 'ngrok.io',
  'ngrok-free.app', 'trycloudflare.com', 'myshopify.com', 'wordpress.com', 'notion.site',
]
/** 国家顶级域下面常见的二级：`co.uk`、`com.cn` 这种，注册域要再往前取一段。 */
const SECOND_LEVELS = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'mil'])

/**
 * 站点：判「这条对话第一次打开它」时按什么算同一个。
 *
 * 按**注册域**（`drive.google.com` 和 `docs.google.com` 是同一站），不按完整主机名——
 * 否则在 Drive 里点开一张表格就换到 docs 子域，又弹一次卡。没有公共后缀表，拿两份短名单
 * 近似：共享托管后缀（取后缀再加一段）、国家顶级域下的常见二级（`co.uk` / `com.cn`）。IP 原样。
 */
export function siteOf(host: string): string {
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host
  const parts = host.split('.').filter(Boolean)
  const shared = SHARED_SUFFIXES.find((suffix) => host.endsWith(`.${suffix}`))
  if (shared) return parts.slice(-(shared.split('.').length + 1)).join('.')
  if (parts.length <= 2) return parts.join('.')
  const [second, last] = parts.slice(-2)
  const take = last.length === 2 && SECOND_LEVELS.has(second) ? 3 : 2
  return parts.slice(-take).join('.')
}

/** 一张浏览器卡片是哪一类。「这一轮都批准」按类记，登录批过不等于付款也批过。 */
export type AskKind = 'login' | 'pay'

export interface Ask {
  /** 印在卡片上的那句话。 */
  why: string
  kinds: AskKind[]
}

/**
 * 这次浏览器动作要不要人拍板；要的话返回**为什么**（那句话会印在卡片上）和它是哪一类。
 *
 * **只问登录和付款。** 页面上别的点击、填写、回车、对话框一律不问——改写数据也不问。早先
 * 按「像提交」的词表弹卡，一次报价表改下来几十张卡片，人学会的是闭眼点批准，那张卡片什么
 * 也没守住。浏览器这边人要拍板的只有三件事：**用谁的身份进门**、**付钱**（这里），和
 * **这条对话第一次去哪个站**（policy/index.ts 的 browserApproval，它要记账，不在这个纯函数里）。
 *
 * 没问过的那些写，事后照样留痕：策略在动作完成后看它发没发非幂等请求，发了就记一条
 * （noteWrites）。
 *
 * 登录认三种：点一个印着「登录 / Sign in」的按钮；往密码框里填东西（快照给密码框打了
 * `password` 标记，名字像密码的也算——有些页面的密码框是自己画的）；在一张**有密码框的
 * 页面**上不给 ref 往当前焦点里打字——「点用户名、按 Tab、直接打字」就是这么填密码的，
 * 不认这条的话登录确认一句话就绕过去了（`cx.secret` 那时由服务按「这一页有没有密码框」给）。
 *
 * 付款认两种：点一个印着「支付 / 下单 / Pay / Checkout」的元素；在一个写着这些字的确认框上
 * 点确定（「确认支付 ¥388？」）。**这是启发式，会漏**——一个只写「确定」的付款按钮就漏了，
 * 填完直接回车提交的付款表单也漏了。漏掉的那次落在 noteWrites 的留痕里。
 */
export function browserAsk(tool: string, rawArgs: string, cx: ActionContext | undefined): Ask | null {
  const args = argsOf(rawArgs)
  const label = String(cx?.label ?? '').trim()
  const named = label ? `「${label}」` : ''
  if (tool === 'browser_type') {
    if (!String(args.ref ?? '').trim()) {
      if (cx?.secret) return { why: '在有密码框的页面上往当前焦点里打字（可能是在填密码）', kinds: ['login'] }
      return null
    }
    if (cx?.secret || SECRET_WORDS.test(label)) return { why: `往密码框${named}里填内容（这是在登录）`, kinds: ['login'] }
    return null
  }
  if (tool === 'browser_click') {
    if (!label) return null
    if (PAY_WORDS.test(label)) return { why: `点${named}付款`, kinds: ['pay'] }
    if (LOGIN_WORDS.test(label) && !LOGOUT_WORDS.test(label)) return { why: `点${named}登录`, kinds: ['login'] }
    return null
  }
  if (tool === 'browser_dialog') {
    if (args.action !== 'accept') return null
    const text = String(cx?.dialogText ?? '').trim()
    if (text && PAY_WORDS.test(text)) return { why: `在确认框「${text.slice(0, 60)}」上点确定（这是在付款）`, kinds: ['pay'] }
    return null
  }
  return null
}

/**
 * browser_batch 要不要人拍板：**逐步照单步的判据判**，有一步要问就整批问一次。
 *
 * 只判第一步的话，「先填用户名、再填密码、再点登录」「先填数量、再点支付」就从缝里过去了。
 * 每一步的 ref 认的是**动手之前**那张快照里的名字（批里不拍快照，模型手上也只有那一张），
 * 所以 `cxOf` 照单步那样从缓存里取就对。卡片上把要问的那几步都列出来，人看得清批的是什么。
 */
export function batchBrowserAsk(
  rawArgs: string,
  cxOf: (step: Record<string, unknown>) => ActionContext | undefined,
): Ask | null {
  const steps = argsOf(rawArgs).steps
  if (!Array.isArray(steps)) return null
  const hits: string[] = []
  const kinds = new Set<AskKind>()
  steps.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const step = raw as Record<string, unknown>
    const ask = browserAsk(`browser_${String(step.action ?? '')}`, JSON.stringify(step), cxOf(step))
    if (!ask) return
    hits.push(`第 ${i + 1} 步${ask.why}`)
    for (const k of ask.kinds) kinds.add(k)
  })
  if (!hits.length) return null
  return { why: `这一批 ${steps.length} 步操作里有要确认的：${hits.join('；')}`, kinds: [...kinds].sort() }
}
