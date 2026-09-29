/**
 * 席位从入站请求上学「Gateway 现在在哪」。纯函数，不起服务——探针要 tsx 才 import 得了 .ts。
 *
 * 钉的是四件错了都不当场报错的事：
 * 1. 改写 bot.env 时把别的行弄丢了 —— 那个文件里有 GATEWAY_TOKEN 和 GATEWAY_API_KEY，
 *    丢了就是席位重启即变砖，比地址过期严重得多。
 * 2. 写不进去却改了内存 —— 这次好了、重启又回去，间歇故障最难查。
 * 3. 本地开发（没有 bot.env）被顺手改掉内存 —— 同上。
 * 4. 什么都往里塞：带路径的、file:// 的、垃圾串。
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { adoptGatewayUrl, loadGatewayUrlOverride, resetAdoptState } from './src/gateway-url.ts'
import { setSeatModeForTest } from './src/seat-secrets.ts'

const OLD = 'http://192.168.5.59:3080'
const NEW = 'http://192.168.5.40:3080'

/** 一份和 deploy-seat.sh 写出来的形状一样的 bot.env。 */
const ENV_BODY = [
  `GATEWAY_URL=${OLD}`,
  'GATEWAY_TOKEN=sat_seat-token-never-lose-me',
  'GATEWAY_API_KEY=sk_sw_key-never-lose-me',
  'SATUWORK_BOT_ID=b-1',
  'SATUWORK_CDP_PORT=9222',
  'HOME=/home/sw-1',
  '',
].join('\n')

/** 每个用例一个干净的 SATUWORK_HOME。`withEnv` 决定要不要在里面放 bot.env。 */
// 每个用例一个目录，退出时一起收掉（和 e2e-memory 那几个探针同一个写法）。
const homes = []
process.on('exit', () => {
  for (const h of homes) try { rmSync(h, { recursive: true, force: true }) } catch {}
})
function seat({ withEnv = true, asDir = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'satu-gwurl-'))
  homes.push(home)
  process.env.SATUWORK_HOME = home
  process.env.GATEWAY_URL = OLD
  resetAdoptState()
  const file = join(home, 'bot.env')
  // bot.env 做成目录：readFileSync 会 EISDIR，而这跟跑在谁名下无关——用 chmod 造
  // 失败的话，root 身份下（CI 的某些容器）压根不会失败，断言就成了假通过。
  if (asDir) mkdirSync(file)
  else if (withEnv) writeFileSync(file, ENV_BODY, { mode: 0o600 })
  return { home, file }
}

const out = {}
const logs = []
const log = { info: (s) => logs.push(s), warn: (s) => logs.push(s) }

// 1. 正常改写：地址换了，别的行一个字都不能动
{
  const { file } = seat()
  adoptGatewayUrl(NEW, log)
  const body = readFileSync(file, 'utf8')
  out.rewrite = {
    memory: process.env.GATEWAY_URL,
    lineChanged: body.includes(`GATEWAY_URL=${NEW}`),
    oldGone: !body.includes(OLD),
    keptToken: body.includes('GATEWAY_TOKEN=sat_seat-token-never-lose-me'),
    keptApiKey: body.includes('GATEWAY_API_KEY=sk_sw_key-never-lose-me'),
    keptRest: body.includes('SATUWORK_CDP_PORT=9222') && body.includes('HOME=/home/sw-1'),
    lines: body.trim().split('\n').length,
    // 里头有票和 key，权限不能在改写之后放宽（deploy-seat.sh 是 600）
    mode: (statSync(file).mode & 0o777).toString(8),
    // 临时文件不许留下——它和 bot.env 内容一样，权限却可能被人忽略
    noTmp: (() => {
      try {
        statSync(`${file}.tmp`)
        return false
      } catch {
        return true
      }
    })(),
  }
}

// 2. 地址没变：不写盘（用 mtime 认）
{
  const { file } = seat()
  const before = statSync(file).mtimeMs
  adoptGatewayUrl(OLD, log)
  adoptGatewayUrl(`${OLD}/`, log) // 尾斜杠算同一个
  out.same = { untouched: statSync(file).mtimeMs === before, memory: process.env.GATEWAY_URL }
}

// 3. 写不进去：**内存绝不能改**
{
  seat({ asDir: true })
  adoptGatewayUrl(NEW, log)
  out.unwritable = { memory: process.env.GATEWAY_URL, said: logs.some((l) => l.includes('写不进')) }
}

// 4. 本地开发（没有 bot.env）：内存也不改
{
  seat({ withEnv: false })
  adoptGatewayUrl(NEW, log)
  out.noFile = { memory: process.env.GATEWAY_URL, said: logs.some((l) => l.includes('没有 bot.env')) }
}

// 5. 垃圾一律不认
{
  const bad = ['', '   ', 'not a url', 'file:///etc/passwd', 'ftp://x', 'http://a/b/c', 'http://a?x=1', 'http://u:p@a']
  const kept = []
  for (const raw of bad) {
    seat()
    adoptGatewayUrl(raw, log)
    kept.push(process.env.GATEWAY_URL === OLD)
  }
  out.junk = { allRejected: kept.every(Boolean), n: bad.length }
}

// 6. bot.env 里压根没有 GATEWAY_URL 那一行：补一行，别把文件改没
{
  const { file } = seat({ withEnv: false })
  writeFileSync(file, 'GATEWAY_TOKEN=sat_x\nHOME=/home/sw-1\n', { mode: 0o600 })
  process.env.GATEWAY_URL = ''
  resetAdoptState()
  adoptGatewayUrl(NEW, log)
  const body = readFileSync(file, 'utf8')
  out.missingLine = {
    added: body.includes(`GATEWAY_URL=${NEW}`),
    keptToken: body.includes('GATEWAY_TOKEN=sat_x'),
    memory: process.env.GATEWAY_URL,
  }
}

// ── 远程席位（凭据从 fd 0 读到）：bot.env 在 root 的目录里，新地址写 gateway-url ──
// 那份文件席位用户（terminal 里的任何子进程）也写得动，所以带着席位票做的 HMAC，启动时
// 验过才认——不然改一行就能让 bot 下次重启把票送到别人的服务器上。
setSeatModeForTest(true)
process.env.GATEWAY_TOKEN = 'sat_seat-token-for-mac'

/** 模拟一次重启：清掉「部署时的地址」的记忆，内存回到 bot.env 写的那个。 */
function restart(deployedUrl = OLD) {
  resetAdoptState()
  process.env.GATEWAY_URL = deployedUrl
}

// 7. 学到新地址：写 gateway-url，不碰（也不需要有）bot.env；重启回来按它起
{
  const { home } = seat({ withEnv: false })
  adoptGatewayUrl(NEW, log)
  const file = join(home, 'gateway-url')
  let rec = null
  try {
    rec = JSON.parse(readFileSync(file, 'utf8'))
  } catch {}
  const mode = rec ? (statSync(file).mode & 0o777).toString(8) : ''
  const memory = process.env.GATEWAY_URL
  restart()
  const src = loadGatewayUrlOverride(log)
  out.seatAdopt = {
    memory,
    wrote: rec?.url === NEW && rec?.base === OLD && typeof rec?.mac === 'string',
    hasToken: readFileSync(file, 'utf8').includes('sat_'),
    mode,
    noBotEnv: (() => {
      try {
        statSync(join(home, 'bot.env'))
        return false
      } catch {
        return true
      }
    })(),
    afterRestart: process.env.GATEWAY_URL,
    src,
  }
}

// 8. 子进程改了地址（没有票，算不出 MAC）：重启时不认
{
  const { home } = seat({ withEnv: false })
  adoptGatewayUrl(NEW, log)
  const file = join(home, 'gateway-url')
  const rec = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...rec, url: 'http://evil.example:3080' }))
  restart()
  logs.length = 0
  const src = loadGatewayUrlOverride(log)
  out.seatTampered = { memory: process.env.GATEWAY_URL, src, said: logs.some((l) => l.includes('校验对不上')) }
}

// 9. 重新部署换了地址：旧覆盖的 base 对不上，以部署的为准
{
  seat({ withEnv: false })
  adoptGatewayUrl(NEW, log)
  const REDEPLOYED = 'http://192.168.5.77:3080'
  restart(REDEPLOYED)
  const src = loadGatewayUrlOverride(log)
  out.seatRedeployed = { memory: process.env.GATEWAY_URL, src, expect: REDEPLOYED }
}

// 10. 票换过（重新部署发了新票）：旧 MAC 作废
{
  seat({ withEnv: false })
  adoptGatewayUrl(NEW, log)
  process.env.GATEWAY_TOKEN = 'sat_rotated'
  restart()
  const src = loadGatewayUrlOverride(log)
  out.seatRotated = { memory: process.env.GATEWAY_URL, src }
  process.env.GATEWAY_TOKEN = 'sat_seat-token-for-mac'
}

// 11. 远程席位写不进 gateway-url：内存照样不改
{
  const { home } = seat({ withEnv: false })
  mkdirSync(join(home, 'gateway-url'))
  logs.length = 0
  adoptGatewayUrl(NEW, log)
  out.seatUnwritable = { memory: process.env.GATEWAY_URL, said: logs.some((l) => l.includes('写不进 gateway-url')) }
}

// 12. 不是远程席位：启动时根本不读 gateway-url（本地 bot 的 SATUWORK_HOME 里放着一份也不认）
{
  const { home } = seat({ withEnv: false })
  adoptGatewayUrl(NEW, log)
  setSeatModeForTest(false)
  restart()
  const src = loadGatewayUrlOverride(log)
  out.localIgnores = { memory: process.env.GATEWAY_URL, src, fileThere: statSync(join(home, 'gateway-url')).isFile() }
}

// 13. https 部署的席位，头里报来一个明文 http 地址：不认（不落盘、不改内存）；换成 https 照认；
//     明知有风险的开关打开也照认。
{
  setSeatModeForTest(true)
  const HTTPS = 'https://gw.example.com'
  const { home } = seat({ withEnv: false })
  restart(HTTPS)
  logs.length = 0
  adoptGatewayUrl(NEW, log)
  const refused = {
    memory: process.env.GATEWAY_URL,
    fileThere: (() => { try { statSync(join(home, 'gateway-url')); return true } catch { return false } })(),
    said: logs.some((l) => l.includes('明文 http')),
  }
  adoptGatewayUrl('https://gw2.example.com', log)
  const httpsOk = process.env.GATEWAY_URL
  restart(HTTPS)
  process.env.SATUWORK_ALLOW_INSECURE_GATEWAY = '1'
  adoptGatewayUrl(NEW, log)
  const optIn = process.env.GATEWAY_URL
  delete process.env.SATUWORK_ALLOW_INSECURE_GATEWAY
  // 覆盖文件里被塞进一个 http 地址（MAC 就算对得上也不认）：启动时按部署的 https 起
  restart(HTTPS)
  process.env.SATUWORK_ALLOW_INSECURE_GATEWAY = '1'
  adoptGatewayUrl(NEW, log)
  delete process.env.SATUWORK_ALLOW_INSECURE_GATEWAY
  restart(HTTPS)
  const src = loadGatewayUrlOverride(log)
  out.noDowngrade = { refused, httpsOk, optIn, reload: { memory: process.env.GATEWAY_URL, src } }
}

console.log('__RESULT__' + JSON.stringify(out))
