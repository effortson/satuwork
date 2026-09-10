/**
 * 本地 Bot 自己领日常任务（src/local-routines）。假 Gateway 发一条活，自己这颗进程的 server 上
 * 摆几条假路由扮「自己的会话」：要看的是——凭席位票去领、started 带会话 id、消息发进了自己的
 * 会话（带 routine 身份和 utility 角色）、只认自己那一轮的 turn/end、finish 报 completed。
 */
import { createServer } from 'node:http'

process.env.SATUWORK_RUNTIME_KIND = 'local'
process.env.SATUWORK_BOT_ID = 'bot-local'
process.env.GATEWAY_TOKEN = 'sat_local_probe'
process.env.SATUWORK_LOCAL_ROUTINE_TICK_MS = '1000'

const seen = []
let handed = false
const gateway = createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const url = new URL(req.url, 'http://probe')
    const body = raw ? JSON.parse(raw) : undefined
    seen.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, body })
    const send = (code, value) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.method === 'GET' && url.pathname === '/runtime/local-routines/due') {
      if (handed) return send(200, { jobs: [], leaseMs: 60000 })
      handed = true
      return send(200, {
        jobs: [{ runId: 'run-1', routineId: 'rt-1', trigger: 'schedule', botId: 'bot-local', accountId: 'acc', seatId: 'desktop', name: '每日简报', instruction: '把今天的事说一遍', modelRole: 'utility', leaseMs: 60000, timeoutMs: 120000 }],
        leaseMs: 60000,
      })
    }
    if (req.method === 'POST' && url.pathname === '/runtime/local-routines/run-1/started') return send(200, { blocked: null })
    if (req.method === 'POST' && url.pathname === '/runtime/local-routines/run-1/renew') return send(200, { leaseMs: 60000 })
    if (req.method === 'POST' && url.pathname === '/runtime/local-routines/run-1/finish') return send(200, { ok: true })
    send(404, { error: 'no route' })
  })
})
await new Promise((r) => gateway.listen(0, '127.0.0.1', r))
process.env.GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`

const { Context } = await import('@deepseek-ai/cordis')
const ctx = new Context()
const port = 30000 + Math.floor(Math.random() * 20000)
process.env.SATUWORK_BOT_PORT = String(port)
await ctx.plugin(await import('./src/server/index.ts'), { host: '127.0.0.1', port })
for (let i = 0; i < 100 && !ctx.server; i++) await new Promise((r) => setTimeout(r, 20))

// 自己的会话：假的三条路 + 一条会吐 turn/end 的事件流。
const own = []
const streams = []
ctx.server.get('/api/bots/:id/session', async (req, res) => {
  own.push({ path: req.path, auth: req.headers.get('authorization') })
  return Response.json({ sessionId: 's-local' })
})
ctx.server.get('/api/sessions/:id/history', async (req, res) => {
  own.push({ path: req.path, auth: req.headers.get('authorization') })
  return Response.json({ events: [{ seq: 3 }] })
})
ctx.server.get('/api/sessions/:id/events', async (req, res) => {
  own.push({ path: req.path, auth: req.headers.get('authorization') })
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(': hi\n\n'))
        streams.push(controller)
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
})
ctx.server.post('/api/sessions/:id/messages', async (req, res) => {
  const body = await req.json()
  own.push({ path: req.path, auth: req.headers.get('authorization'), body })
  setTimeout(() => {
    const enc = new TextEncoder()
    for (const c of streams) {
      // 先来一条别人的消息带走一轮，再来我们自己的：轮号要认对。
      c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'user/message', seq: 4, data: { message: { content: '别人的话' } } })}\n\n`))
      c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'turn/start', seq: 5, data: { turn: 7 } })}\n\n`))
      c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'turn/end', seq: 6, data: { turn: 7, reason: 'aborted' } })}\n\n`))
      c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'user/message', seq: 7, data: { message: { content: body.text } } })}\n\n`))
      c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'turn/start', seq: 8, data: { turn: 8 } })}\n\n`))
      c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'turn/end', seq: 9, data: { turn: 8, reason: { kind: 'completed' } } })}\n\n`))
    }
  }, 30)
  return Response.json({ accepted: true })
})

await ctx.plugin(await import('./src/local-routines/index.ts'))

const deadline = Date.now() + 15000
while (Date.now() < deadline && !seen.some((s) => s.path.endsWith('/finish'))) await new Promise((r) => setTimeout(r, 50))
for (const c of streams) try { c.close() } catch {}
gateway.close()
console.log('__RESULT__' + JSON.stringify({ seen, own }))
process.exit(0)
