import type { Context } from '@deepseek-ai/cordis'
import { WorkspaceError } from '../workspace/index.ts'
import { CommandError } from '../agent/index.ts'

/** 路由共用的小件：报错怎么回、下载文件名怎么写、哪些转人工单还开着。 */

type JsonRes = { status: number; json: (v: unknown) => void }

/** 命令被拒（CommandError）带着自己的状态码和那句原话；别的一律 500。 */
export function replyCommandError(res: JsonRes, e: unknown): void {
  res.status = e instanceof CommandError ? e.status : 500
  res.json({ error: (e as Error).message })
}

/** 工作区路径上的错：越界 400 带原话，不存在 404 回 `missing`，其余 500 回 `other`。 */
export function replyFileError(res: JsonRes, e: unknown, missing: string, other: string): void {
  const err = e as NodeJS.ErrnoException
  res.status = e instanceof WorkspaceError ? 400 : err?.code === 'ENOENT' ? 404 : 500
  res.json({ error: e instanceof WorkspaceError ? e.message : err?.code === 'ENOENT' ? missing : other })
}

/**
 * Content-Disposition 里的文件名。
 *
 * 两份一起给：`filename=` 是 ASCII 兜底，`filename*=` 按 RFC 5987 带 UTF-8 原名。
 * 中文名只给前者会变成乱码，只给后者老浏览器不认。ASCII 那份把引号和反斜杠也换掉——
 * 它在引号里，不换就能把这个 header 撑破。
 */
export function dispositionName(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** 还开着的转人工单：open / claimed。`of()` 里还有已交还（returned）的，不算。 */
export function openHandoffs(ctx: Context, sessionId: string) {
  return ctx.handoffs.of(sessionId).filter((h) => h.state === 'open' || h.state === 'claimed')
}
