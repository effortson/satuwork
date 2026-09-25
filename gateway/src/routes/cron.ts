import type { RouteCtx } from './ctx.ts'
import { HttpError, bearer, json, type Router } from '../http.ts'
import { maintenanceTick } from '../routines.ts'
import { tickChannelDeliveries } from '../channels.ts'
import { timingSafeToken } from '../crypto.ts'

/**
 * 分钟级的那一拍，给没有常驻进程的环境用：Vercel Cron 每分钟打一次 `GET /cron/tick`，
 * 里面跑的就是 Debian 上调度器每 30 秒跑的那份 maintenanceTick（routines.ts）。
 *
 * 认 `CRON_SECRET`：Vercel 触发 Cron 时在 Authorization 上带 `Bearer <CRON_SECRET>`。没配就
 * 整条路关着——一条不鉴权的「现在扫一遍」接口，谁都能拿来让 Gateway 白忙。
 *
 * 一拍里最慢的是模型目录刷新（外呼 models.dev，6 小时一次）和渠道投递的尾巴，都在秒级。
 * 日常任务这里只抢、只记（routines.ts）：跑在机器上的工人那边，Gateway 不等任何一轮的结果，
 * 所以一拍不会撞上 maxDuration。
 *
 * **渠道投递也在这一拍里。** 常驻进程上它由 startChannelDispatcher 的定时器做，函数形态没有
 * 那个定时器——以前也就没人做，已经有回复、投递失败过一次的事件就永远卡在那儿，连带挡住
 * 那个会话之后的每一条（见 channels.ts 的 tickChannelDeliveries）。Debian 上要是也配了
 * CRON_SECRET，两边会一起扫：领取是带租约的原子更新，同一条不会被发两遍。
 */
export function attachCron(router: Router, { db, keys, channelKey }: RouteCtx) {
  router.get('/cron/tick', async (req, res) => {
    const expected = (process.env.CRON_SECRET || '').trim()
    if (!expected) throw new HttpError(404, '没有这个入口')
    const given = bearer(req) || ''
    if (!given || !timingSafeToken(given, expected)) throw new HttpError(401, '无效的 Cron 凭证')
    const startedAt = Date.now()
    await maintenanceTick(db)
    // 同 maintenanceTick：一拍里某一件事出错只记一笔，不把整拍报成失败——下一拍还会再来。
    const channels = await tickChannelDeliveries(db, channelKey, keys).catch((e: Error) => {
      console.error(`satuwork-gateway: 渠道投递扫描失败：${e.message}`)
      return 0
    })
    json(res, 200, { ok: true, ms: Date.now() - startedAt, channels })
  })
}
