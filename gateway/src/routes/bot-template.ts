/**
 * 公司的 Bot 模版：读、改、以及「立刻下发到全公司席位」。
 *
 * 这一层原来是「一批共享的公司 Bot」。改成模版之后，公司管理员配的是**所有人的
 * Bot 共用的那一份底座**，员工自己建的 Bot 长在它上面（见 lib/catalog.ts 的
 * publicBot）。所以这几条路由是公司侧最要紧的写入口，单独一个模块。
 */
import type { RouteCtx } from './ctx.ts'
import { HttpError, type Router, json } from '../http.ts'
import { applyTemplatePatch, botTemplateOf, defaultBotModel, ensureBotTemplate, publicTemplate } from '../lib/catalog.ts'
import { bodyOf } from '../lib/validate.ts'
import { requireOrgUser } from '../lib/guards.ts'
import { deploySeat } from '../deploy.ts'
import { companyOr404 } from '../lib/org.ts'

/** 一次「立刻下发」最多重铺多少个席位。超过的留给轮询自己跟上。 */
const REDEPLOY_LIMIT = 50

/**
 * 这条请求的总预算。用完就停手，剩下的报成 `skipped`。
 *
 * 光限席位条数是不够的：单个席位的部署超时是 15 分钟（首次部署要装桌面栈），50 个串
 * 起来最坏能跑几个小时。那时候浏览器和中间的反向代理早断了，管理员看到的是一个网络
 * 错误、不知道到底铺没铺，很可能再按一次——而每一轮都会打断所有人正在进行的对话。
 * 有了预算，回执一定回得来，且一定说得清谁铺了、谁没铺。
 */
const REDEPLOY_BUDGET_MS = 4 * 60_000

/**
 * 批量重铺时单个席位的超时。
 *
 * 这些席位都已经 ready，桌面栈早就装好了，重铺只是重写 drop-in 再重启单元；给它 90 秒
 * 足够，不该让一台卡住的机器把整条请求按 15 分钟的首次部署超时拖住。
 */
const REDEPLOY_SEAT_TIMEOUT_MS = 90_000

export function attachBotTemplate(router: Router, ctx: RouteCtx) {
  const { db, keys } = ctx

  /**
   * 公司还在不在。
   *
   * requireOrg 对 owner 直接放行、不查公司，所以拼错一个 id 会一路走到
   * ensureBotTemplate 去插一条 companyId 悬空的行——外键把它打回来，被那层 catch 吞掉，
   * 最后抛一个跟真正原因毫无关系的 500。catalog.ts 里同层级的建接口都先过这一关。
   */
  async function ensureCompany(id: string): Promise<void> {
    await companyOr404(db, id)
  }

  /**
   * 读模版。**公司里的所有人都读得到**，不只是管理员：员工建 Bot 的那一屏要显示
   * 「你的 Bot 会继承这些」，看不到底座就等于让人蒙着眼睛建。
   */
  router.get('/orgs/:id/bot-template', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id)
    await ensureCompany(req.params.id)
    const item = await ensureBotTemplate(db, req.params.id)
    const tpl = botTemplateOf(item)
    json(res, 200, {
      template: publicTemplate(tpl, await defaultBotModel(db)),
      options: {
        skills: (await db.visibleCatalog('skill', req.params.id)).map((i) => ({ id: i.id, name: i.name })),
        mcps: (await db.visibleCatalog('mcp', req.params.id)).map((i) => ({ id: i.id, name: i.name })),
      },
      // 员工看不到这一份：他要的是「我的 Bot 继承了什么」，不是全公司谁的席位落后了。
      ...(account.role === 'member' ? {} : { sync: await syncOf(req.params.id, tpl.version) }),
    })
  })

  /**
   * 「改完到底铺下去没有」——这一页唯一答不了、又最该答的问题。
   *
   * 版本号是保存的那一刻就 +1 的，界面上立刻显示 v5；可席位换没换是另一回事，中间隔着
   * 一轮探针、一次拉取，以及所有会出错的地方（进程死了、机器断网、拉取一直失败）。没有
   * 这一格的时候，这三种情况和「一切正常」在界面上长得一模一样。
   *
   * 只数**已经部署好的**席位：还没部署、部署失败的不该算进「多少台跟上了」的分母——
   * 它们落后的原因不在模版这一层，混进来会把一个能看懂的数字变成一个吓人的数字。
   */
  async function syncOf(companyId: string, version: number) {
    const rows = (await db.seatRuntimesOf(companyId)).filter((s) => s.status === 'ready')
    // 名字一次查齐，不按席位一个个查：一家公司几十个席位就是几十次往返，而这一页每次
    // 打开都要走一遍。
    const names = new Map((await db.accountsOf(companyId)).map((a) => [a.id, a.name || a.email]))
    const seats = rows.map((r) => ({
      seatId: r.seatId,
      botId: r.botId,
      accountId: r.accountId,
      name: names.get(r.accountId) || '',
      version: r.tplVersion,
      syncedAt: r.tplSyncedAt,
    }))
    return {
      version,
      total: seats.length,
      synced: seats.filter((s) => s.version === version).length,
      // 落后的排在前面：这一格是拿来找那几台的，不是拿来看花名册的。
      seats: seats.sort((a, b) => (a.version ?? -1) - (b.version ?? -1) || a.seatId.localeCompare(b.seatId)),
    }
  }

  /**
   * 改模版。保存即生效：版本号 +1，公司里所有 Bot 下一次被读到时合成的就是新的这份。
   *
   * 没有「发布 / 草稿」两态。加了它就得回答「谁的 Bot 停在哪一版」，而这一层的全部
   * 意义就是**只有一版**——想灰度就先在自己的 Bot 上用追加提示词试。
   *
   * **body 里带 `version` 就是一次 if-match。** 这一层是读-改-写：两个管理员同时打开
   * 这一页，各读到 v1、各写出 v2，后落地的那份会把前一份的改动整段盖掉，而两个人都
   * 看到「已保存，现在是 v2」，没有任何冲突提示。界面一定带上它（见 app.js 的
   * template-save）；不带的调用方（脚本、e2e）按老样子直接覆盖，不强制。
   */
  router.put('/orgs/:id/bot-template', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id, true)
    await ensureCompany(req.params.id)
    const item = await ensureBotTemplate(db, req.params.id)
    const body = bodyOf(req)
    const cur = botTemplateOf(item)
    if (body.version !== undefined && Number(body.version) !== cur.version) {
      throw new HttpError(409, `模版已经是 v${cur.version} 了，别人刚改过。刷新一下再改。`)
    }
    const next = await applyTemplatePatch(db, req.params.id, cur, body)
    await db.updateCatalog(item.id, { definition: next })
    await db.audit({
      companyId: req.params.id,
      accountId: account.id,
      action: 'bot-template.update',
      detail: { version: next.version, skills: next.skills.length, mcps: next.mcps.length },
    })
    // 保存完顺手回一份同步状态：这一刻它一定是「0 台跟上」，而那正是要让人看见的——
    // 版本号跳到 v5 不等于席位到了 v5，两个数字并排出现，这件事才说得清。
    json(res, 200, {
      template: publicTemplate(next, await defaultBotModel(db)),
      sync: await syncOf(req.params.id, next.version),
    })
  })

  /**
   * 立刻下发：把本公司**已经部署好**的席位挨个重铺一遍。
   *
   * 平时不需要按它——席位实例自己在轮询模版版本号（见 bot/src/catalog），改完一分钟
   * 内就跟上了。这个按钮是给「现在就要」和「那台机器上的东西不对」准备的：重铺会重启
   * bot 进程，等于让它从头拉一次目录。代价是**正在进行的对话会断**，所以它不是自动的。
   *
   * 只碰 ready 的席位：部署失败、还没部署过的，重铺一遍多半还是同一个错，而它会把这
   * 条请求拖到超时。
   */
  router.post('/orgs/:id/bot-template/redeploy', async (req, res) => {
    const actor = await requireOrgUser(req, db, keys, req.params.id, true)
    await ensureCompany(req.params.id)
    const seats = (await db.seatRuntimesOf(req.params.id)).filter((s) => s.status === 'ready')
    if (seats.length > REDEPLOY_LIMIT) throw new HttpError(409, `席位太多（${seats.length} 个），请让它们自己跟上`)
    const deadline = Date.now() + REDEPLOY_BUDGET_MS
    const failed: { seatId: string; error: string }[] = []
    const skipped: string[] = []
    let ok = 0
    for (const seat of seats) {
      // 预算用完就停手。没铺到的不是失败——它们照样会在下一轮探针里自己跟上。
      if (Date.now() >= deadline) {
        skipped.push(seat.seatId)
        continue
      }
      const account = await db.account(seat.accountId)
      if (!account) continue
      const out = await deploySeat(db, keys, account, {
        botId: seat.botId,
        force: true,
        // force 在这里只是为了穿过「版本没变就跳过」那道门，**不是**「现在就掐掉他们
        // 正在说的话」。改一次模版把全公司跑着的那一轮一起打断，没有任何道理——等席位
        // 把手上的活干完（见 manager/src/seats.ts 的排空），等不到的这一轮就先跳过，
        // 它们照样会在下一轮探针里自己跟上（这条路本来就是这么设计的）。
        //
        // 排空能等多久不用在这里定：deploySeat 从下面这个超时里切一半发给管家，两边
        // 于是不可能各定各的（那正是「等到一半被自己的超时掐断」的来源）。
        interrupt: false,
        timeoutMs: REDEPLOY_SEAT_TIMEOUT_MS,
      })
      if (out.ok) ok++
      else failed.push({ seatId: seat.seatId, error: out.error })
    }
    await db.audit({
      companyId: req.params.id,
      accountId: actor.id,
      action: 'bot-template.redeploy',
      detail: { total: seats.length, ok, failed: failed.length, skipped: skipped.length },
    })
    json(res, 200, { total: seats.length, ok, failed, skipped })
  })
}
