/**
 * 下载页（`/download`）：**把桌面端装到这台电脑上**。
 *
 * 为什么单开一页，而不是首页上放两颗按钮：这条地址是要被**单独发出去**的——管理员
 * 开通完席位之后发给员工的那句「先把客户端装上」，指的就是它。两颗按钮挂在首页中间，
 * 发过去的人还得先看完一屏产品介绍，才找得到自己真正要的那个文件。
 *
 * 分工和隐私政策那两页一样（见 pages-legal.js）：
 *
 *   /download  这一页
 *
 * 和它们一样**不看登录状态**（见 render.js 的 render()）：要装客户端的人多半还没登录
 * 过——他手上只有一条管理员发来的地址。所以这一页背后不该有登录墙。
 *
 * **自动认系统**：进来时按浏览器报的平台挑一档（dlDetect），认出来哪个就把哪个摆在
 * 左边那张大卡上。认不出来、或者人就是要给另一台电脑下载（在 Mac 上给同事拿 Windows
 * 包是常事），顶上那排切换随时能改——所以自动只是**默认值**，不是唯一的路。
 *
 * 文案就地给中英两版（`t('中文', 'English')`），理由同 pages-landing.js：这一屏整个是
 * 渲染时才拼的字符串，就地写看得见上下文。
 */

/**
 * 这一页发的是哪一版。**发了新版就要动它**——它同时决定页面上印的版本号和每个文件的
 * 下载地址（见 dlBuilds），两处从同一个常量长出来，不会改了一处忘了另一处。
 */
const DL_VERSION = '0.1.0'

/** 这一版是什么时候发的。页面上那句「更新于」。 */
const DL_UPDATED = '2026-09-22'

/**
 * 安装包**还没发布**。
 *
 * 桌面端的发版 CI 还没做（见 desktop/README.md 的「还没做的事」），`desktop-v*` 这个
 * tag 下面现在什么都没有，所以下面那几条地址点下去是 404。
 *
 * 和首页那句「示例二维码」、法律页那条「还没过法务」是同一种东西：一件没做完的事在
 * 页面上留下的唯一痕迹。**按钮照样是活的**——CI 一跑通、Release 一建出来，它们当场
 * 就对了，那时把这个常量关掉，横条跟着消失。
 */
const DL_PENDING = true

/**
 * 文件放在哪儿。GitHub Release，tag 是 `desktop-v<版本>`。
 *
 * **不走 `releases/latest/download/`**：这个仓库里 bot、管家、桌面端三条发布线共用一个
 * Release 列表（见 .github/workflows/），`latest` 指的是**时间上最新的那一个**——管家
 * 发一版，桌面端的下载地址就跟着指到管家的包上去了，而页面上看不出任何毛病。所以这里
 * 钉死 tag，代价是发版时要来改 DL_VERSION。
 *
 * 写成函数而不是模块级常量：LP_REPO 在 pages-landing.js 里（加载顺序见 index.html），
 * 在渲染时才去读它，就不必依赖两个分片谁先求值。
 */
function dlBase() {
  return `${LP_REPO}/releases/download/desktop-v${DL_VERSION}`
}

/** Windows 那只窗。不走 svg()——那个助手画描边图标，这几块是实心的。 */
const DL_ICON_WINDOWS =
  '<svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M0 2.27 6.51 1.4v6.29H0zm7.3-.98L15.99 0v7.6H7.3zM0 8.48h6.51v6.29L0 13.9zm7.3 0h8.69V16L7.3 14.72z"/></svg>'

/** macOS 那只苹果。同样是实心路径。 */
const DL_ICON_APPLE =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.05 12.54c-.02-2.4 1.96-3.55 2.05-3.61-1.12-1.64-2.86-1.86-3.48-1.89-1.48-.15-2.89.87-3.64.87-.75 0-1.91-.85-3.14-.83-1.61.02-3.1.94-3.93 2.38-1.68 2.91-.43 7.22 1.2 9.58.8 1.16 1.75 2.46 3 2.41 1.2-.05 1.66-.78 3.11-.78 1.45 0 1.86.78 3.13.75 1.29-.02 2.11-1.18 2.9-2.34.91-1.34 1.29-2.64 1.31-2.71-.03-.01-2.5-.96-2.53-3.83M14.7 5.1c.66-.8 1.11-1.92.99-3.03-.95.04-2.11.63-2.8 1.43-.61.71-1.15 1.85-1.01 2.94 1.07.08 2.16-.54 2.82-1.34"/></svg>'

/** 下载那支箭：一条线朝下，落在一根托盘上。 */
const DL_ICON_DOWN = ['M12 4v11', 'm7 11 5 5 5-5', 'M5 20h14']

/**
 * 每一档包：**平台、架构、文件名，一条一行**。
 *
 * 文件名是 Tauri 出包时的默认命名（`<productName>_<version>_<arch>.<后缀>`，见
 * desktop/src-tauri/tauri.conf.json 里的 productName）。**这张表和发版 CI 是一对**
 * ——CI 那边传的资产名改了，这里跟着改，不然页面上每颗按钮都是 404。
 *
 * macOS 两档分芯片：Apple 芯片的包在 Intel 机器上装不起来，反过来能跑但是走 Rosetta。
 * 浏览器里**认不出 Mac 的芯片**（navigator 在 M 系上照样报 `MacIntel`），所以两档都
 * 摆出来、Apple 芯片排在前面，让人自己认一下——这是这一页上唯一要人动脑子的地方，
 * 所以那一行写了「关于本机」在哪儿看。
 */
function dlBuilds() {
  return [
    {
      os: 'windows',
      variant: t('64 位', '64-bit'),
      hint: t('Windows 10 及以上', 'Windows 10 and later'),
      file: `Satuwork_${DL_VERSION}_x64-setup.exe`,
      kind: t('安装程序 · .exe', 'Installer · .exe'),
    },
    {
      os: 'mac',
      variant: t('Apple 芯片', 'Apple silicon'),
      hint: t('M1 及以后的机型', 'M1 and later'),
      file: `Satuwork_${DL_VERSION}_aarch64.dmg`,
      kind: '.dmg',
    },
    {
      os: 'mac',
      variant: t('Intel 芯片', 'Intel'),
      hint: t('2020 年前后的旧机型', 'Older Intel Macs'),
      file: `Satuwork_${DL_VERSION}_x64.dmg`,
      kind: '.dmg',
    },
  ]
}

const DL_OS = {
  windows: { label: 'Windows', icon: DL_ICON_WINDOWS },
  mac: { label: 'macOS', icon: DL_ICON_APPLE },
}

/**
 * 这台电脑是什么系统。认不出来回空串。
 *
 * **先认 Mac 再认 Windows**：`Darwin` 里带着 `win` 三个字母，反过来判的话 Mac 会被
 * 认成 Windows——而那正是「自动检测」最丢脸的错法。
 *
 * `userAgentData.platform` 是新浏览器上唯一没被冻结的那个（Chrome 里 `navigator.platform`
 * 早就不动了），所以排在最前面；三样拼成一条一起匹配，少一样也还认得出来。iPhone、
 * iPad 上没有桌面端可装，落回空串，页面会照实说一句。
 */
function dlDetect() {
  const nav = typeof navigator === 'object' && navigator ? navigator : {}
  const hint = nav.userAgentData && typeof nav.userAgentData.platform === 'string' ? nav.userAgentData.platform : ''
  const raw = `${hint} ${nav.platform || ''} ${nav.userAgent || ''}`
  if (/mac ?os|macintosh|darwin/i.test(raw)) return 'mac'
  if (/windows|win32|win64|wow64/i.test(raw)) return 'windows'
  return ''
}

/**
 * 这一帧摆哪个平台。人点过切换就听他的，没点过才去认。
 *
 * 认不出来（Linux、iPad、以及一切没见过的 UA）时摆 Windows——这一页上总得有个东西
 * 摆出来，空着一格比摆错更没用；页面另有一句话说明「没认出来」。
 */
function dlOs() {
  if (state.dlOs === 'windows' || state.dlOs === 'mac') return state.dlOs
  return dlDetect() || 'windows'
}

/**
 * 顶上那排平台切换。**是按钮不是链接**：换的只是这一页上摆哪一档，地址不变。
 *
 * 自动认得对的时候它看着是多余的，而它恰恰是这一页的保险——在 Mac 上替同事下一个
 * Windows 包，靠的就是这排。
 */
function dlTabs(cur) {
  const one = (key) =>
    `<button type="button" data-act="download-os" data-os="${key}" aria-pressed="${cur === key}">
      ${DL_OS[key].icon}<span>${esc(DL_OS[key].label)}</span>
    </button>`
  return `<div class="satu-dl-tabs" role="group" aria-label="${esc(t('选择操作系统', 'Choose your operating system'))}">
    ${one('windows')}${one('mac')}
  </div>`
}

/**
 * 一档包那一行。**`<a download>` 真链接，不是 data-act 按钮**：右键「链接存储为」、
 * 中键、复制地址这几样是浏览器在链接上给的，而这一页上恰恰有人要把地址复制给别人
 * （「你先把这个下下来」）。桌面壳里它也照样走得通（见 desktop/README.md 的自检表）。
 *
 * `primary` 是这一档里排第一的那个：按钮实心，其余的是描边。
 */
function dlRow(b, primary) {
  const href = `${dlBase()}/${b.file}`
  return `<a class="btn ${primary ? 'btn-primary' : 'btn-secondary'} satu-dl-get" href="${esc(href)}" download>
    ${svg(DL_ICON_DOWN, 16)}
    <span class="satu-dl-getin">
      <b>${esc(t(`下载 ${DL_OS[b.os].label} 版`, `Download for ${DL_OS[b.os].label}`))}${b.os === 'mac' ? esc(` · ${b.variant}`) : ''}</b>
      <em>${esc(`${b.kind} · ${b.hint}`)}</em>
    </span>
  </a>`
}

/**
 * 安装完第一步要填的那个地址：**就是这台 Gateway**。
 *
 * 桌面壳第一屏问「连哪台 Gateway」，而拿到这一页的人多半答不上来——他手上只有这条
 * 被发过来的地址，而那条地址就在他的地址栏里。所以这里把它印出来。
 *
 * 取不到（桌面壳里页面是包里自带的，`location.origin` 是 `satu://localhost`）就整块
 * 不画：印一条错地址比不印坏得多。
 */
function dlServerHint() {
  const base = gatewayBase() || (typeof location === 'object' && location && typeof location.origin === 'string' ? location.origin : '')
  if (!base || !/^https?:\/\//i.test(base)) return ''
  return `<p class="satu-dl-server">${t('第一次打开要填的服务器地址：', 'The server address it asks for on first launch:')}<code>${esc(base)}</code></p>`
}

/** 「装完之后」里的一条。标题 + 一段话。 */
function dlNote(title, body) {
  return `<div class="satu-dl-note">
    <h3>${esc(title)}</h3>
    <p>${esc(body)}</p>
  </div>`
}

/**
 * 这一页的顶栏和页脚借首页那一套（见 pages-legal.js 的 legalTop —— 同样的理由，同样
 * 的一条：**没有「联系销售」**，来下载的人是已经被开通了的那个）。
 */
function dlTop() {
  return `<header class="satu-lp-top">
    <div class="satu-lp-wrap satu-lp-topin">
      <button type="button" class="satu-lp-brand" data-act="go" data-href="/">
        <img src="/assets/satuwork-logo.png" alt="Satuwork" width="28" height="28">
        <span>Satuwork</span>
      </button>
      <div class="satu-lp-topact">
        <div class="satu-lp-lang" role="group" aria-label="${esc(t('语言', 'Language'))}">
          <button type="button" data-act="landing-locale" data-locale="zh" aria-pressed="${localeMode !== 'en'}">中文</button>
          <button type="button" data-act="landing-locale" data-locale="en" aria-pressed="${localeMode === 'en'}">EN</button>
        </div>
        <button type="button" class="btn btn-primary satu-lp-topsign" data-act="go" data-href="/login">${t('登录', 'Sign in')}</button>
      </div>
    </div>
  </header>`
}

function dlFoot() {
  return `<footer class="satu-lp-foot">
    <div class="satu-lp-wrap satu-lp-footin">
      <span class="satu-lp-brand" data-static>
        <img src="/assets/satuwork-logo.png" alt="" width="20" height="20">
        <span>Satuwork</span>
      </span>
      <span class="satu-lg-links">
        <button type="button" data-act="go" data-href="/">${t('首页', 'Home')}</button>
        <button type="button" data-act="go" data-href="/privacy">${t('隐私政策', 'Privacy Policy')}</button>
        <button type="button" data-act="go" data-href="/terms">${t('服务条款', 'Terms of Service')}</button>
        <span>© 2026 Satuwork</span>
      </span>
    </div>
  </footer>`
}

/**
 * 下载页本体。
 *
 * 版式：左边一张大卡（当前平台的包），右边一列说明。和首页一样不套 `.gw-page`——
 * 这一屏没有外壳，滚的是文档本身。
 */
function downloadView() {
  const cur = dlOs()
  const builds = dlBuilds().filter((b) => b.os === cur)
  const guessed = dlDetect()
  return `
  <div class="satu-lp satu-dl">
    ${dlTop()}
    <div class="satu-lp-wrap satu-lg-head">
      <h1>${t('下载 Satuwork 桌面端', 'Download Satuwork for desktop')}</h1>
      <p class="satu-lg-lead">${t(
        '桌面端把界面装进本机，并且能在这台电脑上直接跑「本地」那种 AI 员工——他的工作区就是你电脑上的文件夹，对话不经过服务器。浏览器里用不到这一层，随时也可以直接登录网页版。',
        'The desktop app bundles the interface and runs “local” coworkers right on this machine — their workspace is a folder on your computer and those conversations never leave it. You can always use the web version instead.',
      )}</p>
      <p class="satu-lg-meta">${esc(t(`版本 ${DL_VERSION} · 更新于 ${DL_UPDATED}`, `Version ${DL_VERSION} · updated ${DL_UPDATED}`))}</p>
      ${
        DL_PENDING
          ? `<p class="satu-lg-note">${esc(
              t(
                '安装包还没发布：桌面端的发版 CI 还没做（见 desktop/README.md），下面几条地址现在是 404。第一版打出来之后核对 pages-download.js 里的 DL_VERSION，并把 DL_PENDING 关掉。',
                'The installers are not published yet — the desktop release CI does not exist (see desktop/README.md), so the links below still 404. Once the first build ships, check DL_VERSION in pages-download.js and turn off DL_PENDING.',
              ),
            )}</p>`
          : ''
      }
    </div>

    <div class="satu-lp-wrap satu-dl-grid">
      <section class="satu-dl-card">
        ${dlTabs(cur)}
        <div class="satu-dl-head">
          <span class="satu-dl-osicon" aria-hidden="true">${DL_OS[cur].icon}</span>
          <div>
            <h2>${esc(DL_OS[cur].label)}</h2>
            <p>${esc(
              guessed === cur
                ? t('看起来你正用的就是这个系统。', 'This looks like the system you are on.')
                : guessed
                  ? t('你正用的是另一个系统，这一档是给别的电脑准备的。', 'You are on the other system — this one is for a different machine.')
                  : t('没认出你的系统，上面那排可以自己切。', 'We could not detect your system — switch it above.'),
            )}</p>
          </div>
        </div>
        <div class="satu-dl-gets">
          ${builds.map((b, i) => dlRow(b, i === 0)).join('')}
        </div>
        ${
          cur === 'mac'
            ? `<p class="satu-dl-fine">${t(
                '不确定是哪种芯片？左上角苹果菜单 →「关于本机」，写着 Apple M 开头的选上面那个。',
                'Not sure which chip? Apple menu → “About This Mac”. Anything starting with Apple M takes the first one.',
              )}</p>`
            : ''
        }
        ${dlServerHint()}
        <p class="satu-dl-fine">${t('装不了也不耽误用：', 'Can’t install it? Nothing is lost: ')}<button type="button" class="satu-dl-weblink" data-act="go" data-href="/login">${t('直接用网页版登录', 'sign in to the web version')}</button>${t('，除了本地 AI 员工之外都一样。', ' — everything except local coworkers works the same.')}</p>
      </section>

      <aside class="satu-dl-side">
        ${dlNote(
          t('第一次打开会拦一下', 'The first launch gets blocked'),
          cur === 'mac'
            ? t(
                '这个包还没做苹果签名，双击会说「无法打开」。在访达里对着应用图标右键选「打开」，再点一次「打开」就进去了——只有第一次要这么做。',
                'The build is not signed by Apple yet, so a double-click says it can’t be opened. In Finder, right-click the app and choose Open, then Open again. Only the first launch needs this.',
              )
            : t(
                '这个包还没做代码签名，SmartScreen 会挡一下。在那个蓝框里点「更多信息」→「仍要运行」——只有第一次要这么做。',
                'The build is not code-signed yet, so SmartScreen steps in. Click “More info” → “Run anyway” in that blue box. Only the first launch needs this.',
              ),
        )}
        ${dlNote(
          t('账号还是原来那个', 'Same account as the web'),
          t(
            '桌面端不另开账号：填完服务器地址，用管理员给你开的那个邮箱和口令登录即可。没有账号就找公司管理员开通。',
            'The desktop app does not have its own accounts. After the server address, sign in with the email and password your admin gave you. No account yet? Ask your company admin.',
          ),
        )}
        ${dlNote(
          t('自己会升级的只有一半', 'Half of it updates itself'),
          t(
            '本地 AI 员工的运行时会自己在后台更新；外面这层应用还要手工换新版——所以升级的时候回这一页再下一次。',
            'The local coworker runtime updates itself in the background. The app shell around it still needs a new installer, so come back to this page to upgrade.',
          ),
        )}
        ${dlNote(
          t('Linux 暂时没有包', 'No Linux build yet'),
          t(
            'Linux 上的桌面端还没验过，暂时不发包。那边先用浏览器打开这台服务器，除了本地 AI 员工之外功能一样。',
            'The Linux desktop build is not verified yet, so we don’t ship one. Open this server in a browser there — everything except local coworkers is the same.',
          ),
        )}
      </aside>
    </div>
    ${dlFoot()}
  </div>`
}
