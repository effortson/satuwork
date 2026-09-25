/**
 * 可见目录，以及反代到席位实例的那一组：目录下发、桌面、日志、部署、对话。
 */
import type { ServerResponse } from 'node:http'
import type { RouteCtx } from './ctx.ts'
import { HttpError, bearer, json, type Req, type Router } from '../http.ts'
import { INSTANCE_DOWN, desktopTicketFor, machineResolver } from '../lib/machines.ts'
import { KIND, bodyOf, deployOptsOf, strField } from '../lib/validate.ts'
import type { Account, CatalogItem, Memory, MemoryKind, SeatRuntime } from '../db.ts'
import { LOGS_FOLLOW_GONE, deployInFlight, deploySeat, listSeatRuntime, logsDirectPayload, publicSeatRuntime, reconcileDeploy, seatStepOf, startSeatDeploy, rosterUrlOf } from '../deploy.ts'
import { blockMapOf, connectorDefOf, runtimeConnectorServer } from '../lib/connectors.ts'
import { LEGACY_BOT_ICONS, type BotMemory, botContext, botIconOf, botNameOf, defaultBotModel, extraPromptOf, iconSetFor, publicBot, publicCatalog, publicSkill, runtimeKindOf, runtimeServer, skillDisplayNames, skillFiles, tagsOf, trimStr } from '../lib/catalog.ts'
import { kindOf, originOf, requirePlatformToken, requireSeatOnly, requireUser } from '../lib/guards.ts'
import { MEMORY_PIN_MAX, MEMORY_TEXT_MAX, memoryExpiresAt, memoryKey, memoryKindAllowed, memoryKindOf, memoryScopeLayers, memoryStamp, memoryStoreMax, memoryText, publicMemory } from '../lib/memory.ts'
import { WebToolError } from '../web-tools.ts'
import { runExtract, runSearch } from '../web-service.ts'
import { machineHeader, managerTargetFor, proxyDownload, proxyJson, requireSeat, seatBearer, seatTargetFor, seatTargetForSession, visibleBotOf } from '../lib/runtime.ts'
import { requestBotDeletion } from '../conversation-audit.ts'
import { directReleaseUrl, localBotReleaseTarget } from '../releases.ts'

/**
 * 一个人最多建几个 Bot。
 *
 * 有上限是因为**每个 Bot 都是机器上的一个真实进程**（一个席位一套 systemd 单元、一块
 * 屏、一个端口），不是一行配置。默认 10 够一个人分工用，真不够就调环境变量，不必改码。
 */
export const MAX_USER_BOTS = Math.max(1, Math.trunc(Number(process.env.GATEWAY_MAX_USER_BOTS) || 10))

/**
 * 名单流的直连地址；空串 = 没有名单流。
 *
 * Gateway 不再扇入名单（那条 `/runtime/roster/stream` 连同 lib/roster-stream.ts 一起删了：
 * 一个人一条小时级的 SSE，在 Vercel 上开不起）。所以只有一个前提：至少一个席位 Bot 已经
 * 落在某台机器上，且那台机器够新、配了 directUrl（rosterUrlOf）。账号粘机器（§3.0），随便
 * 哪一个席位的机器都是同一台。
 *
 * 本地 Bot 不是障碍：它跑在员工电脑上，不在任何机器的名册里，管家那条流里自然没有它——
 * 它那一行由桌面端自己盖上去（见下面 botRuntime 里的说明），名单流只管席位 Bot。
 */
async function rosterStreamUrlFor(
  seats: Map<string, SeatRuntime>,
  machineOf: ReturnType<typeof machineResolver>,
  bots: { id: string; runtimeKind?: string }[],
): Promise<string> {
  for (const b of bots) {
    const rt = seats.get(b.id)
    if (!rt?.machineId) continue
    return rosterUrlOf(await machineOf(rt))
  }
  return ''
}

/**
 * 名册一页里每颗 Bot 的运行态。
 *
 * 席位行和机器行都由调用方**一次取齐**再传进来（`seatRuntimesOfAccount` + `machineResolver`）：
 * 以前每颗 Bot 各查一遍席位、再各查一遍机器，N 颗就是 2N 次往返，而账号粘机器（§3.0），
 * 那 N 次机器查询查的几乎永远是同一行。Vercel 上每次冷启这些都是真的 Neon 往返。
 */
async function botRuntime(
  seatOf: (botId: string) => Promise<SeatRuntime | null | undefined>,
  machineOf: ReturnType<typeof machineResolver>,
  item: CatalogItem,
) {
  if (runtimeKindOf(item) === 'remote') {
    const rt = await seatOf(item.id)
    if (!rt) return null
    return listSeatRuntime(rt, await machineOf(rt))
  }
  /**
   * 本地 Bot 跑在员工的电脑上，Gateway **不知道它在不在跑**——以前靠一条反向隧道投影，
   * 隧道拆了（docs/adr-gateway-vercel-neon.md §4）。这里只是个占位，前端在桌面端里用壳子
   * 的 status 盖掉它（ui/chat.js 的 overlayLocalRuntime）；在普通浏览器里它就是「本机未运行」，
   * 也是真话。
   */
  return { kind: 'local' as const, status: 'none' as const, machineLink: 'offline' as const, workspace: 'desktop' }
}

/** 单颗 Bot 的运行态（建 / 改 / 看详情那几条路）——只查这一颗的席位行。 */
function oneBotRuntime(db: RouteCtx['db'], account: Account, item: CatalogItem) {
  return botRuntime((botId) => db.seatRuntime(account.id, botId), machineResolver(db), item)
}
/**
 * 「数这个人有几个 Bot、再插一个」那一段的 advisory lock 键。两条建 Bot 的路（这里的
 * POST /runtime/bots 和 channels.ts 绑 Telegram 时顺手建的那颗）数的是同一个配额，
 * 所以**必须是同一把锁**——各用各的号，两边就能同时读到「还差一个」一起挤进来。
 */
export const USER_BOT_QUOTA_LOCK = 0x43484e

/**
 * 「这份目录变了没有」的指纹。
 *
 * 四样东西并成一个串：公司模版的版本号、这一颗 Bot 自己的 updatedAt、可见的
 * Skill/MCP 里最新的那个 updatedAt，以及它们的条数。改模版、改 Bot 的名字头像、
 * 给公司加一个 MCP、删掉一个 Skill，都会让它变。
 *
 * 条数不能省：只看「最新的那个时间」的话，删掉一条不会让任何时间变小，实例就永远
 * 以为没事。
 */
/**
 * 下发给席位的连接器超时。
 *
 * `bot/src/catalog/mcp.ts` 默认只等 8 秒——对本地 MCP 够用，对「发一封邮件」「查一遍
 * CRM」不够。Gateway 自己对上游是 45 秒（见 routes/mcp.ts），必须比这个数**小**：
 * 我们要先拿到结果再回答，否则席位那边已经断了，这一次调用记不到结果，钱也说不清。
 */
const CONNECTOR_TIMEOUT_MS = 60_000

function catalogStamp(
  version: number,
  bot: CatalogItem | undefined,
  tools: CatalogItem[],
  /**
   * 连接器那一截：这个账号的安装和连接。
   *
   * **不能省。** 员工装一个连接器、连一个新邮箱、关掉几个工具，`catalog_items` 一个
   * 字节都不会变，只看上面那三样的话探针会一直判「没变」，工具永远不出现——直到有人
   * 重新部署。
   */
  conn: { updatedAt: number; count: number } = { updatedAt: 0, count: 0 },
  /**
   * 平台钉的两个模型角色。
   *
   * **不能省。** 席位拿着 `models.utility` 去做网页摘要，而这两个角色改动时
   * `catalog_items` 一个字节都不会变——只看上面那几样的话，管理员换掉 utility（比如
   * 旧的那个下架了）之后，跑着的席位永远不会重拉目录，摘要会一直打那个已经不存在的
   * 模型，然后静静退化成「截原文前 8000 字」。
   */
  models = '',
  /**
   * 记忆那一截。
   *
   * **不能省，理由同上面两条。** 记忆不在 `catalog_items` 里，人在界面上删掉一条、
   * 改掉一条，上面那几样一个字节都不会变——探针会一直判「没变」，而席位还带着那条
   * 已经不存在的记忆去组每一轮的提示词。私有档 Skill 那次踩的是同一个洞
   * （docs/skills.md §7、docs/memory.md §5）。
   */
  memories = '0:0',
): string {
  const toolsAt = tools.reduce((n, i) => Math.max(n, i.updatedAt), 0)
  return `${version}:${bot?.updatedAt ?? 0}:${toolsAt}:${tools.length}:${conn.updatedAt}:${conn.count}:${models}:${memories}`
}

/** 两个模型角色压成一小段，进指纹用。 */
function modelStamp(s: { daily: { provider: string; model: string; reasoningEffort?: string }; utility: { provider: string; model: string; reasoningEffort?: string } }): string {
  return `${s.daily.provider}/${s.daily.model}:${s.daily.reasoningEffort || 'off'}|${s.utility.provider}/${s.utility.model}:${s.utility.reasoningEffort || 'off'}`
}

/** 这个账号的连接器状态指纹：安装和连接一起算，删一条也要能看出来。 */
async function connectorStampOf(db: RouteCtx['db'], accountId: string, companyId: string | null) {
  const installs = await db.connectorInstalls(accountId)
  const conns = await db.connectionsFor(accountId, companyId)
  const updatedAt = [...installs, ...conns].reduce((n, r) => Math.max(n, r.updatedAt), 0)
  return { updatedAt, count: installs.length + conns.length }
}

/** 自己建的那一颗。别人的、公司的、全局的都不是——改和删都走它。 */
async function ownBotOf(db: RouteCtx['db'], account: Account, id: string, allowDeleting = false) {
  const item = await db.catalog((id || '').trim())
  if (!item || item.kind !== 'bot' || item.scope !== 'user' || item.accountId !== account.id) {
    throw new HttpError(404, '没有这个 Bot')
  }
  if (item.deletingAt && !allowDeleting) throw new HttpError(409, '这个 Bot 正在完成删除前审计')
  return item
}

export function attachRuntime(router: Router, ctx: RouteCtx) {
  const { db, keys, meter } = ctx

  // ── 可见目录（全局 ∪ 本公司）────────────────────────────────────────

  for (const name of Object.keys(KIND)) {
    router.get(`/catalog/${name}`, async (req, res) => {
      const account = await requireUser(req, db, keys)
      json(res, 200, { items: (await db.visibleCatalog(kindOf(name), account.companyId)).map(publicCatalog) })
    })
    /**
     * 平台令牌写全局目录的三条路各记一条审计。令牌不对应任何账号，accountId 记空、
     * companyId 记 'platform'（同 platform.tools.web.update 那条），detail 里标明
     * `by: 'platform-token'`，翻审计的人才分得清是人在界面上改的还是 CI 推的。
     */
    router.post(`/catalog/${name}`, async (req, res) => {
      requirePlatformToken(req)
      const body = bodyOf(req)
      const item = await db.insertCatalog({
        kind: kindOf(name),
        scope: 'global',
        companyId: null,
        name: strField(body, 'name'),
        definition: body.definition ?? {},
      })
      await db.audit({ companyId: 'platform', accountId: null, action: 'catalog.create', detail: { kind: kindOf(name), id: item.id, by: 'platform-token' } })
      json(res, 201, { item: publicCatalog(item) })
    })
    router.patch(`/catalog/${name}/:itemId`, async (req, res) => {
      requirePlatformToken(req)
      const item = await db.catalog(req.params.itemId)
      if (!item || item.kind !== kindOf(name) || item.scope !== 'global') throw new HttpError(404, '目录项不存在')
      const body = bodyOf(req)
      const next = await db.updateCatalog(item.id, {
        name: body.name != null ? strField(body, 'name') : undefined,
        definition: body.definition,
      })
      await db.audit({ companyId: 'platform', accountId: null, action: 'catalog.update', detail: { kind: kindOf(name), id: item.id, by: 'platform-token' } })
      json(res, 200, { item: publicCatalog(next) })
    })
    router.delete(`/catalog/${name}/:itemId`, async (req, res) => {
      requirePlatformToken(req)
      const item = await db.catalog(req.params.itemId)
      if (!item || item.kind !== kindOf(name) || item.scope !== 'global') throw new HttpError(404, '目录项不存在')
      await db.deleteCatalog(item.id)
      await db.audit({ companyId: 'platform', accountId: null, action: 'catalog.delete', detail: { kind: kindOf(name), id: item.id, by: 'platform-token' } })
      json(res, 200, { deleted: true, id: item.id })
    })
  }

  /**
   * 实例拉目录。MCP token 与 env 明文只出现在这里，不出现在 /catalog/mcp，也不出现在
   * 管理面的 /orgs/:id/mcp-servers。**只认席位 sat_**：登录 JWT 能进来的话，任何一个
   * 成员在浏览器里就能把公司所有 MCP 的密钥读走。
   */
  router.get('/runtime/catalog', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const companyId = account.role === 'owner' ? null : account.companyId
    const botId = (req.query.get('botId') || '').trim()
    let bots = await db.botsFor(companyId, account.id)
    if (botId) {
      const hit = bots.find((b) => b.id === botId)
      if (!hit) throw new HttpError(404, '没有这个 Bot')
      bots = [hit]
    }
    const { pinned, tpl } = await botContext(db, companyId)
    /**
     * **按这颗 Bot 取 Skill**，不是按公司取。
     *
     * 差别是私有档那一截：`skillsFor` 的 where 里带着 (accountId, botId)，别的 Bot
     * 攒下的方法一条都进不来（docs/skills.md §7）。没带 botId 的调用（脚本、老席位）
     * 退回「全局 ∪ 公司」，看不见任何私有档——那时也没人知道该给谁的。
     */
    const skills = await db.skillsFor(companyId, account.id, botId || null)
    const servers = await db.visibleCatalog('mcp', companyId)
    /**
     * **这颗 Bot 读得到的全部记忆**，四层一次取齐（`memoriesFor` 的 where 里带着层和
     * 归属，别人的一条都进不来）。
     *
     * 这里**不按模版的「记忆范围」裁**：那三个 pill 决定装配提示词时读哪几层，是席位
     * 的事。下发的是「看得见的全部」——`memory_list` 也要靠它，一条 company 层的记忆
     * 正在影响这颗 Bot，藏起来的话「它怎么知道这件事的」就没有出处（docs/memory.md §4）。
     */
    const memories = companyId ? await db.memoriesFor(companyId, account.id, botId || null) : []

    /**
     * 连接器合成出来的 MCP 记录：这个账号每一把 `active` 的连接一条。
     *
     * `mentionOnly` 的**不进默认表**——它的全部意思就是「只有我 @ 你的时候才用你」，
     * 进了默认表等于这个开关没打开。它由发消息那一轮按 mentions 单独注入。
     *
     * endpoint 指回 Gateway 自己（`/mcp/connectors/:id`），票就用席位这次带来的
     * `sat_`——同一把票，不用再去库里取一次，也不会取错人。
     */
    const connectorItems = await db.visibleCatalog('connector', companyId)
    const blocked = blockMapOf(connectorItems)
    const conns = (await db.connectionsFor(account.id, companyId)).filter((c) => c.status === 'active')
    const synth = conns
      .map((c) => {
        const item = connectorItems.find((i) => i.id === c.connectorId && i.scope === 'global')
        if (!item || blocked.get(item.id)?.blocked) return null
        return runtimeConnectorServer(c, item, {
          origin: originOf(req),
          token: bearer(req) ?? '',
          botId,
          timeoutMs: CONNECTOR_TIMEOUT_MS,
        })
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    /**
     * **`mentionOnly` 的也下发**，只是带个标记。
     *
     * 席位那边照样连上、照样注册工具，但不进默认工具表——只有这一轮被 `@` 点名才进。
     * 不下发是不行的：真被点名时再去握手就晚了，那一轮已经在组请求了。
     */
    const synthIds = synth.filter((x) => !x.mentionOnly).map((x) => x.id)

    // 席位要知道 utility 是谁：网页提取的摘要走它。挑模型是平台的事，所以是下发的，
    // 不是席位自己在 cordis.yml 里配的——那等于给了一条绕过平台配置的暗路。
    const settings = await db.platformSettings()

    json(res, 200, {
      // 实例照着这个数字判断「底座换了没有」。和下面那条探针给的是同一个值。
      templateVersion: tpl.version,
      models: { daily: settings.daily, utility: settings.utility },
      /**
       * **这一份内容的指纹，和探针给的算法完全一样。**
       *
       * 一起给出来，实例才有一个和这份数据同时刻的基线。少了它，实例只能拿第一次探针
       * 的结果当基线，而在「拉完目录」到「第一次探针」之间落地的改动就永远丢了——
       * 那两件事之间隔着一整轮插件启动，几百毫秒到几十秒都可能。
       */
      stamp: catalogStamp(
        tpl.version,
        botId ? bots[0] : undefined,
        [...skills, ...servers],
        await connectorStampOf(db, account.id, companyId),
        modelStamp(settings),
        memoryStamp(memories),
      ),
      /**
       * 连接器绑账号、不绑 Bot：合成出来的那几条挂到**每一颗** Bot 的 `mcps` 上。
       * 席位那边 `toolSchemasFor()` 照现有逻辑按 `mcps` 过滤，一行都不用改。
       */
      bots: bots.map((b) => {
        const pub = publicBot(b, pinned, tpl)
        return { ...pub, mcps: [...pub.mcps, ...synthIds] }
      }),
      /**
       * 重名序号在这里算：模型是拿**名字**去 `skill_view` 的，两条「退款审核」下发到
       * 席位上，它调哪一条都可能对、也都可能错。序号跟着这一份清单一起走，席位不自己算
       * ——两边各算一次，迟早在某个 Unicode 边界上分叉（docs/skills.md §5）。
       */
      skills: (() => {
        const names = skillDisplayNames(skills)
        return skills.map((i) => publicSkill(i, names.get(i.id)))
      })(),
      servers: [...servers.map(runtimeServer), ...synth],
      memories: memories.map(publicMemory),
    })
  })

  /**
   * 「有没有变」的探针。席位实例每分钟打一次，指纹没动就什么都不做。
   *
   * 为什么不让实例直接重拉整份目录：那一份里带着 MCP 的明文 token 和全部 Skill 正文，
   * 一家公司几十个席位每分钟各拉一遍，既是没必要的字节，也是没必要的密钥流动。
   */
  router.get('/runtime/catalog/version', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const companyId = account.role === 'owner' ? null : account.companyId
    const botId = (req.query.get('botId') || '').trim()
    const tplItem = companyId ? await db.botTemplate(companyId) : undefined
    const version = Number((tplItem?.definition as { version?: unknown } | undefined)?.version) || 1
    const bots = await db.botsFor(companyId, account.id)
    const bot = botId ? bots.find((b) => b.id === botId) : undefined
    if (botId && !bot) throw new HttpError(404, '没有这个 Bot')
    /**
     * **顺路把席位自己报的版本记下来。**`?have=` 是它这会儿真正跑着的那一版。
     *
     * 为什么捎在探针上、而不是另开一条上报接口：这条路本来就每分钟一趟、本来就带着席位
     * 的票，多一个查询参数是零成本；单开一条就是把每台席位的请求数翻倍，换来的信息一个
     * 字节都不多。顺带它还兼了心跳——版本对得上、汇报却停在两小时前，说明那个进程已经
     * 不在了，而这件事光看版本号看不出来。
     *
     * 只在带 botId 时记：这两列挂在 (accountId, botId) 那一行上，没有 botId 就不知道
     * 记到哪一行去。席位实例一定带（deploy 下发的 SATUWORK_BOT_ID），不带的是脚本。
     */
    const have = Number(req.query.get('have'))
    /**
     * **整数、且在 int4 里**。这一列是 `int`，一个 `have=99999999999` 会让 PG 抛
     * 22003、整条探针 500——而这条路是席位判断「目录变了没有」的唯一入口，500 之后它
     * 这一轮既拿不到 stamp 也不会重拉。一个畸形参数就能把一台席位卡住，而界面上只会
     * 显示它一直落后。认不出来的值当没带：报不上来不是错误，下一轮再说。
     */
    const sane = Number.isInteger(have) && have > 0 && have <= 2147483647
    if (botId && sane) await db.noteSeatTemplate(account.id, botId, have)
    /**
     * **私有档必须算进指纹。** 不算的话，Bot 用 `skill_manage` 写完一条，每分钟这次
     * 探针都判「没变」，那条 Skill 永远不会出现在它的索引里——而工具明明回了成功。
     * 这是那种「哪一处看起来都对」的故障（docs/skills.md §7）。
     */
    const tools = [
      ...(await db.skillsFor(companyId, account.id, botId || null)),
      ...(await db.visibleCatalog('mcp', companyId)),
    ]
    /** 记忆同理，而且它连 `catalog_items` 都不在——不算进去就永远同步不下来。 */
    const memories = companyId ? await db.memoriesFor(companyId, account.id, botId || null) : []
    json(res, 200, {
      templateVersion: version,
      stamp: catalogStamp(
        version,
        bot,
        tools,
        await connectorStampOf(db, account.id, companyId),
        modelStamp(await db.platformSettings()),
        memoryStamp(memories),
      ),
    })
  })


  // ── 私有档 Skill：Bot 在会话里自己记下来的方法 ────────────────────────
  //
  // 读走 /runtime/catalog（和公司的那些一起下发），这里只有**写**，外加包文件的按需
  // 拉取。整套的理由见 docs/skills.md §7、§8。

  /**
   * 一颗 Bot 最多攒几条私有档，单条正文最多多长。
   *
   * **判据只在这一侧。** 席位那把工具不自己判上限——两边各写一份，迟早一边说存下了、
   * 另一边说满了。模型看到的那句「7/30」也是这里回过去的。
   */
  const SEAT_SKILL_MAX = Math.max(1, Math.trunc(Number(process.env.GATEWAY_SEAT_SKILL_MAX) || 30))
  const SEAT_SKILL_BODY_MAX = Math.max(500, Math.trunc(Number(process.env.GATEWAY_SEAT_SKILL_BODY_MAX) || 8000))
  const SEAT_SKILL_NAME_MAX = 40

  /** 这次请求钉的是哪颗 Bot，并且确认它真是这个账号的。 */
  async function seatBotOf(req: Req, account: Account): Promise<string> {
    const botId = (req.query.get('botId') || '').trim()
    if (!botId) throw new HttpError(400, '要带 botId')
    const bots = await db.botsFor(account.role === 'owner' ? null : account.companyId, account.id)
    if (!bots.some((b) => b.id === botId)) throw new HttpError(404, '没有这个 Bot')
    return botId
  }

  /** 出去的那一份：重名序号按**这颗 Bot 看得见的全部**算，和目录下发的口径一致。 */
  async function seatSkillOut(account: Account, companyId: string | null, botId: string, item: CatalogItem) {
    const all = await db.skillsFor(companyId, account.id, botId)
    const names = skillDisplayNames(all.some((i) => i.id === item.id) ? all : [...all, item])
    const seat = all.filter((i) => i.scope === 'user')
    return { skill: publicSkill(item, names.get(item.id)), used: seat.length, max: SEAT_SKILL_MAX }
  }

  /**
   * 新建一条私有档。
   *
   * **同名不自动加序号。** 撞了就回 409 并把现有正文带回去，让模型自己决定是 `update`
   * 还是换个名字——自动加序号的结果是攒出「周报流程（2）」「（3）」，三条都半对，而
   * 索引在提示词前缀里，三条每一轮都要付一次（docs/skills.md §7）。
   */
  router.post('/runtime/skills', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const companyId = account.role === 'owner' ? null : account.companyId
    if (!companyId) throw new HttpError(400, '这个账号不属于任何公司，写不了私有档')
    const botId = await seatBotOf(req, account)
    const body = bodyOf(req)
    const name = trimStr(body.name)
    if (!name) throw new HttpError(400, 'Skill 要有名字')
    if (name.length > SEAT_SKILL_NAME_MAX) throw new HttpError(400, `名字最多 ${SEAT_SKILL_NAME_MAX} 个字`)
    const text = typeof body.body === 'string' ? body.body.trim() : ''
    if (!text) throw new HttpError(400, 'Skill 要有正文')
    if (text.length > SEAT_SKILL_BODY_MAX) throw new HttpError(400, `正文最多 ${SEAT_SKILL_BODY_MAX} 个字符，写短一点`)

    const visible = await db.skillsFor(companyId, account.id, botId)
    const clash = visible.find((i) => i.name === name)
    if (clash) {
      throw new HttpError(409, `已经有一条「${name}」了。要改它就用 update，确实是另一件事就换个名字。`)
    }
    const mine = visible.filter((i) => i.scope === 'user')
    if (mine.length >= SEAT_SKILL_MAX) {
      throw new HttpError(409, `你自己写的 Skill 已经有 ${mine.length} 条（上限 ${SEAT_SKILL_MAX}）。先删掉用不上的那些。`)
    }

    const now = Date.now()
    const item = await db.insertCatalog({
      kind: 'skill',
      scope: 'user',
      companyId,
      accountId: account.id,
      botId,
      name,
      definition: {
        body: text,
        tags: tagsOf(body.tags),
        source: '手动编写',
        enabled: true,
        /**
         * **模型写的一律按需。** `mode` 这个参数它给不了：常驻直接改这颗 Bot 之后
         * 每一轮的行为、还占着提示词前缀，那是管理员点的，不是模型给自己开的。
         */
        mode: '按需',
        // 席位扫出来的 PII 类型，**只存不判**：判据那一份在席位上（policy/pii.ts），
        // 抄第二份就会分叉。界面拿它标红给管理员看。
        ...(Array.isArray(body.pii) && body.pii.length ? { pii: body.pii.map(String).slice(0, 8) } : {}),
        createdAt: now,
        updatedAt: now,
      },
    })
    await db.audit({
      companyId,
      accountId: account.id,
      action: 'catalog.create',
      detail: { kind: 'skill', id: item.id, scope: 'seat', botId, by: 'bot', name },
    })
    json(res, 201, await seatSkillOut(account, companyId, botId, item))
  })

  /** 这条私有档必须是**这颗 Bot 自己的**。公司目录和全局目录的，模型读得到、改不动。 */
  async function ownSeatSkill(id: string, account: Account, botId: string): Promise<CatalogItem> {
    const item = await db.catalog(id)
    if (!item || item.kind !== 'skill') throw new HttpError(404, '没有这个 Skill')
    if (item.scope !== 'user' || item.accountId !== account.id || item.botId !== botId) {
      throw new HttpError(403, `「${item.name}」不是你自己写的那一档，改不了。要改得请管理员在 Skill 页面上改。`)
    }
    return item
  }

  router.patch('/runtime/skills/:skillId', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const companyId = account.role === 'owner' ? null : account.companyId
    if (!companyId) throw new HttpError(400, '这个账号不属于任何公司，写不了私有档')
    const botId = await seatBotOf(req, account)
    const item = await ownSeatSkill(req.params.skillId, account, botId)
    const body = bodyOf(req)
    const def = { ...(item.definition as Record<string, unknown>) }
    if (typeof body.body === 'string') {
      const text = body.body.trim()
      if (!text) throw new HttpError(400, 'Skill 要有正文')
      if (text.length > SEAT_SKILL_BODY_MAX) throw new HttpError(400, `正文最多 ${SEAT_SKILL_BODY_MAX} 个字符，写短一点`)
      def.body = text
    }
    if (Array.isArray(body.tags)) def.tags = tagsOf(body.tags)
    if (Array.isArray(body.pii)) def.pii = body.pii.map(String).slice(0, 8)
    // mode 收不下：改成常驻是人的动作（同 create）。
    def.mode = '按需'
    def.updatedAt = Date.now()
    let name = item.name
    if (typeof body.name === 'string' && trimStr(body.name)) {
      name = trimStr(body.name)
      if (name.length > SEAT_SKILL_NAME_MAX) throw new HttpError(400, `名字最多 ${SEAT_SKILL_NAME_MAX} 个字`)
      const visible = await db.skillsFor(companyId, account.id, botId)
      if (visible.some((i) => i.name === name && i.id !== item.id)) {
        throw new HttpError(409, `已经有一条「${name}」了，换个名字。`)
      }
    }
    const next = await db.updateCatalog(item.id, { name, definition: def })
    await db.audit({
      companyId,
      accountId: account.id,
      action: 'catalog.update',
      detail: { kind: 'skill', id: item.id, scope: 'seat', botId, by: 'bot', name },
    })
    json(res, 200, await seatSkillOut(account, companyId, botId, next))
  })

  router.delete('/runtime/skills/:skillId', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const companyId = account.role === 'owner' ? null : account.companyId
    if (!companyId) throw new HttpError(400, '这个账号不属于任何公司，写不了私有档')
    const botId = await seatBotOf(req, account)
    const item = await ownSeatSkill(req.params.skillId, account, botId)
    await db.deleteCatalog(item.id)
    await db.audit({
      companyId,
      accountId: account.id,
      action: 'catalog.delete',
      detail: { kind: 'skill', id: item.id, scope: 'seat', botId, by: 'bot', name: item.name },
    })
    const left = (await db.skillsFor(companyId, account.id, botId)).filter((i) => i.scope === 'user')
    json(res, 200, { deleted: true, id: item.id, name: item.name, used: left.length, max: SEAT_SKILL_MAX })
  })

  /**
   * 员工自己删掉一条「Bot 记下的方法」。
   *
   * **和上面那条 DELETE 不是同一条路**：那条认席位票（模型自己删），这条认登录票
   * （人在对话里按了「删掉」）。分开是因为成员账号根本进不了 `/orgs/:id/skills/*`
   * ——那套是管理员的目录页，而看见这张卡的恰恰是这颗 Bot 的主人（docs/skills.md §13）。
   */
  router.delete('/runtime/bots/:botId/skills/:skillId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const companyId = account.role === 'owner' ? null : account.companyId
    const bots = await db.botsFor(companyId, account.id)
    if (!bots.some((b) => b.id === req.params.botId)) throw new HttpError(404, '没有这个 Bot')
    const item = await db.catalog(req.params.skillId)
    if (
      !item ||
      item.kind !== 'skill' ||
      item.scope !== 'user' ||
      item.accountId !== account.id ||
      item.botId !== req.params.botId
    ) {
      throw new HttpError(404, '没有这个 Skill')
    }
    await db.deleteCatalog(item.id)
    if (item.companyId) {
      await db.audit({
        companyId: item.companyId,
        accountId: account.id,
        action: 'catalog.delete',
        detail: { kind: 'skill', id: item.id, scope: 'seat', botId: item.botId, name: item.name },
      })
    }
    json(res, 200, { deleted: true, id: item.id, name: item.name })
  })

  // ── 长期记忆：Bot 跨对话记住的一句事实 ──────────────────────────────
  //
  // 读走 /runtime/catalog（和 Skill、MCP 一起下发），这里只有**写**。整套的理由见
  // docs/memory.md §2、§5。

  /**
   * 这颗 Bot 的记忆设置（模版上那一份）与它当前的用量。
   *
   * **判据只在这一侧。** 席位那把工具不自己判上限、不自己算到期时间——两边各写一套，
   * 迟早一边说存下了、另一边说满了。模型看到的那句「18/40」也是这里回过去的。
   */
  async function memoryCtx(account: Account, companyId: string, botId: string) {
    const { tpl } = await botContext(db, companyId)
    const all = await db.memoriesFor(companyId, account.id, botId)
    /** 只有下面两层算用量：上面两层是管理员写的，不占这颗 Bot 的额度。 */
    const mine = all.filter((m) => m.layer === 'bot' || m.layer === 'self')
    return { mem: tpl.memory, all, mine, max: memoryStoreMax(tpl.memory) }
  }

  /** 回给席位的那一份：归一化之后的整条记录 + 用量。缓存里落的必须是它。 */
  function memoryOut(m: Memory, used: number, max: number) {
    return { memory: publicMemory(m), used, max }
  }

  /**
   * 模型只写得了下面两层。
   *
   * **这是权限边界，不是省事**：`group` / `company` 的条目会逐字进入别人的系统提示词，
   * 而它的来源可能是这颗 Bot 半小时前读的一封邮件。收到别的值一律拒，不静默降级——
   * 静默降级会让模型以为自己写成了一条全公司的记忆（docs/memory.md §3）。
   */
  function seatLayerOf(v: unknown): 'bot' | 'self' {
    const raw = typeof v === 'string' ? v.trim() : ''
    if (!raw || raw === 'bot') return 'bot'
    if (raw === 'self') return 'self'
    throw new HttpError(403, `记忆只能写 bot 或 self 这两层，写不了 ${raw}——那两层是管理员在界面上设的。`)
  }

  /** 席位写进来的正文：归一化 + 长度判据。**不截断**，超了直接拒（docs/memory.md §3）。 */
  function seatTextOf(body: Record<string, unknown>): string {
    const text = memoryText(body.text)
    if (!text) throw new HttpError(400, '记忆要有正文')
    if (text.length > MEMORY_TEXT_MAX) {
      throw new HttpError(
        400,
        `这条太长（${text.length} 字，上限 ${MEMORY_TEXT_MAX}）。拆成几条，或者它其实是一段流程——那用 skill_manage。`,
      )
    }
    return text
  }

  /** 席位写进来的类别。认不出来就拒；模版没勾这一类也拒，并说清是哪一类。 */
  function seatKindOf(body: Record<string, unknown>, mem: BotMemory): MemoryKind {
    const kind = memoryKindOf(body.kind)
    if (!kind) throw new HttpError(400, '记忆的类别只能是「偏好」「事实」「联系人」之一。')
    if (!memoryKindAllowed(mem, kind)) {
      throw new HttpError(403, `这个 Bot 没开「${kind}」这一类，这条没记。`)
    }
    return kind
  }

  /**
   * 席位记下一条。
   *
   * **botId 从 query 取、并验过是这个账号的**，不认请求体里的——同私有档 Skill 那条路
   * （`seatBotOf`）。请求体是模型拼的，一个编出来的 botId 就能把记忆写到别人的 Bot 上。
   */
  router.post('/runtime/memories', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const companyId = account.role === 'owner' ? null : account.companyId
    if (!companyId) throw new HttpError(400, '这个账号不属于任何公司，写不了记忆')
    const botId = await seatBotOf(req, account)
    const body = bodyOf(req)
    const { mem, all, mine, max } = await memoryCtx(account, companyId, botId)
    if (!mem.on) throw new HttpError(403, '这个 Bot 的长期记忆是关着的。')

    const layer = seatLayerOf(body.layer)
    const text = seatTextOf(body)
    const kind = seatKindOf(body, mem)

    /**
     * **完全重复的直接拒**（同 hermes 那份）。
     *
     * 判重的范围是**这颗 Bot 真的会看到的那几层**（按模版的「记忆范围」裁），不是库里
     * 读得出来的全部。差别不是洁癖：`scope` 是「仅本人」时，公司层那些条目一条都不会
     * 进它的提示词——拿它们去挡写入，模型收到的是「这条已经记过了」，而它永远看不见
     * 那一条，于是它既记不下来、也答不上来（这条是 code review 抓出来的）。
     */
    const visible = memoryScopeLayers(mem.scope)
    const key = memoryKey(text)
    const dup = all.filter((m) => visible.has(m.layer)).find((m) => memoryKey(m.text) === key)
    if (dup) {
      throw new HttpError(409, `这条已经记过了（${dup.layer === 'bot' || dup.layer === 'self' ? '你自己记的' : '管理员设的'}）：${dup.text}`)
    }
    if (mine.length >= max) {
      /** 到顶不自动淘汰最老的：那等于「它记住了，然后某天悄悄忘了」，而人不会收到任何
       *  提示。让它撞墙、自己整合，是唯一能让「忘了什么」留下痕迹的做法。 */
      const oldest = [...mine].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, 3)
      throw new HttpError(
        409,
        `记忆满了（${mine.length}/${max}）。先用 remove 或 replace 整合掉几条，最老的几条是：${oldest.map((m) => m.text).join('；')}`,
      )
    }

    const row = await db.insertMemory({
      layer,
      companyId,
      accountId: account.id,
      botId,
      kind,
      text,
      by: 'agent',
      sourceSessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
      // 席位扫出来的敏感类型，**只存不判**：判据那一份在席位上（policy/pii.ts），
      // 抄第二份就会分叉。界面拿它标红给管理员看。
      pii: Array.isArray(body.pii) ? body.pii.map(String).slice(0, 8) : [],
      expiresAt: memoryExpiresAt(mem),
    })
    await db.audit({
      companyId,
      accountId: account.id,
      action: 'memory.create',
      detail: { id: row.id, layer, kind, botId, by: 'bot' },
    })
    json(res, 201, memoryOut(row, mine.length + 1, max))
  })

  /**
   * 这条记忆必须是**这颗 Bot 改得动的**：它自己那两层，而且是这个账号的。
   *
   * 上面两层读得到、改不动——碰了要说清是为什么，不是回一句「没有这条」：模型看得见
   * 它就在眼前，一句「不存在」只会让它换个说法再试一次。
   */
  async function ownSeatMemory(id: string, account: Account, botId: string): Promise<Memory> {
    const m = await db.memory(id)
    if (!m) throw new HttpError(404, '没有这条记忆')
    if (m.layer === 'group' || m.layer === 'company') {
      throw new HttpError(403, `「${m.text}」是管理员设的，我改不了。要改得去 Bot 设置里改。`)
    }
    if (m.accountId !== account.id || (m.layer === 'bot' && m.botId !== botId)) {
      throw new HttpError(404, '没有这条记忆')
    }
    return m
  }

  router.patch('/runtime/memories/:memoryId', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const companyId = account.role === 'owner' ? null : account.companyId
    if (!companyId) throw new HttpError(400, '这个账号不属于任何公司，写不了记忆')
    const botId = await seatBotOf(req, account)
    const { mem, mine, max } = await memoryCtx(account, companyId, botId)
    if (!mem.on) throw new HttpError(403, '这个 Bot 的长期记忆是关着的。')
    const cur = await ownSeatMemory(req.params.memoryId, account, botId)
    const body = bodyOf(req)
    const text = body.text !== undefined ? seatTextOf(body) : cur.text
    const kind = body.kind !== undefined ? seatKindOf(body, mem) : cur.kind
    /**
     * **改成另一条的原文也算重复**，和 add 那条一样判。
     *
     * 少了这一道，一次 `replace` 就能造出两条一模一样的记忆：两条都每轮进提示词、
     * 都占着额度，而之后想删掉其中一条时 `match` 必然「匹配到多条」——两条哪条都删不掉
     * （这条是 code review 抓出来的）。
     */
    if (body.text !== undefined) {
      const visible = memoryScopeLayers(mem.scope)
      const key = memoryKey(text)
      const dup = (await db.memoriesFor(companyId, account.id, botId))
        .filter((m) => m.id !== cur.id && visible.has(m.layer))
        .find((m) => memoryKey(m.text) === key)
      if (dup) throw new HttpError(409, `改成这句会和已经有的那条重复：${dup.text}`)
    }
    /**
     * **改过的那条重新起算到期时间。** 一条被确认、被修正过的记忆，凭什么按它半年前
     * 第一次写下的时刻过期——人刚刚才说它还成立。
     */
    const next = await db.updateMemory(cur.id, {
      text,
      kind,
      expiresAt: memoryExpiresAt(mem),
      ...(Array.isArray(body.pii) ? { pii: body.pii.map(String).slice(0, 8) } : {}),
    })
    if (!next) throw new HttpError(404, '没有这条记忆')
    await db.audit({
      companyId,
      accountId: account.id,
      action: 'memory.update',
      detail: { id: next.id, layer: next.layer, kind: next.kind, botId, by: 'bot' },
    })
    json(res, 200, memoryOut(next, mine.length, max))
  })

  router.delete('/runtime/memories/:memoryId', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const companyId = account.role === 'owner' ? null : account.companyId
    if (!companyId) throw new HttpError(400, '这个账号不属于任何公司，写不了记忆')
    const botId = await seatBotOf(req, account)
    const cur = await ownSeatMemory(req.params.memoryId, account, botId)
    await db.deleteMemory(cur.id)
    await db.audit({
      companyId,
      accountId: account.id,
      action: 'memory.delete',
      detail: { id: cur.id, layer: cur.layer, kind: cur.kind, botId, by: 'bot' },
    })
    const { mine, max } = await memoryCtx(account, companyId, botId)
    json(res, 200, { deleted: true, id: cur.id, text: cur.text, used: mine.length, max })
  })

  /**
   * 人这一侧的记忆增删改。
   *
   * **和上面那三条不是同一条路**：那三条认席位票（模型自己写），这三条认登录票
   * （人在 Bot 设置里改）。分开的理由同私有档 Skill 那次——成员账号进不了
   * `/orgs/:id/*`，而看着这一屏的恰恰是这颗 Bot 的主人（docs/skills.md §13）。
   *
   * 人写的东西**不过 kinds 的勾、不过条数上限**：那两条是拿来管模型的。人在界面上
   * 明确加的一条，不该被一个他自己刚设的开关挡住——他要是不想要，不加就是了。
   * 长度照旧限，那是提示词预算，跟谁写的无关。
   */
  async function userBotOf(req: Req, account: Account): Promise<{ botId: string; companyId: string }> {
    const companyId = account.role === 'owner' ? null : account.companyId
    const bots = await db.botsFor(companyId, account.id)
    if (!bots.some((b) => b.id === req.params.botId)) throw new HttpError(404, '没有这个 Bot')
    if (!companyId) throw new HttpError(400, '这个账号不属于任何公司')
    return { botId: req.params.botId, companyId }
  }

  router.get('/runtime/bots/:botId/memories', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const { botId, companyId } = await userBotOf(req, account)
    const all = await db.memoriesFor(companyId, account.id, botId)
    const { tpl } = await botContext(db, companyId)
    json(res, 200, {
      items: all.map(publicMemory),
      used: all.filter((m) => m.layer === 'bot' || m.layer === 'self').length,
      max: memoryStoreMax(tpl.memory),
    })
  })

  router.post('/runtime/bots/:botId/memories', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const { botId, companyId } = await userBotOf(req, account)
    const body = bodyOf(req)
    const text = memoryText(body.text)
    if (!text) throw new HttpError(400, '记忆要有正文')
    if (text.length > MEMORY_TEXT_MAX) throw new HttpError(400, `正文最多 ${MEMORY_TEXT_MAX} 个字`)
    const kind = memoryKindOf(body.kind)
    if (!kind) throw new HttpError(400, '类别只能是「偏好」「事实」「联系人」之一')
    const layer = seatLayerOf(body.layer)
    const { tpl } = await botContext(db, companyId)
    const row = await db.insertMemory({
      layer,
      companyId,
      accountId: account.id,
      botId,
      kind,
      text,
      by: 'user',
      // 新建时不许直接钉：钉住要过上限那道判断（见 PATCH），而这里还没有这条记录。
      // 人要钉就建完再点一下，多一次点击换一处不用重复写的判据。
      pinned: false,
      expiresAt: memoryExpiresAt(tpl.memory),
    })
    await db.audit({
      companyId,
      accountId: account.id,
      action: 'memory.create',
      detail: { id: row.id, layer, kind, botId },
    })
    json(res, 201, { memory: publicMemory(row) })
  })

  /** 这条得是他自己那两层的。管理员设的上面两层，主人在这一屏看得见、改不动。 */
  async function ownUserMemory(id: string, account: Account, botId: string): Promise<Memory> {
    const m = await db.memory(id)
    if (!m || m.accountId !== account.id) throw new HttpError(404, '没有这条记忆')
    if (m.layer === 'group' || m.layer === 'company') throw new HttpError(403, '这条是管理员设的，去公司模版里改')
    if (m.layer === 'bot' && m.botId !== botId) throw new HttpError(404, '没有这条记忆')
    return m
  }

  router.patch('/runtime/bots/:botId/memories/:memoryId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const { botId, companyId } = await userBotOf(req, account)
    const cur = await ownUserMemory(req.params.memoryId, account, botId)
    const body = bodyOf(req)
    const patch: Parameters<typeof db.updateMemory>[1] = {}
    if (body.text !== undefined) {
      const text = memoryText(body.text)
      if (!text) throw new HttpError(400, '记忆要有正文')
      if (text.length > MEMORY_TEXT_MAX) throw new HttpError(400, `正文最多 ${MEMORY_TEXT_MAX} 个字`)
      patch.text = text
      // 人改过一个字就等于确认它还成立——**由人来说的**，`by` 跟着换。事后查
      // 「这句话是谁定的」时，一条被人改过的记忆不该还挂在 Bot 名下。
      patch.by = 'user'
    }
    if (body.kind !== undefined) {
      const kind = memoryKindOf(body.kind)
      if (!kind) throw new HttpError(400, '类别只能是「偏好」「事实」「联系人」之一')
      patch.kind = kind
    }
    if (body.pinned !== undefined) {
      /**
       * 钉住的**不占注入上限**（席位那边全放进提示词），所以钉的条数自己要有个顶——
       * 否则那根「注入上限」滑杆就是摆设。判据只在这一侧，同别的上限。
       */
      if (body.pinned === true && !cur.pinned) {
        const pinnedNow = (await db.memoriesFor(companyId, account.id, botId)).filter(
          (m) => m.pinned && (m.layer === 'bot' || m.layer === 'self'),
        ).length
        if (pinnedNow >= MEMORY_PIN_MAX) {
          throw new HttpError(409, `最多只能钉住 ${MEMORY_PIN_MAX} 条（钉住的每一轮都在，不受注入上限约束）。先取消钉住几条。`)
        }
      }
      patch.pinned = body.pinned === true
    }
    /** 续期：把「已过期」那一栏里的一条捞回来。人点的，所以按现在的模版重新起算。 */
    if (body.renew === true) {
      const { tpl } = await botContext(db, companyId)
      patch.expiresAt = memoryExpiresAt(tpl.memory)
    }
    const next = await db.updateMemory(cur.id, patch)
    if (!next) throw new HttpError(404, '没有这条记忆')
    await db.audit({
      companyId,
      accountId: account.id,
      action: 'memory.update',
      detail: { id: next.id, layer: next.layer, kind: next.kind, botId },
    })
    json(res, 200, { memory: publicMemory(next) })
  })

  router.delete('/runtime/bots/:botId/memories/:memoryId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const { botId, companyId } = await userBotOf(req, account)
    const cur = await ownUserMemory(req.params.memoryId, account, botId)
    await db.deleteMemory(cur.id)
    await db.audit({
      companyId,
      accountId: account.id,
      action: 'memory.delete',
      detail: { id: cur.id, layer: cur.layer, kind: cur.kind, botId },
    })
    json(res, 200, { deleted: true, id: cur.id })
  })

  /**
   * 升层：把一条 `self` 记忆推给分组或全公司。**只有管理员点得动。**
   *
   * 那两层会逐字进入本公司每个人的系统提示词——这不是一条设置，是一次对所有人的广播
   * （docs/memory.md §12 ⑤）。所以它和私有档 Skill 的「晋升」一样，是人的决定，
   * 而且是管理员的决定。
   *
   * **是搬家不是复制**（见 db.liftMemory）：留一份在原处，两份会各自被编辑，然后在
   * 某一天说不同的话。
   */
  router.post('/runtime/memories/:memoryId/lift', async (req, res) => {
    const account = await requireUser(req, db, keys)
    if (account.role !== 'admin') throw new HttpError(403, '只有管理员能把一条记忆推给分组或全公司')
    const companyId = account.companyId
    if (!companyId) throw new HttpError(400, '这个账号不属于任何公司')
    /**
     * **这一条不挂在 `/runtime/bots/:botId/` 底下**，和它旁边那几条不一样。
     *
     * 那几条是「这颗 Bot 的主人管自己的记忆」，按调用者自己的 Bot 列表认人；而升层是
     * **管理员对别人的一条记忆**动手——管理员的 Bot 列表里根本没有那颗 Bot，按那条路
     * 走一定是 404。判据换成「这条记忆属于我这家公司」：升层本来就是公司这一层的动作。
     */
    const cur = await db.memory(req.params.memoryId)
    if (!cur || cur.companyId !== companyId) throw new HttpError(404, '没有这条记忆')
    if (cur.layer === 'group' || cur.layer === 'company') {
      throw new HttpError(409, '这条已经在分组或全公司那一层了')
    }
    const body = bodyOf(req)
    const to = body.to === 'company' ? 'company' : 'group'
    const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : ''
    if (to === 'group') {
      if (!groupId) throw new HttpError(400, '推给分组要说是哪个分组')
      const g = await db.group(groupId)
      if (!g || g.companyId !== companyId) throw new HttpError(404, '没有这个分组')
    }
    const next = await db.liftMemory(cur.id, to, to === 'group' ? groupId : null)
    if (!next) throw new HttpError(404, '没有这条记忆')
    await db.audit({
      companyId,
      accountId: account.id,
      action: 'memory.lift',
      detail: { id: next.id, from: cur.layer, to, groupId: next.groupId, text: next.text },
    })
    json(res, 200, { memory: publicMemory(next) })
  })

  /**
   * 包里的文件。**不随目录下发**：那条路每分钟被探针摸一次、整份下发，把 5 MB 的包
   * 塞进去等于给每一次目录同步加一个数量级，而绝大多数轮次里没有任何 Skill 被打开。
   */
  async function viewableSkill(req: Req, account: Account): Promise<CatalogItem> {
    const companyId = account.role === 'owner' ? null : account.companyId
    const botId = (req.query.get('botId') || '').trim()
    const all = await db.skillsFor(companyId, account.id, botId || null)
    const item = all.find((i) => i.id === req.params.skillId)
    if (!item) throw new HttpError(404, '没有这个 Skill')
    return item
  }

  router.get('/runtime/skills/:skillId/files', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const item = await viewableSkill(req, account)
    json(res, 200, {
      id: item.id,
      updatedAt: item.updatedAt,
      files: skillFiles(item).map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.text) })),
    })
  })

  /**
   * 一个文件的内容。路径走 query 而不是路径段——包里的路径带 `/`，而这个 router 按
   * 段数精确匹配（http.ts 的 match），拼不出通配那一段。
   */
  router.get('/runtime/skills/:skillId/file', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const item = await viewableSkill(req, account)
    const path = (req.query.get('path') || '').trim()
    if (!path) throw new HttpError(400, '要带 path')
    const hit = skillFiles(item).find((f) => f.path === path)
    if (!hit) throw new HttpError(404, `这条 Skill 的包里没有 ${path}`)
    json(res, 200, { id: item.id, path: hit.path, text: hit.text, updatedAt: item.updatedAt })
  })

  // ── 网页工具。密钥在平台，所以抓取也在这里做完，席位只拿结果。 ─────────
  //
  // 走 /runtime/* 而不是 /v1/*：那一面是 OpenAI/Anthropic 兼容面，明确拒 sat_；
  // 搜索是席位运行时的能力，和 /runtime/catalog 同类。用席位票还顺带把
  // (accountId, companyId) 带了出来——计量不用 body 自报家门，自报的不作数。

  /** 业务失败要成为**结果**，不是 4xx：席位那头要把它原样说给模型听。 */
  async function webCall(res: ServerResponse, run: () => Promise<unknown>) {
    try {
      json(res, 200, { ok: true, ...(await run() as object) })
    } catch (e) {
      if (e instanceof WebToolError) return json(res, 200, { ok: false, error: e.hint })
      throw e
    }
  }

  router.post('/runtime/web/search', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const body = bodyOf(req)
    await webCall(res, () =>
      runSearch(db, meter, account, {
        query: String(body.query ?? ''),
        count: body.count == null ? undefined : Number(body.count),
        domains: Array.isArray(body.domains) ? body.domains.map(String) : [],
        exclude: Array.isArray(body.exclude) ? body.exclude.map(String) : [],
        freshness: String(body.freshness ?? ''),
      }),
    )
  })

  router.post('/runtime/web/extract', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    await webCall(res, () => runExtract(db, meter, account, bodyOf(req).urls))
  })

  router.get('/runtime/desktop', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const botId = (req.query.get('botId') || '').trim()
    if (!botId) throw new HttpError(400, 'botId 不能为空')
    const runtime = await db.seatRuntime(account.id, botId)
    if (!runtime) throw new HttpError(404, '还没有部署')
    /**
     * **票要按这个席位所在的那台机器签，不是公司的默认机器。**
     *
     * host 一直是从 `runtime.machineId` 取的，票却问的是 `companyMachineOf`（也就是
     * `companies.machineId`，第一台配对的那台）。多机之后两者会分家：默认那台被移除
     * 或解绑之后 `machinePaired` 不成立，desktopTicketFor 返回 undefined，于是这个人
     * 的桌面永远是一句「这块屏的凭据过期了」——而他席位所在的机器好端端的。
     * 同一类 host/token 错配 machineTokenFor 已经修过一次，`/runtime/deploy` 那条路
     * 用的也是 `out.result.machine`。
     */
    const machine = await db.machine(runtime.machineId)
    json(res, 200, publicSeatRuntime(runtime, machine ?? null, {
      includePassword: true,
      ticket: desktopTicketFor(keys, machine, runtime),
    }))
  })

  /**
   * 席位现场诊断。转发管家的 `/seats/:id/diag`。
   *
   * **给「席位本人」用，不是只给平台管理员。** 出问题的是他那块屏，而管理员未必在场；
   * 报告里也没有凭据（管家那侧只报文件的存在与时间，日志过了脱敏）。要它下沉到这一层，
   * 才算真的补上「没有 SSH 就看不见机器」这个洞。
   */
  router.get('/runtime/diag', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const t = await managerTargetFor(db, account, (req.query.get('botId') || '').trim())
    const lines = Number(req.query.get('lines') || 40)
    const q = Number.isFinite(lines) ? `?lines=${Math.min(200, Math.max(1, Math.trunc(lines)))}` : ''
    await proxyJson(res, 'GET', `${t.base}/seats/${encodeURIComponent(t.seatId)}/diag${q}`, undefined, undefined, t.machineToken)
  })

  /**
   * 席位 bot 的运行日志：最近 N 行，一次 JSON 往返。
   *
   * 和 diag 是一对：那条回答「它活着吗」，这条回答「它卡在哪一步」。这一层最贵的
   * 故障恰恰都不报错——单元 active、端口有人听，只是那一轮永远不结束——不看日志
   * 就只能靠猜，而没有 SSH 的时候连猜的依据都没有。
   *
   * 只看**自己席位**的：seatRuntime 按 (account.id, botId) 查，管理员也调不出别人的。
   * 日志里有对话正文和 bash 跑过的命令，这条线不该松。机器票留在 Gateway，浏览器
   * 只拿自己的席位票——它是管家的 root 控制面凭据，一步都不能往下放。
   *
   * **`follow=1` 不在这里了。** 跟着滚是一条小时级的 SSE，Gateway 上最后一条这样的连接，
   * Vercel 函数扛不住（见 docs/vercel-deploy.md）。改成浏览器直连管家，票由下面那条
   * `/runtime/logs/direct` 签。老前端还传 `follow=1` 的话回 410，别静默降级成「最近 200
   * 行」——那样人以为在跟，其实屏幕早停了。
   */
  router.get('/runtime/logs', async (req, res) => {
    const account = await requireUser(req, db, keys)
    if (req.query.get('follow') === '1') throw new HttpError(410, LOGS_FOLLOW_GONE)
    const t = await managerTargetFor(db, account, (req.query.get('botId') || '').trim())
    const lines = Math.min(2000, Math.max(1, Math.trunc(Number(req.query.get('lines')) || 200)))
    const url = `${t.base}/seats/${encodeURIComponent(t.seatId)}/logs?lines=${lines}`
    await proxyJson(res, 'GET', url, undefined, undefined, t.machineToken)
  })

  /**
   * 日志跟随的直连入口：给地址、签一张日志票，浏览器自己去打管家。
   *
   * 鉴权和上面那条逐字一样（`managerTargetFor`：只解析调用者自己那颗 Bot 的席位和机器），
   * 所以票上只会是自己的席位。票是 `satu-logs` 而不是桌面票——理由见 crypto.ts 的
   * signLogsTicket。五分钟：够把流开起来，流开了就不再看票。
   *
   * 机器没配 `directUrl`、或管家 < 9 号（`/logs` 还不认日志票）→ 409，界面上就说清楚
   * 「这台机器跟不了」，不要让人对着一条永远不动的流等。这个尾巴（算地址、409、签票）
   * 三条 `/logs/direct` 共用 deploy.ts 的 logsDirectPayload；鉴权和审计不在里面，各路
   * 自己守自己的。
   */
  router.get('/runtime/logs/direct', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const t = await managerTargetFor(db, account, (req.query.get('botId') || '').trim())
    json(res, 200, logsDirectPayload(keys, t.machine, t.seatId))
  })

  /**
   * 这个席位这会儿装到哪一步了。**建完 Bot 那一屏每两秒问一次的就是它。**
   *
   * 两层进度拼在一起：
   *
   * - **Gateway 自己的那份**（`status` / `phase` / `elapsedMs`）永远有，不依赖机器通不
   *   通——「已经装了几分钟」是这一屏上最要紧的一句话，它不该在管家答不上来的时候连着
   *   一起没有。
   *   「装了多久」**给的是年龄，不是起始时刻**（同 heartbeatAge，见 publicMachine 里那
   *   段）：员工的电脑和 Gateway 差几分钟是常事，让界面拿绝对时刻自己减本地时钟的话，
   *   一台快十分钟的电脑会在人刚按下「创建」的那一秒写出「已经装了 10:03」——正好是这
   *   一屏要打消的那个念头。界面收到之后自己锚一次，往后每秒由它自己的时钟往前走。
   * - **机器上那份**（第几步、这一步在干什么）由管家现问现答，问不到就没有（老管家、
   *   刚开始装还没报出第一行、这一刻网络抖了）。
   *
   * 没有席位行不是 404：这条路的调用方是一个每两秒转一圈的轮询，它要分得清「还没登记」
   * 和「问错了」——前者照旧画那句「还没有部署」，后者才是 bug。所以回 200 + `none`。
   */
  router.get('/runtime/deploy/progress', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const botId = (req.query.get('botId') || '').trim()
    if (!botId) throw new HttpError(400, 'botId 不能为空')
    const found = await db.seatRuntime(account.id, botId)
    if (!found) {
      const live = deployInFlight(account.id, botId)
      // 后台那次登记还没落库（建完 Bot 之后的头几百毫秒），也说成「在装」——这一屏
      // 上「还没有部署」那句话会带一颗按钮，让人在机器已经开工的时候再按一次。
      json(res, 200, { status: live ? 'deploying' : 'none', phase: live ? 'queued' : null, elapsedMs: null, lastError: null, step: null, stale: false })
      return
    }
    /**
     * 这个进程手上没有这次部署时，先去管家那儿问结局（reconcileDeploy）。
     *
     * 在 Vercel 上这是常态而不是例外：装是在另一个实例里发出去的，那个实例回完包可能已经被
     * 冻住，这一格 inFlightDeploys 在这里永远是空的。不问的话，机器上装得好好的席位会被说成
     * 「上一次安装没做完」，而机器上还在装的会被说成「没人在装」。
     */
    const { runtime, live, step: knownStep } = await reconcileDeploy(db, found)
    /**
     * **装到一半没人管了。**
     *
     * 装现在跑在后台，于是 Gateway 一重启，库里那一行就永远停在 `deploying`：机器上
     * 什么都没在装，而界面上那个读秒会一直往上走。人守着一屏永远不会完成的进度，
     * 手里连一颗能按的按钮都没有——这是把「装得久」换成了「永远装不完」。
     *
     * 库里看不出这件事（两种 `deploying` 长得一模一样），只有进程自己知道手上有没有
     * 这活儿。所以这一格由 deployInFlight 回答，界面据此改口并给出「重新部署」。
     */
    const stale = runtime.status === 'deploying' && !live
    const machine = runtime.status === 'deploying' && !stale && !knownStep ? await db.machine(runtime.machineId) : undefined
    json(res, 200, {
      status: runtime.status,
      phase: runtime.deployPhase,
      elapsedMs: runtime.deployStartedAt == null ? null : Math.max(0, Date.now() - runtime.deployStartedAt),
      lastError: runtime.lastError,
      stale,
      // 只有真的在装才去问机器：装完之后每两秒敲一次管家，问的是一件已经没有答案的事。
      step: knownStep ?? (machine && runtime.deployPhase === 'installing' ? (await seatStepOf(machine, runtime.seatId)) ?? null : null),
    })
  })

  router.post('/runtime/deploy', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const opts = deployOptsOf(req)
    const item = await visibleBotOf(db, account, opts.botId)
    if (runtimeKindOf(item) === 'local') throw new HttpError(409, '本地 Bot 由 Satuwork Desktop 启动，不能部署到远程机器')
    const out = await deploySeat(db, keys, account, opts)
    if (!out.ok) throw new HttpError(out.status, out.error)
    await db.audit({
      companyId: account.companyId!,
      accountId: account.id,
      action: 'runtime.deploy',
      detail: {
        botId: out.result.runtime.botId,
        linuxUser: out.result.runtime.linuxUser,
        seatId: out.result.runtime.seatId,
        slot: out.result.runtime.slot,
        status: out.result.runtime.status,
      },
    })
    json(res, 200, publicSeatRuntime(out.result.runtime, out.result.machine, {
      includePassword: true,
      ticket: desktopTicketFor(keys, out.result.machine, out.result.runtime),
    }))
  })

  // ── 对话。名册走 Gateway 目录；会话才反代到该 pair 的实例。────────

  router.get('/runtime/bots', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    // 平台指定的那一对和公司模版，整份名册共用一次——每行各读一遍没有意义。
    const { pinned, tpl } = await botContext(db, account.companyId)
    // 渠道归属与 Bot 定义分表保存。给名册带稳定标记，前端才能只给渠道 Bot 画来源标签，
    // 不能拿固定名称 `telegram bot` 猜：名称能改，也可能有普通 Bot 恰好同名。
    const [bindings, seatRows, items] = await Promise.all([
      db.channelBindings(account.id),
      db.seatRuntimesOfAccount(account.id),
      db.botsFor(account.companyId, account.id),
    ])
    const channelByBot = new Map(bindings.map((row) => [row.botId, row.kind]))
    const seats = new Map(seatRows.map((rt) => [rt.botId, rt]))
    const machineOf = machineResolver(db)
    const bots = await Promise.all(
      items.map(async (item) => ({
        ...publicBot(item, pinned, tpl),
        channel: channelByBot.get(item.id) ?? null,
        runtime: await botRuntime(async (id) => seats.get(id), machineOf, item),
      })),
    )
    json(res, 200, {
      bots,
      quota: { used: await db.countUserBots(account.id), max: MAX_USER_BOTS },
      rosterStreamUrl: (await rosterStreamUrlFor(seats, machineOf, bots)) || null,
    })
  })

  /**
   * 自己建一个 Bot。
   *
   * **这一层只收身份**：名字、头像、简介、开场白，外加一段追加提示词。人设、行为边界、
   * 记忆策略、能用哪些 Skill / MCP 全部来自公司模版（见 lib/catalog.ts 的 publicBot），
   * 这里既不存也不收——收了就会有人以为自己改得动，而下一次读仍然是模版那一份。
   *
   * **建完就开装，不用再点一次「部署」。** 以前这里是「只落一行目录项」，理由是「一个
   * Bot 一个进程，那是机器上的真实开销，不该在填完名字的一瞬间悄悄发生」。可那笔开销
   * 并不会因为多一颗按钮就少一点：人建 Bot 就是为了跟它说话，没有谁会建完之后不部署。
   * 代价全落在了另一头——建完跳进对话页，看到的是一块空屏加一句「还没有部署」，而他
   * 刚刚明明填完了整张表。
   *
   * 装那一段（十几分钟）**不挂在这条请求上**：startSeatDeploy 只等「登记」做完就返回，
   * 席位行这时已经是 `deploying` 了，界面照着它画安装进度。
   *
   * **装不成不等于建不成。** 公司还没配机器、没发布过 Bot 版本、槽位用满——这些都不该
   * 让「建 Bot」这件事失败（那颗 Bot 本身好好的，机器修好之后点一下就能装上）。所以理
   * 由回在 `deploy` 里，让界面把话说清楚，而不是把 201 变成 409。
   */
  router.post('/runtime/bots', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const body = bodyOf(req)
    // 先把 body 整理好再进事务：形状错的 400 不该占着锁。
    const definition = {
      description: strField(body, 'description', false),
      greeting: strField(body, 'greeting', false),
      extraPrompt: extraPromptOf(body.extraPrompt),
      icon: botIconOf(body.icon, 'company'),
      enabled: true,
      runtimeKind: body.runtimeKind === 'local' ? 'local' : 'remote',
    }
    const name = botNameOf(body.name)
    // 数和插放同一个事务、先拿锁（照 channels.ts 绑 Telegram 那条的写法）：不锁的话两个
    // 并发请求都读到「还差一个」，配额就多出一颗。
    const item = await db.tx(async () => {
      await db.lockExclusive(USER_BOT_QUOTA_LOCK)
      const used = await db.countUserBots(account.id)
      if (used >= MAX_USER_BOTS) throw new HttpError(409, `最多建 ${MAX_USER_BOTS} 个 Bot`)
      return db.insertCatalog({
        kind: 'bot',
        scope: 'user',
        companyId: account.companyId,
        accountId: account.id,
        name,
        definition,
      })
    })
    await db.audit({
      companyId: account.companyId!,
      accountId: account.id,
      action: 'bot.create',
      detail: { id: item.id, name: item.name },
    })
    /**
     * **开装这一步不许把「建 Bot」带倒。**
     *
     * 目录项这时已经落库了，而这条路上每一步都可能抛：挑机器、定槽位那个事务、审计，
     * 全是查库。一次连接抖动就会让这条请求变成 500，可 Bot 明明建好了——界面上是一句
     * 「创建失败」外加一个还开着、字都填好了的弹窗，人当然会再按一次，于是同名的第二颗
     * Bot 建出来，十个配额白扣一个。**回执必须如实说「建好了，只是没装上」。**
     *
     * 预料之内的失败（没配机器、没发布版本、槽位满）由 startSeatDeploy 用返回值说；
     * 这个 catch 只兜预料之外的那些。
     */
    let started: Awaited<ReturnType<typeof startSeatDeploy>>
    if (runtimeKindOf(item) === 'local') {
      started = { ok: false, status: 200, error: '', runtime: undefined }
    } else try {
      started = await startSeatDeploy(db, account, { botId: item.id })
    } catch (e) {
      console.warn(`satuwork-gateway: Bot ${item.id} 建好了但没能开装：${e instanceof Error ? e.message : String(e)}`)
      started = { ok: false, status: 500, error: '这个 Bot 建好了，但这次没能开始安装。稍后在它的对话页上点「部署这个 Bot」再试。', runtime: undefined }
    }
    if (started.ok) {
      // 同上：审计写不进去也不该把已经建好的 Bot 报成失败。
      await db
        .audit({
          companyId: account.companyId!,
          accountId: account.id,
          action: 'runtime.deploy',
          detail: {
            botId: item.id,
            linuxUser: started.runtime.linuxUser,
            seatId: started.runtime.seatId,
            slot: started.runtime.slot,
            status: started.runtime.status,
            // 审计里要分得出「谁按的」：这一条没有人按，是建 Bot 顺带开的。
            auto: true,
          },
        })
        .catch((e) => console.warn(`satuwork-gateway: Bot ${item.id} 自动部署的审计没写成：${e instanceof Error ? e.message : String(e)}`))
    }
    const { pinned, tpl } = await botContext(db, account.companyId)
    // 席位那一份同理：读不出来就当没有（界面照旧从轮询那条路要），不能因此把 201 变成
    // 500——这一整段之后没有任何一件事值得让「建 Bot」失败。
    const runtime = await oneBotRuntime(db, account, item).catch(() => null)
    json(res, 201, {
      bot: { ...publicBot(item, pinned, tpl), runtime },
      deploy: runtimeKindOf(item) === 'local'
        ? { started: false, local: true }
        : started.ok ? { started: started.installing } : { started: false, error: started.error },
    })
  })

  /** 改自己那一个。同样只认身份字段——底座在模版里，这里传什么都不看。 */
  router.patch('/runtime/bots/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const item = await ownBotOf(db, account, req.params.id)
    const body = bodyOf(req)
    const def = { ...(item.definition as Record<string, unknown>) }
    if (body.description !== undefined) def.description = String(body.description).trim()
    if (body.greeting !== undefined) def.greeting = String(body.greeting).trim()
    if (body.extraPrompt !== undefined) def.extraPrompt = extraPromptOf(body.extraPrompt)
    // 跨层级的键（全局那套）当没传，保留原值——跟平台侧那条 patch 一个规矩。
    // 走 botIconOf 的话不认识的键会落回默认头像，改一次名字顺手把头像也冲了。
    if (typeof body.icon === 'string') {
      const key = LEGACY_BOT_ICONS[body.icon.trim()] ?? body.icon.trim()
      if (iconSetFor('company').has(key)) def.icon = key
    }
    if (typeof body.enabled === 'boolean') def.enabled = body.enabled
    const next = await db.updateCatalog(item.id, {
      name: body.name !== undefined ? botNameOf(body.name) : undefined,
      definition: def,
    })
    await db.audit({
      companyId: account.companyId!,
      accountId: account.id,
      action: 'bot.update',
      detail: { id: item.id, name: next.name },
    })
    const { pinned, tpl } = await botContext(db, account.companyId)
    json(res, 200, { bot: { ...publicBot(next, pinned, tpl), runtime: await oneBotRuntime(db, account, next) } })
  })

  /**
   * Desktop 启动本地进程所需的短路径。只给本人自己的 local Bot。
   *
   * **给的是桌面端那一套凭证，不是席位那一套**（迁移 0041）。席位那一套从来不换，以前这里
   * 把它交给任何一张登录票，一张被偷的票就能换成一对永久有效的 `sat_` / `sk_sw_`。桌面那一套
   * 跟登录票同生共死：改口令、被管理员重置（tokenRevokedAt）之后它一起作废，桌面端重新登录、
   * 再来要一次，拿到的就是新的；壳子发现票换了，会用新票把跑着的本地 Bot 重起一遍。
   */
  router.post('/runtime/bots/:id/local-bootstrap', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const item = await ownBotOf(db, account, req.params.id)
    if (runtimeKindOf(item) !== 'local') throw new HttpError(409, '这不是本地 Bot')
    const secrets = await db.desktopSecrets(account.id, account.tokenRevokedAt ?? 0)
    json(res, 200, {
      botId: item.id,
      gatewayUrl: originOf(req),
      accessToken: secrets.accessToken,
      apiKey: secrets.apiKey,
    })
  })

  /**
   * Desktop 的轻量更新探针。平台与架构由本机上报；没有对应包或已经是最新版都回 204。
   * 下载仍走带 sat_ 鉴权的 internal 路由，manifest 本身不泄露运行时凭证。
   */
  router.get('/runtime/local-bot-release', async (req, res) => {
    await requireSeatOnly(req, db)
    const platform = String(req.query.get('platform') || '').trim().toLowerCase()
    const arch = String(req.query.get('arch') || '').trim().toLowerCase()
    if (!['darwin', 'windows', 'linux'].includes(platform)) throw new HttpError(400, '不支持这个 Desktop 平台')
    if (!['x64', 'arm64'].includes(arch)) throw new HttpError(400, '不支持这个 Desktop 架构')
    const latest = (await db.botReleases('local-bot')).find((release) => {
      const target = localBotReleaseTarget(release.version)
      return target?.platform === platform && target.arch === arch
    })
    const have = String(req.query.get('have') || '').trim()
    if (!latest || latest.version === have) {
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    json(res, 200, {
      version: latest.version,
      sha256: latest.sha256,
      size: latest.size,
      url: `${originOf(req)}/internal/local-bot-releases/${encodeURIComponent(latest.version)}`,
      // 外部地址（GitHub Release）。现有的 Desktop 只认上面那个同源的 `url`，这个字段是给
      // 以后的壳用的：有它就裸取、按 sha256 / size 比对，不经 Gateway 转发（原因见
      // releases.ts 的 directReleaseUrl）。null = 只能走 `url`。
      directUrl: directReleaseUrl(latest),
      minDesktopVersion: '0.1.0',
      mandatory: false,
      note: latest.note,
    })
  })

  /** 删自己那一个：先冻结、跑删除终审，再由后台状态机拆席位并物理删除。 */
  router.delete('/runtime/bots/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const item = await ownBotOf(db, account, req.params.id, true)
    // 删除流程可能是异步的。先停渠道，避免新消息继续落到即将拆掉的席位。
    const bindings = await db.channelBindings(account.id)
    await Promise.all(bindings
      .filter((binding) => binding.botId === item.id && binding.status !== 'paused')
      .map((binding) => db.updateChannelBinding(binding.id, {
        status: 'paused', lastError: '绑定的 Bot 正在删除',
      })))
    const deletion = await requestBotDeletion(db, {
      companyId: account.companyId!, accountId: account.id, botId: item.id, botName: item.name, requestedBy: account.id,
    })
    const done = deletion.status === 'completed'
    json(res, done ? 200 : 202, done
      ? { deleted: true, id: item.id, seats: 'releasedSeats' in deletion ? deletion.releasedSeats : 0, orphans: deletion.orphans, deletion }
      : { deleting: true, id: item.id, deletion })
  })

  router.get('/runtime/bot-deletions/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const deletion = await db.botDeletion(req.params.id)
    if (!deletion || deletion.companyId !== account.companyId || (deletion.accountId && deletion.accountId !== account.id)) {
      throw new HttpError(404, '删除请求不存在')
    }
    json(res, 200, { deletion })
  })

  router.get('/runtime/bots/:id/session', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const bot = await visibleBotOf(db, account, req.params.id)
    const target = await seatTargetFor(db, account, bot.id)
    const url = `${target.host}/api/bots/${encodeURIComponent(bot.id)}/session`
    const bearerTok = await seatBearer(db, account.id)
    let r: Response
    try {
      r = await fetch(url, {
        headers: {
          authorization: bearerTok ? `Bearer ${bearerTok}` : '',
          accept: 'application/json',
          ...machineHeader(target.machineToken),
        },
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      throw new HttpError(503, INSTANCE_DOWN)
    }
    const text = await r.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = { error: text.slice(0, 200) || INSTANCE_DOWN }
    }
    if (r.ok && parsed && typeof parsed === 'object' && account.companyId) {
      const sessionId = (parsed as { sessionId?: unknown }).sessionId
      if (typeof sessionId === 'string' && sessionId) {
        await db.upsertSessionIndex({
          sessionId,
          companyId: account.companyId,
          accountId: account.id,
          botId: bot.id,
        })
      }
    }
    /**
     * **席位说「没有这个助理」不等于「没有这颗 Bot」，它说的是「我还不认识它」。**
     *
     * 进程刚起来那会儿目录还没拉回来（catalog 的首次 pull 是 fire-and-forget，见 bot 的
     * catalog/index.ts），名册是空的，`/api/bots/:id/session` 于是 404。这和「进程还没
     * 听上端口」是同一件事的两副面孔——一次全新部署必然把两个窗口都走一遍。
     *
     * 原样把 404 转出去的话，调用方只能在**两种含义完全相反的 404** 之间猜：这一条是
     * 「再等等就好」，而上面 visibleBotOf 那条（这颗 Bot 不是你的 / 已经删了）是「等一
     * 万年也一样」。折成 503 之后，「还没就绪」在这条接口上只有一个状态码，404 就单纯
     * 是永久错误了。席位自己那句话留在 body 里，curl 排错时还看得见。
     */
    if (r.status === 404) {
      const seatSaid = (parsed as { error?: unknown } | null)?.error
      json(res, 503, { error: typeof seatSaid === 'string' && seatSaid ? `${INSTANCE_DOWN}（席位：${seatSaid}）` : INSTANCE_DOWN })
      return
    }
    json(res, r.status, parsed)
  })

  router.get('/runtime/bots/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const bot = await visibleBotOf(db, account, req.params.id)
    const { pinned, tpl } = await botContext(db, account.companyId)
    json(res, 200, { bot: { ...publicBot(bot, pinned, tpl), runtime: await oneBotRuntime(db, account, bot) } })
  })

  /**
   * 再往前翻一页历史。游标是上一页最靠前那条的 seq。
   *
   * 和那条流分开走：翻页是人点出来的一次性动作，塞进流里既要发明请求帧，又会让
   * 重连的游标语义变浑。
   */
  router.get('/runtime/sessions/:id/history', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    const before = Math.max(0, Math.trunc(Number(req.query.get('before')) || 0))
    const turns = Math.min(50, Math.max(1, Math.trunc(Number(req.query.get('turns')) || 20)))
    await proxyJson(
      res,
      'GET',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/history?turns=${turns}${before ? `&before=${before}` : ''}`,
      undefined,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  /**
   * 一次委派的子会话全文（见 docs/delegation.md §13 的「看过程」）。
   *
   * **授权走主会话。** 子会话不进会话索引，而 `seatTargetForSession` 查的正是那张索引
   * ——按子会话 id 直取会换回 503，而那个 503 在界面上长得像「席位掉线了」。父子关系由
   * 席位那头核对（它才有 JSONL）。
   */
  router.get('/runtime/sessions/:id/tasks/:child/history', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    const turns = Math.min(50, Math.max(1, Math.trunc(Number(req.query.get('turns')) || 50)))
    await proxyJson(
      res,
      'GET',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/tasks/${encodeURIComponent(req.params.child)}/history?turns=${turns}`,
      undefined,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  router.post('/runtime/sessions/:id/messages', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    const body = bodyOf(req)
    // 图片带的是**工作区里的路径**，不是字节——文件早就传上去了（见上面那条 files）。
    // 真正的校验（路径越界、文件在不在、格式模型认不认）在席位那头，那里才有工作区。
    const images = Array.isArray(body.images)
      ? body.images.slice(0, 10).map((x) => {
          const o = (x ?? {}) as Record<string, unknown>
          return { path: String(o.path ?? ''), mime: String(o.mime ?? '') }
        })
      : undefined
    /**
     * `@` 点名。**Gateway 必须逐个校验，不能原样透传。**
     *
     * 席位那边收到什么就注入什么——它信的是那张 `sat_` 票，票背后是谁由我们说了算。
     * 不属于这个账号的、断了的、公司禁了的一律**剔掉**，并在响应里说明是哪几条；
     * 不是让整条消息失败：用户那句话没有错，错的是一个已经失效的点名。
     */
    const wanted = Array.isArray(body.mentions) ? body.mentions.slice(0, 10) : []
    const mentions: { kind: string; id: string; label: string }[] = []
    const dropped: string[] = []
    if (wanted.length) {
      const companyId = account.role === 'owner' ? null : account.companyId
      const items = await db.visibleCatalog('connector', companyId)
      const blocks = blockMapOf(items)
      const defs = new Map(items.filter((i) => i.scope === 'global').map((i) => [i.id, connectorDefOf(i)]))
      const conns = new Map(
        (await db.connectionsFor(account.id, companyId)).filter((c) => c.status === 'active').map((c) => [c.id, c]),
      )
      for (const raw of wanted) {
        const o = (raw ?? {}) as Record<string, unknown>
        const id = String(o.id ?? '').trim()
        const kind = String(o.kind ?? 'connector')
        const conn = kind === 'connector' ? conns.get(id) : undefined
        const def = conn ? defs.get(conn.connectorId) : undefined
        if (!conn || !def || !def.enabled || blocks.get(conn.connectorId)?.blocked) {
          if (id) dropped.push(id)
          continue
        }
        mentions.push({ kind: 'connector', id, label: `${def.name} (${conn.label})` })
      }
    }

    await proxyJson(
      res,
      'POST',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/messages`,
      {
        text: strField(body, 'text', images?.length || mentions.length ? false : true),
        ...(images?.length ? { images } : {}),
        ...(mentions.length ? { mentions } : {}),
      },
      await seatBearer(db, account.id),
      target.machineToken,
      // 剔掉了什么要说出来：界面上那几颗药丸得消失，而人要知道为什么。
      dropped.length ? { droppedMentions: dropped } : undefined,
    )
  })

  /** 排着的消息。刷新页面之后 dock 靠它恢复——队列的真相在席位那边，不在浏览器。 */
  router.get('/runtime/sessions/:id/queue', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    await proxyJson(
      res,
      'GET',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/queue`,
      undefined,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  /** 取消一条。已经开跑的席位会回 409，原样透出去——界面据此把那一行改成气泡。 */
  router.delete('/runtime/sessions/:id/queue/:queueId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    await proxyJson(
      res,
      'DELETE',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/queue/${encodeURIComponent(req.params.queueId)}`,
      undefined,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  /**
   * 还等着人拍板的高风险调用。**真相在席位那边**——等待方是那个进程里的一个 Promise，
   * Gateway 只是把它转出来；自己缓存一份的话，刷新页面看到的会是一张早就点过的卡片。
   */
  router.get('/runtime/sessions/:id/approvals', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    await proxyJson(
      res,
      'GET',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/approvals`,
      undefined,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  /**
   * 批准 / 拒绝。
   *
   * **鉴权就是 `seatTargetForSession`**：它已经保证了这条会话属于这个账号（那把
   * `sat_` 是按账号发的）。别人的会话在这里根本查不出席位，拿不到可以点的地方——
   * 这也是为什么这条路不能走席位票直连：那把票在员工的桌面里够得着。
   *
   * 席位回 409（这条确认已经结束）原样透出去，界面据此把卡片改成「已失效」。
   */
  router.post('/runtime/sessions/:id/approvals/:callId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    const body = bodyOf(req)
    await proxyJson(
      res,
      'POST',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/approvals/${encodeURIComponent(req.params.callId)}`,
      {
        decision: strField(body, 'decision'),
        scope: strField(body, 'scope', false) || 'once',
        /**
         * 卡片上改过的那几格，**原样转发**。
         *
         * Gateway 不认字段、也不做校验：哪几格能改是席位那边算出来的（policy/forms.ts），
         * 在这儿再判一次就是同一套规则的第二份，两份迟早会漂。这里只保证形状是个对象。
         */
        ...(body.edits && typeof body.edits === 'object' && !Array.isArray(body.edits) ? { edits: body.edits } : {}),
      },
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  /**
   * 这条会话上还没闭合的交接单。
   *
   * **真相在席位那边**（那是落盘的单子），这一跳只转发；Gateway 库里那一份是索引，
   * 给跨 Bot 的待办页用，不给这里用——两处读法不一样的话，会话里那张卡片和待办页上
   * 那一行迟早会各说各的。
   *
   * 接手 / 交还走的是 `/runtime/handoffs/:id/*`（按单号，不按会话）：接手的人可能是
   * 管理员，这条会话根本不是他的，`seatTargetForSession` 那条判据在那儿不成立。
   */
  router.get('/runtime/sessions/:id/handoffs', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    await proxyJson(
      res,
      'GET',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/handoffs`,
      undefined,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  /**
   * 这条会话现在的待办清单（输入框上面那块 dock 的初值，见 docs/todo-tool.md）。
   *
   * 和上面那条交接单一样只是转发：真相在席位的库里。界面平时靠 `todo/list` 事件跟着
   * 变，这一跳只在**刚打开这一页**时拉一次——流上只垫最近一轮，早先列出来还没做完的
   * 那张表不在里面。
   */
  router.get('/runtime/sessions/:id/todos', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    await proxyJson(
      res,
      'GET',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/todos`,
      undefined,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  router.post('/runtime/sessions/:id/abort', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    await proxyJson(
      res,
      'POST',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/abort`,
      {},
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  /**
   * 人手改上下文边界：`/compact` 压一次、`/new` 从这里重开（见 docs/chat-commands.md）。
   *
   * **这一层不做业务判断**，形状和上面那条 abort 逐字一样。这条会话跑没跑、有几个
   * 可切的轮次边界、队里还排着几条——只有席位知道；Gateway 只管身份与归属，剩下的
   * 原样转、原样透回（拒绝的状态码和那句原话一起）。
   */
  for (const act of ['compact', 'reset'] as const) {
    router.post(`/runtime/sessions/:id/${act}`, async (req, res) => {
      const account = await requireUser(req, db, keys)
      const target = await seatTargetForSession(db, account, req.params.id)
      await proxyJson(
        res,
        'POST',
        `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/${act}`,
        {},
        await seatBearer(db, account.id),
        target.machineToken,
      )
    })
  }

  /**
   * 上传附件**不再经 Gateway**。原来这里有一条 `postRaw('/runtime/sessions/:id/files')` 把字节
   * 边收边转给席位；上传动辄几十 MB，在 Vercel 函数里既撞请求体上限又占着一个实例十分钟。
   * 现在浏览器拿 `/runtime/bots` 里的 `uploadUrl`（`{directUrl}/seats/:id/stream`，管家 ≥ 9）
   * 直接 `POST {uploadUrl}/sessions/:id/files`，带登录 JWT，管家换成 `sat_` 把正文管给 Bot。
   * 文件名照旧走 `x-filename` 头，不进查询串（查询串会进访问日志，而文件名常常就是内容本身）。
   */

  /**
   * 列这条会话所在席位的工作区里的一层目录（界面右栏那棵文件树）。
   *
   * 和下面那条预览同一道门：越界检查在席位那头，这里只证明「这个人有权打这台席位」。
   */
  router.get('/runtime/sessions/:id/workspace', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    const path = req.query.get('path') ?? ''
    await proxyJson(
      res,
      'GET',
      `${target.host}/api/workspace/list?path=${encodeURIComponent(path)}`,
      undefined,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  /**
   * 删掉这条会话所在席位的工作区里的一个文件或目录（树上那颗删除）。
   *
   * 和上面那条列目录同一道门、同一个 path 语义，只是方法不同——**归属判断不能松**：
   * 这是这几条里唯一不可逆的一条，`seatTargetForSession` 证明的正是「这个人有权打
   * 这台席位」，越界与「能不能删」由席位那头说了算。
   */
  router.delete('/runtime/sessions/:id/workspace', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    const path = req.query.get('path') ?? ''
    // 空 path 在席位那头会落到工作区根上（那条自己也挡了一道）。这里先挡是为了别把
    // 一次「按钮没带上路径」的前端 bug 变成一次打到席位的删除请求。
    if (!path.trim()) throw new HttpError(400, 'path 不能为空')
    await proxyJson(
      res,
      'DELETE',
      `${target.host}/api/workspace/file?path=${encodeURIComponent(path)}`,
      undefined,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  /**
   * 预览（或下载）这条会话所在席位的工作区里的一个文件。
   *
   * 上传进来的和 Bot 自己写出来的走同一条路——它们本来就在同一个目录里。越界检查在
   * 席位那头（workspace 服务），这里只负责证明「这个人有权打这台席位」。
   */
  router.get('/runtime/sessions/:id/files', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    const path = req.query.get('path') ?? ''
    if (!path.trim()) throw new HttpError(400, 'path 不能为空')
    // `as=text` 回的是 JSON（提取出来的文档正文），不是字节流——走 proxyJson。
    // 拿 proxyDownload 转会给它安上 content-disposition 和那条 sandbox CSP，
    // 对一段 JSON 既没意义又容易让人误以为它也是「文件字节」。
    if (req.query.get('as') === 'text') {
      await proxyJson(
        res,
        'GET',
        `${target.host}/api/workspace/file?path=${encodeURIComponent(path)}&as=text`,
        undefined,
        await seatBearer(db, account.id),
        target.machineToken,
      )
      return
    }
    const q = `?path=${encodeURIComponent(path)}${req.query.get('download') === '1' ? '&download=1' : ''}`
    await proxyDownload(
      req,
      res,
      `${target.host}/api/workspace/file${q}`,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })
}
