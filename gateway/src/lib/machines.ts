/**
 * 运行机器：地址归一、配对码、桌面票、管家/Bot 发布包。
 *
 * 从 routes.ts 拆出来的——那个文件曾经是 5700 行，前 1900 行全是这类帮手。
 */
import type { ServerResponse } from 'node:http'
import { gatewayPageIsHttp, HttpError, type Req } from '../http.ts'
import { bodyOf, strField } from './validate.ts'
import { openRelease, parseBotVersion, registerRemoteRelease } from '../releases.ts'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import { type Db, type Machine, type ReleaseKind, releaseArch } from '../db.ts'
import { type JwtKeys, signDesktopTicket } from '../crypto.ts'
import { type MachineLoad, machinePaired, ownerMachine } from '../deploy.ts'

export function machineBase(host: string): string {
  const h = host.trim().replace(/\/$/, '')
  return /^https?:\/\//i.test(h) ? h : `http://${h}`
}

export const PULL_ERROR = '机器不在线，全文拉不下来'

export async function pullSessionEvents(
  host: string,
  sessionId: string,
  tokens: { seat: string; machine: string },
): Promise<{ ok: true; events: unknown[] } | { ok: false }> {
  const url = `${machineBase(host)}/internal/sessions/${encodeURIComponent(sessionId)}`
  // 两个头，**两把不同的票**：bot 认 authorization 上的席位票（sat_），管家认
  // x-satuwork-machine 上的机器票（smt_）。以前两个头塞的是同一把机器票，代价是 bot
  // 必须把 smt_ 存在自己的环境里——而那个环境是席位用户读得到的。
  const headers: Record<string, string> = {}
  if (tokens.seat) headers.authorization = `Bearer ${tokens.seat}`
  if (tokens.machine) headers['x-satuwork-machine'] = tokens.machine
  try {
    const r = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return { ok: false }
    const body = (await r.json()) as { events?: unknown }
    if (!body || !Array.isArray(body.events)) return { ok: false }
    return { ok: true, events: body.events }
  } catch {
    return { ok: false }
  }
}

export const INSTANCE_DOWN = '实例还没上线'

/**
 * 机器地址。`example.com:3080` 或 `http(s)://example.com:3080` 都收，别的都不收——
 * 这个值会被 Gateway 自己带着机器凭证去 fetch，路径、用户名口令、别的协议一律挡掉。
 */
export function machineHostOf(raw: string): string {
  const text = raw.trim().replace(/\/$/, '')
  if (!text) return ''
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  let u: URL
  try {
    u = new URL(hasScheme ? text : `http://${text}`)
  } catch {
    throw new HttpError(400, 'host 必须是 http/https 地址')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'host 必须是 http/https 地址')
  if (u.username || u.password) throw new HttpError(400, 'host 不能带用户名或口令')
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw new HttpError(400, 'host 不能带路径')
  return hasScheme ? `${u.protocol}//${u.host}` : u.host
}

/**
 * 机器管家的基址。**一定带 scheme**——它要被直接拼成 fetch 的 URL，裸 host 会在
 * 调用点各自补一次，补法迟早会不一致。
 */
export function managerHostOf(raw: string): string {
  const normalized = machineHostOf(raw)
  if (!normalized) throw new HttpError(400, 'host 不能为空')
  return machineBase(normalized)
}

/**
 * 席位机器的**公网直连地址**（见迁移 0038）。空串 = 清掉，回到从 Gateway 反代。
 *
 * 比 `machineHostOf` 严一档，因为这一列是给**浏览器**用的，而浏览器的规矩不一样：
 *
 * · **必须 https——除非 Gateway 自己就是 http。** Gateway 的页面走 https 时，页面里
 *   嵌一个 http 的 iframe 会被当成混合内容直接拦掉，而且是**静默**的——界面上就是
 *   一块永远打不开的空白，控制台之外没有任何线索。所以宁可在这里就把话说死，也不要
 *   让人去查一块白屏。但这条理由的前提是「页面是 https」：本地开发时 Gateway 自己就
 *   跑在 http 上，混合内容根本无从谈起，而管家只监听明文 http（node:http，自己不做
 *   TLS），硬要 https 等于在本地永远配不出直连——桌面、对话流、名单流、日志跟随全
 *   都没有退路可退。所以**只在 GATEWAY_PUBLIC_URL 明确配成 http 时**放行 http。
 *   没配过就照旧强制 https：没配时这个值是按 Host 猜的（见 gatewayBaseFor），拿一个
 *   猜出来的协议去放宽一道安全校验，不划算。
 * · **不能带路径。** 这个值后面要拼 `/seats/<seatId>/vnc/`，带了路径拼出来的地址
 *   落不到管家的那条路由上，同样是一块打不开的屏。
 *
 * 不校验的事也说清楚：**这里探不到「浏览器连不连得上」**。Gateway 能连到不等于
 * 员工的浏览器能连到（机器可能只对 Gateway 开了口），证书对不对、域名解析到哪儿，
 * 都只有真正在浏览器里打开才知道。所以这条只挡形状，不给「已验证」的错觉。
 */
export function directUrlOf(raw: string): string | null {
  const text = (raw || '').trim().replace(/\/$/, '')
  if (!text) return null
  let u: URL
  try {
    u = new URL(text)
  } catch {
    throw new HttpError(400, '直连地址要写成完整的 https URL，例如 https://m001.example.com')
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && gatewayPageIsHttp())) {
    throw new HttpError(400, '直连地址必须是 https：Gateway 的页面是 https，http 的桌面会被浏览器当成混合内容静默拦掉')
  }
  if (u.username || u.password) throw new HttpError(400, '直连地址不能带用户名或口令')
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) {
    throw new HttpError(400, '直连地址不能带路径或参数：后面要拼 /seats/<席位>/vnc/')
  }
  return `${u.protocol}//${u.host}`
}

/** 配对码 30 分钟过期。够贴一次命令，不够别人捡去慢慢试。 */
export const PAIRING_TTL = 30 * 60 * 1000

/**
 * 配对码。`SW-XXXX-XXXX`。
 *
 * 字母表要能**照着屏幕手抄不出错**——这个码的唯一用法就是人肉搬到另一台机器上。
 * 所以成对易混的一律只留一个：去掉 `O/0`、`I/1/L`，以及 `S/5`、`Z/2`、`B/8` 里的
 * 字母那一半（留数字，因为数字在等宽字体里更好认）。
 *
 * 剩 28 个字符取 8 位 ≈ 38 bit，配上 30 分钟窗口和一次性认领足够——它换到的是一台
 * 机器的控制权，不是长期凭据。
 *
 * **取字符用拒绝采样，不是 `% 28`。** 256 不是 28 的倍数（256 = 9×28 + 4），直接取模
 * 的话前 4 个字母（A/C/D/E）各多出 1/256 的概率，每一位少掉约 0.02 bit。这一点点在
 * 38 bit 上无关痛痒，但「随机码里带偏置」是那种会被原样抄进下一个用途的写法——下一处
 * 未必还有 30 分钟窗口兜着。多这三行，把它挡在源头。
 */
export function randomPairingCode(): string {
  const alphabet = 'ACDEFGHJKMNPQRTUVWXY23456789'
  // 256 里能整除 28 的最大段。落在这一段之外的字节直接丢掉重取。
  const limit = Math.floor(256 / alphabet.length) * alphabet.length
  let out = ''
  while (out.length < 8) {
    for (const byte of randomBytes(8)) {
      if (byte >= limit) continue
      out += alphabet[byte % alphabet.length]
      if (out.length === 8) break
    }
  }
  return `SW-${out.slice(0, 4)}-${out.slice(4)}`
}

/**
 * 收码时把手抄错的那几个字符纠回去。
 *
 * 生成端已经不产出 `S/Z/B/O/I/L` 了，所以看到它们必定是抄错——直接映射成对应的
 * 数字，而不是让人对着一个「配对码无效」的提示反复重来。
 *
 * **代价**：换字母表之前发出去的、含这些字母的码，从此换不回去了（会被纠成数字，
 * 和库里存的对不上）。码只活 30 分钟且一次性，所以这个代价只在改动当天存在一次；
 * 但真撞上时症状是「明明没过期却说无效」，很难猜，所以写在这儿。
 */
export function normalizePairingCode(raw: string): string {
  const text = String(raw || '').trim().toUpperCase()
  // **只纠随机那一段**：前缀 `SW-` 里就有一个 S，一起替换会把每个码都毁掉。
  if (!text.startsWith('SW-')) return text
  const fixed = text
    .slice(3)
    .replace(/[SZBOIL]/g, (c) => ({ S: '5', Z: '2', B: '8', O: '0', I: '1', L: '1' })[c] ?? c)
  return 'SW-' + fixed
}

/** 安装命令里的 Gateway 地址：优先 GATEWAY_PUBLIC_URL，否则按请求的 Host 猜。 */
export function gatewayBaseFor(req: Req): string {
  const explicit = (process.env.GATEWAY_PUBLIC_URL || '').trim().replace(/\/$/, '')
  if (explicit) return explicit
  const host = String(req.headers.host || '').trim() || '127.0.0.1:3080'
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http'
  return `${proto}://${host}`
}

export function installCommandFor(req: Req, code: string): string {
  return `curl -fsSL ${gatewayBaseFor(req)}/install-manager.sh | sudo bash -s -- --code ${code}`
}

/**
 * 只有配对好的机器才签得出桌面票；没配对时返回 undefined，URL 里就不带 ticket。
 *
 * 口令跟着票走（见 signDesktopTicket），所以「打开桌面」点开就是桌面本身，不再是
 * 一个还要人回去抄一遍口令的登录框。
 */
export function desktopTicketFor(
  keys: JwtKeys,
  machine: Machine | undefined,
  row: { seatId: string; vncPassword?: string },
): string | undefined {
  if (!machinePaired(machine)) return undefined
  return signDesktopTicket(keys, row.seatId, row.vncPassword ?? '')
}

/**
 * 管家要求的最低 Node 大版本。
 *
 * 管家包里带着 tsx 但**不带 Node**，所以自升级换不了运行时。低于这个数就不升——
 * 让它继续用旧版本活着，等人重跑安装脚本。升到起不来比不升坏得多：没有 SSH 可以救。
 */
export const MIN_MANAGER_NODE = 24

/**
 * 这台机器该跑哪个管家版本。
 *
 * 优先级：单机钉的 > 平台全局钉的 > 最新发布。单机那一层是灰度用的——先让一台机器
 * 追新版本，看几天再改全局。
 */
/**
 * 钉的那一版，但**换成这台机器的架构**。
 *
 * `0.1.2+abc-x64` 和 `0.1.2+abc-arm64` 是同一次发布的两份包。钉版本的人（尤其是平台
 * 全局那一档）只能写一个字符串，写不了两个架构；照着发下去，另一半机器必然拿到错包。
 * 所以先按原样找，架构对不上就找同版本的兄弟包。
 *
 * 找不到兄弟就返回 undefined，让调用方回落——发一个已知错架构的包没有任何意义。
 */
export async function managerReleaseFor(db: Db, version: string, arch: string | null) {
  const row = await db.botRelease(version, 'manager')
  const want = arch?.trim()
  if (!want) return row
  const got = row ? releaseArch(row.version) : undefined
  if (row && (!got || got === want)) return row
  const sibling = version.replace(/-(x64|arm64)$/, '') + '-' + want
  if (sibling === version) return row
  return await db.botRelease(sibling, 'manager')
}

export async function desiredManagerRelease(db: Db, machine?: Machine) {
  const arch = machine?.arch ?? null
  const pinned = machine?.desiredManagerVersion?.trim()
  if (pinned) {
    const row = await managerReleaseFor(db, pinned, arch)
    if (row) return row
  }
  const settings = await db.platformSettings()
  const global = (settings as { managerVersion?: unknown }).managerVersion
  if (typeof global === 'string' && global.trim()) {
    const row = await managerReleaseFor(db, global.trim(), arch)
    if (row) return row
  }
  return db.latestBotRelease('manager', arch)
}

/**
 * 席位 → 它那台机器。
 *
 * 多机之后**不能再用「公司那台机器」**：两个员工的席位可能落在不同机器上，用错
 * 地址的后果是 noVNC 打不开、聊天反代打到别人的机器上。带一个 Map 当本次请求的
 * 缓存，列表接口不至于逐行查库。
 *
 * 给的是整行而不是 host：这一行还要答「那台机器通不通」（心跳有多久没来了，见
 * listSeatRuntime 的 machineLink）。只取 host 的话，调用方就得为同一台机器再查一次库。
 */
export function machineResolver(db: Db) {
  const cache = new Map<string, Machine | null>()
  return async (row: { machineId: string }): Promise<Machine | null> => {
    const id = row.machineId
    if (!id) return null
    if (!cache.has(id)) cache.set(id, (await db.machine(id)) ?? null)
    return cache.get(id) ?? null
  }
}

/** 取这家公司名下的某台机器。跨公司拿 id 一律 404，不透露它存在。 */
export async function machineOfOrg(db: Db, companyId: string, machineId: string): Promise<Machine> {
  const machine = await db.machine(machineId)
  if (!machine || machine.companyId !== companyId) throw new HttpError(404, '没有这台机器')
  return machine
}

/**
 * 一台机器在界面上的一张卡片：身份 + 负载 + 版本 + 有没有可升的。
 *
 * 「已用」算的是**激活账号数**，不是席位数——一个员工的多个 bot 落在同一台机器上，
 * 只占一个账号位。两个数都给，因为运维时想知道机器上到底跑着多少个进程。
 */
export async function machineCard(
  db: Db,
  load: MachineLoad,
  latest: { botLatest: string | null; managerLatest: string | null },
  /**
   * 这家公司的第几台，1 起。**给人指代用的短号**（「2 号机上不去了」），不是标识符
   * ——中间删掉一台，后面的号会往前挪。要唯一地指一台，用 `machine.id`。
   */
  no: number,
  /**
   * `seatList: false` = 不带席位清单。
   *
   * 那份清单是给日志选择器用的，每个席位要查一次账号；而调用方里有两类根本用不上
   * 它：只画汇总的列表页，以及自己会重建一份更全的详情页。默认带着（公司详情页要），
   * 不要的显式说一声——**省掉的是一整轮按席位的账号查询**，机器一多就不是小数。
   *
   * 不要时整个键都不出现，而不是给一个空数组：空数组的意思是「这台机器没有席位」，
   * 那是另一回事，会让日志选择器安静地少列几行。
   */
  opts: { seatList?: boolean } = {},
) {
  const { machine, seatRows, accounts, seats, full } = load
  const counts = new Map<string, number>()
  for (const r of seatRows) {
    if (r.status === 'none') continue
    counts.set(r.botVersion ?? '', (counts.get(r.botVersion ?? '') ?? 0) + 1)
  }
  const botVersions = [...counts.entries()]
    .map(([version, n]) => ({ version: version || null, seats: n }))
    .sort((a, b) => b.seats - a.seats)
  /**
   * 同一份清单，按**席位自报的模版版本**再数一遍。
   *
   * 和 botVersions 并排给出来，因为这台机器上「装的是哪个包」和「跑的是哪一版模版」是
   * 两件会各自落后的事：包升到最新了、模版却还停在三版之前，只看上面那一行看不出来。
   * `null` 是「这台席位还没报到过」，不是第 0 版——两者在界面上分开说。
   */
  const tplCounts = new Map<number | null, number>()
  for (const r of seatRows) {
    if (r.status === 'none') continue
    tplCounts.set(r.tplVersion ?? null, (tplCounts.get(r.tplVersion ?? null) ?? 0) + 1)
  }
  const tplVersions = [...tplCounts.entries()]
    .map(([version, n]) => ({ version, seats: n }))
    .sort((a, b) => b.seats - a.seats)
  const desired = (await desiredManagerRelease(db, machine))?.version ?? null
  // 席位清单给平台端的日志选择器用：要看某个席位的 bot 日志，得先知道有哪些席位。
  const seatList =
    opts.seatList === false
      ? undefined
      : await Promise.all(
          seatRows
            .filter((r) => r.status !== 'none')
            .map(async (r) => ({
              seatId: r.seatId,
              botId: r.botId,
              linuxUser: r.linuxUser,
              who: (await db.account(r.accountId))?.email ?? r.accountId,
            })),
        )
  return {
    no,
    ...(seatList ? { seatList } : {}),
    machine: ownerMachine(machine),
    accounts,
    maxAccounts: machine.maxAccounts,
    seats,
    full,
    botVersions,
    tplVersions,
    botOutdated: Boolean(latest.botLatest) && botVersions.some((v) => v.version !== latest.botLatest),
    managerDesired: desired,
    managerOutdated:
      Boolean(latest.managerLatest) && Boolean(machine.managerVersion) && machine.managerVersion !== latest.managerLatest,
    managerPending: Boolean(desired) && Boolean(machine.managerVersion) && machine.managerVersion !== desired,
    // 时区和管家版本一样是「下指令 → 机器自己去改 → 下一轮心跳才知道成没成」。
    timezonePending: Boolean(machine.timezone) && machine.currentTimezone !== machine.timezone,
  }
}

/** 把「新增版本」表单的四个字段收下来。四个都必填——验证靠的就是它们。 */
export async function registerFromBody(db: Db, req: Req, kind: ReleaseKind) {
  const body = bodyOf(req)
  return registerRemoteRelease(db, {
    kind,
    version: strField(body, 'version'),
    url: strField(body, 'url'),
    // 数字和字符串都收：界面走 FormData 拿到的是字符串，脚本调用直接给数字。
    // 让一个数值字段只认字符串，是给调用方挖坑。
    size: Number((body as Record<string, unknown>).size),
    sha256: strField(body, 'sha256'),
    note: strField(body, 'note', false),
  })
}

/**
 * 流式下发一个发布包。
 *
 * 字节在本机还是在别处（只登记了 url）对调用方不可见——`openRelease` 抹平了这层。
 * **不用 302 打发到远端地址**：`x-bot-sha256` 要跟着响应走，重定向之后管家就拿不到
 * 校验值了，那等于把完整性检查悄悄关掉。
 */
export async function sendReleaseFile(res: ServerResponse, kind: ReleaseKind, rawVersion: string, db: Db): Promise<void> {
  const version = parseBotVersion(rawVersion)
  const row = await db.botRelease(version, kind)
  if (!row) throw new HttpError(404, '没有这个版本')
  const body = await openRelease(row)
  res.writeHead(200, {
    'content-type': 'application/gzip',
    'content-length': String(row.size),
    'x-bot-sha256': row.sha256,
    'cache-control': 'no-store',
  })
  await pipeline(body, res)
}
