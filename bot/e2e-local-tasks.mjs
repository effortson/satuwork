/**
 * 本地 Bot 自己领主 Bot 派的活（src/local-tasks）。假 Gateway 先发一条 run 活、再发一条 deliver 活，
 * 自己这颗进程的 server 上摆几条假路由扮「自己的会话」：要看的是——run 那一步只认自己那一轮、把那一轮
 * 的 assistant/message 正文带回 finish；deliver 那一步把结论发进会话（带 task 身份）就报 delivered。
 */
import { createServer } from 'node:http'

process.env.SATUWORK_RUNTIME_KIND = 'local'
process.env.SATUWORK_BOT_ID = 'bot-local'
process.env.GATEWAY_TOKEN = 'sat_local_probe'
process.env.SATUWORK_LOCAL_TASK_TICK_MS = '800'

const seen = []
let handed = 0
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
    if (req.method === 'GET' && url.pathname === '/runtime/local-tasks/due') {
      handed++
      if (handed === 1) {
        return send(200, {
          jobs: [{ taskId: 'tk-1', phase: 'run', botId: 'bot-local', accountId: 'acc', seatId: 'desktop', instruction: '【主 Bot「助手」派来的任务】\n做月报', task: { id: 'tk-1', phase: 'instruction', from: { id: 'bot-main', name: '助手' } }, leaseMs: 60000, timeoutMs: 120000 }],
          leaseMs: 60000,
        })
      }
      // run 那一步回报完才给 deliver 那一步（真 Gateway 也是这个顺序）。
      if (seen.some((s) => s.path === '/runtime/local-tasks/tk-1/finish') && !seen.some((s) => s.path === '/runtime/local-tasks/tk-2/started')) {
        return send(200, {
          jobs: [{ taskId: 'tk-2', phase: 'deliver', botId: 'bot-local', accountId: 'acc', seatId: 'desktop', instruction: '【任务结果】@财务 做完了（任务：做月报）\n合计 20 万', task: { id: 'tk-2', phase: 'result', from: { id: 'fin', name: '财务' } }, leaseMs: 60000, timeoutMs: 120000 }],
          leaseMs: 60000,
        })
      }
      // 前两件收场之后发第三件：它跑到一半，主 Bot 那边按了停止。
      if (seen.some((s) => s.path === '/runtime/local-tasks/tk-2/finish') && !seen.some((s) => s.path === '/runtime/local-tasks/tk-3/started')) {
        return send(200, {
          jobs: [{ taskId: 'tk-3', phase: 'run', botId: 'bot-local', accountId: 'acc', seatId: 'desktop', instruction: '【主 Bot「助手」派来的任务】\n做一件很久的事', task: { id: 'tk-3', phase: 'instruction', from: { id: 'bot-main', name: '助手' } }, leaseMs: 60000, timeoutMs: 120000, cancelPollMs: 200 }],
          leaseMs: 60000,
        })
      }
      return send(200, { jobs: [], leaseMs: 60000 })
    }
    if (req.method === 'POST' && url.pathname === '/runtime/local-tasks/tk-3/renew') {
      // 开跑后第二次续租起说「停了」。
      const n = seen.filter((s) => s.path === '/runtime/local-tasks/tk-3/renew').length
      return send(200, { leaseMs: 60000, cancelled: n >= 2 })
    }
    if (req.method === 'POST' && /^\/runtime\/local-tasks\/tk-3\/(started|finish)$/.test(url.pathname)) return send(200, url.pathname.endsWith('started') ? { blocked: null } : { ok: true })
    if (req.method === 'POST' && /^\/runtime\/local-tasks\/tk-[12]\/started$/.test(url.pathname)) return send(200, { blocked: null })
    if (req.method === 'POST' && /^\/runtime\/local-tasks\/tk-[12]\/renew$/.test(url.pathname)) return send(200, { leaseMs: 60000 })
    if (req.method === 'POST' && /^\/runtime\/local-tasks\/tk-[12]\/finish$/.test(url.pathname)) return send(200, { ok: true })
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

const own = []
const streams = []
ctx.server.get('/api/bots/:id/session', async (req) => {
  own.push({ path: req.path, auth: req.headers.get('authorization') })
  return Response.json({ sessionId: 's-local' })
})
ctx.server.get('/api/sessions/:id/history', async (req) => {
  own.push({ path: req.path })
  return Response.json({ events: [{ seq: 3 }] })
})
ctx.server.get('/api/sessions/:id/events', async (req) => {
  own.push({ path: req.path })
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
// 中止：第三件被停时工人来调它。收到就让那一轮以 aborted 收口。
ctx.server.post('/api/sessions/:id/abort', async (req) => {
  own.push({ path: req.path, auth: req.headers.get('authorization') })
  const enc = new TextEncoder()
  for (const c of streams) {
    try {
      c.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'turn/end', seq: 99, data: { turn: 20, reason: 'aborted' } })}\n\n`))
    } catch {}
  }
  return Response.json({ aborted: true })
})
ctx.server.post('/api/sessions/:id/messages', async (req) => {
  const body = await req.json()
  own.push({ path: req.path, auth: req.headers.get('authorization'), body })
  // 第三件：开一轮、说一句，就一直跑着不收口——等着被停。
  if (body.task?.id === 'tk-3') {
    setTimeout(() => {
      const enc = new TextEncoder()
      const line = (type, seq, data) => enc.encode(`data: ${JSON.stringify({ type, seq, data })}\n\n`)
      for (const c of streams) {
        try {
          c.enqueue(line('user/message', 30, { message: { content: body.text } }))
          c.enqueue(line('turn/start', 31, { turn: 20 }))
          c.enqueue(line('assistant/message', 32, { turn: 20, message: { content: [{ type: 'text', text: '我开始做了，要很久。' }] } }))
        } catch {}
      }
    }, 30)
    return Response.json({ accepted: true })
  }
  if (body.task?.phase === 'instruction') {
    setTimeout(() => {
      const enc = new TextEncoder()
      const line = (type, seq, data) => enc.encode(`data: ${JSON.stringify({ type, seq, data })}\n\n`)
      for (const c of streams) {
        // 先来一轮别人的（连带它的回复），再来我们自己的：轮号和正文都要认对。
        c.enqueue(line('user/message', 4, { message: { content: '别人的话' } }))
        c.enqueue(line('turn/start', 5, { turn: 7 }))
        c.enqueue(line('assistant/message', 6, { turn: 7, message: { content: [{ type: 'text', text: '别人的回复' }] } }))
        c.enqueue(line('turn/end', 7, { turn: 7, reason: 'completed' }))
        c.enqueue(line('user/message', 8, { message: { content: body.text } }))
        c.enqueue(line('turn/start', 9, { turn: 8 }))
        c.enqueue(line('assistant/message', 10, { turn: 8, message: { content: [{ type: 'text', text: '我先查一下。' }] } }))
        c.enqueue(line('assistant/message', 11, { turn: 8, message: { content: [{ type: 'text', text: '月报做好了：合计 20 万。' }] } }))
        c.enqueue(line('turn/end', 12, { turn: 8, reason: { kind: 'completed' } }))
      }
    }, 30)
  }
  return Response.json({ accepted: true })
})

await ctx.plugin(await import('./src/local-tasks/index.ts'))

const deadline = Date.now() + 30000
while (Date.now() < deadline && !seen.some((s) => s.path === '/runtime/local-tasks/tk-3/finish')) await new Promise((r) => setTimeout(r, 50))
for (const c of streams) try { c.close() } catch {}
gateway.close()
console.log('__RESULT__' + JSON.stringify({ seen, own }))
process.exit(0)
