import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { managerHome } from './config.ts'
import { json } from './http.ts'
import { seat } from './seats.ts'
import { forwardHeaders, pipeUpstream } from './proxy.ts'
import { run } from './run.ts'

/**
 * 给本机工人（src/worker/index.ts）的中继口。**工人手上什么凭据都没有**，它要碰 Gateway 或
 * 碰本机 bot 都从这儿过，管家替它出示凭据、也替它划边界：
 *
 *   /w-local/gateway/worker/*        → `${gatewayUrl}/worker/*`，带 smt_。**只有 /worker/ 底下**：
 *                                       别的路径（部署、拉包、心跳）工人没有理由碰
 *   /w-local/seats/:seatId/bot/*     → 本机 bot，authorization 换成那个席位的 sat_
 *
 * 两道闸：只收回环地址来的连接；头上要带开机时随机出来的 `x-satuwork-worker`。令牌写在
 * worker.env 里（0640，属 satuwork-worker 组），工人单元靠 EnvironmentFile 读它。
 */

const RELAY_PREFIX = /^\/w-local\/(gateway\/worker(\/.*)?|seats\/([^/]+)\/bot(\/.*)?)$/

let workerToken = ''

/** 开机时生成（或读回）本机工人的令牌，并写出 worker.env。 */
export function ensureWorkerEnv(localPort: number, dryRun: boolean): void {
  const path = managerHome('worker.env')
  let token = ''
  if (existsSync(path)) {
    const m = /^SATUWORK_WORKER_TOKEN=(\S+)$/m.exec(readFileSync(path, 'utf8'))
    token = m?.[1] ?? ''
  }
  if (!token) token = 'swk_' + randomBytes(24).toString('base64url')
  workerToken = token
  mkdirSync(managerHome(), { recursive: true })
  writeFileSync(path, `SATUWORK_WORKER_TOKEN=${token}\nSATUWORK_MANAGER_LOCAL=http://127.0.0.1:${localPort}\n`, { mode: 0o640 })
  // 工人用户能读、别人不能：真机上把组交给它。没有这个用户（老安装脚本装的机器）就算了，
  // 工人本来也起不来，下一次装脚本会把用户和单元一起补上。
  if (!dryRun) void run('chown', ['root:satuwork-worker', path], { timeout: 5000 }).catch(() => {})
}

/** 测试要拿令牌去扮工人。 */
export function workerTokenForTest(): string {
  return workerToken
}

function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress || ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

function tokenOk(req: IncomingMessage): boolean {
  const given = String(req.headers['x-satuwork-worker'] || '')
  if (!workerToken || !given || given.length !== workerToken.length) return false
  let diff = 0
  for (let i = 0; i < workerToken.length; i++) diff |= given.charCodeAt(i) ^ workerToken.charCodeAt(i)
  return diff === 0
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export interface RelayDeps {
  machineToken: () => string
  gatewayUrl: () => string
}

export function relayIntercept(deps: RelayDeps) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const m = RELAY_PREFIX.exec(url.pathname)
    if (!m) return false
    if (!isLoopback(req) || !tokenOk(req)) {
      json(res, 401, { error: '不是本机工人' })
      return true
    }
    if (m[1].startsWith('gateway/')) {
      // 到 Gateway 的都是小 JSON（领活、续租、回报），收完再发；SSE 不走这条。
      const body = await readBody(req)
      const target = `${deps.gatewayUrl()}/worker${m[2] || ''}${url.search}`
      try {
        const r = await fetch(target, {
          method: req.method,
          headers: {
            authorization: `Bearer ${deps.machineToken()}`,
            accept: 'application/json',
            ...(body.length ? { 'content-type': String(req.headers['content-type'] || 'application/json') } : {}),
          },
          body: body.length ? new Uint8Array(body) : undefined,
          signal: AbortSignal.timeout(20_000),
        })
        res.writeHead(r.status, {
          'content-type': r.headers.get('content-type') || 'application/json',
          'cache-control': 'no-store',
        })
        if (r.body) await Readable.fromWeb(r.body as never).pipe(res)
        else res.end()
      } catch (e) {
        if (!res.headersSent) json(res, 502, { error: 'Gateway 够不着: ' + (e as Error).message })
        else res.end()
      }
      return true
    }
    const row = seat(m[3])
    if (!row) {
      json(res, 404, { error: '没有这个席位' })
      return true
    }
    if (!row.gatewayToken) {
      json(res, 409, { error: '席位还没登记席位票，重新部署后可用' })
      return true
    }
    const headers = forwardHeaders(req, row.botPort)
    delete headers['x-satuwork-worker']
    headers.authorization = `Bearer ${row.gatewayToken}`
    pipeUpstream(req, res, row.botPort, (m[4] || '/') + url.search, headers)
    return true
  }
}
