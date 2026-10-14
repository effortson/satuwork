/**
 * 对话内查找的语义（session/search.ts）。纯函数，不起服务——探针要 tsx 才 import 得了 .ts。
 * 结果打在 `__RESULT__` 那一行上（见 e2e/search.mjs）。
 */
import { searchSession, blocksOf, termsOf, snippetOf, splitUploads } from './src/session/search.ts'

let seq = 0
let clock = 1000
const ev = (type, data) => ({ seq: ++seq, time: (clock += 1000), type, data })
const msg = (content) => ({ content: typeof content === 'string' ? [{ type: 'text', text: content }] : content })
const user = (content, source = { kind: 'user' }) => ev('user/message', { message: msg(content), source })

/** 一轮：提问 → turn/start → 若干 chunk → （工具）→ 最终消息 → turn/end。 */
function turn(out, n, question, answer, extra = () => {}) {
  out.push(user(question))
  out.push(ev('turn/start', { turn: n }))
  for (let i = 0; i < 3; i++) out.push(ev('assistant/chunk', { turn: n, step: 0, chunk: { type: 'text-delta', text: 'x' } }))
  extra(out, n)
  out.push(ev('assistant/message', { turn: n, step: 0, message: msg(answer) }))
  out.push(ev('turn/end', { turn: n, reason: 'completed' }))
}

function conversation() {
  seq = 0
  clock = 1000
  const out = [ev('session', { version: 6, id: 's', createdAt: 1, botId: 'b' })]
  turn(out, 1, '帮我看看报价单', '好的，报价单我看过了，总价 12,000。')
  // 第二轮：带上传附件的提问，助手产出一个文件。
  turn(out, 2, '我上传了文件，在工作区里：\n- `uploads/s/合同草案.docx`\n\n按这个改一版报价', '改好了，见下面的文件。', (o, n) => {
    o.push(ev('tool/call', { turn: n, step: 0, callId: 'c1', name: 'office_write', arguments: '{}' }))
    o.push(ev('tool/result', { turn: n, step: 0, callId: 'c1', text: '已写出', failed: false, files: [{ path: 'out/报价单-v2.xlsx', name: '报价单-v2.xlsx' }] }))
  })
  // 第三轮：一轮里两条助手消息（工具中间穿插）；正文取最后一条有字的，锚点是最后一条。
  out.push(user('那合同呢'))
  out.push(ev('turn/start', { turn: 3 }))
  out.push(ev('assistant/message', { turn: 3, step: 0, message: msg('我先查一下合同。') }))
  out.push(ev('tool/call', { turn: 3, step: 1, callId: 'c2', name: 'read', arguments: '{}' }))
  out.push(ev('tool/result', { turn: 3, step: 1, callId: 'c2', text: '合同正文……（工具原文里也有报价两个字）', failed: false }))
  out.push(ev('assistant/message', { turn: 3, step: 2, message: msg('合同里没有提到报价，只有付款周期。') }))
  out.push(ev('turn/end', { turn: 3, reason: 'completed' }))
  // 第四轮：系统注入的 user/message 不画、也不该搜到；助手推理块不该搜到。
  out.push(user('[系统快照] 报价报价报价', { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' }))
  out.push(user('今天天气'))
  out.push(ev('turn/start', { turn: 4 }))
  out.push(ev('assistant/message', { turn: 4, step: 0, message: msg([{ type: 'reasoning', text: '用户想问报价吗？不是。' }, { type: 'text', text: '晴。' }]) }))
  out.push(ev('turn/end', { turn: 4, reason: 'completed' }))
  return out
}

const out = {}

// 1. 分块与锚点
{
  const all = conversation()
  const blocks = blocksOf(all)
  const third = blocks.find((b) => b.role === 'assistant' && b.text.includes('付款周期'))
  const lastMsg = all.filter((e) => e.type === 'assistant/message' && e.data.turn === 3).at(-1)
  out.blocks = {
    块数: blocks.length,
    注入的用户消息不成块: !blocks.some((b) => b.text.includes('系统快照')),
    一轮里多条助手消息合成一块: blocks.filter((b) => b.role === 'assistant').length === 4,
    正文取最后一条有字的: Boolean(third) && !third.text.includes('先查一下'),
    锚点是最后一条助手消息的seq: Boolean(third) && third.anchor === lastMsg.seq,
    上传附件认回来了: blocks.some((b) => b.role === 'user' && b.files.some((f) => f.path === 'uploads/s/合同草案.docx')),
    上传那段话从正文里拆掉了: !blocks.some((b) => b.text.includes('我上传了文件')),
    工具产出挂在助手块上: blocks.some((b) => b.role === 'assistant' && b.files.some((f) => f.name === '报价单-v2.xlsx')),
  }
}

// 2. 搜正文
{
  const all = conversation()
  const r = searchSession(all, { q: '报价' })
  out.text = {
    命中数: r.total,
    新的在前: r.hits.every((h, i) => i === 0 || h.anchor < r.hits[i - 1].anchor),
    工具原文不算: !r.hits.some((h) => h.snippet.includes('工具原文')),
    推理不算: !r.hits.some((h) => h.snippet.includes('用户想问')),
    注入不算: !r.hits.some((h) => h.snippet.includes('系统快照')),
    摘录带命中词: r.hits.every((h) => h.snippet.includes('报价')),
    角色齐全: r.hits.some((h) => h.role === 'user') && r.hits.some((h) => h.role === 'assistant'),
    词: r.terms,
    hasMore: r.hasMore,
  }
}

// 3. 搜文件
{
  const all = conversation()
  const r = searchSession(all, { q: '报价单' })
  const xlsx = r.files.find((f) => f.name === '报价单-v2.xlsx')
  const r2 = searchSession(all, { q: '合同草案' })
  out.files = {
    产出的文件命中: Boolean(xlsx),
    文件锚点指向那条助手消息: Boolean(xlsx) && all.some((e) => e.seq === xlsx.anchor && e.type === 'assistant/message'),
    上传的附件按名字命中: r2.files.some((f) => f.path === 'uploads/s/合同草案.docx'),
    附件命中不算正文命中: r2.total === 0,
    fileTotal: r.fileTotal,
  }
}

// 4. 多词、大小写、空查询、分页
{
  const all = conversation()
  const both = searchSession(all, { q: '报价 合同' })
  const upper = searchSession(all, { q: 'X' })
  const blank = searchSession(all, { q: '   ' })
  const page1 = searchSession(all, { q: '报价', limit: 2 })
  const page2 = searchSession(all, { q: '报价', limit: 2, before: page1.nextBefore })
  out.query = {
    多个词都要有: both.total === 1 && both.hits[0].snippet.includes('付款周期'),
    不区分大小写: upper.total === 0 || upper.hits.length === upper.total,
    空查询给空结果: blank.hits.length === 0 && blank.terms.length === 0 && !blank.hasMore,
    第一页: page1.hits.length,
    第一页说还有: page1.hasMore && page1.nextBefore === page1.hits.at(-1).seq,
    第二页接上: page2.hits.length > 0 && page2.hits[0].anchor < page1.hits.at(-1).anchor,
    两页加起来是全部: page1.hits.length + page2.hits.length === page1.total,
    总数不随分页变: page1.total === page2.total,
    词数上限: termsOf('a b c d e f g h i j k').length,
  }
}

// 5. /clear 之前的不搜；/new 之后的照样搜
{
  const all = conversation()
  const cut = all.at(-1).seq
  const cleared = all.concat([{ seq: cut + 1, time: 99999, type: 'session/reset', data: { throughSeq: cut, clear: true } }])
  const renewed = all.concat([{ seq: cut + 1, time: 99999, type: 'session/reset', data: { throughSeq: cut } }])
  out.reset = {
    clear之后搜不到前文: searchSession(cleared, { q: '报价' }).total === 0,
    new之后仍能搜到前文: searchSession(renewed, { q: '报价' }).total === searchSession(all, { q: '报价' }).total,
  }
}

// 6. 摘录与上传解析
{
  const long = '前面是很长的一段铺垫'.repeat(20) + '这里出现了关键词' + '后面还有很多话'.repeat(30)
  const snip = snippetOf(long, ['关键词'])
  const up = splitUploads('我上传了文件，在工作区里：\n- `uploads/s/a.pdf`\n- `uploads/s/b.png`\n\n看看')
  out.snippet = {
    两头都有省略号: snip.startsWith('…') && snip.endsWith('…'),
    带着命中词: snip.includes('关键词'),
    长度有界: snip.length < 220,
    上传两个: up.files.length === 2 && up.text === '看看',
    不是上传格式就原样: splitUploads('随便一句 - `uploads/x`').files.length === 0,
  }
}

console.log('__RESULT__' + JSON.stringify(out))
