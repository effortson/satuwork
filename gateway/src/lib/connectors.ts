/**
 * 连接器目录项的定义、校验与对外序列化。
 *
 * 见 docs/connectors.md §4。三样东西分得很清：**上架**（这里）、**安装**、**连接**。
 */
import { HttpError } from '../http.ts'
import { DEFAULT_VENDOR, isVendor, providerFor, type ToolDef } from '../connectors/index.ts'
import type { Db } from '../db.ts'
import { MCP_PERMS, asDef, trimStr } from './catalog.ts'
import { strListOf } from '../db/rows.ts'
import { COMPANY_CONNECTION_LABEL as COMPANY_LABEL, type CatalogItem, type ConnectorBlockDef, type ConnectorConnection, type ConnectorDef, type ConnectorInstall } from '../db.ts'

/**
 * 一把连接最多下发几个工具。
 *
 * 连接器绑账号不绑 Bot，工具数是随**安装数**涨的：光 Gmail 一家就有 29 个，装八个
 * 连接器就是两百多个工具挤进每一颗 Bot 的每一轮请求，上下文先塌，模型选工具的准确率
 * 也跟着垮。首选出路是员工自己在详情页把用不上的关掉；这个数是关不掉时的硬闸。
 *
 * **截断不许静默**：结果里带 `truncated`，日志里写一行，详情页给一条红字。
 * 静默截断的表现是「某个工具时有时无」，是最难查的一类。
 */
export const MAX_TOOLS = Math.max(1, Math.trunc(Number(process.env.CONNECTOR_MAX_TOOLS) || 64))

/**
 * 工具清单的缓存。列表是给模型看的目录，不是实时数据，五分钟足够新。
 *
 * 可以调小，只为一件事：e2e 要验「清单拉不到时会怎样」，而缓存一旦热了，供应商挂没挂
 * 都影响不到那条路——测出来的会是缓存，不是那一档行为。
 */
const TOOL_TTL_MS = Math.max(0, Math.trunc(Number(process.env.CONNECTOR_TOOL_TTL_MS) || 5 * 60_000))
const toolCache = new Map<string, { at: number; tools: ToolDef[] }>()

export async function toolsOf(db: Db, vendor: string, toolkit: string): Promise<ToolDef[]> {
  const key = `${vendor}/${toolkit}`
  const hit = toolCache.get(key)
  if (hit && Date.now() - hit.at < TOOL_TTL_MS) return hit.tools
  const provider = await providerFor(db, vendor)
  const tools = await provider.listTools(toolkit)
  toolCache.set(key, { at: Date.now(), tools })
  return tools
}


/**
 * 席位侧那把上传工具的名字。写在 schema 的说明里，模型照着它去找。
 *
 * **两边要对得上**：`bot/src/tools/connector.ts` 注册的就是这个名。改一边不改另一边的
 * 表现是：说明里让模型去调一把不存在的工具，它试一次、被告知「未知工具」、然后又回到
 * 自己编 s3key 的老路上。
 */
export const UPLOAD_TOOL_NAME = 'connector_upload_file'

/**
 * 这一格参数是不是「要先暂存的文件」。
 *
 * Composio 把它标成 `file_uploadable: true`，形状是 `{ name, mimetype, s3key }`。两种
 * 判据都认：标记在、或者形状对——供应商改标记名的那天，形状多半还在。
 */
export function isFileParam(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false
  const o = schema as Record<string, unknown>
  if (o.file_uploadable === true || o.fileUploadable === true) return true
  const props = o.properties
  return Boolean(props && typeof props === 'object' && 's3key' in (props as Record<string, unknown>))
}

/**
 * 给文件参数的说明补上「先上传」这一句。**只改说明，不改形状**。
 *
 * 不补的话模型只看得到 `{ name, mimetype, s3key }` 三个字符串——它不知道 `s3key` 是
 * 从哪来的，于是把工作区路径、或者一个 URL 填进去，上游去取就是 404，而模型把这一步
 * 解释成「附件接口坏了」。线上真发生过一次。
 *
 * 数组里的文件（`attachments: [{...}]`）也补，补在 `items` 上。再往深的嵌套不追：
 * 供应商的文件参数都在顶层或一层数组里，为了一个不存在的形状写递归只会把 schema 搅乱。
 */
export function annotateFileParams(schema: Record<string, unknown>): Record<string, unknown> {
  const props = schema.properties
  if (!props || typeof props !== 'object' || Array.isArray(props)) return schema
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
    const hinted = hintFileParam(raw)
    if (hinted !== raw) changed = true
    next[key] = hinted
  }
  return changed ? { ...schema, properties: next } : schema
}

const FILE_HINT =
  `【文件参数】先调用 ${UPLOAD_TOOL_NAME} 把工作区里的文件上传，再把它返回的 ` +
  `{ name, mimetype, s3key } 原样填在这里。不要自己编 s3key，也不要填本地路径或网址。`

function hintFileParam(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const o = raw as Record<string, unknown>
  if (isFileParam(o)) {
    const desc = typeof o.description === 'string' && o.description.trim() ? `${o.description.trim()}\n` : ''
    return { ...o, description: `${desc}${FILE_HINT}` }
  }
  if (o.type === 'array' && isFileParam(o.items)) {
    const inner = o.items as Record<string, unknown>
    const desc = typeof o.description === 'string' && o.description.trim() ? `${o.description.trim()}\n` : ''
    return { ...o, description: `${desc}${FILE_HINT}`, items: hintFileParam(inner) }
  }
  return raw
}

/** toolkit slug 会进工具名和流水表，不收怪字符。 */
export const TOOLKIT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function connectorDefOf(item: CatalogItem): ConnectorDef {
  const def = asDef(item.definition)
  const perm = (MCP_PERMS as readonly string[]).includes(trimStr(def.perm)) ? trimStr(def.perm) : '只读'
  return {
    vendor: trimStr(def.vendor) || DEFAULT_VENDOR,
    toolkit: trimStr(def.toolkit),
    authConfigId: trimStr(def.authConfigId),
    name: trimStr(def.name) || item.name,
    description: trimStr(def.description),
    logo: trimStr(def.logo),
    category: trimStr(def.category),
    multiAccount: def.multiAccount !== false,
    perm,
    enabled: def.enabled !== false,
    recommendedTools: strListOf(def.recommendedTools),
  }
}

/** 建一条上架记录。`toolkit` 和 `vendor` 建完就不给改了（见 patch）。 */
export function newConnectorDefinition(body: Record<string, unknown>): ConnectorDef {
  const vendor = trimStr(body.vendor) || DEFAULT_VENDOR
  if (!isVendor(vendor)) throw new HttpError(400, `没有这家供应商：${vendor}`)
  const toolkit = trimStr(body.toolkit).toLowerCase()
  if (!TOOLKIT_RE.test(toolkit)) throw new HttpError(400, 'toolkit 只能是小写字母数字和 _ -')
  return {
    vendor,
    toolkit,
    authConfigId: trimStr(body.authConfigId),
    name: trimStr(body.name) || toolkit,
    description: trimStr(body.description),
    logo: trimStr(body.logo),
    category: trimStr(body.category),
    multiAccount: body.multiAccount !== false,
    perm: (MCP_PERMS as readonly string[]).includes(trimStr(body.perm)) ? trimStr(body.perm) : '只读',
    enabled: body.enabled !== false,
    recommendedTools: toolListOf(body.recommendedTools),
  }
}

/**
 * 推荐工具集的**形状**：去空、去重、封顶。
 *
 * 这里**不判对错、也不改大小写**——对不对要拿真清单核（`checkRecommended`），而大小写
 * 改坏了比不改更糟：`enabledTools` 是拿 slug 精确比的，被大写化过的 slug 会一个都对不上，
 * 结果是「装上了、连着、一个工具都没有」。
 */
function toolListOf(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.map((x) => trimStr(x)).filter(Boolean))].slice(0, 500)
}

/**
 * 拿 toolkit 的真清单核一遍推荐工具集，并把它归一成**真实 slug**。
 *
 * **不核不行。** 这一份会原样写进新员工的 `enabledTools`，而 `tools/list` 是拿它精确
 * 过滤的：写错一个 slug，那个人装上之后 `picked` 是空的，`tools/list` 回一张空表——
 * 连接看着是连上的、界面上还写着「1 / 500 个已开启」，一个工具都用不了，日志里一个字
 * 都没有。这正是这套代码到处在防的那类静默失败（docs/tool-search.md §2）。
 *
 * 拉不到清单时**宁可挡住这次保存**，不放行：这是一次配置写入，重试的代价是刷新一下，
 * 而放行的代价是上面那一整套静默失败。和 `resolveToolSlug` 那里「拉不到就退回猜」不是
 * 一回事——那边挡住的是所有调用，这边挡住的只是一次编辑。
 *
 * **只核这一次真的要写进去的那份。** `prev` 传上一版：和它一模一样就直接放行，因为那份
 * 是上次写入时核过的。不这么做的话，一条改说明的 PATCH 也会被拖去核一遍推荐集——供应商
 * 这会儿不可达、或者某个 slug 早就被上游改名了，改说明就会 502 / 400，而这两件事和这次
 * 编辑毫无关系。存量里过期的 slug 由接收端负责说出来（`matchTools`），不在这里堵。
 */
export async function checkRecommended(db: Db, def: ConnectorDef, prev?: string[]): Promise<ConnectorDef> {
  if (!def.recommendedTools.length) return def
  if (prev && prev.length === def.recommendedTools.length && prev.every((x, i) => x === def.recommendedTools[i])) return def
  let tools: ToolDef[]
  try {
    tools = await toolsOf(db, def.vendor, def.toolkit)
  } catch (e) {
    throw new HttpError(502, `拉不到 ${def.toolkit} 的工具清单，没法核对推荐工具集：${(e as Error).message}`)
  }
  if (!tools.length) throw new HttpError(502, `${def.toolkit} 的工具清单是空的，没法核对推荐工具集`)
  // 大小写不敏感地对，存回去的是**清单里那个写法**。
  const bySlug = new Map(tools.map((t) => [t.slug.toUpperCase(), t.slug]))
  const real: string[] = []
  const unknown: string[] = []
  for (const want of def.recommendedTools) {
    const hit = bySlug.get(want.toUpperCase())
    if (hit) real.push(hit)
    else unknown.push(want)
  }
  if (unknown.length) {
    throw new HttpError(400, `${def.toolkit} 里没有这些工具：${unknown.join('、')}。名字要和工具清单里的一模一样。`)
  }
  return { ...def, recommendedTools: [...new Set(real)] }
}

/**
 * 开着的工具里有几个是真的、哪几个对不上。
 *
 * 对不上的那些**必须说出来**：它们既不下发也不报错，表现就是「工具凭空少了几个」。
 * 供应商改名、下线一个工具都会走到这里，不只是填错。
 */
export function matchTools(tools: ToolDef[], enabled: string[]): { matched: string[]; unknown: string[] } {
  const real = new Set(tools.map((t) => t.slug))
  const matched: string[] = []
  const unknown: string[] = []
  for (const slug of enabled) (real.has(slug) ? matched : unknown).push(slug)
  return { matched, unknown }
}

/**
 * 改一条上架记录。
 *
 * **`vendor` 和 `toolkit` 不给改。** 它们已经写进了流水表的字面量列和员工已有的连接；
 * 改掉之后「上个月 gmail 花了多少」会指向一个不同的东西，而已经授权的连接会静静地
 * 连到另一家服务上。要换就下架再上架一条新的。
 */
export function applyConnectorPatch(cur: ConnectorDef, body: Record<string, unknown>): ConnectorDef {
  const next = { ...cur }
  if ('authConfigId' in body) next.authConfigId = trimStr(body.authConfigId)
  if ('name' in body) next.name = trimStr(body.name) || cur.name
  if ('description' in body) next.description = trimStr(body.description)
  if ('logo' in body) next.logo = trimStr(body.logo)
  if ('category' in body) next.category = trimStr(body.category)
  if ('multiAccount' in body) next.multiAccount = body.multiAccount !== false
  if ('perm' in body && (MCP_PERMS as readonly string[]).includes(trimStr(body.perm))) next.perm = trimStr(body.perm)
  if ('enabled' in body) next.enabled = body.enabled !== false
  if ('recommendedTools' in body) next.recommendedTools = toolListOf(body.recommendedTools)
  return next
}

export function blockDefOf(item: CatalogItem | undefined): ConnectorBlockDef {
  const def = asDef(item?.definition)
  return { connectorId: trimStr(def.connectorId), blocked: def.blocked === true, reason: trimStr(def.reason) }
}

/** 公司层的禁令表：连接器 id → 禁令。没有记录 = 放行。 */
export function blockMapOf(items: CatalogItem[]): Map<string, ConnectorBlockDef> {
  const map = new Map<string, ConnectorBlockDef>()
  for (const item of items) {
    if (item.scope !== 'company') continue
    const block = blockDefOf(item)
    if (block.connectorId) map.set(block.connectorId, block)
  }
  return map
}

/**
 * 上架记录的对外形状。**`authConfigId` 永远不出现**——它是平台在供应商侧的配置 id，
 * 公司和员工都不该看见，和密钥同一档。
 */
export function publicConnector(item: CatalogItem) {
  const def = connectorDefOf(item)
  return {
    id: item.id,
    vendor: def.vendor,
    toolkit: def.toolkit,
    name: def.name,
    description: def.description,
    logo: def.logo,
    category: def.category,
    multiAccount: def.multiAccount,
    perm: def.perm,
    enabled: def.enabled,
    /** 配了 auth config 才连得上。只说配没配，不带出值。 */
    authReady: Boolean(def.authConfigId),
    recommendedTools: def.recommendedTools,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

export function publicInstall(v: ConnectorInstall) {
  return {
    id: v.id,
    connectorId: v.connectorId,
    accountId: v.accountId,
    enabledTools: v.enabledTools,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  }
}

/** 连接的对外形状。`externalId` 和 `externalUserId` 是供应商侧的引用，不带出去。 */
export function publicConnection(v: ConnectorConnection) {
  return {
    id: v.id,
    connectorId: v.connectorId,
    scope: v.scope,
    label: v.label,
    accountId: v.accountId,
    status: v.status,
    mentionOnly: v.mentionOnly,
    error: v.lastError,
    connectedAt: v.connectedAt,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  }
}

/**
 * 一把已连接的账号 → 席位那边看到的一条 MCP 服务器记录。
 *
 * **一把连接一条**，不是一个连接器一条：这样席位那边合成的工具名天然带账号
 * （`mcp_gmail_person_send_email`），模型选得动，流水也落得到具体哪一把。
 *
 * `timeoutMs` 必须下发：`bot/src/catalog/mcp.ts` 默认只等 8 秒，对本地 MCP 够用，
 * 对「发一封邮件」「查一遍 CRM」不够——这类调用十几秒是常态。
 */
export function runtimeConnectorServer(
  conn: ConnectorConnection,
  item: CatalogItem,
  opts: { origin: string; token: string; botId: string; timeoutMs: number },
) {
  const def = connectorDefOf(item)
  const query = opts.botId ? `?botId=${encodeURIComponent(opts.botId)}` : ''
  return {
    id: conn.id,
    // 名字进工具名前缀，所以带上 label——两把 Gmail 才分得开。
    name: conn.scope === 'company' ? `${def.name} (${COMPANY_LABEL})` : `${def.name} (${conn.label})`,
    kind: 'HTTP' as const,
    endpoint: `${opts.origin}/mcp/connectors/${encodeURIComponent(conn.id)}${query}`,
    env: {} as Record<string, string>,
    hasEnv: false,
    perm: def.perm,
    enabled: true,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
    hasToken: true,
    token: opts.token,
    timeoutMs: opts.timeoutMs,
    /** 「仅 @ 时可用」：席位照样连上、照样注册工具，但不进默认工具表。 */
    mentionOnly: conn.mentionOnly,
    /** 席位不需要它，但界面和排错要：这条是连接器合成出来的，不是公司配的 MCP。 */
    connector: def.toolkit,
  }
}
