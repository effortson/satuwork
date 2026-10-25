import type { Context } from '@deepseek-ai/cordis'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { Readable } from 'node:stream'
import { WorkspaceError } from '../workspace/index.ts'
import { docKindOf, extractDocument } from '../workspace/extract.ts'
import { RenderError, renderToPdf, renderableOf } from '../workspace/render.ts'
import { dispositionName, replyFileError } from './http.ts'

/** 工作区文件那几条路：上传附件、列目录、预览（含提取文本和渲染 PDF）、删除。都过 workspace 服务的越界检查。 */
export function workspaceRoutes(ctx: Context) {
  /**
   * 上传附件。裸字节进 body，文件名走 `x-filename`（URL 编码）。
   *
   * **不用 multipart**：这条路只传一个文件，multipart 要么拉个解析依赖，要么自己写一个
   * 状态机去切 boundary——都是为了一个这里根本用不上的「多部分」语义付钱。
   *
   * 文件落进工作区（`uploads/<sessionId>/`），返回相对路径。之后模型用 read_file 读它，
   * 浏览器用下面那条 GET 预览它——**同一份字节，没有第二处副本**。
   */
  ctx.server.post('/api/sessions/:id/files', async (req, res) => {
    const sessionId = req.params.id
    // 会话必须真的存在。Gateway 那边已经按账号校过一遍，这里再挡一次是因为
    // 「往哪个目录写」是这条路唯一的副作用，不该由一个没人认领的 id 决定。
    try {
      await ctx.sessions.events(sessionId)
    } catch {
      res.status = 404
      res.json({ error: `没有这个会话：${sessionId}` })
      return
    }
    const raw = req.headers.get('x-filename') ?? ''
    let filename = raw
    try {
      filename = decodeURIComponent(raw)
    } catch {
      // 不是合法的百分号编码就按原样用，safeName 会再洗一遍。
    }
    try {
      const saved = await ctx.workspace.saveUpload(sessionId, filename, req.body)
      ctx.logger?.info?.(`upload: ${sessionId} ← ${saved.path}（${saved.size} 字节）`)
      res.json(saved)
    } catch (e) {
      if (e instanceof WorkspaceError) {
        res.status = 400
        res.json({ error: e.message })
        return
      }
      throw e
    }
  })

  /**
   * 列工作区里的一层目录，给界面右栏那棵文件树用。
   *
   * **一次一层**（见 workspace/index.ts 的 list）：展开哪个目录就取哪个目录。
   * 点开某个文件走的仍是下面那条预览——两处看到的是同一个工作区、同一份字节。
   */
  ctx.server.get('/api/workspace/list', async (req, res) => {
    try {
      res.json(await ctx.workspace.list(req.query.get('path') ?? ''))
    } catch (e) {
      replyFileError(res, e, '目录不存在', '列不出来')
    }
  })

  /**
   * 预览工作区里的一个文件。上传进来的和 Bot 自己写出来的走的是同一条路——
   * 它们本来就在同一个目录里，没有理由分两套。
   *
   * `?download=1` 强制另存。除此之外，能不能内联由**扩展名白名单**说了算
   * （见 workspace/index.ts 的 INLINE）：SVG 和 HTML 不在里面，它们能带脚本。
   */
  ctx.server.get('/api/workspace/file', async (req, res) => {
    const path = req.query.get('path') ?? ''
    if (!path.trim()) {
      res.status = 400
      res.json({ error: 'path 不能为空' })
      return
    }
    /**
     * `?as=text`：把 Word / Excel / PPT / PDF 提取成文本回给界面预览。
     *
     * 浏览器打不开这几种格式，而对一份刚生成的报表说「下载下来看吧」是很差的答复。
     * 走的是 `read` 工具用的**同一套提取**（workspace/extract.ts），所以界面上看到的
     * 和模型读到的是同一份东西——内容对不上时，能一眼看出是提取的问题还是模型的问题。
     *
     * **摆在 open() 前面**：open() 会当场开一个读流，而这条路根本不读字节，
     * 放在后面等于每次预览都漏一个 fd。
     */
    if (req.query.get('as') === 'text') {
      const kind = docKindOf(path)
      if (!kind) {
        res.status = 415
        res.json({ error: '这种格式没法提取成文本' })
        return
      }
      try {
        const out = await extractDocument(ctx.workspace.resolve(path), kind)
        res.json({ text: out.text, note: out.truncated ? `内容较长，只提取了前 ${out.parts} ${out.unit}。` : '' })
      } catch (e) {
        replyFileError(res, e, '文件不存在', `提取失败：${(e as Error).message}`)
      }
      return
    }
    /**
     * `?as=pdf`：把 Word / Excel / PPT 渲染成 PDF 给界面预览（workspace/render.ts）。
     *
     * 和上面 `as=text` 是一对：那条是「模型读到的是什么」，这条是「它长什么样」。这台
     * 机器没装 LibreOffice 时回 **501**——界面据此退回提取文本，不当成出错。
     *
     * 同样摆在 open() 前面，理由同上。
     */
    if (req.query.get('as') === 'pdf') {
      if (!renderableOf(path)) {
        res.status = 415
        res.json({ error: '这种格式没法渲染成 PDF' })
        return
      }
      let pdf: string
      try {
        pdf = await renderToPdf(ctx.workspace.resolve(path))
      } catch (e) {
        const err = e as NodeJS.ErrnoException
        if (e instanceof RenderError) {
          res.status = e.reason === 'unavailable' ? 501 : e.reason === 'too-big' ? 413 : 422
          res.json({ error: e.message, reason: e.reason })
          return
        }
        replyFileError(res, e, '文件不存在', `渲染失败：${err.message}`)
        return
      }
      const info = await stat(pdf)
      const name = basename(path).replace(/\.[^.]+$/, '') + '.pdf'
      return new Response(Readable.toWeb(createReadStream(pdf)) as ReadableStream<Uint8Array>, {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-length': String(info.size),
          'content-disposition': `inline; ${dispositionName(name)}`,
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-store',
        },
      })
    }
    let file: Awaited<ReturnType<typeof ctx.workspace.open>>
    try {
      file = await ctx.workspace.open(path)
    } catch (e) {
      replyFileError(res, e, '文件不存在', '读不出来')
      return
    }
    const inline = file.inline && req.query.get('download') !== '1'
    return new Response(file.stream, {
      status: 200,
      headers: {
        'content-type': file.contentType,
        'content-length': String(file.size),
        'content-disposition': `${inline ? 'inline' : 'attachment'}; ${dispositionName(file.name)}`,
        // 声明的类型就是最终类型。允许嗅探，等于让一个改名成 .png 的 HTML
        // 重新变回 HTML——白名单当场作废。
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      },
    })
  })

  /**
   * 删掉工作区里的一个文件或目录（界面右栏那棵树上，鼠标移上去出来的那颗）。
   *
   * 和上面那两条同一个工作区、同一道越界检查（workspace 服务），差别只在这条是
   * **有副作用**的：删掉就没了，工作区里没有回收站。所以确认在界面上做（那颗按钮
   * 弹一次框），这里不再问第二遍——两处都问的话，人只会把第二问当成噪音点掉。
   */
  ctx.server.delete('/api/workspace/file', async (req, res) => {
    const path = req.query.get('path') ?? ''
    if (!path.trim()) {
      res.status = 400
      res.json({ error: 'path 不能为空' })
      return
    }
    try {
      const gone = await ctx.workspace.remove(path)
      // 记一笔。删除是这个目录上唯一不可逆的操作，出了事「谁在什么时候删的」只能从
      // 这儿找回来——上传那条也是同一个理由记的。
      ctx.logger?.info?.(`delete: ${gone.path}${gone.dir ? '/（整个目录）' : ''}`)
      res.json(gone)
    } catch (e) {
      replyFileError(res, e, '文件不存在', '删不掉')
    }
  })
}
