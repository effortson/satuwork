/**
 * 本地开发用的桌面转发：把本机的一个端口转给席位机器的管家。
 *
 * **为什么需要它。** 两件事，都只在本地开发里成立：
 *
 * · **够不着。** 席位机器常常是本机上的一台虚机（`192.168.64.6`），那张网只有宿主机
 *   在上面。而 `directUrl` 是个绝对地址，对话流、名单流、桌面那块 iframe 全照着它
 *   直连——局域网里另一台机器（Windows 上的桌面壳、手机）没有到那张网的路由，三条
 *   一起连不上。转发把管家借到宿主机的地址上，`directUrl` 填它，谁都够得着。
 * · **想跑生产那条路径**（https 直连）。管家只监听明文 http（node:http，自己不做
 *   TLS），本地没有反代就永远试不到那条路。
 *
 * 两种模式，按有没有给证书分：
 *
 * · **纯 TCP（默认）**：原样转字节。`directUrl` 填 `http://<本机 IP>:<监听端口>`——收 http
 *   的前提是 `GATEWAY_PUBLIC_URL` 明确配成 http（见 lib/machines.ts 的 directUrlOf）。
 *   **浏览器版和桌面壳都够用。** 以前这里写的是「桌面壳用不上」，理由是那张 cookie 在
 *   非 https 下只能是 `SameSite=Lax`、进不了跨站子框；票改写进路径之后（管家 0.1.24 起，
 *   manager/src/proxy.ts 的 `VNC_TICKET_PATH`）那条限制没了，noVNC 的相对资源和那条
 *   WebSocket 自己就带着凭据，cookie 只是兜底。
 * · **TLS 终结（给了证书）**：自己收 https，解密后把明文转给管家，并补上
 *   `x-forwarded-proto: https`（管家按它决定兜底那张 cookie 发不发 `SameSite=None; Secure`）。
 *   跑的是和生产一样的那条路径，`directUrl` 填 `https://<监听地址>:<监听端口>`。
 *   **代价是证书要伺候两头**：SAN 得覆盖你真正填进 `directUrl` 的那个 IP，每台客户机
 *   还都要装上 mkcert 的根证书。少一样的表现是对话流和桌面一起**静默**连不上——界面上
 *   一个字都没有。局域网里拿别的机器试的时候，纯 TCP 那一档省掉这两件事。
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
 * **存在的理由是「跑一遍生产那条路径」**：生产上直连是 https，而管家只说明文 http。
 * 顺带补上的 `x-forwarded-proto: https` 决定管家那张兜底 cookie 发不发
 * `SameSite=None; Secure`（manager/src/proxy.ts）；票本身写在路径里，不靠这张 cookie，
 * 所以纯 TCP 那一档同样能看到桌面（见文件头）。
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
