/**
 * 席位这一侧的 generate_image。探针要 tsx 才 import 得了 .ts。
 *
 * 模型那条路（管家 / Gateway 的 /v1/images/generations）用一个假的顶掉：这一层要验的是
 * 「请求体拼得对不对、答复拆得对不对、图落没落盘、失败那一条怎么说」。授权、计费、上游
 * 地址在 e2e/manager.mjs 和 e2e/image-gen.mjs 里验。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { WorkspaceService } from './src/workspace/index.ts'
import { ToolService } from './src/tools/index.ts'
import * as imageTools from './src/tools/image.ts'
import { geminiMaskParts, imageDims, imageFileName, imageFromResponse, imageRequest, inputPathsOf, maskProblem, maskRegion, prepareMask } from './src/tools/image.ts'
import { decodeAlpha, encodeGray, jpegOrientation, unorient } from './src/tools/png.ts'
import { crc32, deflateSync, inflateSync } from 'node:zlib'

const out = {}
/** 一张 1x1 的 PNG，现场编码：探针里不放二进制样本。 */
const PIXEL = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex').toString('base64')

/**
 * 假上游这一次怎么答：sse / json / error / broken（流里只有一帧 error）/ gone（404 not found，老管家），
 * gemini（Gemini 的 SSE：先一张思考草稿、再一张真图、最后一帧用量）。
 */
let mode = 'sse'
let seen = null

const server = createServer((req, res) => {
  let s = ''
  req.on('data', (d) => (s += d))
  req.on('end', () => {
    seen = { path: req.url, auth: req.headers.authorization, body: JSON.parse(s || '{}') }
    if (mode === 'gone') {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'not found' }))
    }
    if (mode === 'error') {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: '描述违反了内容政策' } }))
    }
    if (mode === 'json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ created: 1, output_format: 'png', data: [{ b64_json: PIXEL }] }))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (mode === 'gemini') {
      const frame = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
      frame({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'ZHJhZnQ=' }, thought: true }] } }] })
      frame({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: PIXEL } }] }, finishReason: 'STOP' }] })
      frame({ usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 1290 } })
      return res.end()
    }
    if (mode === 'broken') {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: '上游炸了' } })}\n\n`)
      return res.end()
    }
    const fmt = seen.body.output_format
    res.write(`event: image_generation.completed\ndata: ${JSON.stringify({ type: 'image_generation.completed', b64_json: PIXEL, output_format: fmt, usage: { input_tokens: 9, output_tokens: 99 } })}\n\n`)
    res.end()
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
process.env.GATEWAY_URL = `http://127.0.0.1:${server.address().port}`
process.env.GATEWAY_API_KEY = 'sk_sw_e2e'

class FakeCatalog extends Service {
  constructor(ctx) {
    super(ctx, 'catalog')
    this.models = { image: { provider: 'openai', model: 'gpt-image-2', api: 'openai-images' } }
  }
}
// 桌面本地 Bot 那一档（没设 GATEWAY_LLM_URL）：原图总量上限 3 MB，huge.png 正好超一个字节。
delete process.env.GATEWAY_LLM_URL

const OPENAI = { provider: 'openai', model: 'gpt-image-2', api: 'openai-images' }
const GEMINI = { provider: 'google', model: 'gemini-3.1-flash-image', api: 'gemini-images' }

const root = mkdtempSync(join(tmpdir(), 'satu-image-'))
// 工作区里几张原图：用户发来的那种（uploads/）、一张 GIF（不认）、一张太大的。
mkdirSync(join(root, 'uploads', 's1'), { recursive: true })
writeFileSync(join(root, 'uploads', 's1', 'cat.png'), Buffer.from(PIXEL, 'base64'))
writeFileSync(join(root, 'uploads', 's1', 'dog.jpg'), Buffer.from(PIXEL, 'base64'))
writeFileSync(join(root, 'uploads', 's1', 'anim.gif'), Buffer.from('GIF89a'))
writeFileSync(join(root, 'uploads', 's1', 'huge.png'), Buffer.alloc(3 * 1024 * 1024 + 1))

/**
 * 只有 PNG 头的「图」：签名 + IHDR（宽、高、位深 8、颜色类型）+ IEND。maskProblem / imageDims
 * 只读这几个字节，不验 CRC，所以够用——而且看得懂每个字节是什么，比一坨样本好。
 */
function pngHead(w, h, colorType) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)])
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))])
}
/** 同理，一个只有 SOF0 的 JPEG 头：高 20、宽 30。前面垫一个 APP0，验「跳过别的段」。 */
const JPEG_HEAD = Buffer.from('ffd8' + 'ffe00004' + '0000' + 'ffc00011' + '08' + '0014' + '001e' + '03' + '011100' + '021100' + '031100', 'hex')
/**
 * 现场编一张真 PNG：每行轮着用 0–4 五种过滤器（验解码那边每一种都解对了），像素由 `pixel(x, y)`
 * 给出（一个字节数组，按颜色类型和位深排好）。`extra` 是插在 IDAT 前面的块（PLTE / tRNS）。
 */
function realPng(w, h, { colorType, bitDepth = 8, pixel, extra = [] }) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])) >>> 0)
    return Buffer.concat([len, Buffer.from(type), data, crc])
  }
  const bpp = Math.max(1, (pixel(0, 0).length))
  const rows = []
  let prev = Buffer.alloc(w * bpp)
  for (let y = 0; y < h; y++) {
    const line = Buffer.concat(Array.from({ length: w }, (_, x) => Buffer.from(pixel(x, y))))
    const f = y % 5
    const out = Buffer.alloc(line.length)
    for (let i = 0; i < line.length; i++) {
      const a = i >= bpp ? line[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      const p = a + b - c
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c
      const pred = [0, a, b, (a + b) >> 1, paeth][f]
      out[i] = (line[i] - pred) & 0xff
    }
    rows.push(Buffer.from([f]), out)
    prev = line
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = bitDepth
  ihdr[9] = colorType
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    ...extra.map(([t, d]) => chunk(t, d)),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
/** 90×60 的照片（不透明）和它的蒙版：右下角 x 60–89、y 40–59 透明。 */
const inHole = (x, y) => x >= 60 && y >= 40
const PHOTO = realPng(90, 60, { colorType: 6, pixel: (x, y) => [x, y, 128, 255] })
const MASK90 = realPng(90, 60, { colorType: 6, pixel: (x, y) => [0, 0, 0, inHole(x, y) ? 0 : 255] })
writeFileSync(join(root, 'uploads', 's1', 'photo.png'), PHOTO)
writeFileSync(join(root, 'uploads', 's1', 'mask90.png'), MASK90)
writeFileSync(join(root, 'uploads', 's1', 'mask-solid.png'), realPng(90, 60, { colorType: 6, pixel: () => [0, 0, 0, 255] }))

// PIXEL 本身是 1×1 的 RGBA，正好是 cat.png 的一张合格蒙版。
writeFileSync(join(root, 'uploads', 's1', 'mask-cat.png'), Buffer.from(PIXEL, 'base64'))
writeFileSync(join(root, 'uploads', 's1', 'mask-big.png'), pngHead(2, 2, 6))
writeFileSync(join(root, 'uploads', 's1', 'mask-rgb.png'), pngHead(1, 1, 2))
// 头是对的（90×60、RGBA），但没有像素数据：OpenAI 那条放行（上游自己判），Gemini 那条读不出来。
writeFileSync(join(root, 'uploads', 's1', 'mask-head90.png'), pngHead(90, 60, 6))
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }) } catch {} })
const ctx = new Context()
ctx.plugin(WorkspaceService, { root })
ctx.plugin(ToolService)
ctx.plugin(FakeCatalog)
ctx.plugin(imageTools)
await new Promise((r) => setTimeout(r, 80))

const call = (args) => ctx.tools.execute({ callId: 'c1', name: 'generate_image', arguments: JSON.stringify(args), sessionId: 's1' })

// ── 1. 请求体：默认值、透明背景、参数校验（纯函数）──────────────────────
{
  const m = OPENAI
  const plain = imageRequest(m, { prompt: '一只猫' })
  const clear = imageRequest(m, { prompt: '图标', transparent: true })
  out.request = {
    plain: plain.body,
    plainFormat: plain.format,
    clear: clear.body,
    clearFormat: clear.format,
    empty: imageRequest(m, { prompt: '  ' }).error ?? null,
    jpegClear: imageRequest(m, { prompt: 'x', transparent: true, format: 'jpeg' }).error ?? null,
    tooLong: imageRequest(m, { prompt: 'x'.repeat(5000) }).error ?? null,
    badSize: imageRequest(m, { prompt: 'x', size: '9x9' }).body.size,
  }
}

// ── 2. 答复：流、整块 JSON、流里的错（纯函数）────────────────────────
out.parse = {
  sse: imageFromResponse(`event: x\ndata: {"type":"image_generation.partial_image","b64_json":"half"}\n\ndata: {"type":"image_generation.completed","b64_json":"full","output_format":"png"}\n\n`),
  json: imageFromResponse(JSON.stringify({ data: [{ b64_json: 'blob' }], output_format: 'webp' })),
  err: imageFromResponse(`data: {"type":"error","error":{"message":"坏了"}}\n\n`),
  empty: imageFromResponse(''),
}

// ── 3. 文件名 ─────────────────────────────────────────────────────────
out.names = {
  given: imageFileName('封面 v2.png', 'jpeg'),
  slashes: imageFileName('../a/b', 'png'),
  none: imageFileName('', 'webp'),
}

// ── 4. 整条：打模型那条路，图落进 images/，给模型一行字、给人一个文件 ──
{
  mode = 'sse'
  const r = await call({ prompt: '一只戴帽子的猫', name: '猫' })
  const f = r.files?.[0]
  out.happy = {
    path: seen?.path,
    auth: seen?.auth,
    body: seen?.body,
    text: r.text,
    failed: !!r.failed,
    file: f ?? null,
    onDisk: !!f && existsSync(join(root, f.path)) && readFileSync(join(root, f.path)).equals(Buffer.from(PIXEL, 'base64')),
  }
  // 同名再画一张：不覆盖。
  const again = await call({ prompt: '又一只', name: '猫' })
  out.again = again.files?.[0]?.name ?? null
}

// ── 5. 非流式的整块 JSON 也认，格式以答复为准 ─────────────────────────
{
  mode = 'json'
  const r = await call({ prompt: '一只猫' })
  out.json = { name: r.files?.[0]?.name ?? '', failed: !!r.failed }
}

// ── 6. 失败：上游 400、流里报错、老管家没有这条路 ─────────────────────
{
  mode = 'error'
  const bad = await call({ prompt: '一只猫' })
  mode = 'broken'
  const broken = await call({ prompt: '一只猫' })
  mode = 'gone'
  const gone = await call({ prompt: '一只猫' })
  out.fail = {
    bad: { text: bad.text, files: bad.files ?? null },
    broken: { text: broken.text, files: broken.files ?? null },
    gone: gone.text,
  }
}

// ── 7. Gemini：请求体、答复（跳过思考草稿）、被拦下 ─────────────────
{
  const plain = imageRequest(GEMINI, { prompt: '一只猫', size: '1536x1024', quality: 'high' })
  const inputs = [{ path: 'uploads/s1/cat.png', mime: 'image/png', b64: 'QUJD' }]
  const edit = imageRequest(GEMINI, { prompt: '把猫换成狗' }, inputs)
  out.gemini = {
    plain: plain.body,
    edit: edit.body,
    editFlag: edit.edit,
    clear: imageRequest(GEMINI, { prompt: 'x', transparent: true }).error ?? null,
    parse: imageFromResponse(
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '先想想', thought: true }, { inlineData: { mimeType: 'image/png', data: 'draft' }, thought: true }] } }] })}\n\n` +
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'final' } }] } }] })}\n\n`,
      'gemini-images',
    ),
    blocked: imageFromResponse(`data: ${JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })}\n\n`, 'gemini-images'),
    finish: imageFromResponse(`data: ${JSON.stringify({ candidates: [{ finishReason: 'IMAGE_SAFETY' }] })}\n\n`, 'gemini-images'),
    jsonArray: imageFromResponse(JSON.stringify([{ candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/webp', data: 'w' } }] } }] }]), 'gemini-images'),
  }

  ctx.catalog.models.image = GEMINI
  mode = 'gemini'
  const r = await call({ prompt: '一只猫', name: '双子猫' })
  out.geminiCall = { path: seen?.path, body: seen?.body, file: r.files?.[0] ?? null, text: r.text }
  ctx.catalog.models.image = OPENAI
}

// ── 8. 改图：原图从工作区读、两家各拼各的、路由换成 edits ─────────────
{
  const inputs = [{ path: 'uploads/s1/cat.png', mime: 'image/png', b64: 'QUJD' }]
  const o = imageRequest(OPENAI, { prompt: '加一顶帽子' }, inputs)
  out.openaiEdit = { body: o.body, edit: o.edit }
  out.paths = { one: inputPathsOf('a.png'), dedup: inputPathsOf(['a.png', ' a.png ', '', 'b.png']), none: inputPathsOf(undefined) }

  mode = 'sse'
  const r = await call({ prompt: '加一顶帽子', images: ['uploads/s1/cat.png', 'uploads/s1/dog.jpg'] })
  const sent = seen?.body?.images ?? []
  out.editCall = {
    path: seen?.path,
    urls: sent.map((x) => x.image_url.slice(0, 22)),
    carried: sent[0]?.image_url === `data:image/png;base64,${PIXEL}`,
    size: seen?.body?.size,
    text: r.text,
    file: r.files?.[0] ?? null,
    originalKept: readFileSync(join(root, 'uploads', 's1', 'cat.png')).equals(Buffer.from(PIXEL, 'base64')),
  }

  seen = null
  const gif = await call({ prompt: 'x', images: ['uploads/s1/anim.gif'] })
  const escape = await call({ prompt: 'x', images: ['../../etc/passwd.png'] })
  const missing = await call({ prompt: 'x', images: ['uploads/s1/nope.png'] })
  const many = await call({ prompt: 'x', images: ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'] })
  const huge = await call({ prompt: 'x', images: ['uploads/s1/huge.png'] })
  out.inputFail = { gif: gif.text, escape: escape.text, missing: missing.text, many: many.text, huge: huge.text, hit: seen !== null }
}

// ── 9. 局部重绘：蒙版要 PNG、带透明、和原图一样大；Gemini 不收 ───────
{
  const cat = { path: 'uploads/s1/cat.png', mime: 'image/png', b64: 'QUJD' }
  const mask = { path: 'uploads/s1/mask-cat.png', mime: 'image/png', b64: 'TUFTSw==' }
  out.mask = {
    body: imageRequest(OPENAI, { prompt: '换成狗' }, [cat], mask).body?.mask ?? null,
    alone: imageRequest(OPENAI, { prompt: 'x' }, [], mask).error ?? null,
    // 这张「蒙版」不是真 PNG：Gemini 那条要靠像素画黑白蒙版，读不出来就得拦下。
    gemini: imageRequest(GEMINI, { prompt: 'x' }, [cat], mask).error ?? null,
    ok: maskProblem(pngHead(4, 3, 6), pngHead(4, 3, 2)) ?? null,
    grayAlpha: maskProblem(pngHead(4, 3, 4), undefined) ?? null,
    noAlpha: maskProblem(pngHead(4, 3, 2), undefined) ?? null,
    notPng: maskProblem(JPEG_HEAD, undefined) ?? null,
    sizeVsPng: maskProblem(pngHead(4, 3, 6), pngHead(5, 3, 6)) ?? null,
    sizeVsJpeg: maskProblem(pngHead(4, 3, 6), JPEG_HEAD) ?? null,
    jpegDims: imageDims(JPEG_HEAD) ?? null,
    webpDims: imageDims(Buffer.from('RIFF0000WEBP')) ?? null,
  }

  mode = 'sse'
  seen = null
  const r = await call({ prompt: '换成狗', images: ['uploads/s1/cat.png'], mask: 'uploads/s1/mask-cat.png' })
  out.maskCall = {
    path: seen?.path,
    mask: seen?.body?.mask?.image_url ?? null,
    images: (seen?.body?.images ?? []).length,
    text: r.text,
  }
  seen = null
  const big = await call({ prompt: 'x', images: ['uploads/s1/cat.png'], mask: 'uploads/s1/mask-big.png' })
  const rgb = await call({ prompt: 'x', images: ['uploads/s1/cat.png'], mask: 'uploads/s1/mask-rgb.png' })
  const jpg = await call({ prompt: 'x', images: ['uploads/s1/cat.png'], mask: 'uploads/s1/dog.jpg' })
  out.maskFail = { big: big.text, rgb: rgb.text, jpg: jpg.text, hit: seen !== null }
}

// ── 10. PNG 读写与 Gemini 的局部重绘 ─────────────────────────────────
{
  const rgba = decodeAlpha(MASK90)
  const holeOk = !('error' in rgba) && Array.from({ length: 60 * 90 }, (_, i) => (rgba.alpha[i] === 0) === inHole(i % 90, Math.floor(i / 90))).every(Boolean)
  // 灰度 + 透明 16 位（alpha 高字节）、调色板 + tRNS。
  const ga16 = decodeAlpha(realPng(4, 3, { colorType: 4, bitDepth: 16, pixel: (x) => [9, 9, x < 2 ? 0 : 255, 7] }))
  const pal = decodeAlpha(realPng(4, 3, { colorType: 3, pixel: (x) => [x % 2], extra: [['PLTE', Buffer.from([0, 0, 0, 255, 255, 255])], ['tRNS', Buffer.from([0])]] }))
  const gray = encodeGray(3, 2, Uint8Array.from([0, 255, 0, 255, 0, 255]))
  // 灰度图的 IDAT 自己解一遍：每行一个 0 过滤字节 + 像素。
  const idatAt = gray.indexOf('IDAT')
  const grayRaw = inflateSync(gray.subarray(idatAt + 4, idatAt + 4 + gray.readUInt32BE(idatAt - 4)))
  out.png = {
    holeOk,
    ga16: 'error' in ga16 ? ga16.error : Array.from(ga16.alpha),
    pal: 'error' in pal ? pal.error : Array.from(pal.alpha),
    grayNoAlpha: decodeAlpha(gray).error ?? null,
    grayType: gray[25],
    grayRaw: Array.from(grayRaw),
    notPng: decodeAlpha(Buffer.from('nope')).error ?? null,
    region: rgba.error ? null : maskRegion(rgba),
    empty: maskRegion({ width: 2, height: 2, alpha: Uint8Array.from([255, 255, 255, 255]) }) ?? null,
    center: maskRegion({ width: 3, height: 3, alpha: Uint8Array.from([255, 255, 255, 255, 0, 255, 255, 255, 255]) }),
  }

  const photo = { path: 'uploads/s1/photo.png', mime: 'image/png', b64: PHOTO.toString('base64') }
  const m90 = { path: 'uploads/s1/mask90.png', mime: 'image/png', b64: MASK90.toString('base64') }
  const parts = geminiMaskParts([photo], m90, '换成一只猫')
  const bw = Buffer.from(parts[1].inlineData.data, 'base64')
  const bwAt = bw.indexOf('IDAT')
  const bwRaw = inflateSync(bw.subarray(bwAt + 4, bwAt + 4 + bw.readUInt32BE(bwAt - 4)))
  const bwOk = Array.from({ length: 60 * 90 }, (_, i) => bwRaw[Math.floor(i / 90) * 91 + 1 + (i % 90)] === (inHole(i % 90, Math.floor(i / 90)) ? 255 : 0)).every(Boolean)
  out.geminiMask = {
    count: parts.length,
    first: parts[0].inlineData.data === photo.b64,
    bwDims: imageDims(bw),
    bwType: bw[25],
    bwOk,
    text: parts[2].text,
  }

  ctx.catalog.models.image = GEMINI
  mode = 'gemini'
  seen = null
  const r = await call({ prompt: '换成一只猫', images: ['uploads/s1/photo.png'], mask: 'uploads/s1/mask90.png' })
  const sent = seen?.body?.contents?.[0]?.parts ?? []
  out.geminiMaskCall = { path: seen?.path, parts: sent.length, text: sent[2]?.text ?? '', file: r.files?.[0] ?? null }
  seen = null
  const solid = await call({ prompt: 'x', images: ['uploads/s1/photo.png'], mask: 'uploads/s1/mask-solid.png' })
  const unreadable = await call({ prompt: 'x', images: ['uploads/s1/photo.png'], mask: 'uploads/s1/mask-head90.png' })
  out.geminiMaskFail = { solid: solid.text, unreadable: unreadable.text, hit: seen !== null }
  ctx.catalog.models.image = OPENAI
  mode = 'sse'
  // OpenAI 那条也认「一个透明的地方都没有」。
  const solidOpenai = await call({ prompt: 'x', images: ['uploads/s1/photo.png'], mask: 'uploads/s1/mask-solid.png' })
  out.openaiSolid = solidOpenai.text
}

// ── 11. JPEG 的段、EXIF 方向、tRNS 只认真块 ───────────────────────────
{
  /** 一个 JPEG 头：可选的 EXIF 方向段、可选的填充字节和独立标记，然后一个 SOF0（宽 w、高 h）。 */
  const jpeg = (w, h, { orientation, fill = false } = {}) => {
    const parts = [Buffer.from('ffd8', 'hex')]
    if (orientation) {
      // TIFF（大端）：头 8 字节，IFD0 在偏移 8，一条 0x0112 SHORT。
      const tiff = Buffer.alloc(8 + 2 + 12 + 4)
      tiff.write('MM', 0, 'latin1')
      tiff.writeUInt16BE(42, 2)
      tiff.writeUInt32BE(8, 4)
      tiff.writeUInt16BE(1, 8)
      tiff.writeUInt16BE(0x0112, 10)
      tiff.writeUInt16BE(3, 12)
      tiff.writeUInt32BE(1, 14)
      tiff.writeUInt16BE(orientation, 18)
      const data = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
      const len = Buffer.alloc(2)
      len.writeUInt16BE(data.length + 2)
      parts.push(Buffer.from('ffe1', 'hex'), len, data)
    }
    // 填充字节（连续的 0xFF）和一个独立标记（RST0）：以前的扫描会把它们后面的字节当长度读。
    if (fill) parts.push(Buffer.from('ffffffd0', 'hex'))
    const sof = Buffer.from('ffc0001108000000000301', 'hex')
    sof.writeUInt16BE(h, 5)
    sof.writeUInt16BE(w, 7)
    parts.push(sof, Buffer.from('0111000211000311000000', 'hex'))
    return Buffer.concat(parts)
  }
  // 竖着拍、按横图存：文件里 4×2，方向 6（顺时针 90°），屏幕上 2×4。人在屏幕上涂的是 2×4 的蒙版，
  // 透明的是屏幕上的 (1, 0)——换回文件方向应该是 (0, 0)。
  const shownMask = realPng(2, 4, { colorType: 6, pixel: (x, y) => [0, 0, 0, x === 1 && y === 0 ? 0 : 255] })
  const photo6 = jpeg(4, 2, { orientation: 6 })
  const turned = prepareMask(shownMask, photo6)
  const back = 'bytes' in turned ? decodeAlpha(turned.bytes) : turned
  // 方向 8（逆时针 90°）：文件里 (0, 0) 显示在 (0, w-1)。方向 3（180°）：(0, 0) 显示在 (w-1, h-1)。
  const u8 = unorient({ width: 2, height: 4, alpha: Uint8Array.from([255, 255, 255, 255, 255, 255, 0, 255]) }, 8, 4, 2)
  const u3 = unorient({ width: 4, height: 2, alpha: Uint8Array.from([255, 255, 255, 255, 255, 255, 255, 0]) }, 3, 4, 2)
  // RGB 的 PNG（没有透明），IDAT 里碰巧有 `tRNS` 这四个字节：以前按字节搜会当成有透明。
  const rgbWithTrnsBytes = Buffer.concat([pngHead(1, 1, 2).subarray(0, 33), (() => {
    const data = Buffer.from('xxtRNSxx')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    return Buffer.concat([len, Buffer.from('IDAT'), data, Buffer.alloc(4)])
  })(), pngHead(1, 1, 2).subarray(33)])
  out.jpeg = {
    orientation: jpegOrientation(photo6),
    noExif: jpegOrientation(jpeg(4, 2)),
    dimsWithFill: imageDims(jpeg(30, 20, { fill: true })) ?? null,
    dims6: imageDims(photo6) ?? null,
    turned: 'error' in back ? back.error : { w: back.width, h: back.height, alpha: Array.from(back.alpha) },
    // 蒙版照文件方向涂的（4×2）也认，不转。
    storedOk: maskProblem(realPng(4, 2, { colorType: 6, pixel: (x) => [0, 0, 0, x ? 255 : 0] }), photo6) ?? null,
    // 两个方向都对不上：报的是屏幕上看到的尺寸。
    wrong: maskProblem(realPng(3, 3, { colorType: 6, pixel: () => [0, 0, 0, 0] }), photo6) ?? null,
    u8: Array.from(u8.alpha),
    u3: Array.from(u3.alpha),
    trnsBytes: maskProblem(rgbWithTrnsBytes, undefined) ?? null,
  }
}

// ── 12. 平台没开：工具照样注册，但会明说 ──────────────────────────────
{
  ctx.catalog.models.image = null
  seen = null
  const r = await call({ prompt: '一只猫' })
  out.off = { text: r.text, hit: seen !== null }
}

server.close()
console.log('__RESULT__' + JSON.stringify(out))
