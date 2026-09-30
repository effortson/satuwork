/**
 * 模型自己看文档：office_render（tools/look.ts）+ 工具结果带图这一整条链。探针要 tsx。
 *
 * 链上三段各有各的坏法，而且都是**静默**的——图没进去，模型照样一本正经地说「排版没问题」：
 *
 *  A. 请求体：OpenAI 两种协议的工具结果只收文本，图得补在一条用户消息里；补早了（插在一批
 *     tool 消息中间）chat 协议整条拒。Anthropic 的图要进 tool_result 里面。
 *  B. agent：同一轮里 pi 用的是 bridgeTools 返回的 content，跨轮是 toAgentMessages 重建的；
 *     两处都得带图，而且看不了图的模型一张都不能塞（上游会拒掉整个请求）。
 *  C. 出图：LibreOffice 导出 PNG 只认第一页（7.4 上实测，PageRange 被无视），退路那条要真的
 *     画出第 2、3 页，而不是三张一样的第 1 页。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { Document, Packer, Paragraph, PageBreak, TextRun } from 'docx'
import * as storagePlugin from './src/storage/index.ts'
import * as sessionsPlugin from './src/session/index.ts'
import * as workspacePlugin from './src/workspace/index.ts'
import * as toolsPlugin from './src/tools/index.ts'
import * as llmPlugin from './src/llm/index.ts'
import * as agentPlugin from './src/agent/index.ts'
import * as lookTools from './src/tools/look.ts'
import { parsePages } from './src/tools/look.ts'
import { toAnthropic, toOpenAI, toOpenAIResponses } from './src/llm/gateway.ts'
import { AssistantMessageEventStream, emptyAssistant } from './src/llm/stream.ts'

const home = mkdtempSync(join(tmpdir(), 'satu-look-'))
const work = mkdtempSync(join(tmpdir(), 'satu-look-work-'))
process.env.SATUWORK_HOME = home
process.on('exit', () => {
  try { rmSync(home, { recursive: true, force: true }) } catch {}
  try { rmSync(work, { recursive: true, force: true }) } catch {}
})
const out = {}

// ── A1. 页码 ──────────────────────────────────────────────────────────
const tryPages = (spec) => {
  try {
    return parsePages(spec)
  } catch (e) {
    return `错：${e.message}`
  }
}
out.pages = {
  默认: tryPages(undefined),
  范围: tryPages('2-4'),
  混写: tryPages('1, 3，5'),
  数字: tryPages(7),
  倒着写: tryPages('5-2'),
  乱写: tryPages('第二页'),
  // 不能先摆出十万个数再说超了。
  超大范围: (() => {
    const t = Date.now()
    const r = tryPages('1-100000')
    return { 长度: Array.isArray(r) ? r.length : r, 毫秒: Date.now() - t }
  })(),
}

// ── A2. 请求体：图在各协议里落在对的地方 ──────────────────────────────
{
  const img = { type: 'image', data: 'QUJD', mimeType: 'image/png' }
  const context = {
    systemPrompt: 's',
    messages: [
      { role: 'user', content: '看看文档' },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'c1', name: 'office_render', arguments: {} },
          { type: 'toolCall', id: 'c2', name: 'read_file', arguments: {} },
        ],
      },
      { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: '第 1 页的图' }, img] },
      { role: 'toolResult', toolCallId: 'c2', content: [{ type: 'text', text: '文本' }] },
      { role: 'assistant', content: [{ type: 'text', text: '看完了' }] },
    ],
  }
  const chat = toOpenAI(context, { provider: 'p', id: 'm' }).messages
  const roles = chat.map((m) => m.role)
  const extra = chat.find((m) => m.role === 'user' && Array.isArray(m.content))
  out.openai = {
    角色顺序: roles.join(','),
    tool消息只有文本: chat.filter((m) => m.role === 'tool').every((m) => typeof m.content === 'string'),
    图在补的用户消息里: Boolean(extra?.content.some((c) => c.type === 'image_url' && c.image_url.url === 'data:image/png;base64,QUJD')),
    说明是哪次调用: Boolean(extra?.content.some((c) => c.type === 'text' && c.text.includes('c1'))),
  }
  const responses = toOpenAIResponses(context, { provider: 'p', id: 'm' }).input
  const kinds = responses.map((x) => x.type ?? x.role)
  out.responses = {
    顺序: kinds.join(','),
    图: responses.some((x) => x.role === 'user' && Array.isArray(x.content) && x.content.some((c) => c.type === 'input_image')),
  }
  const anthropic = toAnthropic(context, { provider: 'anthropic', id: 'claude' }).messages
  const results = anthropic.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'tool_result')
  const withImage = results.find((r) => r.tool_use_id === 'c1')
  out.anthropic = {
    图在tool_result里: Array.isArray(withImage?.content) && withImage.content.some((c) => c.type === 'image' && c.source?.data === 'QUJD'),
    文字也在: Array.isArray(withImage?.content) && withImage.content.some((c) => c.type === 'text' && c.text === '第 1 页的图'),
    没图的还是字符串: typeof results.find((r) => r.tool_use_id === 'c2')?.content === 'string',
    没有多出用户消息: !anthropic.some((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c.type === 'image')),
  }
}

// ── B. 完整 agent：同一轮 + 下一轮重建，看得了 / 看不了 ───────────────
class FakeCatalog extends Service {
  constructor(ctx) {
    super(ctx, 'catalog')
  }
  get servers() {
    return []
  }
  toolNamesFor() {
    return []
  }
}
const ctx = new Context()
ctx.plugin(storagePlugin, { path: join(home, 'db.sqlite') })
ctx.plugin(sessionsPlugin, { root: join(home, 'sessions') })
ctx.plugin(workspacePlugin, { root: work })
ctx.plugin(toolsPlugin)
ctx.plugin(FakeCatalog)
ctx.plugin(llmPlugin)
ctx.plugin(agentPlugin)
ctx.plugin(lookTools)
await new Promise((r) => setTimeout(r, 300))

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex')
const pics = [1, 2, 3, 4].map((i) => {
  writeFileSync(join(work, `pic${i}.png`), PNG)
  return { path: `pic${i}.png`, mime: 'image/png' }
})
ctx.tools.register({
  name: 'fake_look',
  delegation: {},
  risk: ['read'],
  description: '探针用：回四张图',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ text: '画好了四页', images: pics }),
})

/** 这一轮的剧本：先调两次 fake_look，再收口。每次调用都把送进模型的 context 记下来。 */
let captured = []
let script = []
let seenModel = null
ctx.llm.streamFn = (model, context) => {
  seenModel = { provider: model.provider, id: model.id }
  captured.push(context)
  const step = script.shift() ?? 'stop'
  const stream = new AssistantMessageEventStream()
  const partial = emptyAssistant(model)
  queueMicrotask(() => {
    stream.push({ type: 'start', partial })
    if (step === 'look') {
      partial.content.push({ type: 'toolCall', id: `call_${captured.length}`, name: 'fake_look', arguments: {} })
      stream.push({ type: 'toolcall_start', contentIndex: 0, partial })
      stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: partial.content[0], partial })
      partial.stopReason = 'toolUse'
      stream.push({ type: 'done', reason: 'toolUse', message: partial })
    } else {
      partial.content.push({ type: 'text', text: '看完了' })
      partial.stopReason = 'stop'
      stream.push({ type: 'done', reason: 'stop', message: partial })
    }
  })
  return stream
}

// 先空跑一轮拿到默认 Bot 用的是哪颗模型，好在目录里给它标上看不看得了图。
{
  const probe = await ctx.sessions.create({ title: '探模型', botId: 'default' })
  script = ['stop']
  await ctx.agents.send(probe, 'hi').catch(() => {})
}
const setVision = (on) => {
  ctx.llm.cached = [
    { provider: seenModel.provider, name: seenModel.provider, models: [{ id: seenModel.id, name: seenModel.id, input: on ? ['text', 'image'] : ['text'] }] },
  ]
}
const toolResults = (context) => (context?.messages ?? []).filter((m) => m.role === 'toolResult')
const blocks = (m) => (Array.isArray(m?.content) ? m.content : [])
const imagesOfMsg = (m) => blocks(m).filter((c) => c.type === 'image')

{
  setVision(true)
  const sid = await ctx.sessions.create({ title: '看得了', botId: 'default' })
  captured = []
  script = ['look', 'look', 'stop']
  await ctx.agents.send(sid, '画出来看看').catch(() => {})
  // 第三次调用（收口那次）送进去的 context 里，两次工具结果都在。
  const sameTurn = toolResults(captured[2])
  const toolNames = (captured[0]?.tools ?? []).map((t) => t.name)
  const events = await ctx.sessions.events(sid)
  const logged = events.filter((e) => e.type === 'tool/result').map((e) => e.data.images?.length ?? 0)
  captured = []
  script = ['stop']
  await ctx.agents.send(sid, '下一轮').catch(() => {})
  const replayed = toolResults(captured[0])
  out.vision = {
    同一轮每次都带图: sameTurn.length === 2 && sameTurn.every((m) => imagesOfMsg(m).length === 4),
    图带了字节: sameTurn.every((m) => imagesOfMsg(m).every((c) => typeof c.data === 'string' && c.data.length > 0)),
    日志里记了路径: logged.join(','),
    // 下一轮从日志重建：一共 8 张，只有最近 6 张带字节。
    重建后带字节的张数: replayed.reduce((n, m) => n + imagesOfMsg(m).length, 0),
    太远的换成说明: replayed.some((m) => blocks(m).some((c) => c.type === 'text' && c.text.includes('离现在太远'))),
    最近那次四张全在: imagesOfMsg(replayed[replayed.length - 1]).length === 4,
    工具表里有office_render: toolNames.includes('office_render'),
  }
}

{
  setVision(false)
  const sid = await ctx.sessions.create({ title: '看不了', botId: 'default' })
  captured = []
  script = ['look', 'stop']
  await ctx.agents.send(sid, '画出来看看').catch(() => {})
  const sameTurn = toolResults(captured[1])
  const toolNames = (captured[0]?.tools ?? []).map((t) => t.name)
  captured = []
  script = ['stop']
  await ctx.agents.send(sid, '下一轮').catch(() => {})
  const replayed = toolResults(captured[0])
  const noted = (m) => blocks(m).some((c) => c.type === 'text' && c.text.includes('看不了图'))
  out.blind = {
    同一轮一张图都没塞: sameTurn.length === 1 && imagesOfMsg(sameTurn[0]).length === 0,
    同一轮说明了: noted(sameTurn[0]),
    重建后也没塞: replayed.length === 1 && imagesOfMsg(replayed[0]).length === 0,
    重建后也说明了: noted(replayed[0]),
    // 画出来的图就是它全部的结果，看不了图的模型拿到它只会白调一次。
    工具表里没有office_render: !toolNames.includes('office_render'),
    工具表不是空的: toolNames.length > 0,
  }
}

// ── C. 真出图（机器上有 pdftoppm 或 LibreOffice 才跑） ─────────────────
{
  const { officeExecutable, pdftoppmExecutable } = await import('./src/workspace/render.ts')
  const hasToppm = Boolean(pdftoppmExecutable())
  const hasOffice = Boolean(officeExecutable())
  process.env.SATUWORK_RENDER_TIMEOUT_MS = '120000'
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun({ text: '第一页 封面', size: 64 })] }),
          new Paragraph({ children: [new PageBreak()] }),
          new Paragraph({ children: [new TextRun({ text: '第二页 目录', size: 64 })] }),
          ...Array.from({ length: 30 }, (_, i) => new Paragraph(`目录项 ${i + 1}`)),
          new Paragraph({ children: [new PageBreak()] }),
          new Paragraph({ children: [new TextRun({ text: '第三页 正文', size: 64 })] }),
        ],
      },
    ],
  })
  writeFileSync(join(work, 'three.docx'), await Packer.toBuffer(doc))
  const call = async (args) => ctx.tools.execute({ callId: `r${Math.random()}`, name: 'office_render', arguments: JSON.stringify(args), sessionId: 's' })
  // 一份三页的 PDF，每页画的东西位置不同：三页出来的图必须各不相同。
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib')
  const pdfDoc = await PDFDocument.create()
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 3; i++) {
    const page = pdfDoc.addPage([595, 842])
    page.drawRectangle({ x: 60, y: 842 - 150 * i, width: 300, height: 100, color: rgb(0.1 * i, 0.2, 0.5) })
    page.drawText(`PAGE ${i}`, { x: 60, y: 780, size: 36, font })
  }
  writeFileSync(join(work, 'three.pdf'), await pdfDoc.save())

  const pngWidth = (p) => readFileSync(join(work, p)).readUInt32BE(16)
  const describe = async (label, path) => {
    rmSync(join(work, '.satuwork', 'render'), { recursive: true, force: true })
    const r = await call({ path, pages: '1-3' })
    const imgs = r.images ?? []
    const bytes = imgs.map((i) => readFileSync(join(work, i.path)).toString('base64'))
    return {
      引擎: label,
      张数: imgs.length,
      宽度: imgs.map((i) => pngWidth(i.path)),
      三页各不相同: imgs.length === 3 && new Set(bytes).size === 3,
      说了共几页: (r.text ?? '').includes('共 3 页'),
      给人的缩略图: Boolean(imgs.length) && r.shot?.path === imgs[0].path,
      原话: (r.text ?? '').slice(0, 160),
    }
  }
  const withoutToppm = async (fn) => {
    const keep = process.env.SATUWORK_PDFTOPPM
    process.env.SATUWORK_PDFTOPPM = join(home, 'no-pdftoppm')
    try {
      return await fn()
    } finally {
      if (keep === undefined) delete process.env.SATUWORK_PDFTOPPM
      else process.env.SATUWORK_PDFTOPPM = keep
    }
  }
  out.real = { hasToppm, hasOffice }
  if (hasToppm) out.real.pdftoppm = await describe('pdftoppm', 'three.pdf')
  if (hasOffice) {
    // 退路：没有 pdftoppm，只剩 LibreOffice——三页必须真是三页，不是三张第一页。
    out.real.libreoffice = await withoutToppm(() => describe('libreoffice', 'three.pdf'))
    out.real.docx = await describe(hasToppm ? 'pdftoppm' : 'libreoffice', 'three.docx')
  }
  if (hasToppm || hasOffice) {
    const beyond = await call({ path: 'three.pdf', pages: '9' })
    const tooMany = await call({ path: 'three.pdf', pages: '1-7' })
    const notDoc = await call({ path: 'pic1.png' })
    const partial = await call({ path: 'three.pdf', pages: '3-5' })
    out.real.edges = {
      页码超了: beyond.text,
      一次太多: tooMany.text,
      不是文档: notDoc.text,
      部分越界: { 张数: (partial.images ?? []).length, 原话: partial.text },
    }
  }
  // 两样都没有：明说画不了。
  const keepSoffice = process.env.SATUWORK_SOFFICE
  process.env.SATUWORK_SOFFICE = join(home, 'no-soffice')
  process.env.SATUWORK_PDFTOPPM = join(home, 'no-pdftoppm')
  writeFileSync(join(work, 'other.docx'), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('x')] }] })))
  out.real.none = (await call({ path: 'other.docx' })).text
  if (keepSoffice === undefined) delete process.env.SATUWORK_SOFFICE
  else process.env.SATUWORK_SOFFICE = keepSoffice
}

console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
