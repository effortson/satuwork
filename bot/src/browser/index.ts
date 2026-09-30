import { Service, type Context } from '@deepseek-ai/cordis'
import { spawn, type ChildProcess } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findExecutable } from '../executable.ts'
import { satuworkHome } from '../home.ts'
import { childEnv } from '../workspace/index.ts'
import { blockedHost, hostOf, privateAddress, siteAllowed, type ActionContext } from '../policy/browser.ts'
import type { ToolCall, ToolResult, WorkspaceFile } from '../tools/index.ts'
import { Cdp, CdpError } from './cdp.ts'
import { callExpr } from './page.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browser: BrowserService
  }
}

/**
 * 席位桌面上那个 Chrome 的遥控器。
 *
 * **它连的是员工自己在用的那一个**（`$SEAT_DIR/chrome` 那份 profile），不是另起一个
 * 干净的。这是整套工具唯一的存在理由：员工在 noVNC 桌面里登过的那些系统，cookie 就在
 * 那份 profile 里，而 `web_extract` 永远看不见登录墙后面。
 *
 * 连不上就自己把它拉起来——桌面单元只写了包装脚本和 dock 上那一格，真正启动它的是
 * 员工点的那一下。员工没点过的席位上，CDP 端口是空的。
 */
export interface Config {
  /** CDP 端口。默认读 `SATUWORK_CDP_PORT`，再回落 9222。 */
  port?: number
  /**
   * 允许页面**解析到**内网地址。**只给 e2e 用**，生产的 cordis.yml 里没有这一项。
   *
   * 探针的测试页只能跑在 127.0.0.1 上，而下面那条按响应 IP 判的检查正是为了拦住那种
   * 地址——不给个口子，这套工具就没法对着一个真浏览器跑一遍。
   *
   * **它不放开 URL 层的硬黑名单。** 也就是说打开了它，`http://127.0.0.1/` 照样被拦；
   * 松掉的只有「域名解析到内网」这一种（探针靠 --host-resolver-rules 造出这种情况）。
   */
  trustPrivateAddresses?: boolean
}

/**
 * Desktop 本地 Bot 使用本机浏览器；远程席位仍走部署好的 seat-chrome。
 *
 * 优先认显式覆盖，方便公司统一安装在非标准位置。其余候选只挑已经存在的可执行文件，
 * 不在这里运行 `which` / shell，避免浏览器路径变成一段可执行命令。
 */
export function localBrowserExecutable(): string | null {
  const names =
    process.platform === 'win32'
      ? ['chrome.exe', 'msedge.exe', 'chromium.exe']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  const fixed =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          join(homedir(), 'Applications/Chromium.app/Contents/MacOS/Chromium'),
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : process.platform === 'win32'
        ? [
            ...(process.env.PROGRAMFILES
              ? [join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')]
              : []),
            ...(process.env['PROGRAMFILES(X86)']
              ? [join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe')]
              : []),
            ...(process.env.LOCALAPPDATA
              ? [join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')]
              : []),
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']
  return findExecutable(process.env.SATUWORK_CHROME, names, fixed)
}

/** 一次动作之后等页面消化多久。够 SPA 跑完一轮渲染，又不至于每一步都明显卡一下。 */
const SETTLE_MS = 350

/**
 * 页面里那段脚本一趟的上限。比 CDP 默认的 15 秒短得多：这几段脚本本身都是毫秒级的，
 * 真的等满只有一个原因——页面被原生对话框冻住了。早点回来才好去认那个对话框。
 */
const PAGE_CALL_TIMEOUT = 5_000

/**
 * 截图：**拍给人看的，不进模型的上下文**（见 tools/index.ts 的 `ToolResult.shot`）。
 *
 * JPEG 而不是 PNG：一屏网页的 PNG 动辄几百 KB（图多的页面上更大），同一屏 JPEG 七成
 * 质量只有它的几分之一。而这张图的用途是「事后看一眼当时页面长什么样」，不是取证。
 * 它落在员工自己的工作区里，一次多步浏览就是十几张，差出来的是实打实的盘。
 *
 * 只拍视口，不拍整页（`captureBeyondViewport`）：整页截图在无限滚动的页面上会拍出一张
 * 几万像素高的东西，而「Bot 当时看到的」本来就是那一屏。
 *
 * 超时压短：拍照卡住不该把这次工具调用一起拖住——这张图没拍成，动作本身照样是成功的。
 */
const SHOT_QUALITY = 70
const SHOT_TIMEOUT = 5_000
/**
 * 一条会话最多留多少张。
 *
 * 不是为了省那点盘，是给跑飞的循环兜底：模型卡在「点一下、看一眼」上转两百圈时，
 * 前六十张已经把「它卡在哪儿」说清楚了，后面一百四十张只是同一屏的复印件。
 */
const MAX_SHOTS = 60

/** wait_for 的硬上限。不接受模型传更大的值——它很愿意让你等五分钟。 */
const MAX_WAIT_MS = 30_000

interface Snapshot {
  version: number
  url: string
  title: string
  body: string
  truncated: boolean
}

/**
 * 工作区里我们要用的那两样。**结构化地写在这里，不 import 那个类**——见 workspaceOf：
 * 这个服务不 inject workspace，类型上也不该反过来依赖它。
 */
interface WorkspaceLike {
  root?: string
  saveBytes?: (dir: string, filename: string, bytes: Uint8Array) => Promise<{ path: string; name: string }>
}

interface Located {
  x?: number
  y?: number
  name?: string
  role?: string
  err?: string
}

const REF_ERRORS: Record<string, string> = {
  stale: '这个 ref 是上一次快照的，页面已经变了。重新调用 browser_snapshot 拿新的 ref。',
  gone: '快照里没有这个 ref。重新调用 browser_snapshot 看看现在页面上有什么。',
  detached: '这个元素已经从页面上消失了。重新调用 browser_snapshot。',
  notselect: '这不是一个下拉框，browser_select 用不上它。',
}

/** 越界：读到的这一页不在允许的范围里。**业务失败**，不是管道故障。 */
export class ScopeError extends Error {}

/**
 * 这一页现在用不了：导航失败了、停在浏览器的错误页、或者还没打开过任何页面。
 *
 * **和 ScopeError 分开**，因为对模型的含义正相反：越界是「换条路」，这个是「这一步没
 * 成功，可以换个地址再试」。合成一种的话，一次 DNS 失败会被讲成一次边界拦截，而模型
 * 面对边界的正确反应恰恰是**不要重试**。
 */
export class PageError extends Error {}

/**
 * 这个地址解析出来落在内网吗。**给「我们没看着它加载」的那些页补的一道。**
 *
 * 判不了（解析失败）时返回 null：这一层只在能确定的时候拦，DNS 抽风不该让一次正常的
 * 切标签页失败——真是内网的话，attach 之后那道按 IP 判的闸还在。
 */
async function resolvesPrivate(url: string): Promise<string | null> {
  const host = hostOf(url)
  if (!host) return null
  try {
    const found = await lookup(host, { all: true })
    for (const one of found) {
      const bad = privateAddress(one.address)
      if (bad) return `它解析到了 ${one.address}：${bad}`
    }
  } catch {
    return null
  }
  return null
}

export class BrowserService extends Service {
  /**
   * **不要 `static inject = ['logger']`。**
   *
   * `logger` 不是一个服务：`satu-logger` 只是给 cordis 自带的 `ctx.logger` 挂了个
   * exporter，从没 `provide` 过。写了这条 inject 的后果是它**永远满足不了**——服务不
   * 启动、`ctx.browser` 不存在、`browser/tools.ts` 的 `inject: ['browser']` 跟着一直挂
   * 着，于是十二把工具一把都没注册，**而且一声不响**：进程正常起来、健康检查通过、
   * 日志干干净净，只有模型说「我没有这些工具」。真栽过一次。
   *
   * 仓库里别处一律用 `ctx.logger?.warn?.()` 可选链，就是因为它可能没有。
   */

  readonly port: number
  private readonly trustPrivate: boolean
  /** 只有本地 Bot 才由本服务拉起浏览器；远程席位的 Chrome 不归 Bot 生命周期管理。 */
  private localBrowser: ChildProcess | null = null
  private cdp: Cdp | null = null
  private sessionId = ''
  private targetId = ''
  /**
   * 连接与建页那一段的**互斥**。
   *
   * 少了它，同一条助手消息里的两个工具调用并发进来时会各连一次 CDP、各开一个窗口，
   * 然后互相覆盖 sessionId——先返回的那次还拿着已经被换掉的 session 继续发命令，
   * 而员工屏幕上多出一个没人管的空窗口。
   */
  private connecting: Promise<{ cdp: Cdp; sessionId: string }> | null = null
  /**
   * **这次调用允许碰哪些站点。** 由策略在放行时推下来（policy 的 checkBrowser）。
   *
   * 为什么服务这边也要有一份：策略只在**工具调用之前**判一次「当前停在哪一页」，
   * 而一次调用当中页面还会动——navigate 撞上 302、点一下开出新标签页、页内脚本自己
   * 跳走。判过之后读回来的那一页，可能已经不是判的时候那一页了。
   */
  private scope: { sites: string[]; allowlist: boolean } | null = null
  /**
   * Bot 自己开出来的标签页。**员工自己开的那些不在里面。**
   *
   * browser_tabs 只列这些。列全部的话，那把工具就成了「把员工开着的网银和私人邮箱
   * 一次性交出去」——而它存在的理由只是「点一下开出了新标签页，得切过去」。
   */
  private own = new Set<string>()
  /** 当前页的主框架 id。请求拦截要靠它把顶层导航和第三方 iframe 分开。 */
  private mainFrame = ''
  /**
   * 上一次动作之后经过的**非幂等请求**（POST/PUT/PATCH/DELETE）。
   *
   * 提交判据是启发式，一定会漏（一个只有图标的删除按钮就没有名字）。漏掉的那次靠
   * 这里事后记一笔——见 policy 里 tools/post-execute 那段。
   */
  private writes: { method: string; url: string }[] = []
  /**
   * 上一次动作之后新冒出来的标签页数。**取走即清零。**
   *
   * 点一个 `target=_blank` 的链接之后，模型面前的快照**一个字都没变**——它会以为那一下
   * 没生效，然后再点一次、再点一次。这是本文档里说的「最难自查的一种卡死」，而破解它
   * 只需要在回执上加一句话。
   */
  private opened = 0
  /** 上一次快照给出的 ref → 名字。**策略要同步问「点的是什么」，所以缓存在这边。** */
  private labels = new Map<string, { name: string; role: string }>()
  /** 已经发到第几号 ref。跳转之后接着往下发，见 page.ts 里 snapshot 的说明。 */
  private refBase = 0
  private url = ''
  /** 页面上正挂着的原生对话框。挂着的时候页面是冻住的，所有别的动作都做不了。 */
  private dialog: { kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string } | null = null
  /** 在等「对话框弹出来了」这个信号的人。见 dispatch。 */
  private dialogWaiters = new Set<() => void>()
  /** 这一页是不是落在了不该落的地方（响应回来才发现解析到内网）。 */
  private poisoned = ''
  /**
   * 上一次导航自己报的失败原因（`net::ERR_NAME_NOT_RESOLVED` 这类）。
   *
   * **`Page.navigate` 的回执里就带着它。** 早先丢掉了，然后在下游靠「页面停在哪个
   * 地址」去猜刚才发生了什么——手上有确切原因却去猜，还猜错了：真实的失败页是
   * `chrome-error://chromewebdata/`，不是 `about:blank`，于是报出一句关于协议的错话。
   */
  private navError = ''
  /**
   * 下载：guid → 建议文件名。**两个事件才凑齐一次下载**——`downloadWillBegin` 知道
   * 叫什么名字但还没落盘，`downloadProgress` 知道落完了但只带 guid。
   */
  private downloading = new Map<string, string>()
  private downloads: string[] = []
  /** 每条会话已经拍了多少张。见 MAX_SHOTS。 */
  private shots = new Map<string, number>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'browser')
    const fromEnv = Number(process.env.SATUWORK_CDP_PORT)
    this.port = config.port ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 9222)
    this.trustPrivate = config.trustPrivateAddresses === true
    ctx.effect(() => () => this.teardown())
  }

  /**
   * 这次动作作用在什么东西上。**策略同步调它**（见 policy/index.ts 的 actionContext）。
   *
   * 全部从缓存回答：ref 的名字来自上一次快照，地址来自导航事件。去问一趟页面会让
   * 每一次工具调用都多一个 await，而策略跑在执行的关键路径上。
   */
  actionContext(call: ToolCall): ActionContext {
    let ref = ''
    try {
      const args = JSON.parse(call.arguments || '{}') as Record<string, unknown>
      ref = typeof args.ref === 'string' ? args.ref : ''
    } catch {
      /* 参数不是 JSON：那次调用本来就会失败 */
    }
    const hit = ref ? this.labels.get(ref) : undefined
    return {
      ...(hit?.name ? { label: hit.name } : {}),
      ...(hit?.role ? { role: hit.role } : {}),
      ...(this.dialog ? { dialog: this.dialog.kind } : {}),
      ...(this.url ? { url: this.url } : {}),
    }
  }

  /**
   * 策略放行这次调用时，把「允许碰哪些站点」推下来。
   *
   * 单向：服务只读不写，判据仍然只有 policy/browser.ts 那一份。
   */
  setScope(sites: readonly string[], allowlist: boolean): void {
    this.scope = { sites: [...sites], allowlist }
  }

  /**
   * 这个地址现在能不能碰。返回一句给人看的话，能碰时返回 null。
   *
   * 和策略那一次判的是**同一套判据**，只是时机不同：策略判的是「动手之前停在哪」，
   * 这里判的是「读回来的是哪一页」。中间隔着一次可能发生的跳转。
   */
  guardUrl(url: string): string | null {
    const host = hostOf(url)
    const blocked = blockedHost(host)
    if (blocked) return blocked
    if (!this.scope || !this.scope.allowlist) return null
    if (siteAllowed(host!, this.scope.sites)) return null
    return `${host} 不在这个 Bot 允许打开的站点里`
  }

  /** 当前停在哪一页。诊断那一屏要显示它。 */
  get where(): { url: string; dialog: string | null } {
    return { url: this.url, dialog: this.dialog?.kind ?? null }
  }

  // ── 连接 ────────────────────────────────────────────────────────────

  private async listening(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(800) })
      return res.ok
    } catch {
      return false
    }
  }

  /** 拉起浏览器。本地 Bot 用本机 Chrome 和独立 profile；远程席位保持原来的 wrapper。 */
  private async launch(): Promise<void> {
    if ((process.env.SATUWORK_RUNTIME_KIND || '').trim() === 'local') {
      const executable = localBrowserExecutable()
      if (!executable) {
        const override = process.env.SATUWORK_CHROME?.trim()
        throw new CdpError(
          override
            ? `本机浏览器路径不存在：${override}。请修正 SATUWORK_CHROME。`
            : '本机没有找到 Chrome、Chromium 或 Edge，安装其中一个后即可使用浏览器工具。',
        )
      }
      const profile = satuworkHome('browser', 'chrome')
      mkdirSync(profile, { recursive: true })
      const args = [
        `--remote-debugging-port=${this.port}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--new-window',
        'about:blank',
      ]
      const child = spawn(executable, args, { stdio: 'ignore', env: childEnv() })
      this.localBrowser = child
      child.once('exit', () => {
        if (this.localBrowser === child) this.localBrowser = null
      })
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', (error) => reject(new CdpError(`启动本机浏览器失败：${error.message}`)))
      })
    } else {
      const wrapper = satuworkHome('bin/seat-chrome')
      if (!existsSync(wrapper)) {
        throw new CdpError(
          `这个席位上没有浏览器可用（找不到 ${wrapper}）。桌面那套没部署，或者机器上装不上 Chrome。`,
        )
      }
      // env 用剔过凭据的副本（见 workspace 的 childEnv）：Chrome 及它拉起的一切都不该
      // 看到 GATEWAY_TOKEN 这类东西。包装脚本自己不读 SATUWORK_*，DISPLAY / HOME 都还在。
      spawn(wrapper, ['--new-window', 'about:blank'], { detached: true, stdio: 'ignore', env: childEnv() }).unref()
    }
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250))
      if (await this.listening()) return
    }
    if (this.localBrowser) {
      this.localBrowser.kill()
      this.localBrowser = null
    }
    throw new CdpError('浏览器起来了但调试端口一直没响应')
  }

  /** 拿一条能用的页面连接。断了就重连，标签页没了就重开一个。 */
  private async page(signal?: AbortSignal): Promise<{ cdp: Cdp; sessionId: string }> {
    if (this.cdp?.alive && this.sessionId) return { cdp: this.cdp, sessionId: this.sessionId }
    // 已经有人在连了就搭它的车，别自己再连一次（见 connecting 上的说明）。
    if (this.connecting) return await this.connecting
    this.connecting = this.openPage(signal).finally(() => {
      this.connecting = null
    })
    return await this.connecting
  }

  private async openPage(signal?: AbortSignal): Promise<{ cdp: Cdp; sessionId: string }> {
    if (!(await this.listening())) await this.launch()
    const cdp = this.cdp?.alive ? this.cdp : await Cdp.connect(this.port)
    if (cdp !== this.cdp) {
      this.cdp = cdp
      cdp.on((event) => this.onEvent(event))
      // 要收 Target.targetCreated / targetDestroyed：前者用来认出「点一下开出来的
      // 新标签页」是自己的，后者用来在窗口被员工关掉时把 session 作废（不然
      // page() 会一直复用一个已经不存在的 session，这颗 Bot 的浏览器就废到重启）。
      await cdp.send('Target.setDiscoverTargets', { discover: true }, { signal }).catch(() => {})
    }

    /**
     * **自己开一个窗口，不去抢员工正看着的那个标签页。**
     *
     * 同一个 browser context（不是 incognito）——cookie 是全部的意义所在，换个 context
     * 就等于回到没登录的状态。员工看得见这个窗口，也能随时接管。
     */
    const created = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
      newWindow: true,
    })
    this.targetId = created.targetId
    this.own.add(created.targetId)
    try {
      const attached = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
        targetId: created.targetId,
        flatten: true,
      })
      this.sessionId = attached.sessionId
      await this.enableDomains(cdp, this.sessionId, signal)
      await this.setDownloadDir(cdp)
      return { cdp, sessionId: this.sessionId }
    } catch (e) {
      /**
       * **半开的窗口要收掉。** 窗口已经在员工屏幕上了，而 sessionId 还是空的——下一次
       * 调用会再开一个，这一个从此没人管。用户点一次停止就多一个空窗口，一轮下来一屏。
       */
      this.own.delete(created.targetId)
      this.targetId = ''
      await cdp.send('Target.closeTarget', { targetId: created.targetId }).catch(() => {})
      throw e
    }
  }

  /**
   * 开这一页要用到的那几个域。**换标签页之后要重来一遍**——域是按 session 开的，
   * 换了 session 而不重开，表现是「拦截突然不生效了」，而且一声不响。
   */
  private async enableDomains(cdp: Cdp, sessionId: string, signal?: AbortSignal): Promise<void> {
    const on = { sessionId, signal }
    await cdp.send('Page.enable', {}, on)
    await cdp.send('Runtime.enable', {}, on)
    await cdp.send('Network.enable', {}, on)
    /**
     * 请求层的硬黑名单。**只拦文档和接口请求**，不拦图片字体——那些打到内网也只是
     * 读不到图，而全量拦截会让每一张图都多一次往返。
     */
    await cdp.send(
      'Fetch.enable',
      {
        patterns: [
          { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
          { urlPattern: '*', resourceType: 'XHR', requestStage: 'Request' },
          { urlPattern: '*', resourceType: 'Fetch', requestStage: 'Request' },
        ],
      },
      on,
    )
    // 主框架 id：请求拦截靠它把「顶层跳走了」和「页面里嵌了个第三方 iframe」分开。
    try {
      const tree = await cdp.send<{ frameTree: { frame: { id: string; url: string } } }>(
        'Page.getFrameTree',
        {},
        on,
      )
      this.mainFrame = tree.frameTree.frame.id
      this.url = httpUrl(tree.frameTree.frame.url)
    } catch {
      this.mainFrame = ''
    }
  }

  /**
   * Bot 自己开出来的那些标签页。
   *
   * 存在的理由只有一个：**点一个链接开出新标签页时，模型会一直对着旧那一页发指令**，
   * 而快照看起来「什么都没变」——这是最难自查的一种卡死。
   *
   * **只列自己的。** 早先一版列的是 `Target.getTargets` 的全部 page，那等于把员工
   * 开着的网银、私人邮箱的标题和地址一次性交给模型——而站点白名单对这一步完全没有
   * 表态的机会（策略判的是「当前停在哪一页」，切过去之前那一页还是合规的）。
   */
  async tabs(signal?: AbortSignal): Promise<{ targetId: string; url: string; title: string; current: boolean }[]> {
    const { cdp } = await this.page(signal)
    const res = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string; title: string }[] }>(
      'Target.getTargets',
      {},
      { signal },
    )
    return res.targetInfos
      .filter((t) => t.type === 'page' && this.own.has(t.targetId))
      .map((t) => ({ targetId: t.targetId, url: t.url, title: t.title, current: t.targetId === this.targetId }))
  }

  /** 换到另一个标签页。旧的那条 session 断掉，域重开，ref 表作废。 */
  async selectTab(targetId: string, signal?: AbortSignal): Promise<void> {
    if (!this.own.has(targetId)) throw new ScopeError('这个标签页不是这次任务开出来的，不能切过去。')
    const { cdp } = await this.page(signal)
    this.poisoned = ''
    this.writes = []
    if (this.sessionId) await cdp.send('Target.detachFromTarget', { sessionId: this.sessionId }, { signal }).catch(() => {})
    const attached = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true }, { signal })
    this.sessionId = attached.sessionId
    this.targetId = targetId
    this.labels.clear()
    this.dialog = null
    this.poisoned = ''
    await this.enableDomains(cdp, this.sessionId, signal)
    // 换完页要知道现在停在哪——策略下一次调用就靠这个地址判站点。
    const where = await this.call<{ url: string }>('where', [], signal)
    this.url = where?.url ?? ''
    /**
     * **切过去之后立刻按同一套判据再判一次。**
     *
     * 策略在切之前判的是「当前停在哪一页」，也就是旧那一页；新那一页它根本没看见。
     * 一次点击开出来的标签页完全可能落在名单外（页面上一个外链、一次 OAuth 跳转），
     * 不在这儿拦，紧接着的那次快照就把内容读回去了。
     *
     * **还要自己解析一次地址。** `target=_blank` 开出来的页在我们 attach 之前就已经
     * 载完了——那一趟没经过 Fetch/Network 拦截，`poisoned` 自然是空的，而 `guardUrl`
     * 从头到尾只看主机名。一个解析到内网的公网域名（内网别名，或者 rebinding）就这么
     * 整页读了回来。attach 之后它再发的请求会被 `Network.responseReceived` 那道按 IP
     * 判的闸接住，但**首屏那一份不会**，所以这儿补一次 DNS 解析。
     */
    const bad = this.guardUrl(this.url) ?? (this.trustPrivate ? null : await resolvesPrivate(this.url))
    if (bad) {
      await cdp.send('Target.detachFromTarget', { sessionId: this.sessionId }, { signal }).catch(() => {})
      this.forgetTarget()
      throw new ScopeError(`那个标签页停在 ${where?.url ?? '未知地址'}，${bad}。没有切过去。`)
    }
  }

  async closeTab(targetId: string, signal?: AbortSignal): Promise<void> {
    // 和 selectTab 同一道检查：调用方那边已经只从自己的列表里挑，这里再挡一次是因为
    // 「关掉员工正在用的那一页」是不可逆的，不能只靠上一层没写错。
    if (!this.own.has(targetId)) throw new ScopeError('这个标签页不是这次任务开出来的，不能关它。')
    const { cdp } = await this.page(signal)
    await cdp.send('Target.closeTarget', { targetId }, { signal })
    if (targetId === this.targetId) {
      // 把自己那一页关掉了：下一次调用会重新开一个。
      this.sessionId = ''
      this.targetId = ''
      this.labels.clear()
      this.url = ''
    }
  }

  /**
   * 工作区服务，**取不到就当没有**。
   *
   * 走 `reflect.get` 而不是 inject。inject 了 workspace 的话，没有工作区的场合
   * （探针、以后某个精简组合）这个服务整个起不来——而「下载落哪儿」「截图存哪儿」
   * 只是它的附带功能，不该反过来决定它能不能存在。
   */
  private workspaceOf(): WorkspaceLike | undefined {
    try {
      return (this.ctx as unknown as { reflect?: { get?: (name: string) => unknown } }).reflect?.get?.('workspace') as
        | WorkspaceLike
        | undefined
    } catch {
      return undefined
    }
  }

  private async setDownloadDir(cdp: Cdp): Promise<void> {
    const root = this.workspaceOf()?.root ?? ''
    if (!root) return
    try {
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: root, eventsEnabled: true })
    } catch (e) {
      // 下载落不到工作区不该让整套工具起不来：还能浏览，只是下不了东西。
      this.ctx.logger?.warn?.(`browser: 下载目录设不上 ${(e as Error).message}`)
    }
  }

  private onEvent(event: { method: string; params: Record<string, unknown> }): void {
    const p = event.params
    switch (event.method) {
      case 'Fetch.requestPaused': {
        void this.onRequest(p)
        return
      }
      case 'Page.frameNavigated': {
        const frame = p.frame as { id?: string; url?: string; parentId?: string } | undefined
        // 只认主框架：iframe 里的地址不是「当前停在哪一页」。
        if (frame && !frame.parentId && typeof frame.url === 'string') {
          /**
           * **只认 http(s) 的地址。**
           *
           * 导航失败之后这里收到的是 `chrome-error://chromewebdata/`，刚建好的标签页是
           * `about:blank`。把它们记成「当前停在哪一页」的话，策略下一次调用会拿它去过
           * 站点判据，报出「只能打开 http / https 的地址」——一句关于协议的话，而地址
           * 本来就是 https。留空反而准确：那时候确实没有一页可用，checkBrowser 会说
           * 「还没有打开任何页面」。
           */
          this.url = httpUrl(frame.url)
          if (frame.id) this.mainFrame = frame.id
          /**
           * **这里不清 poisoned。**
           *
           * 清过一版，是错的：CDP 的事件顺序是 responseReceived → frameNavigated，
           * 也就是说刚在响应里发现「这个域名解析到了内网」并置位，紧接着这条导航
           * 事件就把它抹了——那条防线于是永远不会被任何人读到。它只在**下一次显式
           * 导航**（navigate / back / 换标签页）时清，见那几个方法。
           */
          this.labels.clear()
        }
        return
      }
      case 'Target.targetCreated': {
        const info = p.targetInfo as { targetId?: string; type?: string; openerId?: string } | undefined
        // 自己这一页点出来的新标签页也算自己的。认 openerId，不认「页面上新开的都算」
        // ——员工同时也在用这个浏览器，他开的那些不该进 browser_tabs。
        if (info?.type === 'page' && info.openerId && this.own.has(info.openerId) && info.targetId) {
          this.own.add(info.targetId)
          this.opened += 1
        }
        return
      }
      case 'Target.targetDestroyed': {
        const gone = String(p.targetId ?? '')
        this.own.delete(gone)
        if (gone && gone === this.targetId) this.forgetTarget()
        return
      }
      case 'Target.detachedFromTarget': {
        // 会话没了（窗口被关、标签页崩了）。不作废的话，page() 会一直复用这个
        // 已经不存在的 session，之后每一次调用都以「No session with given id」失败，
        // 而它自己永远不会重开一个——这颗 Bot 的浏览器就废到进程重启为止。
        if (String(p.sessionId ?? '') === this.sessionId) this.forgetTarget()
        return
      }
      case 'Page.javascriptDialogOpening': {
        const kind = String(p.type ?? 'alert')
        this.dialog = {
          kind: (['alert', 'confirm', 'prompt', 'beforeunload'].includes(kind) ? kind : 'alert') as never,
          message: String(p.message ?? ''),
        }
        for (const wake of this.dialogWaiters) wake()
        this.dialogWaiters.clear()
        return
      }
      case 'Page.javascriptDialogClosed': {
        this.dialog = null
        return
      }
      case 'Network.responseReceived': {
        if (this.trustPrivate) return
        const res = p.response as { remoteIPAddress?: string; url?: string } | undefined
        /**
         * **每一种请求都要判，不只是 Document。**
         *
         * 这里原先写的是 `type !== 'Document'` 就返回，于是整道 rebinding 兜底只罩着
         * 顶层文档：页面里一句 `fetch('http://内网别名/…')` 走的是 XHR/Fetch，请求阶段
         * 那层只看主机名（看着像公网就放行），响应阶段又因为类型不对直接跳过——解析到
         * 的 IP 从头到尾没人看过一眼。而这类正文会被写进 DOM，下一次 snapshot 就进了
         * 模型。子资源同样算数：一张图的 URL 也能把内网地址带出去。
         */
        if (!res?.remoteIPAddress) return
        /**
         * **按解析到的 IP 再判一次。**
         *
         * 上面那层拦的是 URL 里的主机名，而一个公网域名完全可以解析到 127.0.0.1
         * （DNS rebinding，或者管理员自己在白名单里写了一个内网别名）。等响应回来才
         * 发现已经晚了一步，所以这里的处理是把页面弹回 about:blank 并记一笔——
         * 下一次工具调用会看到这一笔，直接拒。
         */
        /**
         * **判地址用 `privateAddress`，不是 `blockedHost`。**
         *
         * 后者是给 URL 里的主机名写的，带着「不带点的一律拒」这类只对主机名成立的
         * 启发式——而一个公网 IPv6 里没有点。线上撞过：所有 https 站点全打不开。
         */
        const bad = privateAddress(res.remoteIPAddress)
        if (!bad) return
        this.poisoned = `${res.url ?? '这一页'} 解析到了 ${res.remoteIPAddress}：${bad}`
        void this.cdp?.send('Page.navigate', { url: 'about:blank' }, { sessionId: this.sessionId }).catch(() => {})
        return
      }
      case 'Browser.downloadWillBegin': {
        const guid = String(p.guid ?? '')
        const name = String(p.suggestedFilename ?? '')
        if (guid && name) this.downloading.set(guid, name)
        return
      }
      case 'Browser.downloadProgress': {
        const guid = String(p.guid ?? '')
        if (!guid) return
        // **只报下完的。** 报「开始下载」等于在文件还不存在的时候给用户一张文件卡片。
        if (p.state === 'completed') {
          const name = this.downloading.get(guid)
          if (name) this.downloads.push(name)
        }
        if (p.state === 'completed' || p.state === 'canceled') this.downloading.delete(guid)
        return
      }
      default:
        return
    }
  }

  /** 这条 session / target 已经不作数了，下一次 page() 重开一个。 */
  private forgetTarget(): void {
    this.sessionId = ''
    this.targetId = ''
    this.mainFrame = ''
    this.url = ''
    this.labels.clear()
    this.dialog = null
  }

  private async onRequest(p: Record<string, unknown>): Promise<void> {
    const requestId = String(p.requestId ?? '')
    const req = p.request as { url?: string; method?: string } | undefined
    const cdp = this.cdp
    if (!cdp || !requestId) return
    const url = String(req?.url ?? '')
    const method = String(req?.method ?? 'GET').toUpperCase()
    // 非幂等的记一笔：提交判据漏掉的那次，靠这个事后查得到（见 writes 上的说明）。
    if (method !== 'GET' && method !== 'HEAD' && this.writes.length < 20) {
      this.writes.push({ method, url })
    }
    let bad = blockedHost(hostOf(url))
    /**
     * **顶层导航还要过一遍站点白名单。**
     *
     * 策略只在动手之前判过一次「当前停在哪一页」；页内脚本自己跳走、302 跳到别的域，
     * 都发生在那之后。只判顶层文档：第三方 iframe（支付控件、验证码）和 XHR 打到
     * 别的域是网页的常态，照白名单拦会把好端端的页面拦成白板。
     */
    // mainFrame 取不到时（enableDomains 里那次 getFrameTree 失败会把它置空）不能因为
    // `frameId === ''` 恒假就把整道白名单跳过——那等于在最需要兜底的时候把闸关了。
    // 拿不到主框架 id 就按「顶层文档一律判」处理，宁可多判一次。
    const isTopDoc =
      String(p.resourceType ?? '') === 'Document' && (!this.mainFrame || String(p.frameId ?? '') === this.mainFrame)
    if (!bad && isTopDoc) {
      bad = this.scope?.allowlist ? this.guardUrl(url) : null
    }
    const on = { sessionId: this.sessionId }
    try {
      /**
       * **每一条暂停的请求都必须有个交代。** 漏一条，那个页面就一直转圈——而表现是
       * 「浏览器卡住了」，跟被拦下来完全不像。
       */
      if (bad) await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, on)
      else await cdp.send('Fetch.continueRequest', { requestId }, on)
    } catch {
      /* 请求早就取消了 */
    }
  }

  // ── 页面动作 ────────────────────────────────────────────────────────

  /** 在页面里跑一段，把返回值取回来。 */
  private async evaluate<T>(expr: string, signal?: AbortSignal, timeout?: number): Promise<T> {
    const { cdp, sessionId } = await this.page(signal)
    const res = await cdp.send<{ result?: { value?: T }; exceptionDetails?: { text?: string } }>(
      'Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true },
      { sessionId, signal, ...(timeout ? { timeout } : {}) },
    )
    if (res.exceptionDetails) throw new CdpError(res.exceptionDetails.text || '页面里那段脚本出错了')
    return res.result?.value as T
  }

  private async call<T>(fn: string, args: unknown[], signal?: AbortSignal): Promise<T> {
    return await this.evaluate<T>(callExpr(fn, args), signal, PAGE_CALL_TIMEOUT)
  }

  /**
   * 挡在每一次动作前面的两条：对话框挂着、这一页被判定落错了地方。
   *
   * **两条都要留一把能解开它的工具。** 一条边界如果把唯一的出路也堵上，它就不是边界，
   * 是死局：
   *
   * - 对话框挂着时页面真的冻住了，什么都做不了——除了 `browser_dialog`，那正是用来
   *   把它解掉的。
   * - 中毒（解析到了内网）之后页面已经退回空白页，但这个标记只在**显式导航**时才清，
   *   而 `browser_navigate` 恰恰是那次显式导航。挡住它等于这颗 Bot 的浏览器从此再也
   *   去不了任何地方，直到进程重启。
   */
  blockedNow(tool = ''): string | null {
    if (this.dialog && tool !== 'browser_dialog') {
      return `页面上正挂着一个 ${this.dialog.kind} 对话框：「${this.dialog.message}」。先用 browser_dialog 处理掉它，页面才会继续响应。`
    }
    if (this.poisoned && tool !== 'browser_navigate' && tool !== 'browser_dialog') {
      return `这一页已经被拦下了（${this.poisoned}），页面已退回空白页。用 browser_navigate 换一个能公开访问的地址继续。`
    }
    return null
  }

  /**
   * 这一页现在能不能读。能读返回 null，不能读返回一句**说得出原因**的话。
   *
   * **只写一份，snapshot 和 read 共用。** 早先只加在 snapshot 上，于是模型换一把工具
   * 再试一次就又撞回那句错话——两把工具对同一个状态给出一致的错话，反而更像「环境
   * 就是这样」。
   *
   * 顺序是按「谁更接近真正的原因」排的：中毒 > 导航自己报的错 > 从地址反推。
   */
  private unusable(url: string): string | null {
    if (this.poisoned) return `这一页已经被拦下了（${this.poisoned}），页面已退回空白页。换一个能公开访问的地址。`
    if (this.navError) {
      return `刚才那次导航没有成功：${this.navError}。检查一下网址，或者换一个地址再试——这不是权限问题。`
    }
    // 浏览器的错误页。地址长这样就说明上一次导航失败了，只是没拿到 errorText。
    if (url.startsWith('chrome-error://')) {
      return '上一次导航没有成功，页面停在浏览器的错误页上。检查一下网址，或者换一个地址再试。'
    }
    if (!url || url === 'about:blank') {
      return '页面停在空白页：还没有成功打开任何页面。先用 browser_navigate 打开一个地址。'
    }
    return null
  }

  async snapshot(full: boolean, signal?: AbortSignal): Promise<Snapshot> {
    const snap = await this.call<Snapshot>('snapshot', [full, this.refBase], signal)
    // **读回来的这一页要再判一次。** 策略判的是动手之前停在哪，中间可能跳过了。
    // 先看这一页能不能用（导航失败 / 错误页 / 中毒），再看它在不在允许的范围里。
    // 反过来的话，一次 DNS 失败会被讲成一次边界拦截。
    const unusable = this.unusable(snap.url)
    if (unusable) {
      this.labels.clear()
      throw new PageError(unusable)
    }
    const bad = this.guardUrl(snap.url)
    if (bad) {
      // 这张 ref 表描述的是**上一页**。留着它，策略下一次问「@e5 是什么按钮」时，
      // 答的是另一页上那个同号元素的名字。
      this.labels.clear()
      throw new ScopeError(`这一页是 ${snap.url}，${bad}。内容没有取回来。`)
    }
    this.url = snap.url
    // ref → 名字。**策略靠这张表判「点的是不是提交」**，所以它必须和模型看到的那份
    // 快照是同一次的产物；从别处现取会出现「卡片上写的按钮和它要点的不是一个」。
    this.labels.clear()
    for (const line of snap.body.split('\n')) {
      const m = /^- (\S+) "([^"]*)" \[@e(\d+)\]/.exec(line)
      if (!m) continue
      this.labels.set(`@e${m[3]}`, { role: m[1], name: m[2] })
      this.refBase = Math.max(this.refBase, Number(m[3]))
    }
    return snap
  }

  /**
   * 一次动作之后的收尾：**先看有没有弹出原生对话框，再拍快照**。
   *
   * 顺序反过来就是一次必然的卡死：点中一个 onclick 里带 confirm 的按钮之后，整页是
   * 冻住的，Runtime.evaluate 不会返回，快照一直等到默认超时（15 秒）——模型收到的是
   * 一句「Runtime.evaluate 超时」，既不知道点击其实成功了，也不知道下一步该调
   * browser_dialog。它多半会再点一次。
   *
   * 快照这一趟也压短超时：对话框在动作之后、拍照之前那一瞬弹出来的话，事件还没到，
   * 只能靠这次超时兜回来。
   */
  async settleAndSnapshot(
    signal?: AbortSignal,
  ): Promise<{ dialog?: { kind: string; message: string }; snap?: Snapshot; opened?: number }> {
    await settle(signal)
    const opened = this.takeOpened()
    const pending = () => (this.dialog ? { dialog: { kind: this.dialog.kind, message: this.dialog.message } } : null)
    const early = pending()
    if (early) return { ...early, opened }
    try {
      return { snap: await this.snapshot(false, signal), opened }
    } catch (e) {
      // 超时的真正原因多半就是它：动作之后、拍照之前那一瞬弹出来的对话框。
      const late = pending()
      if (late) return { ...late, opened }
      throw e
    }
  }

  async locate(ref: string, signal?: AbortSignal): Promise<Located> {
    return await this.call<Located>('locate', [ref], signal)
  }

  /** 聚焦到输入框并**清空**它。追加而不是替换，是模型最容易误以为已经改掉的一种。 */
  async focus(ref: string, signal?: AbortSignal): Promise<Located> {
    return await this.call<Located>('focusOn', [ref], signal)
  }

  async select(ref: string, values: string[], signal?: AbortSignal): Promise<{ picked?: number; name?: string; err?: string }> {
    return await this.call('selectOptions', [ref, values], signal)
  }

  async read(ref: string | undefined, signal?: AbortSignal): Promise<{ url?: string; title?: string; body?: string; total?: number; err?: string }> {
    const got = await this.call<{ url?: string; title?: string; body?: string; total?: number; err?: string }>('read', [ref ?? null], signal)
    // 和 snapshot 同一份判据、同一个顺序（见 unusable 上的说明）。
    const unusable = this.unusable(String(got.url ?? ''))
    if (unusable) throw new PageError(unusable)
    if (got.url) {
      const bad = this.guardUrl(got.url)
      if (bad) throw new ScopeError(`这一页是 ${got.url}，${bad}。内容没有取回来。`)
    }
    return got
  }

  async scroll(direction: string, amount: number, signal?: AbortSignal): Promise<{ y: number; height: number; viewport: number }> {
    return await this.call('scrollBy', [direction, amount], signal)
  }

  async hasText(needle: string, signal?: AbortSignal): Promise<boolean> {
    return await this.call<boolean>('hasText', [needle], signal)
  }

  /**
   * 派发一次输入。**对话框把回执卡住了不算失败。**
   *
   * `Input.dispatchMouseEvent` 的回执要等页面处理完这次事件才回来，而 confirm 一弹出来
   * 页面就冻住了——回执永远等不到。那次点击**已经发生了**（对话框正是它弹出来的），
   * 所以这里认这个信号：超时时只要有对话框挂着，就当动作成功，让上层去讲那个对话框。
   *
   * 超时也压短（PAGE_CALL_TIMEOUT）：拿默认的 15 秒等，每一次这样的点击都要卡满一刻钟。
   */
  private async dispatch(run: () => Promise<unknown>): Promise<void> {
    const sent = run().then(
      () => 'done' as const,
      (e: Error) => {
        if (this.dialog) return 'done' as const
        throw e
      },
    )
    // **不要干等那五秒。** 对话框一弹出来就说明这次派发已经生效了，剩下的等待纯属浪费——
    // 而模型那头正等着知道「发生了什么」。输了这一局的那个 promise 仍然可能在超时后
    // 抛错，挂个空 catch 免得变成未处理的 rejection。
    sent.catch(() => {})
    // **等完要把自己从等待名单里摘掉。** 不摘的话，没弹对话框的那些次（也就是绝大多数）
    // 各留下一个永远不会兑现的 resolve，一条长会话下来攒成几千个——而席位上的 bot 是
    // 常驻进程。
    let wake: (() => void) | null = null
    const opened = new Promise<void>((resolve) => {
      if (this.dialog) return resolve()
      wake = resolve
      this.dialogWaiters.add(resolve)
    })
    try {
      await Promise.race([sent, opened])
    } finally {
      if (wake) this.dialogWaiters.delete(wake)
    }
  }

  /** 一次真的鼠标点击（按下 + 抬起），不是 `el.click()`。 */
  async clickAt(x: number, y: number, clickCount: number, signal?: AbortSignal): Promise<void> {
    const { cdp, sessionId } = await this.page(signal)
    const base = { x, y, button: 'left', clickCount }
    const on = { sessionId, signal, timeout: PAGE_CALL_TIMEOUT }
    await this.dispatch(() => cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, on))
    await this.dispatch(() => cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, on))
  }

  async typeText(text: string, signal?: AbortSignal): Promise<void> {
    const { cdp, sessionId } = await this.page(signal)
    // insertText 一次把整段塞进去。逐字符敲的话，一段长文本要几百次往返，
    // 而中途一旦被停止，输入框里留下的是半句话。
    await this.dispatch(() => cdp.send('Input.insertText', { text }, { sessionId, signal, timeout: PAGE_CALL_TIMEOUT }))
  }

  async pressKey(key: string, signal?: AbortSignal): Promise<void> {
    const { cdp, sessionId } = await this.page(signal)
    const spec = KEYS[key.toLowerCase()] ?? { key, code: key, windowsVirtualKeyCode: 0 }
    for (const type of ['keyDown', 'keyUp'] as const) {
      await this.dispatch(() =>
        cdp.send('Input.dispatchKeyEvent', { type, ...spec }, { sessionId, signal, timeout: PAGE_CALL_TIMEOUT }),
      )
    }
  }

  async navigate(url: string, signal?: AbortSignal): Promise<void> {
    const { cdp, sessionId } = await this.page(signal)
    this.dialog = null
    // 显式换一页才清这个标记（见 frameNavigated 那段）。
    this.poisoned = ''
    this.writes = []
    this.navError = ''
    /**
     * **回执里就带着失败原因**（`errorText`），收下来。下游不必再靠「页面停在哪儿」
     * 去猜——那条路走过，猜错了。
     */
    const res = await cdp.send<{ errorText?: string }>('Page.navigate', { url }, { sessionId, signal, timeout: 30_000 })
    if (typeof res?.errorText === 'string' && res.errorText) this.navError = res.errorText
    await settle(signal)
    // 成功才记；失败时留给 frameNavigated 去处置（它只认 http(s)）。
    if (!this.navError) this.url = httpUrl(url)
  }

  async back(signal?: AbortSignal): Promise<boolean> {
    const { cdp, sessionId } = await this.page(signal)
    this.poisoned = ''
    this.writes = []
    const hist = await cdp.send<{ currentIndex: number; entries: { id: number }[] }>(
      'Page.getNavigationHistory',
      {},
      { sessionId, signal },
    )
    if (hist.currentIndex <= 0) return false
    await cdp.send('Page.navigateToHistoryEntry', { entryId: hist.entries[hist.currentIndex - 1].id }, { sessionId, signal })
    await settle(signal)
    return true
  }

  async handleDialog(accept: boolean, text: string | undefined, signal?: AbortSignal): Promise<string> {
    const pending = this.dialog
    if (!pending) return ''
    const { cdp, sessionId } = await this.page(signal)
    await cdp.send(
      'Page.handleJavaScriptDialog',
      { accept, ...(text !== undefined ? { promptText: text } : {}) },
      { sessionId, signal },
    )
    this.dialog = null
    return pending.message
  }

  /** 上一次动作之后新开出来的标签页数。取走即清零。 */
  takeOpened(): number {
    const n = this.opened
    this.opened = 0
    return n
  }

  /**
   * 上一次动作之后经过的非幂等请求，**取走即清空**。
   *
   * 给策略的事后审计用：提交判据漏掉的那一次（只有图标、没有名字的删除按钮），
   * 至少在会话日志里留得下「这次点击发出了一条 POST」。
   */
  takeWrites(): { method: string; url: string }[] {
    const out = this.writes
    this.writes = []
    return out
  }

  /**
   * 这一步之后页面长什么样，拍一张落进工作区。**给人看，不给模型看。**
   *
   * 为什么值得拍：一次多步浏览在日志里只剩十几段 a11y 文本，出了问题（点错了、页面
   * 弹了个没见过的东西、登录掉了）翻那些文本几乎看不出所以然，而一眼截图就够。模型
   * 那边不需要它——它手上有快照，而且默认那个对话模型没有视觉（见 docs/browser-tools.md
   * 第 1 节，那一条没有变）。
   *
   * **拍不成一律当没拍**，不往上抛：这张图是痕迹，不是动作的一部分。因为拍照失败把一次
   * 成功的点击报成失败，是拿一个附带功能去毁主功能。
   *
   * 三种情况直接不拍：
   * - **页面上挂着原生对话框**——那时候整页是冻住的，`captureScreenshot` 的回执和快照
   *   一样永远等不到，只会白等一个超时。这是 settleAndSnapshot 上那段说明的同一个坑。
   * - 没有工作区（图没地方放）。
   * - 这条会话已经拍够了（见 MAX_SHOTS）。
   */
  async screenshot(sessionId: string, action: string, signal?: AbortSignal): Promise<WorkspaceFile | undefined> {
    if (this.dialog) return undefined
    const cdp = this.cdp
    const target = this.sessionId
    // 没有页面就没什么可拍的。**不在这里 page()**：那会为了一张截图把一个已经关掉的
    // 标签页重新开出来，而这一步本来只是想留个痕迹。
    if (!cdp?.alive || !target) return undefined
    const ws = this.workspaceOf()
    if (!ws?.saveBytes) return undefined
    const taken = this.shots.get(sessionId) ?? 0
    if (taken >= MAX_SHOTS) return undefined
    try {
      const got = await cdp.send<{ data?: string }>(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: SHOT_QUALITY },
        { sessionId: target, signal, timeout: SHOT_TIMEOUT },
      )
      const data = typeof got?.data === 'string' ? got.data : ''
      if (!data) return undefined
      const file = await ws.saveBytes(`browser/${sessionId}`, `${shotStamp()}-${action}.jpg`, Buffer.from(data, 'base64'))
      this.shots.set(sessionId, taken + 1)
      return { path: file.path, name: file.name }
    } catch (e) {
      this.ctx.logger?.warn?.(`browser: 截图没拍成 ${(e as Error).message}`)
      return undefined
    }
  }

  /** 这一次动作之后新落下来的文件。报给界面用，模型不看。 */
  takeDownloads(): WorkspaceFile[] {
    const names = [...new Set(this.downloads)]
    this.downloads = []
    return names.map((name) => ({ path: name, name }))
  }

  /**
   * 插件卸下时把连接收掉。
   *
   * **走 `ctx.effect`，不写一个 `stop()`。** 这个版本的 cordis 里 Service 没有 stop 钩子
   * ——写了也没人调，而它长得像生命周期方法，下一个人会以为收尾这件事已经有人管了。
   * 仓库里别处（storage 关 SQLite、catalog 清定时器）用的都是这一套。
   *
   * 不收的后果：一次热重载之后旧连接还开着、旧的监听器还在跑，两份监听器同时处理
   * `Fetch.requestPaused`，同一条请求被 continue 两次，第二次报错。
   */
  private teardown(): void {
    this.cdp?.close()
    if (this.localBrowser) {
      this.localBrowser.kill()
      this.localBrowser = null
    }
    this.cdp = null
    this.sessionId = ''
    this.targetId = ''
    this.own.clear()
    this.dialogWaiters.clear()
  }
}

/** 按键那几个要带虚拟键码，不然网页里的快捷键判断收不到。 */
const KEYS: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  pagedown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  pageup: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
}

/**
 * 只留 http(s) 的地址，别的（`chrome-error://`、`about:blank`、`devtools://`）当作
 * 「现在没有一页可用」。见 frameNavigated 里那段说明。
 */
function httpUrl(url: unknown): string {
  const s = typeof url === 'string' ? url.trim() : ''
  return /^https?:\/\//i.test(s) ? s : ''
}

/**
 * 截图的文件名前缀：`20260824-113045-321`。
 *
 * 用时间而不是序号：序号得有个计数器，而计数器跟着进程走——席位重启之后从头数，
 * 同一条会话的目录里就会撞名，而撞名的后果要么是覆盖掉一张旧的（那是数据丢失），
 * 要么是 `-1` `-2` 这种谁也看不懂的后缀。带毫秒的时间戳既不会撞，又刚好按顺序排，
 * 人直接在工作区里按文件名就能把这次浏览从头看到尾。
 */
function shotStamp(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
  )
}

async function settle(signal?: AbortSignal): Promise<void> {
  await new Promise((r) => setTimeout(r, SETTLE_MS))
  if (signal?.aborted) throw new CdpError('已中止')
}

export { MAX_WAIT_MS, REF_ERRORS, type Located, type Snapshot }

export const name = 'satu-browser'

export function apply(ctx: Context, config: Config = {}) {
  ctx.plugin(BrowserService, config)
}
