/**
 * `pnpm dev` 的外壳：起 Gateway，顺带起本地开发用的桌面转发。
 *
 * **没配 `SATUWORK_DESK_PROXY` 就什么都不多做**，行为和以前那条 `node --import tsx --watch
 * src/index.ts` 一模一样——这件事只有「Gateway 在本机、席位机器在另一个 IP 上」的人需要，
 * 不该让别人每次 dev 都多一个连不上的进程。
 *
 * 转发为什么存在见 scripts/desk-proxy.mjs 开头。**它跟着 Gateway 的生死走**：手动起的那种
 * 迟早会剩在后台，而下一次改了目标机器之后，那个旧的还占着端口——排查起来是「桌面时好
 * 时坏」，比黑屏难查得多。
 */
import { spawn } from 'node:child_process'
import { parseDeskProxy, startDeskProxyAuto } from './desk-proxy.mjs'

const raw = process.env.SATUWORK_DESK_PROXY || ''
const cfg = parseDeskProxy(raw)
if (raw && !cfg) {
  console.warn(`desk-proxy: SATUWORK_DESK_PROXY=${raw} 看不懂，要的是 [监听端口:]<管家主机>:<管家端口>`)
}
// 给了证书就 TLS 终结（跑的是和生产一样的 https 那条路），否则纯 TCP 转发——两种桌面壳都能看。
const tls = { cert: process.env.SATUWORK_DESK_PROXY_CERT || '', key: process.env.SATUWORK_DESK_PROXY_KEY || '' }
if (cfg && ((tls.cert && !tls.key) || (!tls.cert && tls.key))) {
  console.warn('desk-proxy: SATUWORK_DESK_PROXY_CERT 与 SATUWORK_DESK_PROXY_KEY 要一起给，这次按纯 TCP 起')
}
const closeProxy = cfg ? startDeskProxyAuto(cfg, tls) : null

// Gateway 自己仍然带 --env-file-if-exists：这一层读到的 .env 不会自动传给它。
const child = spawn(
  process.execPath,
  ['--env-file-if-exists=.env', '--import', 'tsx', '--watch', 'src/index.ts'],
  { stdio: 'inherit' },
)

let closing = false
function shutdown(sig) {
  if (closing) return
  closing = true
  closeProxy?.()
  // 信号转给子进程，让 --watch 自己收场；它退出时下面那个 close 会带着我们一起走。
  child.kill(sig)
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig))

child.on('close', (code, signal) => {
  closeProxy?.()
  // 被信号杀掉时 code 是 null。照 shell 的规矩换算成 128+n，免得 CI 把它当成功。
  process.exit(signal ? 128 + (typeof signal === 'string' ? (signal === 'SIGINT' ? 2 : 15) : 0) : (code ?? 0))
})
