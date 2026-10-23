/**
 * 主 Bot 派活的那把工具（src/tools/assign.ts）。假目录给一份可派名单、假 Gateway 收 POST /runtime/tasks：
 * 要看的是——按名字解析成 id、带自己的 botId / 会话 / callId 去记一条、回给模型的话说清「已派出、别等」；
 * 名单上没有的、Gateway 说派不了（409）的，原话回给模型；名单空着（不是主 Bot）就派不了。
 */
import { createServer } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import * as toolsPlugin from './src/tools/index.ts'
import * as assignPlugin from './src/tools/assign.ts'

process.env.SATUWORK_BOT_ID = 'bot-main'
process.env.GATEWAY_TOKEN = 'sat_assign_probe'

const seen = []
let calls = 0
const gateway = createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined
    seen.push({ method: req.method, path: req.url, auth: req.headers.authorization, body })
    const send = (code, value) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.method === 'POST' && req.url === '/runtime/tasks') {
      calls++
      if (calls === 1) return send(201, { task: { id: 't-1234567890', status: 'queued' }, toName: '财务' })
      return send(409, { error: '「财务」上一件活还没做完，等它交回来再派' })
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
    ]
  }
  get servers() {
    return []
  }
  toolNamesFor() {
    return []
  }
}

const ctx = new Context()
ctx.plugin(toolsPlugin)
ctx.plugin(FakeCatalog)
ctx.plugin(assignPlugin)
await new Promise((r) => setTimeout(r, 300))

const run = (args, callId = 'c-1') => ctx.tools.execute({ callId, name: 'assign_task', sessionId: 's-main', arguments: JSON.stringify(args) })

const out = {}
const def = ctx.tools.schemas().find((t) => t.name === 'assign_task')
out.schema = {
  在表里: Boolean(def),
  描述里有名单: Boolean(def && /财务/.test(def.description) && /做报表、对账/.test(def.description)),
}
const ok = await run({ bot: '财务', instruction: '做一份本月费用月报' })
out.ok = { text: ok.text, posted: seen.find((s) => s.path === '/runtime/tasks') }
const nobody = await run({ bot: '法务', instruction: '看合同' }, 'c-2')
out.nobody = nobody.text
const busy = await run({ bot: 'fin', instruction: '再来一份' }, 'c-3')
out.busy = busy.text
const empty = await run({ bot: '财务', instruction: '  ' }, 'c-4')
out.empty = empty.text
ctx.catalog.assignable = []
const notMain = await run({ bot: '财务', instruction: '做点什么' }, 'c-5')
out.notMain = notMain.text
out.calls = calls

gateway.close()
console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
