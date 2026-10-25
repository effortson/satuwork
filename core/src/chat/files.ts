/**
 * 正文里的文件名怎么接回工作区里的文件。原先在 gateway/ui/chat.js（knownFiles / fileCands /
 * fileHits），只碰字符串；把命中的区间变成链接那一半（走 DOM 文本节点）还留在那边。
 */

export interface KnownFile {
  path: string
  name: string
}

/**
 * 这条会话里已经露过面的工作区文件：path → { path, name }。
 *
 * 三个来源，都是**报出来的、不是猜出来的**：人上传的附件、工具落地的产出（files）、
 * 工具看到的那些（refs，见 bot 的 tools/index.ts）。有了这份名册，正文里出现的文件名才能
 * 接回一个真实存在的路径——没有它就只能拿正则去散文里认路径，措辞一改就散架。
 *
 * **按整条会话攒，不是按消息。** 模型常常上一条列了目录、下一条才说「那份 PDF 里
 * 写着…」，只看本条的话，人最想点的那一次恰好点不了。
 */
export function knownFiles(blocks: any[] | null | undefined): Map<string, KnownFile> {
  const map = new Map<string, KnownFile>()
  const add = (f: any) => {
    if (!f || !f.path || map.has(f.path)) return
    map.set(f.path, { path: f.path, name: f.name || f.path.split('/').pop() || f.path })
  }
  for (const b of blocks || []) {
    for (const f of b.files || []) add(f)
    // 人引用过的文件也算露过面：正文里再出现它的名字就该能点。
    for (const r of b.refs || []) if (r && r.kind === 'file') add(r)
    for (const x of b.tools || []) {
      for (const f of x.files || []) add(f)
      for (const f of x.refs || []) add(f)
    }
  }
  return map
}

/** 带扩展名才算文件名。没有它，一个叫「报告」的文件会把正文里每一个「报告」都点亮。 */
const FILE_EXT_RE = /\.[A-Za-z0-9]{1,8}$/

export interface FileCand {
  needle: string
  file: KnownFile
}

/**
 * 名册摊成一张「要在正文里找的字串」表，长的排前面。
 *
 * 两种字串：**完整路径**（模型写全的那种）和**文件名**。文件名这一类有两道闸——
 * 必须带扩展名、且在整条会话里不重名。重名的一律不认：`index.ts` 有三个的时候，
 * 猜中的那次不值得赔上另外两次指到错的文件。
 */
export function fileCands(known: Map<string, KnownFile>): FileCand[] {
  const byBase = new Map<string, KnownFile | null>()
  for (const f of known.values()) {
    const base = f.path.split('/').pop() || f.path
    // 撞名的置空而不是删掉——后面再来一个同名的，也得继续认得出它撞过。
    byBase.set(base, byBase.has(base) ? null : f)
  }
  const out: FileCand[] = []
  for (const f of known.values()) if (f.path.includes('/')) out.push({ needle: f.path, file: f })
  for (const [base, f] of byBase) if (f && FILE_EXT_RE.test(base)) out.push({ needle: base, file: f })
  return out.sort((a, b) => b.needle.length - a.needle.length)
}

export interface FileHit {
  start: number
  end: number
  file: KnownFile
}

/**
 * 一段文本里出现的那些文件名，落在哪几段区间上。
 *
 * 这条规则最容易出错的地方是边界（`报表.xlsx.bak` 不是 `报表.xlsx`、`src/a.ts` 里的 `a.ts`
 * 不该单独再算一次），而那几条拿字符串就能钉死。长的先认、认过的区间不再让给短的，所以完整
 * 路径永远赢过它自己的文件名。
 */
export function fileHits(text: unknown, cands: FileCand[] | null | undefined): FileHit[] {
  const src = String(text == null ? '' : text)
  if (!src || !cands || !cands.length) return []
  const hits: FileHit[] = []
  for (const c of cands) {
    let from = 0
    for (;;) {
      const at = src.indexOf(c.needle, from)
      if (at < 0) break
      const end = at + c.needle.length
      from = end
      if (!fileEdgeOk(src, at, end)) continue
      if (hits.some((h) => at < h.end && h.start < end)) continue
      hits.push({ start: at, end, file: c.file })
    }
  }
  return hits.sort((a, b) => a.start - b.start)
}

/**
 * 这一段确实是「一个完整的名字」，不是从更长的东西里截出来的一半。
 *
 * 中日韩的字不算词字符（`\w` 不匹配），所以「已生成印尼山火报告2026-08.html，请查收」
 * 里那个文件名照样接得上——这恰恰是最常见的写法。
 */
export function fileEdgeOk(src: string, start: number, end: number): boolean {
  const before = start > 0 ? src[start - 1] : ''
  const after = end < src.length ? src[end] : ''
  if (before && /[\w./\\-]/.test(before)) return false
  if (after && /[\w/\\-]/.test(after)) return false
  // `报表.xlsx.bak` 不是 `报表.xlsx`。
  if (after === '.' && /[A-Za-z0-9]/.test(src[end + 1] || '')) return false
  return true
}
