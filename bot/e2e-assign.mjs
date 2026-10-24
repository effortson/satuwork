/**
 * 主 Bot 派活的那把工具（src/tools/assign.ts，docs/bot-tasks.md §1、§2）。假目录给一份可派名单、
 * 假 Gateway 扮任务的一生（POST 建、GET 先 running 后 done），假会话收 bot/assign 事件。要看的是：
 *
 *  - 同步：工具一直等到每一件收场才返回，返回里带着每一件的结论；
 *  - 编排：没依赖的一起派，after 的等前置做完再派，并且指令末尾附上前置交回的结论；
 *    同一颗 Bot 的几件自动排队；前置没做成，依赖它的跳过；
 *  - 校验：名单上没有的、环、重复 id，整次不发生；名单空着（不是主 Bot）派不了；
 *  - 每一件的状态变化都写进会话（bot/assign）。
 */
import { createServer } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'

// 环境变量要在**导入工具模块之前**设好：轮询间隔是模块加载时读的，静态 import 会抢在这几行前面执行。
process.env.SATUWORK_BOT_ID = 'bot-main'
process.env.GATEWAY_TOKEN = 'sat_assign_probe'
process.env.SATUWORK_ASSIGN_POLL_MS = '200'
const toolsPlugin = await import('./src/tools/index.ts')
const assignPlugin = await import('./src/tools/assign.ts')

/** 每件任务：建出来之后被问到第 2 次就 done；派给「法务」的做不成。 */
const tasks = new Map()
const posted = []
/** 主 Bot 这边发出去的停止（POST /runtime/tasks/:id/cancel）。 */
const cancels = []
let seq = 0
const gateway = createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined
    const send = (code, value) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.method === 'POST' && req.url === '/runtime/tasks') {
      posted.push({ auth: req.headers.authorization, body, at: Date.now() })
      if (body.toBot === 'busy') return send(409, { error: '「忙人」上一件活还没做完' })
      const id = `t-${++seq}`
      tasks.set(id, { id, body, polls: 0 })
      return send(201, { task: { id, status: 'queued' } })
    }
    const cm = req.url.match(/^\/runtime\/tasks\/([^/]+)\/cancel$/)
    if (req.method === 'POST' && cm) {
      cancels.push(cm[1])
      return send(200, { task: { id: cm[1], status: 'running' } })
    }
    const m = req.url.match(/^\/runtime\/tasks\/([^/]+)$/)
    if (req.method === 'GET' && m) {
      const t = tasks.get(m[1])
      if (!t) return send(404, { error: 'no' })
      t.polls++
      // 跑着的那一拍带上领活方报的进度和对方的会话 id（真 Gateway 的 publicBotTask 就是这个形状）。
      // 运营那件一直跑着：看它会不会跟着被停。
      if (t.body.toBot === 'ops') return send(200, { task: { id: t.id, status: 'running' } })
      if (t.polls < 2) return send(200, { task: { id: t.id, status: 'running', runSessionId: `s-${t.body.toBot}`, progress: { steps: 2, tool: { name: 'web_search', detail: t.body.toBot } } } })
      if (t.body.toBot === 'legal') return send(200, { task: { id: t.id, status: 'done', runKind: 'failed', error: '它那边报错了', result: '没做成：它那边报错了' } })
      // 设计师那边有人按了停止（真 Gateway 的 taskFinish：kind=aborted、主 Bot 这边没停）。
      if (t.body.toBot === 'design') return send(200, { task: { id: t.id, status: 'done', runKind: 'aborted', error: '有人在它的对话里把这一轮停了', result: '已停止：有人在它的对话里把这一轮停了，这件活作废。' } })
      return send(200, { task: { id: t.id, status: 'done', runKind: 'completed', result: `【${t.body.toBot}】做完了：${t.body.instruction.split('\n')[0]}` } })
    }
    send(404, { error: 'no route' })
  })
})
await new Promise((r) => gateway.listen(0, '127.0.0.1', r))
process.env.GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`

class FakeCatalog extends Service {
  constructor(ctx) {
    super(ctx, 'catalog')
    this.assignable = [
      { id: 'fin', name: '财务', desc: '做报表、对账' },
      { id: 'sales', name: '销售', desc: '' },
      { id: 'legal', name: '法务', desc: '' },
      { id: 'design', name: '设计师', desc: '' },
      { id: 'ops', name: '运营', desc: '' },
    ]
  }
  get servers() {
    return []
  }
  toolNamesFor() {
    return []
  }
}

const events = []
class FakeSessions extends Service {
  constructor(ctx) {
    super(ctx, 'sessions')
  }
  async append(sessionId, type, data) {
    events.push({ sessionId, type, data })
  }
}

const ctx = new Context()
ctx.plugin(toolsPlugin)
ctx.plugin(FakeCatalog)
ctx.plugin(FakeSessions)
ctx.plugin(assignPlugin)
await new Promise((r) => setTimeout(r, 300))

const run = (args, callId) => ctx.tools.execute({ callId, name: 'assign_task', sessionId: 's-main', arguments: JSON.stringify(args) })
const out = {}

const def = ctx.tools.schemas().find((t) => t.name === 'assign_task')
out.schema = { 在表里: Boolean(def), 描述里有名单: Boolean(def && /财务/.test(def.description) && /做报表、对账/.test(def.description)) }

// ── 串并混合：mail、crm 并行，bill 等 mail；fin2 和 bill 同一颗财务，自动排在 bill 后面 ──
{
  const t0 = Date.now()
  const r = await run(
    {
      tasks: [
        { id: 'mail', bot: '销售', instruction: '扫邮箱' },
        { id: 'crm', bot: '法务', instruction: '看合同' },
        { id: 'bill', bot: '财务', instruction: '核账单', after: ['mail'] },
        { id: 'fin2', bot: '财务', instruction: '出月报' },
        { id: 'law2', bot: '销售', instruction: '跟进合同', after: ['crm'] },
      ],
    },
    'c-dag',
  )
  const order = posted.map((p) => p.body.instruction.split('\n')[0])
  const at = (name) => posted.find((p) => p.body.instruction.startsWith(name))
  const mine = events.filter((e) => e.type === 'bot/assign' && e.data.callId === 'c-dag')
  const last = new Map()
  for (const e of mine) last.set(e.data.id, e.data)
  out.dag = {
    order,
    text: r.text,
    带席位票和wait: posted.every((p) => p.auth === 'Bearer sat_assign_probe' && p.body.wait === true && p.body.fromBotId === 'bot-main' && p.body.sessionId === 's-main'),
    并行的一起派: Math.abs(at('扫邮箱').at - at('看合同').at) < 150,
    串行的等前置: at('核账单').at > at('扫邮箱').at + 150,
    // 单独放进 context，不拼进指令：指令有 4000 字的上限，前置一长后一件就派不出去。
    前置结论单独交过去: at('核账单').body.instruction === '核账单' && String(at('核账单').body.context || '').includes('【sales】做完了：扫邮箱'),
    没前置的不带context: !('context' in at('扫邮箱').body),
    同一颗Bot自动排队: at('出月报').at > at('核账单').at + 150,
    前置没做成就跳过: !at('跟进合同') && last.get('c-dag:law2')?.state === 'skipped',
    结论都回给模型: /\[1\/5 done · @销售/.test(r.text) && /\[2\/5 failed · @法务/.test(r.text) && r.text.includes('【fin】做完了：出月报'),
    事件先画全部再更新: mine.slice(0, 5).every((e) => e.data.state === 'waiting') && last.get('c-dag:mail')?.state === 'done',
    事件带结论: (last.get('c-dag:bill')?.result || '').includes('【fin】做完了：核账单'),
    进度写进了事件: mine.some((e) => e.data.id === 'c-dag:mail' && e.data.state === 'running' && e.data.progress?.tool?.detail === 'sales'),
    收场也带着对方会话: last.get('c-dag:mail')?.runSessionId === 's-sales' && last.get('c-dag:mail')?.progress?.steps === 2,
    总耗时合理: Date.now() - t0 < 10_000,
  }
}

// ── 对方那边被人停了（docs/bot-tasks.md §1.3）：这一件标成已停止，同一批整批跟着停，做完的留着 ──
{
  const r = await run(
    {
      tasks: [
        { id: 'draw', bot: '设计师', instruction: '画三版首页' },
        { id: 'quote', bot: '财务', instruction: '按首页出报价', after: ['draw'] },
        { id: 'leads', bot: '销售', instruction: '列本周线索' },
        { id: 'promo', bot: '运营', instruction: '排一周推广' },
      ],
    },
    'c-stop',
  )
  const promoId = [...tasks.values()].find((t) => t.body.instruction.startsWith('排一周推广'))?.id
  const last = new Map()
  for (const e of events.filter((e) => e.type === 'bot/assign' && e.data.callId === 'c-stop')) last.set(e.data.id, e.data)
  out.stopThere = {
    text: r.text,
    这一件标成已停止: last.get('c-stop:draw')?.state === 'cancelled' && (last.get('c-stop:draw')?.result || '').includes('有人在 @设计师 的对话里把它停了'),
    等着的跟着停: last.get('c-stop:quote')?.state === 'cancelled' && (last.get('c-stop:quote')?.result || '').includes('跟着停了'),
    等着的没派出去: !posted.some((p) => p.body.instruction.startsWith('按首页出报价')),
    在跑的跟着停: last.get('c-stop:promo')?.state === 'cancelled' && (last.get('c-stop:promo')?.result || '').includes('@设计师 那边有人按了停止'),
    在跑的发了停止: Boolean(promoId) && cancels.includes(promoId),
    做完的结论留着: last.get('c-stop:leads')?.state === 'done',
    告诉模型整批停了别重派: r.text.includes('整批跟着停了') && r.text.includes('不要重派') && /\[1\/4 cancelled · @设计师/.test(r.text),
  }
}

// ── 校验：整次不发生 ──
{
  const before = posted.length
  out.bad = {
    没有这颗: (await run({ tasks: [{ bot: '行政', instruction: 'x' }] }, 'c-b1')).text,
    有环: (await run({ tasks: [{ id: 'a', bot: '财务', instruction: 'x', after: ['b'] }, { id: 'b', bot: '销售', instruction: 'y', after: ['a'] }] }, 'c-b2')).text,
    重复id: (await run({ tasks: [{ id: 'a', bot: '财务', instruction: 'x' }, { id: 'a', bot: '销售', instruction: 'y' }] }, 'c-b3')).text,
    一件没发: posted.length === before,
  }
  // 单条简写照旧认。
  const single = await run({ bot: '财务', instruction: '单条' }, 'c-one')
  out.single = single.text
  ctx.catalog.assignable = []
  out.notMain = (await run({ tasks: [{ bot: '财务', instruction: 'x' }] }, 'c-nm')).text
}

gateway.close()
console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
