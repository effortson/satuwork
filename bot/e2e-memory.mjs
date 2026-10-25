/**
 * 长期记忆的探针（docs/memory.md）。e2e/memory-bot.mjs 用。要 tsx 才 import 得了 .ts。
 *
 * 盯的是四件在线上**都不会报错**的事：
 *
 * 1. **那一段排在提示词最后。** 排错了不报错，只是每记一条就把整段 Skill 正文的
 *    前缀缓存作废一次——症状是账单变贵，没有任何日志会提到它。
 * 2. **挑哪几条。** 层、类别、过期、钉住、注入上限。判错了模型只是"忘了点什么"。
 * 3. **两个标注。** `memory_write` 是 `root-only`、**不带 `external` 位**——带上它，
 *    「关掉外发」的 Bot 连自己的记忆都写不进去，而那也不会报错。
 * 4. **话术。** 太长、是流程、有手机号、匹配到多条——四种拒绝各说各的话，还要给出
 *    可执行的下一步。写成一句干巴巴的失败，模型就会转头告诉用户做不到。
 */
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tempDir } from './e2e-lib.mjs'

const home = tempDir('satu-memory-')
process.env.SATUWORK_HOME = home
process.env.SATUWORK_BOT_ID = 'bot-1'
/**
 * 确认卡等多久。**调到 2 秒**，因为下面有一条用例的全部内容就是「不该走到确认那一步」
 * ——真走到了，默认的五分钟会让这个探针挂到超时，而屏幕上只有一句「探针没跑完」，
 * 指不回是哪一条出的事。
 */
process.env.SATUWORK_APPROVAL_TIMEOUT_MS = '2000'

const { Context } = await import('@deepseek-ai/cordis')
const { cachedMemories, cachedMemoryOf } = await import('./src/catalog/index.ts')
const { memoryOf, DEFAULT_MEMORY } = await import('./src/registry/index.ts')
const { looksProcedural, matchMemories } = await import('./src/tools/memory.ts')
const { memoryBlockOf, memoryLayersOf, pickMemories } = await import('./src/agent/index.ts')
const { formOf } = await import('./src/policy/forms.ts')
const { StorageService } = await import('./src/storage/index.ts')
const { ToolService } = await import('./src/tools/index.ts')

const out = {}
const DAY = 24 * 60 * 60 * 1000

const mem = (text, over = {}) =>
  cachedMemoryOf({
    id: `id-${text}`,
    layer: 'bot',
    kind: '事实',
    text,
    by: 'agent',
    pii: [],
    pinned: false,
    expiresAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  })

// ── 1. 结构判据：什么算一段流程 ───────────────────────────────────────
//
// **只认结构，不猜语义**（docs/memory.md §11）：换行两处以上、或者编号列表。
// 「先看 A 再看 B」和「他习惯先看 A 再看 B」在字面上分不开，扫语义只会误伤。

out.procedural = {
  oneLine: looksProcedural('他姓赵，不要叫他小王'),
  twoBreaks: looksProcedural('第一步这样\n第二步那样\n第三步收尾'),
  numbered: looksProcedural('1. 拉流水\n2. 对账'),
  dashes: looksProcedural('- 拉流水\n- 对账'),
  // 一处换行不算：正文里断个句是常事，一刀切会把正常的事实拦在外面。
  oneBreak: looksProcedural('他姓赵\n别叫他小王'),
}

// ── 1b. 挑哪几条、拼成什么 ────────────────────────────────────────────
//
// 这一段是整个功能最吃重的地方，而它**挑错了不会报任何错**——模型只是"忘了点什么"。

{
  const POLICY = { on: true, scope: '所属分组', kinds: ['偏好', '事实'], cap: 3 }
  const NOW = 1_000_000_000_000
  const list = [
    mem('本人层最新', { id: 'a', layer: 'self', updatedAt: 900 }),
    mem('这颗 Bot 的', { id: 'b', layer: 'bot', updatedAt: 800 }),
    mem('分组的', { id: 'c', layer: 'group', updatedAt: 700 }),
    mem('全公司的', { id: 'd', layer: 'company', updatedAt: 600 }),
    mem('类别没勾', { id: 'e', kind: '联系人', updatedAt: 950 }),
    mem('过期了', { id: 'f', expiresAt: NOW - 1, updatedAt: 999 }),
    mem('钉住的老古董', { id: 'g', pinned: true, updatedAt: 1 }),
  ]

  out.pick = {
    // 「所属分组」= 下面两层 + 分组，**不含全公司**。
    scoped: pickMemories(POLICY, list, NOW).picked.map((m) => m.id),
    self: pickMemories({ ...POLICY, scope: '仅本人' }, list, NOW).picked.map((m) => m.id),
    // **cap 要放宽**：卡在 3 的话「全公司」那条正好被挤掉，这一格就和「所属分组」
    // 长得一模一样——那样这条断言根本分不出两种 scope。
    all: pickMemories({ ...POLICY, scope: '全公司', cap: 9 }, list, NOW).picked.map((m) => m.id),
    // 认不出的 scope 按最窄算：一个拼错的配置不该把全公司的记忆放进某个人的提示词。
    typo: pickMemories({ ...POLICY, scope: '所属分組' }, list, NOW).picked.map((m) => m.id),
    // cap 只卡没钉住的那些；钉住的不占额度，所以 cap=1 时仍然是「钉住的 + 1 条」。
    capped: pickMemories({ ...POLICY, scope: '全公司', cap: 1 }, list, NOW).picked.map((m) => m.id),
    // total 是"筛完还剩多少"，抬头那句「共 N 条」靠它。
    total: pickMemories({ ...POLICY, scope: '全公司', cap: 1 }, list, NOW).total,
    off: pickMemories({ ...POLICY, on: false }, list, NOW).picked.length,
  }
  out.layers = {
    self: [...memoryLayersOf('仅本人')].sort(),
    group: [...memoryLayersOf('所属分组')].sort(),
    company: [...memoryLayersOf('全公司')].sort(),
  }

  out.block = memoryBlockOf({ ...POLICY, scope: '全公司' }, list, NOW)
  out.blockCapped = memoryBlockOf({ ...POLICY, scope: '全公司', cap: 1 }, list, NOW)
  // 一条都挑不出来时整段不加——不是加一个空标题。
  out.blockEmpty = memoryBlockOf({ ...POLICY, kinds: ['没这一类'] }, list, NOW)
}

// ── 2. 子串匹配 ───────────────────────────────────────────────────────

{
  const list = [
    mem('他姓赵，不要叫他小王'),
    mem('季度报表在 work/reports 底下'),
    mem('月度报表也在 work/reports 底下'),
    mem('全公司统一用飞书', { id: 'id-co', layer: 'company' }),
  ]
  out.match = {
    one: matchMemories(list, '姓赵').map((m) => m.text),
    many: matchMemories(list, 'work/reports').length,
    none: matchMemories(list, '发工资').length,
    // **上面两层不进候选**：模型改不动它们，匹配上只会更费解。
    company: matchMemories(list, '飞书').length,
  }
}

// ── 3. 缺字段的回落 ───────────────────────────────────────────────────

out.policyFallback = {
  // 没有 memory 字段（老 Gateway / 本机自建）→ 出厂默认，**不是关掉**。
  missing: memoryOf(undefined),
  // 只给一半 → 另一半沿用默认，不整份退回。
  partial: memoryOf({ memory: { cap: 5, on: false } }),
  defaultOn: DEFAULT_MEMORY.on,
}
out.legacyRow = cachedMemoryOf({ id: 'x', text: '上一版写下的行' })

// ── 4. 工具：话术、标注、写入 ─────────────────────────────────────────

const seen = { posted: [], patched: [], deleted: [] }
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const readBody = () =>
    new Promise((resolve) => {
      let raw = ''
      req.on('data', (d) => (raw += d))
      req.on('end', () => resolve(raw ? JSON.parse(raw) : {}))
    })

  if (url.pathname === '/runtime/memories' && req.method === 'POST') {
    return readBody().then((body) => {
      seen.posted.push(body)
      if (body.text.includes('已经记过')) {
        return send(409, { error: '这条已经记过了（你自己记的）：他姓赵，不要叫他小王' })
      }
      send(201, {
        memory: { id: 'id-new', layer: body.layer, kind: body.kind, text: body.text, by: 'agent', pii: body.pii || [], pinned: false, expiresAt: null, createdAt: 2, updatedAt: 2 },
        used: 3,
        max: 40,
      })
    })
  }
  if (url.pathname.startsWith('/runtime/memories/') && req.method === 'PATCH') {
    return readBody().then((body) => {
      seen.patched.push({ path: url.pathname, body })
      send(200, {
        memory: { id: 'id-report', layer: 'bot', kind: body.kind || '事实', text: body.text, by: 'agent', pii: [], pinned: false, expiresAt: null, createdAt: 1, updatedAt: 3 },
        used: 3,
        max: 40,
      })
    })
  }
  if (url.pathname.startsWith('/runtime/memories/') && req.method === 'DELETE') {
    seen.deleted.push(url.pathname)
    return send(200, { deleted: true, used: 2, max: 40 })
  }
  send(404, { error: 'no' })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
process.env.GATEWAY_URL = `http://127.0.0.1:${server.address().port}`
process.env.GATEWAY_TOKEN = 'sat_probe'

const ctx = new Context()
await ctx.plugin(StorageService, { path: join(home, 'probe.db') })
await ctx.plugin(ToolService)

const noted = []
ctx.provide('catalog', {
  noteMemory: (item) => noted.push(item),
  dropMemory: (id) => noted.push({ dropped: id }),
  pull: async () => true,
})
const cards = []
/**
 * `events` 不能省：policy 的 `botOf` 靠会话根事件认出这条会话属于哪颗 Bot，认不出就
 * 回落到出厂默认的那份策略——那样这个探针里所有开关都拨不动，测的全是默认值。
 */
ctx.provide('sessions', {
  append: async (sessionId, type, data) => cards.push({ sessionId, type, data }),
  events: async () => [{ type: 'session', seq: 1, time: 1, data: { botId: 'bot-1' } }],
})

/** 名册的替身：工具靠它读模版上那几个开关。 */
let policy = { ...DEFAULT_MEMORY, kinds: ['偏好', '事实', '联系人', '流程'], confirm: false }
ctx.provide('roster', { get: () => ({ id: 'bot-1', memory: policy, selfSkills: true }) })

const col = ctx.storage.collection('memories')
col.put('id-name', mem('他姓赵，不要叫他小王', { id: 'id-name', kind: '偏好' }))
col.put('id-report', mem('季度报表在 work/reports 底下', { id: 'id-report' }))
// **两条都带「报表」**——「匹配到多条不许猜」这条只有在真有两条时才测得到。
col.put('id-month', mem('月度报表每月 5 号出', { id: 'id-month' }))
col.put('id-co', mem('全公司统一用飞书', { id: 'id-co', layer: 'company' }))
col.put('id-old', mem('去年的口径', { id: 'id-old', expiresAt: Date.now() - DAY }))

/**
 * `skill_manage` 的替身。
 *
 * 「一段流程改去记成 Skill」那句话是**条件加载**的：那把工具不在表里时不该指过去
 * （docs/memory.md §6）。不摆这个替身的话，探针永远只走得到「没有 skill_manage」
 * 那一支，而线上最常见的恰恰是另一支。
 */
ctx.tools.register({
  name: 'skill_manage',
  description: '替身',
  parameters: { type: 'object', properties: {} },
  risk: ['write'],
  delegation: { mode: 'root-only' },
  execute: () => ({ text: 'ok' }),
})

await ctx.plugin(await import('./src/tools/memory.ts'))
/**
 * **policy 也要真的挂上。**
 *
 * 敏感信息的拒绝在 `tools/pre-execute` 那道闸上，不在工具里——摆在工具里的话，确认卡
 * 会先弹、人点完批准才被拒（见 policy/index.ts 那段注释）。只挂工具的话，这个探针
 * 测的是一条已经不存在的路。
 */
await ctx.plugin(await import('./src/policy/index.ts'))
for (let i = 0; i < 100 && !ctx.tools.has('memory_write'); i++) await new Promise((r) => setTimeout(r, 20))

const call = async (name, args) =>
  await ctx.tools.execute({ callId: 'c1', name, arguments: JSON.stringify(args), sessionId: 's1' })

out.registered = ctx.tools.schemas().map((t) => t.name).filter((n) => n.startsWith('memory'))
out.risk = { write: ctx.tools.riskOf('memory_write'), list: ctx.tools.riskOf('memory_list') }
out.delegation = {
  write: ctx.tools.delegationOf('memory_write'),
  list: ctx.tools.delegationOf('memory_list'),
}

out.list = (await call('memory_list', {})).text
out.listFiltered = (await call('memory_list', { kind: '偏好' })).text
out.listEmpty = (await call('memory_list', { query: '发工资' })).text

out.add = (await call('memory_write', { op: 'add', text: '周会改到周二下午', kind: '事实' })).text
out.addSent = seen.posted[seen.posted.length - 1]
out.noted = noted.map((n) => (n.dropped ? { dropped: n.dropped } : { id: n.id, text: n.text }))
out.cards = cards.map((c) => ({ type: c.type, action: c.data.action, text: c.data.text }))

out.tooLong = (await call('memory_write', { op: 'add', text: '很长'.repeat(200), kind: '事实' })).text
out.procedure = (await call('memory_write', { op: 'add', text: '1. 拉流水\n2. 对账\n3. 出报表', kind: '事实' })).text
out.phone = (await call('memory_write', { op: 'add', text: '他的号码是 13800138000', kind: '联系人' })).text
out.dupe = (await call('memory_write', { op: 'add', text: '已经记过的那句', kind: '事实' })).text

out.replace = (await call('memory_write', { op: 'replace', match: '季度报表', text: '季度报表挪到 work/q 底下' })).text
out.ambiguous = (await call('memory_write', { op: 'replace', match: '报表', text: '换个说法' })).text
out.noMatch = (await call('memory_write', { op: 'replace', match: '发工资', text: '换个说法' })).text
// 上面两层改不动：匹配根本不该把它算进候选，回的是「没有哪条带…」而不是一次误改。
out.companyLayer = (await call('memory_write', { op: 'remove', match: '飞书' })).text
out.remove = (await call('memory_write', { op: 'remove', match: '姓赵' })).text
out.deleted = seen.deleted

// PII 开关关掉时照样扫、照样上报，只是不拒（界面拿它标红）。
policy = { ...policy, pii: false }
out.phoneOff = (await call('memory_write', { op: 'add', text: '他的号码是 13800138000', kind: '联系人' })).text
out.phoneOffSent = seen.posted[seen.posted.length - 1]

// 模版没勾「流程」时，拒绝语不该再指向 skill_manage——那把工具未必在表里。
policy = { ...policy, pii: true, kinds: ['偏好', '事实', '联系人'] }
out.procedureNoSkill = (await call('memory_write', { op: 'add', text: '1. 拉流水\n2. 对账\n3. 出报表', kind: '事实' })).text

/**
 * **开着确认时，删一条照样出卡。**
 *
 * 那道确认闸只拦 add / replace（副文案写的是「提议**记住**某条信息时先征求同意」），
 * 所以删一条既不弹卡片、也没人点过头——这张卡是人唯一能看见「它刚忘掉了什么」的地方。
 * 按 confirm 一刀切掉的话，开着确认的 Bot 反而是删得最无声无息的那种。
 */
policy = { ...policy, confirm: true }
cards.length = 0
out.removeUnderConfirm = (await call('memory_write', { op: 'remove', match: '月度报表' })).text
out.removeCards = cards.map((c) => ({ type: c.type, action: c.data.action, text: c.data.text }))

/**
 * **敏感信息要排在确认前面。**
 *
 * 确认卡在 pre-execute 里弹，比工具执行早；PII 的拒绝要是摆在工具里，人会先读完卡片、
 * 点了批准，然后才收到一句「这条里有手机号，没记」——那次点击白花了。
 *
 * 这一条**靠时间判**：拒绝在前的话它当场返回；顺序错了就会真的停在确认上，
 * 而上面把等待调成了 2 秒，所以回归表现成「用了两秒多，而且话不对」。
 */
{
  const t0 = Date.now()
  out.phoneUnderConfirm = (await call('memory_write', { op: 'add', text: '他的号码是 13800138000', kind: '联系人' })).text
  out.phoneUnderConfirmMs = Date.now() - t0
}
policy = { ...policy, confirm: false }

// 确认卡：正文和类别可改，层不可改。
out.form = formOf({
  name: 'memory_write',
  arguments: JSON.stringify({ op: 'add', text: '周会改到周二', kind: '事实', layer: 'self' }),
})

out.cached = cachedMemories(ctx).map((m) => m.id)

server.close()
console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
