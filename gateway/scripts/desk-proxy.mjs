/**
 * 本地开发用的桌面转发：把本机的一个端口转给席位机器的管家。
 *
 * **为什么需要它。** 桌面是内嵌 iframe，管家给的那张 cookie 在非 https 下只能是
 * `SameSite=Lax`（见 manager/src/proxy.ts 的 sameSite），而浏览器不会把 Lax cookie 带进
 * **跨站**子框——于是 noVNC 的静态资源和那条 WebSocket 全部 401，界面上是一块黑屏，
 * 控制台之外没有任何线索。生产上这件事由「directUrl 和 Gateway 同一个可注册域」解决
 * （docs/gateway-runtime.md §7 的第三个前提），本地开发没有域名，Gateway 在
 * `192.168.64.1:3080`、管家在 `192.168.64.6:8443`，两个裸 IP 之间没有共同的注册域，
 * 怎么配都是跨站。
 *
 * 两种模式，按有没有给证书分：
 *
 * · **纯 TCP（默认）**：把管家借到 Gateway 同一个 IP 上。**端口不算 site 的一部分**，
 *   所以父页和 iframe 同站，Lax 放行。`directUrl` 填 `http://<Gateway 那个 IP>:<监听端口>`。
 *   够浏览器版用，**桌面壳（satu://localhost）用不上**——那个源和任何 IP 都跨站。
 * · **TLS 终结（给了证书）**：自己收 https，解密后把明文转给管家，并补上
 *   `x-forwarded-proto: https`——管家就是看这个头决定发不发 `SameSite=None; Secure` 的。
 *   跨站也带得上 cookie，所以桌面壳那条路只有这一种走得通，而且跑的是和生产一样的路径。
 *   `directUrl` 填 `https://<监听地址>:<监听端口>`，证书得是浏览器信得过的（mkcert）。
 *
 * 单独跑：`node scripts/desk-proxy.mjs 192.168.64.6:8443`
 * 跟着 dev 一起跑：`.env` 里写 `SATUWORK_DESK_PROXY=192.168.64.6:8443`，要 TLS 再加
 * `SATUWORK_DESK_PROXY_CERT` / `SATUWORK_DESK_PROXY_KEY`（见 scripts/dev.mjs）
 */
import { createServer, connect } from 'node:net'
import { createServer as createTlsServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'

/**
 * `[监听端口:]目标主机:目标端口`。
 *
 * 监听端口默认跟目标端口一样——桌面地址和管家地址于是只差一个 IP，排查时少一件要记的事。
 */
export function parseDeskProxy(raw) {
  const text = (raw || '').trim()
  if (!text) return null
  const parts = text.split(':')
  if (parts.length === 2) {
    const [host, port] = parts
    const n = Number(port)
    if (!host || !Number.isInteger(n) || n < 1 || n > 65535) return null
    return { listenPort: n, targetHost: host, targetPort: n }
  }
  if (parts.length === 3) {
    const [listen, host, port] = parts
    const l = Number(listen)
    const n = Number(port)
    if (!host || !Number.isInteger(l) || !Number.isInteger(n) || l < 1 || l > 65535 || n < 1 || n > 65535) return null
    return { listenPort: l, targetHost: host, targetPort: n }
  }
  return null
}

/**
 * 起转发。**永远不抛**——它是开发时的便利，不该把 Gateway 一起带走：端口被占、虚机没开，
 * 都只是一句话加一个「桌面用不了」，Gateway 照常起。
 *
 * 返回 close()，调用方退出时收掉。
 */
export function startDeskProxy(cfg, log = console) {
  const { listenPort, targetHost, targetPort } = cfg
  const sockets = new Set()

  const server = createServer((client) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    // 一头断了另一头也没意义了。destroy 而不是 end：VNC 那条流两个方向都是长连接，
    // 半开着只会让 noVNC 干等到超时。
    const upstream = connect(targetPort, targetHost)
    sockets.add(upstream)
    upstream.on('close', () => sockets.delete(upstream))
    client.pipe(upstream)
    upstream.pipe(client)
    client.on('error', () => upstream.destroy())
    upstream.on('error', (e) => {
      log.warn?.(`desk-proxy: 连不上 ${targetHost}:${targetPort}（${e.message}）`)
      client.destroy()
    })
  })

  server.on('error', (e) => {
    log.warn?.(
      e.code === 'EADDRINUSE'
        ? `desk-proxy: ${listenPort} 已经被占着，这一路不起了（桌面会是黑屏；另一个转发还在跑的话就不用管）`
        : `desk-proxy: 起不来——${e.message}`,
    )
  })

  server.listen(listenPort, '0.0.0.0', () => {
    log.log?.(`desk-proxy: 0.0.0.0:${listenPort} -> ${targetHost}:${targetPort}（桌面直连地址填 http://<本机 IP>:${listenPort}）`)
  })

  return () => {
    for (const s of sockets) s.destroy()
    sockets.clear()
    server.close()
  }
}

/**
 * TLS 终结版：自己收 https，把明文转给管家。
 *
 * **只为一个头存在**：`x-forwarded-proto: https`。管家按它决定桌面那张 cookie 是
 * `SameSite=None; Secure` 还是 `Lax`（manager/src/proxy.ts），而只有前者才进得了跨站
 * 子框——桌面壳的页面源是 `satu://localhost`，和席位机器永远跨站，同站那招救不了它。
 *
 * 这一版必须解析 HTTP（要改头），所以 WebSocket 得自己接 `upgrade` 再手工搭桥：
 * 桌面的像素全走那条，漏了它就是「落地页打得开、屏幕不动」。
 */
export function startDeskTlsProxy(cfg, tls, log = console) {
  const { listenPort, targetHost, targetPort } = cfg
  const sockets = new Set()
  let creds
  try {
    creds = { cert: readFileSync(tls.cert), key: readFileSync(tls.key) }
  } catch (e) {
    log.warn?.(`desk-proxy: 证书读不到（${e.message}），TLS 这一路不起了`)
    return () => {}
  }

  const server = createTlsServer(creds, (req, res) => {
    const upstream = httpRequest(
      {
        host: targetHost,
        port: targetPort,
        method: req.method,
        path: req.url,
        // 原样带过去，只补两个转发头。**host 不能改**：管家反代到 noVNC 时自己会摘。
        headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host ?? '' },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on('error', (e) => {
      log.warn?.(`desk-proxy: 连不上 ${targetHost}:${targetPort}（${e.message}）`)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('desk-proxy: 上游连不上')
    })
    /**
     * **进来的这两头也要接 'error'。** 浏览器在传 body 或读响应的半路断开（关掉桌面
     * 预览、切走页面、网络抖一下）时 req / res 会 emit 'error'，而 EventEmitter 的
     * 'error' 没人听就是未捕获异常——这段代码跑在 scripts/dev.mjs 那个进程里，它同时
     * 是 Gateway `--watch` 的父进程，于是一次寻常的断开会把整个 pnpm dev 带走。
     */
    req.on('error', () => upstream.destroy())
    res.on('error', () => upstream.destroy())
    req.pipe(upstream)
  })

  server.on('upgrade', (req, socket, head) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    // 同上，而且**要在握手之前就挂**：下面那对 error 监听是 'upgrade' 回调里才加的，
    // 在上游回 101 之前这条 socket 一直裸着，客户端这时断开就是一次未捕获异常。
    socket.on('error', () => socket.destroy())
    const upstream = httpRequest({
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host ?? '' },
    })
    upstream.on('upgrade', (up, upSocket, upHead) => {
      sockets.add(upSocket)
      upSocket.on('close', () => sockets.delete(upSocket))
      // 101 的响应行和头要自己写回去——这一层已经不是字节流了。
      const head101 = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`]
      for (const [k, v] of Object.entries(up.headers)) head101.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      socket.write(head101.join('\r\n') + '\r\n\r\n')
      if (upHead?.length) socket.write(upHead)
      if (head?.length) upSocket.write(head)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
      upSocket.on('error', () => socket.destroy())
      socket.on('error', () => upSocket.destroy())
    })
    // 上游不给 101（票不对、席位没了）：把状态原样退回去，别让浏览器干等。
    upstream.on('response', (up) => {
      socket.write(`HTTP/1.1 ${up.statusCode} ${up.statusMessage}\r\nconnection: close\r\n\r\n`)
      socket.destroy()
    })
    upstream.on('error', (e) => {
      log.warn?.(`desk-proxy: WebSocket 连不上 ${targetHost}:${targetPort}（${e.message}）`)
      socket.destroy()
    })
    upstream.end()
  })

  server.on('error', (e) => {
    log.warn?.(
      e.code === 'EADDRINUSE'
        ? `desk-proxy: ${listenPort} 已经被占着，TLS 这一路不起了`
        : `desk-proxy: 起不来——${e.message}`,
    )
  })

  server.listen(listenPort, '0.0.0.0', () => {
    log.log?.(`desk-proxy: https 0.0.0.0:${listenPort} -> ${targetHost}:${targetPort}（桌面直连地址填 https://<本机 IP>:${listenPort}）`)
  })

  return () => {
    for (const s of sockets) s.destroy()
    sockets.clear()
    server.close()
  }
}

/** 给了证书就 TLS 终结，否则纯 TCP。两种都不抛。 */
export function startDeskProxyAuto(cfg, tls, log = console) {
  return tls?.cert && tls?.key ? startDeskTlsProxy(cfg, tls, log) : startDeskProxy(cfg, log)
}

// 直接跑：`node scripts/desk-proxy.mjs 192.168.64.6:8443`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const cfg = parseDeskProxy(process.argv[2] || process.env.SATUWORK_DESK_PROXY || '')
  if (!cfg) {
    console.error('用法: node scripts/desk-proxy.mjs [监听端口:]<管家主机>:<管家端口>')
    process.exit(2)
  }
  const close = startDeskProxyAuto(cfg, {
    cert: process.env.SATUWORK_DESK_PROXY_CERT || '',
    key: process.env.SATUWORK_DESK_PROXY_KEY || '',
  })
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (close(), process.exit(0)))
}
