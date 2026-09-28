import { createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { satuworkHome } from './home.ts'
import { isSeatMode } from './seat-secrets.ts'

/**
 * 「Gateway 现在在哪」——从入站请求上学回来。
 *
 * ## 要解的是什么
 *
 * 席位的 `GATEWAY_URL` 是**部署那一刻**写死进 `bot.env` 的（见 manager 的
 * deploy-seat.sh，值来自 Gateway 的 `GATEWAY_PUBLIC_URL`）。Gateway 换了对外地址之后
 * ——家用网络里 DHCP 换一次租约就够了——这个值就指向一个不存在的地方，而后果是**这台
 * 席位彻底哑掉**：模型调用、目录拉取、会话上报，全部 `fetch failed`。界面上只有一句
 * 「模型调用失败：Gateway 不可达」，没有任何线索指向「地址过期了」。
 *
 * 而它自己无从知道新地址：唯一能告诉它的通道，恰恰是它**打不出去**的那一条。
 *
 * ## 为什么这条路成立
 *
 * 入站那条还通着——机器没挪窝，Gateway 找得到它（正是靠这条路人才在界面上点得动
 * 「重新部署」）。所以反过来说：**Gateway 每次打进来时顺便报一下自己在哪**。
 *
 * 头是 `x-satuwork-gateway-url`，由 Gateway 的 `managerHeaders()` 拼在每一条发往席位的
 * 代理请求上，管家在**验过机器票**的 `/seats/:id/bot/*` 那条路上把它透传下来。这套头
 * 本来就为管家自己学地址而存在（见 manager/src/index.ts 的 adoptGatewayUrl），这里只是
 * 让链路末端的 bot 也听一句。
 *
 * ## 信任面
 *
 * 只在**席位票验过之后**才调（见 guard/index.ts）。但席位票对上**不等于**说话的是
 * Gateway：浏览器直连的 stream、票进来的 vnc、本机工人的中继，这几条路上都是管家验完
 * 别的凭据之后**替调用方换上 `sat_`**。所以管家在那几条路上把一切 `x-satuwork-*` 都摘掉
 * （manager/src/proxy.ts 的 forwardHeaders）——否则任何一个登录了的人都能把这里的
 * GATEWAY_URL 指到自己的服务器上，连同 GATEWAY_TOKEN / GATEWAY_API_KEY 一起收走。
 *
 * Gateway 那边**只在显式配了 `GATEWAY_PUBLIC_URL` 时才带这个头**（
 * `gatewayPublicUrlExplicit`），所以不会拿一个按 Host 猜出来的地址教坏席位。
 *
 * ## 落盘落在哪
 *
 * - **远程席位**（凭据从 fd 0 读到，见 seat-secrets.ts）：`bot.env` 现在在
 *   `/etc/satuwork/seats/<席位>/`，root 的，bot 写不动——也**不能**让它写得动：那是 systemd
 *   以 root 读的 EnvironmentFile，席位用户（包括 terminal 里的任何子进程）写得动就能往里塞
 *   `NODE_OPTIONS`、`LD_PRELOAD`，或者把 `GATEWAY_URL` 指向自己、下次重启时白拿席位票。
 *   所以新地址写进 `$SATUWORK_HOME/gateway-url`，**用席位票做 HMAC**，启动时由 bot 自己
 *   校验着读（`loadGatewayUrlOverride`）。子进程改得动这个文件，但算不出 MAC，改了也只会被
 *   忽略。MAC 里还带着部署写死的那个地址：重新部署换了地址，旧的覆盖自动作废。
 * - **老布局**（bot.env 还在 `$SATUWORK_HOME` 里、归 bot 自己）：照旧改写那一行。
 * - 都没有（本地开发）：什么都不做。
 */

/** 只收裸 origin：协议限 http/https，不许带路径、查询、片段、用户名口令。 */
function originOf(raw: string): string {
  const u = new URL(raw)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol')
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash || u.username || u.password) throw new Error('shape')
  return `${u.protocol}//${u.host}`
}

const norm = (raw: string) => raw.trim().replace(/\/$/, '')

/**
 * 上一次没写成的目标地址。
 *
 * 这个函数挂在**每一条**入站 API 请求上（聊天、SSE、轮询），失败时 `GATEWAY_URL` 还是
 * 旧值、下一条请求会再试一次——不记一笔的话，一块满了的盘能让 journal 每秒刷几十行。
 * 只按「目标变了」重新出声。
 */
let lastFailed = ''

/**
 * 老布局：把新地址写回 `$SATUWORK_HOME/bot.env`（凭据还在那个文件里的那一代部署）。
 *
 * **写临时文件再 rename**：rename 在同一个文件系统上是原子的。就地改写的话，进程在
 * write 中途被 systemd 换掉，留下的是一个截断的 env 文件——那会同时丢掉
 * `GATEWAY_TOKEN` 和 `GATEWAY_API_KEY`，席位重启即变砖，比地址过期严重得多。
 *
 * 权限跟着 deploy-seat.sh 的 `chmod 600`：这个文件里有席位票和 API Key，而席位那个
 * Linux 用户在 noVNC 桌面里是能开终端的。
 */
function rewrite(file: string, next: string): void {
  const src = readFileSync(file, 'utf8')
  const line = `GATEWAY_URL=${next}`
  // 用函数形式的替换：字符串形式里 `$&` 之类有特殊含义，而这里要的是字面量。
  const out = /^GATEWAY_URL=.*$/m.test(src) ? src.replace(/^GATEWAY_URL=.*$/m, () => line) : `${line}\n${src}`
  const tmp = `${file}.tmp`
  writeFileSync(tmp, out, { mode: 0o600 })
  renameSync(tmp, file)
}

/** 席位上学到的新地址落在这里（不是 bot.env）。 */
const OVERRIDE_FILE = 'gateway-url'

/**
 * 部署写死的那个地址（进程启动时 `GATEWAY_URL` 的值，覆盖生效之前）。MAC 算在它和新地址
 * 两个值上：重新部署换了地址 → 旧覆盖的 base 对不上 → 作废，以部署的为准。
 */
let deployedUrl: string | null = null

function deployed(): string {
  if (deployedUrl === null) deployedUrl = norm(process.env.GATEWAY_URL || '')
  return deployedUrl
}

function macOf(base: string, url: string): string {
  const key = (process.env.GATEWAY_TOKEN || '').trim()
  return createHmac('sha256', key).update(`satuwork-gateway-url\n${base}\n${url}`).digest('hex')
}

function macMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function writeOverride(file: string, next: string): void {
  const base = deployed()
  const body = JSON.stringify({ url: next, base, mac: macOf(base, next) }) + '\n'
  const tmp = `${file}.tmp`
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, file)
}

/**
 * 启动时读一次 `$SATUWORK_HOME/gateway-url`，验过 MAC 才认。只在远程席位上做。
 *
 * 必须在凭据读进来之后调（MAC 的钥匙是席位票），也必须在任何消费者读 `GATEWAY_URL` 之前。
 * 返回最后生效的地址来源，给启动日志用。
 */
export function loadGatewayUrlOverride(log?: { info?: (s: string) => void; warn?: (s: string) => void }): 'override' | 'deployed' {
  if (!isSeatMode()) return 'deployed'
  const base = deployed()
  const file = satuworkHome(OVERRIDE_FILE)
  if (!existsSync(file)) return 'deployed'
  let rec: { url?: unknown; base?: unknown; mac?: unknown }
  try {
    rec = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    log?.warn?.(`gateway-url: ${file} 读不出来或不是 JSON，不认，按部署时的 ${base || '（空）'}`)
    return 'deployed'
  }
  let url: string
  try {
    url = originOf(String(rec.url ?? ''))
  } catch {
    log?.warn?.(`gateway-url: ${file} 里的地址形状不对，不认`)
    return 'deployed'
  }
  if (rec.base !== base) {
    // 重新部署换过地址——部署拿到的是 Gateway 当时亲口给的，比这份旧覆盖新。
    log?.info?.(`gateway-url: ${file} 是按旧部署地址 ${String(rec.base)} 学来的，现在部署的是 ${base}，作废`)
    return 'deployed'
  }
  if (!macMatches(rec.mac, macOf(base, url))) {
    // 票换过（重新部署），或者有人改过这个文件。两种都不能认——后者正是要防的：把地址指向
    // 自己的服务器，下一次调用就把席位票和 API Key 送过去。
    log?.warn?.(`gateway-url: ${file} 的校验对不上（票换过，或文件被改过），不认，按部署时的 ${base || '（空）'}`)
    return 'deployed'
  }
  process.env.GATEWAY_URL = url
  log?.info?.(`gateway-url: 按上次从 Gateway 学到的地址 ${url} 起（部署时是 ${base}）`)
  return 'override'
}

/**
 * 认一下新地址。**先落盘，再改内存。**
 *
 * 反过来的话，一次写不进去（盘满在这类机器上是真会发生的事）会留下最难查的那种状态：
 * 内存里已经是新地址、于是下一次调用因为「和现在的一样」提前返回，**再也不会有第二次
 * 尝试**；界面上看着好了，重启回来还是旧地址，席位又一次静默哑掉。
 *
 * 改内存就够让**当下**立刻生效：所有消费者（llm、catalog、web-search、session/gateway）
 * 都是每次现调 `gatewayUrl()` 读 `process.env`，没有谁在启动时把它读死。落盘管的是
 * 下一次重启——远程席位写 `gateway-url`（见文件头「落盘落在哪」），老布局写 `bot.env`。
 */
export function adoptGatewayUrl(raw: unknown, log?: { info?: (s: string) => void; warn?: (s: string) => void }): void {
  const given = String(raw ?? '').trim()
  if (!given) return
  let next: string
  try {
    next = originOf(given)
  } catch {
    return
  }
  const cur = norm(process.env.GATEWAY_URL || '')
  if (next === cur) return

  const seat = isSeatMode()
  const file = seat ? satuworkHome(OVERRIDE_FILE) : satuworkHome('bot.env')
  const where = seat ? OVERRIDE_FILE : 'bot.env'
  if (!seat && !existsSync(file)) {
    /**
     * 不是远程席位、也没有 bot.env——本地开发（`GATEWAY_URL` 来自 shell 或 .env）。
     *
     * **那就什么都不做，连内存也不改。** 改了内存却没地方落盘，得到的是「这次好了、
     * 重启又回去」的间歇故障，比一直不生效难查得多。本地开发也根本不需要这条路：
     * 地址是自己敲的。
     */
    if (lastFailed !== next) {
      lastFailed = next
      log?.warn?.(`gateway-url: Gateway 报的新地址是 ${next}，但这里没有 bot.env（本地开发？），不改`)
    }
    return
  }

  try {
    if (seat) writeOverride(file, next)
    else rewrite(file, next)
  } catch (e) {
    if (lastFailed !== next) {
      lastFailed = next
      log?.warn?.(
        `gateway-url: 收到新的 Gateway 地址 ${next}，但写不进 ${where}（${(e as Error).message}）。` +
          '这次不改，仍按旧地址；盘满或文件系统只读的话先处理那个。',
      )
    }
    return
  }
  process.env.GATEWAY_URL = next
  lastFailed = ''
  log?.info?.(`gateway-url: Gateway 换地址了，${cur || '（原先没配）'} → ${next}，已写回 ${where}`)
}

/** 测试用：把「上次没写成」和「部署时的地址」的记忆清掉。 */
export function resetAdoptState(): void {
  lastFailed = ''
  deployedUrl = null
}
