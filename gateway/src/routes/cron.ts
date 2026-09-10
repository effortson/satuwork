import type { RouteCtx } from './ctx.ts'
import { HttpError, bearer, json, type Router } from '../http.ts'
import { maintenanceTick } from '../routines.ts'
import { timingSafeToken } from '../crypto.ts'

/**
 * 分钟级的那一拍，给没有常驻进程的环境用：Vercel Cron 每分钟打一次 `GET /cron/tick`，
 * 里面跑的就是 Debian 上调度器每 30 秒跑的那份 maintenanceTick（routines.ts）。
 *
 * 认 `CRON_SECRET`：Vercel 触发 Cron 时在 Authorization 上带 `Bearer <CRON_SECRET>`。没配就
 * 整条路关着——一条不鉴权的「现在扫一遍」接口，谁都能拿来让 Gateway 白忙。
 *
 * 一拍里最慢的是模型目录刷新（外呼 models.dev，6 小时一次）和渠道投递的尾巴，都在秒级；
 * 函数默认 300 秒够用。这里**不**跑任何要等席位跑完一轮的事——那些归工人（routes/worker.ts）。
 */
export function attachCron(router: Router, { db }: RouteCtx) {
  router.get('/cron/tick', async (req, res) => {
    const expected = (process.env.CRON_SECRET || '').trim()
    if (!expected) throw new HttpError(404, '没有这个入口')
    const given = bearer(req) || ''
    if (!given || !timingSafeToken(given, expected)) throw new HttpError(401, '无效的 Cron 凭证')
    const startedAt = Date.now()
    await maintenanceTick(db)
    json(res, 200, { ok: true, ms: Date.now() - startedAt })
  })
}
