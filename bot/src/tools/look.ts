import { copyFile, link, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, extname, join, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { safeSegment } from '../workspace/index.ts'
import { RenderError, renderPages, renderableOf, type PageImage } from '../workspace/render.ts'
import { fail, registerTool } from './common.ts'
import type { ToolCall } from './index.ts'

/**
 * `office_render`：把 Word / Excel / PPT / PDF 的某几页画成图，交给模型自己看。
 *
 * 改文档最缺的一环是验收。read_file 读出来的是抽取后的文字，看不出表格错没错位、字有没有
 * 溢出格子、一页 PPT 有没有塞爆、分页对不对——而人点开文件第一眼看的恰恰是这些。这把工具
 * 让模型在交差之前自己看一眼。
 *
 * 链路：Office → PDF（workspace/render.ts 的 renderToPdf，和界面预览是同一份缓存）→ 指定
 * 几页 → PNG（pdftoppm，没有就退到 LibreOffice）。图放在工作区的 `.satuwork/render/` 下：
 * 送进模型的那一层（agent 的 loadImage）只认工作区路径；`.satuwork` 又不进文件树、不算
 * 产出（common.ts 的 SKIPPED_DIRS）。
 *
 * 图送不送得进模型，看**这一轮的模型**有没有视觉——这把工具只报路径（ToolResult.images），
 * 判断在 agent 那一层。看不了的模型收到的是一句说明，不会因为塞了图让整轮请求被拒。
 */
export const name = 'satu-tools-look'
export const inject = ['tools', 'workspace']

/** 一次最多画几页。一页一千多 token，核对排版用不着一次看完整份。 */
const MAX_PAGES = 6
/** 不给 pages 时看前几页。 */
const DEFAULT_PAGES = 3
/**
 * 出图宽度（像素）。A4 在这个宽度下正文字号约十几像素，看得清表格线和错位；再宽只是
 * 多花 token——模型那边多半还会再缩一遍。
 */
const WIDTH = 1024

/**
 * 一条会话最多留几张 office_render 的图。
 *
 * 渲染缓存（`.satuwork/render/<键>/`）会被修剪，而会话日志里的 images、消息底下那张缩略图
 * 指着的都是这里的路径——所以每次交出去的图另存一份到会话自己的目录下（硬链接，不占双份
 * 盘），只按这条会话自己的份数修剪。浏览器截图也是按会话存的（browser/<会话>/），一个道理。
 * 更早的缩略图过了这个数会没，那时它早就不在模型的上下文里了（MAX_LIVE_TOOL_IMAGES）。
 */
const KEPT_PER_SESSION = 200

/** `"1-3,5"` → [1,2,3,5]（去重、从小到大）。写错的段直接报错，不静默丢掉。 */
export function parsePages(spec: unknown): number[] {
  if (spec === undefined || spec === null || spec === '') return Array.from({ length: DEFAULT_PAGES }, (_, i) => i + 1)
  if (typeof spec === 'number') return [Math.trunc(spec)]
  // 去重之后再和上限比：「1-4,2-4」只涉及四页，不该按七个数算成超了。
  const out = new Set<number>()
  for (const part of String(spec).split(/[,，\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:\s*[-~–]\s*(\d+))?$/.exec(part)
    if (!m) fail(`pages 写得不对：「${part}」。写成 "1-3" 或 "2,5" 这样。`)
    const from = Number(m[1])
    const to = m[2] ? Number(m[2]) : from
    if (from < 1 || to < from) fail(`pages 写得不对：「${part}」。页码从 1 开始，范围要从小到大。`)
    // 先按上限截住：「1-100000」不该在这儿先摆出十万个数。
    for (let p = from; p <= to && out.size <= MAX_PAGES; p++) out.add(p)
  }
  return [...out].sort((a, b) => a - b)
}

/** 把渲染缓存里的图另存到会话自己的目录（见 KEPT_PER_SESSION），回新的绝对路径。 */
async function keepForSession(root: string, sessionId: string, source: string, images: PageImage[]): Promise<PageImage[]> {
  const dir = join(root, '.satuwork', 'render', 'sessions', safeSegment(sessionId))
  await mkdir(dir, { recursive: true })
  // 文件名打头是时间戳：按名字排就是按先后排，修剪时不用再 stat。
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')
  const stem = safeSegment(basename(source, extname(source))).slice(0, 40)
  const out: PageImage[] = []
  for (const img of images) {
    const dest = join(dir, `${stamp}-${Math.random().toString(36).slice(2, 6)}-${stem}-p${img.page}.png`)
    // 硬链接不占双份盘；跨盘、或者文件系统不支持时退回复制。
    await link(img.file, dest).catch(() => copyFile(img.file, dest))
    out.push({ page: img.page, file: dest })
  }
  const names = (await readdir(dir)).filter((n) => n.endsWith('.png')).sort()
  for (const n of names.slice(0, Math.max(0, names.length - KEPT_PER_SESSION))) await rm(join(dir, n), { force: true })
  return out
}

export function apply(ctx: Context) {
  const show = (path: string) => ctx.workspace.show(path).split(sep).join('/')

  registerTool(
    ctx,
    {
      name: 'office_render',
      delegation: {},
      vision: true,
      risk: ['read'],
      description:
        '把 Word / Excel / PPT / PDF 的某几页画成图片给你自己看，用来检查排版：新建或改完文档之后，' +
        '看一眼表格有没有错位、字有没有溢出、每页 PPT 是不是塞得太满、分页对不对。' +
        `一次最多 ${MAX_PAGES} 页，不给 pages 就看前 ${DEFAULT_PAGES} 页。只读内容用 read_file，不用画图。` +
        '模型看不了图时，只会收到一句说明。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，相对工作区根目录。' },
          pages: { type: 'string', description: `看哪几页，如 "1-3" 或 "2,5"。默认前 ${DEFAULT_PAGES} 页。` },
        },
        required: ['path'],
      },
    },
    async ({ path, pages }: { path?: string; pages?: unknown }, call: ToolCall) => {
      if (!path) fail('缺少 path 参数')
      const file = ctx.workspace.resolve(path)
      if (!renderableOf(file) && extname(file).toLowerCase() !== '.pdf') {
        fail(`${show(file)} 不是 Word / Excel / PPT / PDF，这把工具画不了它。`)
      }
      const wanted = parsePages(pages)
      if (wanted.length > MAX_PAGES) fail(`一次最多画 ${MAX_PAGES} 页，这次要了 ${wanted.length} 页以上。分几次看。`)
      let got: Awaited<ReturnType<typeof renderPages>>
      try {
        got = await renderPages(file, wanted, join(ctx.workspace.root, '.satuwork', 'render'), WIDTH)
      } catch (e) {
        if (e instanceof RenderError) fail(`${show(file)} 画不出来：${e.message}`)
        throw e
      }
      const kept = await keepForSession(ctx.workspace.root, call.sessionId, file, got.images)
      const images = kept.map((i) => ({ path: show(i.file), mime: 'image/png' }))
      const skipped = wanted.filter((p) => !got.images.some((i) => i.page === p))
      return {
        text:
          `${show(file)} 共 ${got.total} 页，下面是第 ${got.images.map((i) => i.page).join('、')} 页的图。` +
          (skipped.length ? `第 ${skipped.join('、')} 页不存在，跳过了。` : '') +
          (renderableOf(file)
            ? '这是 LibreOffice 画的：字体和分页可能和 Word / WPS / PowerPoint 里有细小出入，版式大体一致。'
            : '') +
          (got.total > got.images[got.images.length - 1].page ? '要看后面的页，换 pages 再调一次。' : ''),
        images,
        refs: [{ path: show(file), name: basename(file) }],
        // 第一页也给人看一眼：消息底下那条缩略图，人就知道 Bot 刚才看的是哪一页。
        shot: { path: images[0].path, name: `${basename(file)} 第 ${got.images[0].page} 页` },
      }
    },
  )
}
