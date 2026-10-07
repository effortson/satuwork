/**
 * 连接器的 MCP 端点：席位实例连到这里，Gateway 再去打供应商。
 *
 * **一把连接一条路径**（`/mcp/connectors/:connectionId`）。这样席位那边合成出来的
 * 工具名天然带账号（`mcp_gmail_person_send_email` / `mcp_gmail_defaul_send_email`），
 * 模型不用靠参数说明去猜该用哪个邮箱，流水也直接落到具体哪一把连接上。
 *
 * 见 docs/connectors.md §7、§8。
 */
import type { ServerResponse } from 'node:http'
import { HttpError, json, type Req, type Router } from '../http.ts'
import type { RouteCtx } from './ctx.ts'
import { ProviderError, providerFor, type ToolDef } from '../connectors/index.ts'
import { MAX_TOOLS, annotateFileParams, blockMapOf, connectorDefOf, matchTools, toolsOf } from '../lib/connectors.ts'
import {
  SEARCH_LIMIT,
  metaToolDefs,
  metaToolOf,
  renderHits,
  renderMiss,
  searchTools,
  toolModeOf,
} from '../lib/tool-search.ts'
import { requireSeatOnly } from '../lib/guards.ts'
import type { Account, ConnectorCallStatus, ConnectorConnection, Db } from '../db.ts'

/**
 * 上游调用的时限。
 *
 * **必须比席位那边的客户端先超时**（那边给连接器留的是 60 秒）。反过来的话，Bot 已经
 * 断了我们还在等，这次调用记不到结果，钱也说不清收没收。
 *
 * 可以调小，只为一件事：e2e 要在几秒内验到超时那一档，而不是真等 45 秒。
 */
const UPSTREAM_TIMEOUT_MS = Math.max(1000, Math.trunc(Number(process.env.CONNECTOR_UPSTREAM_TIMEOUT_MS) || 45_000))

/**
 * 附件暂存的两道上限。
 *
 * 大小默认 25 MB——Gmail 单封邮件的附件上限就是这个数，再大的文件连接器那头也收不下。
 * 时限单独给：两步往返加上把字节推到对象存储，比一次工具调用慢得多，套 45 秒会把
 * 正常的大附件掐断。**席位那边的客户端等的时间要比这个长**（同 UPSTREAM_TIMEOUT_MS
 * 那条理由）。
 */
const UPLOAD_MAX_BYTES = Math.max(1024, Math.trunc(Number(process.env.CONNECTOR_UPLOAD_MAX_BYTES) || 25 * 1024 * 1024))
const UPLOAD_TIMEOUT_MS = Math.max(1000, Math.trunc(Number(process.env.CONNECTOR_UPLOAD_TIMEOUT_MS) || 90_000))

/**
 * 工具名去掉 toolkit 前缀：`GMAIL_SEND_EMAIL` → `SEND_EMAIL`。
 *
 * 席位那边的 `mcpToolName()` 会把服务器名当前缀再拼一次，不去掉的话就成了
 * `mcp_gmail_person_gmail_send_email`——名字有长度上限，重复的那一截会把真正区分
 * 工具的尾巴挤掉，两个不同的工具截成同一个名字，后注册的那个被静默丢弃。
 */
export function shortToolName(toolkit: string, slug: string): string {
  const prefix = `${toolkit.toUpperCase().replace(/-/g, '_')}_`
  return slug.toUpperCase().startsWith(prefix) ? slug.slice(prefix.length) : slug
}

/**
 * 席位传回来的名字 → 真实 slug。
 *
 * **先拿真清单对，对不上再按前缀猜。** 只靠前缀猜是错的：`shortToolName` 只在 slug
 * 带 toolkit 前缀时才去前缀，而这里无条件补前缀，两者对「不带前缀的 slug」不互逆。
 * Composio 的自定义工具就是这种（`LOCAL_GMAIL_GET_IMPORTANT_EMAILS`），猜出来会变成
 * `GMAIL_LOCAL_GMAIL_…`——工具表里有、点了永远失败，还查不出为什么。
 *
 * 拿不到清单（供应商暂时不可达）时才退回猜，那时宁可猜错一个也好过把所有调用堵死。
 * 两条路都保住同一个边界：结果要么来自这个 toolkit 的清单，要么带着它的前缀，
 * 跨 toolkit 是够不着的。
 */
export function resolveToolSlug(toolkit: string, name: string, known: ToolDef[] = []): string {
  const raw = String(name || '').trim()
  if (!raw) return ''
  const upper = raw.toUpperCase()
  const hit = known.find((t) => t.slug.toUpperCase() === upper || shortToolName(toolkit, t.slug).toUpperCase() === upper)
  if (hit) return hit.slug
  const prefix = `${toolkit.toUpperCase().replace(/-/g, '_')}_`
  return upper.startsWith(prefix) ? upper : prefix + upper
}

interface RpcReq {
  jsonrpc?: string
  id?: unknown
  method?: string
  params?: unknown
}

function rpcOk(res: ServerResponse, id: unknown, result: unknown) {
  json(res, 200, { jsonrpc: '2.0', id: id ?? null, result })
}

function rpcErr(res: ServerResponse, id: unknown, code: number, message: string) {
  json(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } })
}

/** 工具的返回值一律走 MCP 的 content 形状；`isError` 让席位那边知道这次没成。 */
function toolResult(text: string, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

/** 目录暂时拉不到时对模型说的话。**说清是目录的问题，不是工具不存在。** */
function renderCatalogDown(toolkit: string): string {
  return (
    `${toolkit} 的工具目录这会儿拉不到，不是没有这个工具。过一会儿再搜一次；` +
    `如果你已经知道确切的工具名，可以直接用 SW_RUN 调，那条路不依赖目录。`
  )
}

/**
 * `SW_RUN` 的参数。**认嵌套的 `args`，也认平铺。**
 *
 * 两层结构（`{ tool, args }`）模型经常写错，把工具自己的参数直接铺在 `arguments` 顶层。
 * 只认 `args` 的话那种调用会带着空参数打到上游——上游回 2xx + `successful:false`，按
 * connectors.md §8 的口径**这一次照收钱**，然后模型看到「缺少必填参数」再试一次、再收
 * 一次。猜错的代价是零（平铺时 `tool` 之外的键本来就是参数），不猜的代价是重复计费。
 */
function runArgsOf(metaArgs: Record<string, unknown>): unknown {
  const nested = metaArgs.args
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested
  // 有些模型会把 args 整个 JSON 字符串化。
  if (typeof nested === 'string' && nested.trim()) {
    try {
      const parsed = JSON.parse(nested)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      /* 不是 JSON 就当没有，退回下面的平铺 */
    }
  }
  const { tool: _tool, args: _args, ...rest } = metaArgs
  return rest
}

export function attachConnectorMcp(router: Router, ctx: RouteCtx) {
  const { db, meter } = ctx

  /**
   * 这一把连接现在能不能用，以及它属于谁。
   *
   * 判定顺序一步都不能省：票 → 归属 → active → 公司没禁 → 装了 → 工具在子集里。
   * URL 上的 `botId` **只做统计归因，不参与鉴权**——它是席位自己填的，可以是假的，
   * 但假也只能假成同一个账号名下的另一颗 Bot。账号才是边界。
   */
  async function gate(req: Req): Promise<{
    account: Account
    conn: ConnectorConnection
    toolkit: string
    vendor: string
    enabledTools: string[]
    botId: string
  }> {
    const account = await requireSeatOnly(req, db)
    const conn = await db.connectorConnection(req.params.connectionId)
    if (!conn) throw new HttpError(404, '没有这个连接')
    const mine = conn.scope === 'company' ? conn.companyId === account.companyId : conn.accountId === account.id
    if (!mine) throw new HttpError(404, '没有这个连接')
    if (conn.status !== 'active') throw new HttpError(409, '这个账号还没连上')

    const items = await db.visibleCatalog('connector', account.companyId)
    const item = items.find((i) => i.id === conn.connectorId && i.scope === 'global')
    if (!item) throw new HttpError(404, '没有这个连接器')
    const def = connectorDefOf(item)
    if (!def.enabled) throw new HttpError(404, '没有这个连接器')
    if (blockMapOf(items).get(item.id)?.blocked) throw new HttpError(403, '本公司已禁用这个连接器')

    // 公司共用那把不挂在某个人的安装上，所以只有个人连接要查安装。
    let enabledTools: string[] = []
    if (conn.scope === 'user') {
      const install = await db.connectorInstall(item.id, account.id)
      if (!install) throw new HttpError(409, '还没装这个连接器')
      enabledTools = install.enabledTools
    }
    return {
      account,
      conn,
      toolkit: def.toolkit,
      vendor: def.vendor,
      enabledTools,
      botId: (req.query.get('botId') || '').trim(),
    }
  }

  // 余额、单价、落账都在 lib/meter.ts 了。这里曾经有一份自己的 budgetOf 和
  // priceMicrosOf——那时连接器是唯一往下扣的东西，所以「余额」只看 connector_calls。
  // 模型和网页工具接上之后那个口径就错了：钱烧在别处，这里算出来的余额纹丝不动。

  router.post('/mcp/connectors/:connectionId', async (req, res) => {
    const body = (req.body ?? {}) as RpcReq
    const method = String(body.method || '')
    const id = body.id
    // 通知（没有 id）不用回结果。`notifications/initialized` 是握手的最后一步。
    const isNotification = id === undefined || id === null

    const g = await gate(req)

    if (method === 'initialize') {
      rpcOk(res, id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: `satuwork-connector-${g.toolkit}`, version: '1' },
      })
      return
    }
    if (method.startsWith('notifications/')) {
      if (isNotification) {
        json(res, 200, {})
        return
      }
      rpcOk(res, id, {})
      return
    }

    if (method === 'tools/list') {
      let all: ToolDef[]
      try {
        all = await toolsOf(db, g.vendor, g.toolkit)
      } catch {
        // 拉不到清单就回空表，不回错：席位那边收到错会把整台服务器标成连不上，
        // 而它其实只是这一次没拿到目录，下一轮探针还会再来。
        rpcOk(res, id, { tools: [] })
        return
      }
      const allow = new Set(g.enabledTools)
      const picked = allow.size ? all.filter((tl) => allow.has(tl.slug)) : all

      /**
       * 开着的 slug 对不上真清单时**要说出来**。
       *
       * 对不上的既不下发也不报错。全都对不上时这把连接就是一张空工具表——连着、界面上
       * 写着「开了 N 个」、一个工具都用不了。上架时填错、供应商改名、供应商下线一个工具，
       * 都会走到这里。
       */
      if (allow.size) {
        const { unknown } = matchTools(all, g.enabledTools)
        if (unknown.length) {
          console.warn(
            `satuwork-gateway: 连接 ${g.conn.id}（${g.toolkit}）开着的 ${unknown.length} 个工具在清单里没有：${unknown.join('、')}`,
          )
        }
      }

      /**
       * 装不下就**降级**，不截断（docs/tool-search.md §4）。
       *
       * 降级和截断的区别是全部：截断之后那 436 个工具**够不着**，降级之后一个都不少，
       * 只是要先搜一下。所以这条路上不带 `truncated`——没有东西被丢掉。
       */
      const mode = toolModeOf(picked)
      if (mode !== 'direct') {
        console.log(
          `satuwork-gateway: 连接 ${g.conn.id}（${g.toolkit}）有 ${picked.length} 个工具，切到搜索模式（${mode}）`,
        )
        rpcOk(res, id, { tools: metaToolDefs(g.toolkit, picked, mode) })
        return
      }

      const kept = picked.slice(0, MAX_TOOLS)
      const dropped = picked.length - kept.length
      if (dropped > 0) {
        console.warn(
          `satuwork-gateway: 连接 ${g.conn.id}（${g.toolkit}）有 ${picked.length} 个工具，超过上限 ${MAX_TOOLS}，截掉 ${dropped} 个`,
        )
      }
      rpcOk(res, id, {
        tools: kept.map((tl) => ({
          name: shortToolName(g.toolkit, tl.slug),
          description: tl.description || tl.name,
          // 文件参数的说明里要写明「先上传」（见 annotateFileParams）。形状原样。
          inputSchema: annotateFileParams(
            tl.inputSchema && Object.keys(tl.inputSchema).length ? tl.inputSchema : { type: 'object', properties: {} },
          ),
        })),
        // 席位不认这个字段，但它得出现在响应里：截断必须说出来。
        ...(dropped > 0 ? { truncated: dropped } : {}),
      })
      return
    }

    if (method !== 'tools/call') {
      rpcErr(res, id, -32601, `不支持的方法：${method}`)
      return
    }

    const params = (body.params ?? {}) as { name?: unknown; arguments?: unknown; _meta?: unknown }
    /**
     * 这一次是不是用户 `@` 点名的。
     *
     * 只有席位那一侧知道（点名决定的是那一轮的工具表），所以它经 MCP 的 `params._meta`
     * 带过来。出事时第一个要问的就是「人点的还是模型自己挑的」，事后从会话正文反推
     * 既慢又不一定对得上。
     *
     * **它现在也参与一处判定**：「仅 @ 时可用」的连接没被点名就不许调（见下面那道门）。
     * 但它仍然是席位自报的，所以那道门挡的是 bug 不是攻击者——真正的边界还是账号
     * （见 gate()）。计费和流水这一侧照旧只拿它做归因。
     */
    // 名字不叫 meta：这个函数里 `meta` 已经是「这次调的是不是元工具」了（SW_SEARCH /
    // SW_DESCRIBE / SW_RUN，见下面 metaToolOf）。两个 meta 撞在同一个作用域里。
    const callMeta = params._meta as { viaMention?: unknown } | undefined
    const viaMention = callMeta?.viaMention === true
    /**
     * 席位到底**说没说**这件事。
     *
     * 三态：true / false / 没这个字段。第三种有两个来源——老席位（那时候还不发这个
     * 标记），以及席位当时答不上来（`viaMentionOf` 返回 undefined）。下面那道
     * mentionOnly 的门只在席位明确说了 false 时才关，见那里的说明。
     */
    const mentionKnown = typeof callMeta?.viaMention === 'boolean'
    // 清单是缓存的（五分钟），所以这一步不是每次调用都打一趟上游。
    /**
     * **拉不到清单和「清单里没有」不是一回事，这里要分开记。**
     *
     * 混成一个空数组的话，供应商抖一下 SW_DESCRIBE 就会回「没有这个工具」，模型转头
     * 告诉用户这个能力不存在——而同一时刻 SW_RUN 其实是通的（`resolveToolSlug` 拉不到
     * 清单会退回猜前缀）。同一个故障给出两种相反结论，是最难查的一类。
     */
    let known: ToolDef[] = []
    let catalogDown = false
    try {
      known = await toolsOf(db, g.vendor, g.toolkit)
    } catch {
      catalogDown = true
    }
    const allow = new Set(g.enabledTools)
    /** 员工开着的那些。元工具**只在这个集合里搜、在这个集合里描述**——关掉的不许露出来。 */
    const visible = allow.size ? known.filter((tl) => allow.has(tl.slug)) : known

    /**
     * 元工具要在 `resolveToolSlug` **之前**拦下来。
     *
     * 那个函数会给不带前缀的名字无条件补 toolkit 前缀，`SW_SEARCH` 会被还原成
     * `GITHUB_SW_SEARCH` 然后当成一个真工具打到上游去。顺序反了就是一个跑得通、
     * 结果全错、日志上看不出来的 bug（docs/tool-search.md §5）。
     */
    const meta = metaToolOf(String(params.name ?? ''))
    // 只认普通对象。数组或字符串直接当空——`runArgsOf` 里的 rest 展开碰上它们会摊出
    // `{0:'{',1:'"'…}` 这种东西，然后一本正经地发给上游。
    const metaArgs =
      params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {}

    /**
     * 搜和描述**不计费、也不落 `connector_calls`**：它们不产生供应商侧的执行，跟
     * `tools/list` 同一档。落进流水表还会把「按工具统计次数」搅浑——`SW_SEARCH` 会
     * 变成这个 toolkit 里调用量最大的「工具」（docs/tool-search.md §7）。只写日志。
     */
    // 目录暂时不可达：**明说是目录的问题**，并给模型一条还走得通的路。
    if ((meta === 'search' || meta === 'describe') && catalogDown) {
      rpcOk(res, id, toolResult(renderCatalogDown(g.toolkit), true))
      return
    }
    if (meta === 'search') {
      const query = String(metaArgs.query ?? '').trim()
      const limit = Math.trunc(Number(metaArgs.limit) || SEARCH_LIMIT)
      const hits = searchTools(visible, query, limit)
      console.log(`satuwork-gateway: 连接 ${g.conn.id}（${g.toolkit}）搜「${query}」命中 ${hits.length} 个`)
      rpcOk(res, id, toolResult(hits.length ? renderHits(hits) : renderMiss(g.toolkit, visible, query)))
      return
    }
    if (meta === 'describe') {
      const want = resolveToolSlug(g.toolkit, String(metaArgs.tool ?? ''), known)
      const hit = visible.find((tl) => tl.slug === want)
      if (!hit) {
        // 关掉的工具也走这一支。**不回它的 schema**——否则模型拿到一份它永远调不动的
        // 参数表，然后反复重试。这里回的是「去找」，不是「不存在」。
        rpcOk(res, id, toolResult(`${g.toolkit} 这把连接里没有开着的 ${want || '(空)'}，先用 SW_SEARCH 找一个。`, true))
        return
      }
      rpcOk(
        res,
        id,
        toolResult(`${hit.slug} — ${hit.description || hit.name}\n\n参数（JSON Schema）：\n${JSON.stringify(annotateFileParams(hit.inputSchema ?? {}), null, 2)}`),
      )
      return
    }

    /**
     * `SW_RUN` 就是今天的 `tools/call`，只是工具名从参数里来。**往下走的是同一段代码**：
     * 白名单、余额、超时、流水、计费一样不少。元工具不许成为绕过工具开关的后门。
     */
    const slug = resolveToolSlug(g.toolkit, String(meta === 'run' ? (metaArgs.tool ?? '') : (params.name ?? '')), known)
    const callArgs = meta === 'run' ? runArgsOf(metaArgs) : (params.arguments ?? {})
    const startedAt = Date.now()

    /**
     * 落一行流水 + 一行账。**被拒的也落**——「谁想调、为什么没调成」和「谁调了」
     * 一样要留档。
     *
     * 流水记事实（耗时、是不是点名来的、哪一把连接），账本记钱，靠 `refId` 串起来。
     * `free` 是「这一次不收钱」：我们自己拒掉的、根本没跑成的，没有产生上游成本。
     */
    /** record() 里最后成功插进流水的那条 id；落账在它之后失败时，日志里靠它对回去。 */
    let recordedRefId: string | null = null
    const record = async (status: ConnectorCallStatus, free = false) => {
      recordedRefId = null
      const call = await db.insertConnectorCall({
        companyId: g.account.companyId,
        accountId: g.account.id,
        connectionId: g.conn.id,
        botId: g.botId || null,
        vendor: g.vendor,
        connector: g.toolkit,
        label: g.conn.label,
        tool: slug,
        status,
        latencyMs: Date.now() - startedAt,
        viaMention,
      })
      await meter.charge({
        kind: 'connector',
        account: g.account,
        botId: g.botId || null,
        status,
        toolkit: g.toolkit,
        tool: slug,
        free,
        refId: call.id,
      })
      recordedRefId = call.id
    }
    /**
     * **上游已经跑过了**（execute 返回、或超时也算发出去了）之后再落账，落账失败不能
     * 再变成 500：那样席位那边看到的是「工具调用失败」，模型多半会再试一次——上游就
     * 被真的执行了两遍（邮件发两封）。这里只记一行 error（带 refId 好补账），把上游
     * 的结果照常还给席位。没跑成那一支不走这里：那时候没有上游成本，500 也不会重放什么。
     */
    const recordAfterUpstream = async (status: ConnectorCallStatus, free = false) => {
      try {
        await record(status, free)
      } catch (e) {
        console.error(
          `satuwork-gateway: 连接器调用已执行但落账失败（connection=${g.conn.id} tool=${slug} status=${status} refId=${recordedRefId ?? '无'}）：${(e as Error).message}`,
        )
      }
    }

    if (!slug) {
      await record('denied', true)
      rpcOk(res, id, toolResult('没有指定工具名', true))
      return
    }
    if (allow.size && !allow.has(slug)) {
      await record('denied', true)
      rpcOk(res, id, toolResult('这个工具没有开启，去连接器那一屏打开它', true))
      return
    }

    /**
     * 「仅 @ 时可用」的连接，**没被点名就不许调**。
     *
     * 这条以前只活在席位那一侧：`toolSchemasFor()` 不把它放进工具表。那是遮掩不是
     * 强制——模型直接报出工具名照样调得到，而这把连接的全部意思就是「只有我点名了
     * 你才能碰我的邮箱」。这里补上服务端这一道。
     *
     * **它挡的是 bug，不是攻击者**：`viaMention` 和 URL 上的 `botId` 一样是席位自报的，
     * 一台被拿下的席位可以直接说自己被点名了。真正的边界仍然是账号（见 gate()）——
     * 假也只能假成同一个账号名下的另一种调用。
     *
     * **席位没说的时候放行，只记一行日志。** 这个字段缺席有两种来源：老席位（Gateway
     * 和席位各自升级，中间必然有一段两边版本不一致），以及席位那一刻取不到 `agents`
     * 服务——后者在线上真发生过一次，当时的后果只是流水少个标记。把「没说」当成「没
     * 点名」的话，那次故障就会变成：用户明明 `@` 了自己的邮箱，每一次调用都被回一句
     * 「这一轮没有点名它」，而他做什么都没用。宁可漏掉一次强制。
     */
    if (g.conn.mentionOnly && mentionKnown && !viaMention) {
      await record('denied', true)
      rpcOk(res, id, toolResult('这把连接设成了「仅 @ 时可用」，这一轮没有点名它', true))
      return
    }
    if (g.conn.mentionOnly && !mentionKnown) {
      console.warn(
        `satuwork-gateway: 连接 ${g.conn.id} 是「仅 @ 时可用」，但席位没报 viaMention（老席位或取不到 agents），这次放行`,
      )
    }

    // 变量名不叫 gate：这个文件里 gate() 已经是「取连接、查权限」那个函数了。
    const credit = await meter.gate(g.account, { kind: 'connector', toolkit: g.toolkit })
    if (!credit.ok) {
      await record('denied', true)
      // **一句人话，不是 HTTP 错误。** 席位那边会把它当工具输出交给模型，模型照实
      // 告诉用户；回错误的话模型多半会重试三次再放弃。
      rpcOk(res, id, toolResult(credit.reason, true))
      return
    }

    if (!g.conn.externalId) {
      await record('error', true)
      rpcOk(res, id, toolResult('这个账号还没连上', true))
      return
    }

    const provider = await providerFor(db, g.vendor)
    const timer = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    try {
      const out = await provider.execute({
        tool: slug,
        externalUserId: g.conn.externalUserId,
        externalId: g.conn.externalId,
        args: callArgs,
        signal: timer,
      })
      /**
       * **execute 返回了，就说明上游 2xx——它真的跑了一遍，照收钱**，哪怕工具自己说
       * 失败（「邮箱不存在」是跑完才知道的，成本已经发生）。没跑成的一律走下面的
       * catch：provider 的契约是「抛出 = 没跑成」，不许把异常吞成一个返回值。
       */
      await recordAfterUpstream(out.ok ? 'ok' : 'failed')
      rpcOk(res, id, toolResult(out.text, !out.ok))
    } catch (e) {
      const timedOut = timer.aborted
      // 超时**照收钱**：发出去的邮件不会因为我们没等到响应就退回来。别的失败
      // （连不上、4xx、5xx）没产生上游成本，不收。
      await recordAfterUpstream(timedOut ? 'timeout' : 'error', !timedOut)
      const msg = e instanceof ProviderError ? e.message : (e as Error).message
      rpcOk(res, id, toolResult(timedOut ? `工具调用超时（${UPSTREAM_TIMEOUT_MS / 1000} 秒）` : `工具调用失败：${msg}`, true))
    }
  })

  /**
   * 附件先暂存：席位把工作区里那份文件的字节 POST 上来，Gateway 转交供应商，把句柄
   * （`{ name, mimetype, s3key }`）还回去，席位再把它填进工具参数。
   *
   *   POST /mcp/connectors/:connectionId/files?tool=SEND_EMAIL&name=<encodeURIComponent(文件名)>
   *   content-type: <文件的 MIME>
   *   <字节>
   *
   * **为什么经 Gateway 而不是席位直传**：和整条连接器链路同一个理由（connectors.md §2）——
   * 供应商密钥不下机器。暂存那一步要带平台 key。
   *
   * **门和 tools/call 一样一道不少**：票 → 归属 → active → 公司没禁 → 装了 → 工具在开着
   * 的子集里。关掉了的工具，附件也传不上去；否则它就是一条把文件送出公司的旁路。
   *
   * **不计费、不落流水。** 上游没有因此执行任何工具，和 tools/list 同一档（§8：一次
   * `tools/call` 才是一个计费事件）。只写一行日志。
   */
  router.postRaw('/mcp/connectors/:connectionId/files', async (req, res) => {
    const g = await gate(req)
    const toolName = (req.query.get('tool') || '').trim()
    if (!toolName) throw new HttpError(400, '要说明这份文件是给哪个工具用的（tool）')
    let known: ToolDef[] = []
    try {
      known = await toolsOf(db, g.vendor, g.toolkit)
    } catch {
      /* 目录拉不到就按前缀猜，同 tools/call */
    }
    const slug = resolveToolSlug(g.toolkit, toolName, known)
    const allow = new Set(g.enabledTools)
    if (allow.size && !allow.has(slug)) throw new HttpError(403, '这个工具没有开启，去连接器那一屏打开它')

    // `req.query` 已经解过一次码（URLSearchParams），这里不再 decode——再解一次会把
    // 名字里本来就有的 `%41` 变成 `A`。只留最后一段：这是给供应商看的展示名，不是路径，
    // 也不该把工作区的目录结构带出去。
    const filename = ((req.query.get('name') || '').trim().split(/[\\/]/).pop() || '').trim()
    if (!filename) throw new HttpError(400, '要带文件名（name）')
    const mimetype = String(req.headers['content-type'] || '').split(';')[0].trim() || 'application/octet-stream'

    /**
     * **边收边数**，超限当场断。先收完再看大小，等于让任何一台席位都能拿 Gateway 的
     * 内存换一次拒绝。整份留在内存里是有意的：推到对象存储那一步要带 Content-Length，
     * 25 MB 以内不值得为它落盘。
     */
    const chunks: Buffer[] = []
    let n = 0
    for await (const chunk of req) {
      n += (chunk as Buffer).length
      if (n > UPLOAD_MAX_BYTES) throw new HttpError(413, `附件太大，上限 ${Math.floor(UPLOAD_MAX_BYTES / 1024 / 1024)} MB`)
      chunks.push(chunk as Buffer)
    }
    if (!n) throw new HttpError(400, '请求体是空的')
    const bytes = Buffer.concat(chunks)

    const provider = await providerFor(db, g.vendor)
    if (!provider.configured()) throw new HttpError(402, '平台还没配这家供应商的密钥')
    if (!provider.caps.fileUpload) throw new HttpError(501, '这家供应商不支持先暂存文件')

    const startedAt = Date.now()
    try {
      const file = await provider.stageFile({
        toolkit: g.toolkit,
        tool: slug,
        filename,
        mimetype,
        bytes,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      })
      console.log(
        `satuwork-gateway: 连接 ${g.conn.id}（${g.toolkit}）为 ${slug} 暂存附件 ${filename}（${n} 字节，${Date.now() - startedAt} ms）`,
      )
      json(res, 200, { file })
    } catch (e) {
      // 供应商那头的失败回 502 带原话：席位把它当业务失败交给模型，模型照实告诉用户。
      const msg = e instanceof ProviderError ? e.message : (e as Error).message
      console.warn(`satuwork-gateway: 连接 ${g.conn.id}（${g.toolkit}）暂存附件失败：${msg}`)
      throw new HttpError(502, `附件没传上去：${msg}`)
    }
  })
}
