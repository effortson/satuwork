/**
 * 管家工人跑派活 run 那一步时的「停止」（manager/src/worker/tasks.ts，docs/bot-tasks.md §1.2、§7）。
 *
 * 一个假的管家中继口同时扮 Gateway（/w-local/gateway/worker/tasks/*）和席位（/w-local/seats/*）。要看的是
 * 停止落在哪一刻、该怎么停：
 *
 *   A. 拿到会话 id 之后、指令发出去之前就被停：对方跑着的是人自己那一轮，不调中止，指令不发。
 *   B. 排在对方队列里被停，第一次撤队列席位没应（500）：下一拍再撤，不退回去中止当前那一轮。
 *   C. 排在对方队列里被停，队列里已经没有这一条（404，人在对方那边撤了）：不调中止，报 aborted。
 */
import { createServer } from 'node:http'

const seen = []
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const url = new URL(req.url, 'http://probe')
    const path = url.pathname
    const body = raw ? JSON.parse(raw) : undefined
    seen.push({ method: req.method, path, body })
    const send = (code, value) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    const task = (path.match(/\/tasks\/(tk-[a-z])\//) || [])[1]
    if (path.startsWith('/w-local/gateway/worker/tasks/')) {
      if (path.endsWith('/started')) {
        // A：started 慢吞吞，这期间续租已经说停了。
        return task === 'tk-a' ? void setTimeout(() => send(200, { blocked: null }), 1200) : send(200, { blocked: null })
      }
      if (path.endsWith('/renew')) {
        const n = seen.filter((s) => s.path === path).length
        return send(200, { leaseMs: 60000, cancelled: task === 'tk-a' || n >= 2 })
      }
      if (path.endsWith('/finish')) return send(200, { ok: true })
    }
    if (path.endsWith('/session')) return send(200, { sessionId: 's-target' })
    if (path.endsWith('/history')) return send(200, { events: [{ seq: 3 }] })
    if (path.endsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': hi\n\n')
      return
    }
    if (path.endsWith('/messages')) {
      const id = body?.task?.id
      return send(200, { queued: true, queueId: id === 'tk-b' ? 'q-b' : 'q-c' })
    }
    if (req.method === 'DELETE' && path.endsWith('/queue/q-b')) {
      const n = seen.filter((s) => s.method === 'DELETE' && s.path === path).length
      return n === 1 ? send(500, { error: '忙' }) : send(200, { cancelled: true })
    }
    if (req.method === 'DELETE' && path.endsWith('/queue/q-c')) return send(404, { error: '没有这条排队消息' })
    if (path.endsWith('/abort')) return send(200, { aborted: true })
    send(404, { error: 'no route' })
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
process.env.SATUWORK_MANAGER_LOCAL = `http://127.0.0.1:${server.address().port}`
process.env.SATUWORK_WORKER_TOKEN = 'wkr_probe'

const { runTaskJob } = await import('./src/worker/tasks.ts')
const job = (taskId) => ({
  taskId,
  phase: 'run',
  botId: 'bot-target',
  accountId: 'acc',
  seatId: 'seat-1',
  instruction: `【主 Bot「助手」派来的任务】\n${taskId}`,
  task: { id: taskId, phase: 'instruction', from: { id: 'bot-main', name: '助手' } },
  leaseMs: 60000,
  timeoutMs: 120000,
  cancelPollMs: 200,
})
const quiet = () => {}
const withDeadline = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('卡住了')), 20000))])
const out = {}
for (const id of ['tk-a', 'tk-b', 'tk-c']) {
  try {
    await withDeadline(runTaskJob(job(id), quiet))
  } catch (e) {
    out[id] = String(e.message || e)
  }
}
server.closeAllConnections?.()
server.close()
console.log('__RESULT__' + JSON.stringify({ seen, out }))
process.exit(0)
