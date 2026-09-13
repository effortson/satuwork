import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 自检靶子。
 *
 * 桌面壳装的是系统 webview——Windows 是 WebView2（Chromium），macOS 是 WKWebView，
 * Linux 是 WebKitGTK。**它们不是同一个浏览器**，而 gateway/ui 靠的几样东西恰好都在
 * 各家实现差异最大的那一档上：
 *
 *   - `res.body.getReader()` 增量读流——聊天的每一个字都从这条来（chat.js 的 SSE）
 *   - WebSocket——右栏那块桌面的像素全走它
 *   - `<a download>` 与 blob: 预览——附件下载和文件预览
 *   - 302 带回来的 SameSite=Lax cookie——**同源**那一种。桌面早就不走 Gateway 反代了
 *     （desktop.ts 已删），现在是直连席位机器的跨站 iframe，那一种这里测不了：靶子和
 *     页面同源，而跨站要 `SameSite=None; Secure`，得有 https 才谈得上
 *
 * 这个靶子把这四样单拎出来，在一个不需要数据库、不需要 Bot、不需要登录的页面里跑一遍。
 * 换一个目标系统就重跑一次，结论落在 result.json 里，不用靠人盯着屏幕看。
 *
 *   node desktop/probe/server.mjs           # 起在 0.0.0.0:4321
 *   SATUWORK_SERVER=http://127.0.0.1:4321 open -a Satuwork
 *
 * 绑 0.0.0.0 是故意的：拿局域网地址（http://192.168.x.x:4321）再跑一遍，验的是
 * macOS 的 ATS 放不放明文 http 进来——那条只有在**打包过的 .app** 里才作数，
 * `tauri dev` 起的裸二进制不受 Info.plist 管。
 */

const here = dirname(fileURLToPath(import.meta.url))
/** webview 有没有真的去取那个附件。见 /download/seen。 */
let downloadAsked = false
/**
 * 链接那三件事各自发生了没有。
 *
 * 桌面壳里这三条**都不是白来的**：`target="_blank"` 和 `window.open()` 在裸 webview
 * 里是空操作（不报错、不开窗、不发请求），站外链接则会把唯一的窗口整个带走。壳子
 * 各打了一个补丁，而补丁对不对，只有靶子说了算。
 */
const links = { blank: false, open: false, outside: false }
const port = Number(process.env.PROBE_PORT ?? 4321)
const host = process.env.PROBE_HOST ?? '0.0.0.0'

function html(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end('<!doctype html><meta charset="utf-8">' + body)
}

/**
 * 隔壁那个端口扮演「站外」。
 *
 * 站外那一条必须真的**跨源**才有意义：壳子放同源的走应用内新窗口、把站外的交给系统
 * 浏览器，两条分支是两段不同的代码。同一个进程里多听一个端口，比让人再起一个服务省事。
 */
createServer((req, res) => {
  links.outside = true
  html(res, '<h1>站外</h1><p>这一页出现在系统浏览器里就是对的；出现在应用窗口里就是错的。</p>')
}).listen(port + 1, host)

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  const path = url.pathname

  if (path === '/' || path === '/index.html') {
    const html = readFileSync(join(here, 'index.html'))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
    return
  }

  // 聊天那条流的形状：text/event-stream，分多次写，中间有间隔。
  // 要验的是 webview 会不会**边收边给**——攒到最后一次性交出来的话，界面上就是
  // 「打字机效果没了，答完才整段蹦出来」。
  if (path === '/sse') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    let n = 0
    const timer = setInterval(() => {
      n += 1
      res.write(`event: tick\ndata: ${JSON.stringify({ n, at: Date.now() })}\n\n`)
      if (n >= 5) {
        clearInterval(timer)
        res.write('event: done\ndata: {}\n\n')
        res.end()
      }
    }, 150)
    res.on('close', () => clearInterval(timer))
    return
  }

  // 下载这一条页面自己判不了：`<a download>` 点下去之后，webview 可能静默把它丢掉。
  // 服务端能判的那一半是「请求到底发出来没有」——最坏的那种失败（什么都没发生）
  // 正好落在这一半里。
  if (path === '/links/blank') { links.blank = true; return html(res, '<p>blank</p>') }
  if (path === '/links/open') { links.open = true; return html(res, '<p>open</p>') }
  if (path === '/links/seen') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(links))
    return
  }
  if (path === '/download/seen') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: downloadAsked }))
    return
  }
  if (path === '/download') {
    downloadAsked = true
    const body = Buffer.from('satuwork desktop probe\n')
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': 'attachment; filename="probe.txt"',
      'content-length': String(body.length),
    })
    res.end(body)
    return
  }

  // 桌面入口的形状：一个 302，顺手种一张 path 限定的 HttpOnly + SameSite=Lax cookie；
  // 下一跳能不能读到它，决定了那块屏是画面还是 401。**这里验的是同源那一种**——现在
  // 的桌面是跨站 iframe（页面在 satu://localhost，屏在席位机器上），跨站的 Lax 一定
  // 带不上，靶子换不出那个场景。
  if (path === '/cookie/set') {
    res.writeHead(302, {
      'set-cookie': 'satu_probe=ok; Path=/cookie; Max-Age=300; HttpOnly; SameSite=Lax',
      location: '/cookie/check',
      'cache-control': 'no-store',
    })
    res.end()
    return
  }
  if (path === '/cookie/check') {
    const got = String(req.headers.cookie ?? '').includes('satu_probe=ok')
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: got }))
    return
  }

  // 页面自己把结论回填到这儿。靠截图看结果的话，跨机器跑就得有人守着屏幕。
  if (path === '/result' && req.method === 'POST') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      console.log('--- 自检结果 ---')
      console.log(raw)
      res.writeHead(204).end()
    })
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

/**
 * 最小 WebSocket：握手 + 回声。不引依赖——这个靶子不该有 node_modules。
 *
 * **按流解帧，不按 data 事件解。** TCP 不保证「一个 data 事件正好是一整帧」：帧可能
 * 被拆成两段，也可能和下一帧粘在一起。照着事件解的话，遇到拆包就静默不回声，页面
 * 3 秒超时报「WebSocket FAIL」——于是坏的是靶子，被判死刑的却是那个系统的 webview。
 * 假阴性最可能出现在唯一还没验、又最需要靠它做决定的平台上。
 */
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key']
  if (!key) {
    socket.destroy()
    return
  }
  const accept = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )

  let buf = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      if (buf.length < 2) return
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let at = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        at = 4
      } else if (len === 127) {
        // 这个靶子不发大帧。真收到就是对不上了，断开比猜好。
        socket.destroy()
        return
      }
      const maskKey = masked ? buf.subarray(at, at + 4) : null
      if (masked) at += 4
      if (buf.length < at + len) return
      const payload = Buffer.from(buf.subarray(at, at + len))
      buf = buf.subarray(at + len)
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4]
      if (opcode === 0x8) {
        socket.end()
        return
      }
      if (opcode !== 0x1) continue
      const reply = Buffer.from('echo:' + payload.toString('utf8'))
      socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]))
    }
  })
  socket.on('error', () => socket.destroy())
})

server.listen(port, host, () => {
  console.log(`probe: 听在 http://${host}:${port}`)
})
