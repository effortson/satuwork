import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { bootConfig } from './config.ts'
import { sameToken } from './http.ts'
import { run, scheduleRestart } from './run.ts'
import { busy } from './seats.ts'

/**
 * 给管家地址配 https（协议 14）。
 *
 * 手工那一套写在 README「用 Caddy 给管家配 https」：装 Caddy、写 Caddyfile、确认外面通了、
 * 在 Gateway 上改两个地址、最后让管家只听回环。**顺序不能反**，反了机器当场失联。这里把机器
 * 上的那几步接过来，顺序交给 Gateway 编排——和时区、自升级同一条路：**心跳驱动、最终收敛**。
 * Gateway 在回包里带期望值 `https: { domain, loopbackOnly, nonce }`，管家照着做，下一轮心跳
 * 把做到哪一步报回去（httpsReport）。
 *
 * 分工：
 *
 * - `domain`：装 Caddy、写 Caddyfile、reload，然后**在本机**验一遍证书和反代都通了
 *   （curl --resolve 到 127.0.0.1，不绕公网——有的云上机器连不回自己的公网 IP，那不该算失败）。
 *   通了报 `ready`。从外面通不通由 Gateway 自己去敲，它才是那个「外面」。
 * - `nonce`：Gateway 从外面敲 `https://<域名>/ingress-check?nonce=…`，对上了才认定「这个域名后面
 *   就是这台管家」。**不带机器票去试**：域名是人手填的，敲错一个字母就落到别人的服务器上。
 * - `loopbackOnly`：Gateway 确认从外面经域名连得上、两个地址都换过去之后才会给 true。管家写
 *   drop-in、重启自己，只听 127.0.0.1；给 false（撤回）就删掉自己写的那份 drop-in、再重启回来。
 *
 * **回包里没有 `https` 就什么都不做。** 老 Gateway、从没配过域名的机器、手工配过 Caddy 的机器
 * 都是这样，不能把「没说」理解成「拆掉」。
 */

export interface HttpsWant {
  domain: string | null
  loopbackOnly: boolean
  nonce: string | null
}

export const CADDYFILE = '/etc/caddy/Caddyfile'
const DROPIN_DIR = '/etc/systemd/system/satuwork-manager.service.d'
/** 和 README 里手工那份同名：两条路配出来的是同一个文件，不会叠出两份互相打架的 drop-in。 */
const DROPIN = `${DROPIN_DIR}/listen-local.conf`
/** 这两个文件里的第一行。认得出是自己写的，才敢改、才敢删。 */
const MARK = '# satuwork-manager 写的文件。改域名请到 Gateway 的机器页，手改会被下一次心跳覆盖。'

/** 本机自检最多等多久。证书第一次申请要走一趟 ACME，一两分钟很正常。 */
const SELF_CHECK_MS = 5 * 60_000
const SELF_CHECK_EVERY_MS = 10_000

type Phase = 'idle' | 'working' | 'ready' | 'error'

let phase: Phase = 'idle'
/** 当前这个 phase 说的是哪个域名。期望换了域名，旧的 ready 就不作数。 */
let phaseDomain = ''
let lastError = ''
let working = false
let nonce = ''
/** 已经发出重启了，等它生效：别每轮心跳再发一次。 */
let restarting = false
/** dryRun 下不碰 systemd，用它假装「现在只听回环」。 */
let fakeLoopback = false

const log = (s: string) => console.log('satuwork-manager: ' + s)
const warn = (s: string) => console.error('satuwork-manager: ' + s)

/**
 * 域名的形状。**这个值会被原样写进 Caddyfile**，所以只收最老实的那种写法：小写字母数字和
 * 连字符、至少两段、顶级域以字母开头（这就把 IP 挡掉了——Caddy 给 IP 申请不到公网证书）。
 * 空白、花括号、换行一个都进不来，也就插不进第二个站点块。Gateway 那边同一套口径再校一遍。
 */
export function domainOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const d = raw.trim().toLowerCase()
  if (d.length < 4 || d.length > 253) return null
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(d)) return null
  return d
}

/** 心跳回包里的 `https` → 期望值。认不出来的一律当没说（null），不猜。 */
export function httpsWantOf(raw: unknown): HttpsWant | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const domain = r.domain == null ? null : domainOf(r.domain)
  if (r.domain != null && !domain) return null
  const n = typeof r.nonce === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(r.nonce) ? r.nonce : null
  return { domain, loopbackOnly: r.loopbackOnly === true, nonce: n }
}

/** 管家现在是不是只听回环。看的是**这个进程起来时**的监听地址，不是 drop-in 写没写。 */
function loopbackNow(): boolean {
  return bootConfig().dryRun ? fakeLoopback : bootConfig().host === '127.0.0.1'
}

/** 搭心跳报上去的那一份。Gateway 按它推进下一步，界面按它说「卡在哪」。 */
export function httpsReport() {
  return {
    domain: phaseDomain || null,
    phase,
    error: lastError || null,
    loopbackOnly: loopbackNow(),
    // 这个 phase 是为哪一次下发做的。Gateway 只认和自己手上 nonce 对得上的那一份：重试那一刻
    // 心跳里报的还是上一次的 error，不带这个就分不出新旧，重试会被旧错当场判死。
    nonce: triedNonce || null,
  }
}

/** Gateway 从外面敲的那条：nonce 对上就 200，别的一律 404（不说为什么）。 */
export function ingressCheck(given: string): boolean {
  return Boolean(nonce) && sameToken(given, nonce)
}

/**
 * 心跳回包里的期望值。**不等装完就返回**：apt 装 Caddy 加上等证书，几分钟是常事，心跳那一轮
 * 不能被它拖住（后面还排着时区、升级）。
 */
export async function maybeHttps(raw: unknown): Promise<void> {
  const want = httpsWantOf(raw)
  if (!want) return
  if (want.nonce) nonce = want.nonce
  if (want.domain && !working) {
    const fresh = (want.nonce ?? '') !== triedNonce
    if (phase === 'ready' && phaseDomain === want.domain) {
      // 同一个域名已经配好了，换了 nonce 只是 Gateway 那边重新开了一次：配置还是那份，把 ready
      // 改记到新 nonce 名下就行，不必重装重验。
      if (fresh) triedNonce = want.nonce ?? ''
    } else if (phaseDomain !== want.domain || phase === 'idle' || fresh) {
      // 换了域名、刚起来、或者上一次失败后 Gateway 换了 nonce 重新下发：重新来一遍。同一个 nonce
      // 失败了不自动重试——同一个错（备案、安全组）每 30 秒撞一次只会把 Let's Encrypt 的频率
      // 限制撞满。要重试由界面再按一次（换一个 nonce）。
      working = true
      triedNonce = want.nonce ?? ''
      void configure(want.domain).finally(() => {
        working = false
      })
    }
  }
  await converge(want)
}

/** 上一次动手时 Gateway 给的 nonce。失败之后同一个 nonce 不重试；Gateway 重新下发会换一个新的。 */
let triedNonce = ''

async function configure(domain: string): Promise<void> {
  phase = 'working'
  phaseDomain = domain
  lastError = ''
  if (bootConfig().dryRun) {
    phase = 'ready'
    log(`https（dryRun）：${domain} 当作已配好`)
    return
  }
  try {
    log(`https：开始给 ${domain} 配 Caddy`)
    await ensureCaddy()
    const changed = await writeCaddyfile(domain, bootConfig().port)
    await run('systemctl', ['enable', 'caddy'], { timeout: 30_000 })
    const active = (await run('systemctl', ['is-active', 'caddy'], { timeout: 10_000 })).code === 0
    if (changed || !active) {
      const r = await run('systemctl', [active ? 'reload' : 'restart', 'caddy'], { timeout: 60_000 })
      if (r.code !== 0) throw new Error(`Caddy 起不来：${tail(r.stderr || r.stdout)}${await caddyHint()}`)
    }
    await selfCheck(domain)
    phase = 'ready'
    log(`https：${domain} 本机自检通过（证书已到、反代到管家）`)
  } catch (e) {
    phase = 'error'
    lastError = (e instanceof Error ? e.message : String(e)).slice(0, 500)
    warn('https 没配上：' + lastError)
  }
}

async function ensureCaddy(): Promise<void> {
  if ((await run('sh', ['-c', 'command -v caddy'], { timeout: 10_000 })).code === 0) return
  const env = { DEBIAN_FRONTEND: 'noninteractive' }
  let r = await run('apt-get', ['install', '-y', 'caddy'], { env, timeout: 10 * 60_000 })
  if (r.code !== 0) {
    // 索引可能早就过期（老机器），刷一次再试。和 deploy-seat.sh 里装包同一个套路。
    await run('apt-get', ['update', '-y'], { env, timeout: 10 * 60_000 })
    r = await run('apt-get', ['install', '-y', 'caddy'], { env, timeout: 10 * 60_000 })
  }
  if (r.code !== 0) {
    throw new Error(`apt 装不上 caddy（Debian 12 起官方源里才有这个包）：${tail(r.stderr || r.stdout)}`)
  }
}

/**
 * 这份 Caddyfile 能不能由管家来写：不存在、Debian 装包自带的那份默认站点、或者本来就是
 * 管家写的。**别人手写的一律不碰**——那上面可能还挂着别的站点，整份覆盖掉等于替人删配置。
 */
export function caddyfileIsOurs(text: string): boolean {
  if (text.startsWith(MARK)) return true
  const bare = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('')
    .replace(/\s+/g, '')
  return bare === '' || bare === ':80{root*/usr/share/caddyfile_server}'
}

/** 和 README「用 Caddy 给管家配 https」那份同一个内容，注释见那里。 */
export function caddyfileFor(domain: string, port: number): string {
  return `${MARK}
${domain} {
	# 本机进程专用：/llm/* 是 Bot 调模型，/w-local/* 是席位工人的中继口。外面的人不该碰到。
	@local_only path /llm/* /w-local/*
	respond @local_only 404

	reverse_proxy 127.0.0.1:${port} {
		# SSE 立即冲出去；Caddy 对 text/event-stream 本来就这样，写上是保险。
		flush_interval -1
		# 不设超时：首次部署席位要十几分钟，SSE 和桌面的 WebSocket 都是长连接。
		transport http {
			read_timeout 0
			write_timeout 0
		}
	}
}
`
}

/**
 * 写 Caddyfile。返回是否真的改了（没改就不必 reload）。
 *
 * **先校验临时文件，过了才换上去。** 反过来的话，一份校验不过的配置（比如 apt 源里的 Caddy 太老、
 * 不认某个指令）会留在 /etc/caddy 里：这一次报了错，下次机器重启 caddy.service 就起不来，连带
 * 它原来在服务的东西一起没了。
 */
async function writeCaddyfile(domain: string, port: number): Promise<boolean> {
  const want = caddyfileFor(domain, port)
  let cur = ''
  try {
    cur = readFileSync(CADDYFILE, 'utf8')
  } catch {
    /* 没有这个文件：装包没带，或者被删了。照写。 */
  }
  if (cur === want) return false
  if (cur && !caddyfileIsOurs(cur)) {
    throw new Error(`${CADDYFILE} 是别人手写的，管家不覆盖。要交给管家管，先把它挪走（比如改名成 Caddyfile.bak）再到机器页重试`)
  }
  mkdirSync('/etc/caddy', { recursive: true })
  const tmp = `${CADDYFILE}.satuwork.tmp`
  writeFileSync(tmp, want)
  const valid = await run('caddy', ['validate', '--config', tmp, '--adapter', 'caddyfile'], { timeout: 60_000 })
  if (valid.code !== 0) {
    rmSync(tmp, { force: true })
    throw new Error(`Caddyfile 校验没过，原来的配置没动：${tail(valid.stderr || valid.stdout)}`)
  }
  renameSync(tmp, CADDYFILE)
  return true
}

/**
 * 本机验一遍：证书拿到了、Caddy 把请求转给了管家。管家的 `/health` 没票是 401，所以 401 就是
 * 「整条链都通了」。拿不到证书时 TLS 握手直接失败（curl 非零退出），一直等到超时。
 */
async function selfCheck(domain: string): Promise<void> {
  const until = Date.now() + SELF_CHECK_MS
  let last = ''
  while (Date.now() < until) {
    const r = await run(
      'curl',
      ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', '--resolve', `${domain}:443:127.0.0.1`, `https://${domain}/health`],
      { timeout: 20_000 },
    )
    if (r.code === 0 && r.stdout.trim() === '401') return
    last = r.code === 0 ? `管家这边回的是 ${r.stdout.trim()}` : tail(r.stderr || r.stdout)
    await new Promise((res) => setTimeout(res, SELF_CHECK_EVERY_MS))
  }
  throw new Error(`${SELF_CHECK_MS / 60_000} 分钟内 ${domain} 的 https 在本机都没通（${last}）。${await caddyHint()}`)
}

/**
 * Caddy 自己最近说了什么。证书拿不到的真正原因（80/443 没放行、域名没解析过来、没备案被拦）
 * 都写在它的 journal 里，管家这边只看得到「握手失败」。
 */
async function caddyHint(): Promise<string> {
  const r = await run('journalctl', ['-u', 'caddy', '-n', '40', '--no-pager', '-o', 'cat'], { timeout: 10_000 })
  const errLine = r.stdout
    .split('\n')
    .filter((l) => /"level":"error"|error/i.test(l))
    .pop()
  const base = '常见原因：域名没解析到这台机器、安全组没放行 80/443、国内机房的域名没备案。'
  return errLine ? `${base}Caddy 最近一条错误：${errLine.slice(-300)}` : base
}

/**
 * 让「只听回环」和期望对上。
 *
 * 收紧（true）要满足两件事才动手：本机 https 已经 ready（Gateway 那边出了错也别把一台没有 https
 * 的机器关在门外），以及没有席位在部署（重启要等部署跑完，那会把这一轮心跳之后的事拖住十几分钟）。
 * 放开（false）只删**自己写的** drop-in：README 手工配的那份不带记号，不是这条路该管的。
 */
async function converge(want: HttpsWant): Promise<void> {
  if (restarting) return
  const dry = bootConfig().dryRun
  if (want.loopbackOnly) {
    if (loopbackNow()) return
    if (!(phase === 'ready' && phaseDomain === want.domain)) return
    if (busy()) return
    if (dry) {
      fakeLoopback = true
      log('https（dryRun）：当作已改成只听回环')
      return
    }
    try {
      mkdirSync(DROPIN_DIR, { recursive: true })
      writeFileSync(DROPIN, `${MARK}\n[Service]\nEnvironment=SATUWORK_MANAGER_HOST=127.0.0.1\n`)
      await restartSelf('改成只听 127.0.0.1')
    } catch (e) {
      lastError = `改成只听回环失败：${e instanceof Error ? e.message : String(e)}`.slice(0, 500)
      warn(lastError)
    }
    return
  }
  if (dry) {
    if (fakeLoopback) log('https（dryRun）：当作已撤回只听回环')
    fakeLoopback = false
    return
  }
  let cur = ''
  try {
    cur = readFileSync(DROPIN, 'utf8')
  } catch {
    return
  }
  if (!cur.startsWith(MARK)) return
  try {
    rmSync(DROPIN, { force: true })
    await restartSelf('撤回只听回环，重新对外听')
  } catch (e) {
    lastError = `撤回只听回环失败：${e instanceof Error ? e.message : String(e)}`.slice(0, 500)
    warn(lastError)
  }
}

/**
 * daemon-reload 让 drop-in 生效，再从**分离的**瞬态单元里重启自己（理由同 upgrade.ts：管家的
 * 子进程去 systemctl restart 会连自己一起被杀，命令发不出去；做法见 run.ts 的 scheduleRestart）。只重启管家：工人连的是
 * 127.0.0.1，监听地址怎么改都碰不到它。
 */
async function restartSelf(why: string): Promise<void> {
  const reload = await run('systemctl', ['daemon-reload'], { timeout: 30_000 })
  if (reload.code !== 0) throw new Error(`daemon-reload 失败：${tail(reload.stderr || reload.stdout)}`)
  const r = await scheduleRestart('satuwork-manager-relisten', ['satuwork-manager.service'])
  if (r.code !== 0) throw new Error(`systemd-run 发不出重启（${r.code}）：${tail(r.stderr || r.stdout)}`)
  restarting = true
  log(`https：${why}，2 秒后重启管家`)
}

function tail(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(-300)
}
