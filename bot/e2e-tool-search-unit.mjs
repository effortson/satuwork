/**
 * Bot 侧工具搜索的纯函数探针（docs/tool-search-bot.md §14 单元那一行）。e2e/tool-search-bot.mjs 用。
 *
 * 打分、中文查询、按 toolkit 合并、四档的边界、id 解析、签名，外加 `tool_call` 的壳在
 * 确认卡那一层剥得开。全是纯函数，不起服务。
 */
import { buildToolIndex, lookupToolId, planTools, publishToolIndex, signatureOf, toolSearchConfig } from './src/catalog/tool-index.ts'
import { buildSearchIndex, conceptsOf, renderHit, searchTools, tokenize } from './src/tools/tool-search.ts'
import { formOf, unwrapCall } from './src/policy/forms.ts'

const schema = (props, required = []) => ({ type: 'object', properties: props, required })
const reg = (server, remote) => `mcp_${server}_${remote.toLowerCase()}`

/** Google Drive 的那一批：几把有名有姓的，剩下的用占位凑数。 */
function driveTools(n) {
  const named = [
    ['FIND_FILE', 'Search for files and folders in Google Drive by name or query.', schema({ query: { type: 'string' }, folder_id: { type: 'string' }, page_size: { type: 'integer' } }, ['query'])],
    ['CREATE_FILE', 'Create a new file in a folder.', schema({ name: { type: 'string' }, parent_id: { type: 'string' } }, ['name'])],
    ['UPLOAD_FILE', 'Upload a file to Google Drive.', schema({ file: { type: 'object' } }, ['file'])],
    ['SHARE_FILE', 'Share a file with a user by updating its permissions.', schema({ file_id: { type: 'string' }, email: { type: 'string' }, role: { type: 'string', enum: ['reader', 'writer'] } }, ['file_id', 'email'])],
    ['CREATE_FOLDER', 'Create a folder in Google Drive.', schema({ name: { type: 'string' } }, ['name'])],
    ['DOWNLOAD_FILE', 'Download a file from Google Drive.', schema({ file_id: { type: 'string' } }, ['file_id'])],
  ]
  const out = named.map(([remote, description, parameters]) => ({ remote, description, parameters }))
  for (let i = out.length; i < n; i++) {
    out.push({ remote: `DRIVE_OP_${String(i).padStart(2, '0')}`, description: `Drive housekeeping operation number ${i} on revisions and labels.`, parameters: schema({ id: { type: 'string' } }) })
  }
  return out
}

function gmailTools(n) {
  const named = [
    ['SEND_EMAIL', 'Send an email to one or more recipients.', schema({ recipient_email: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, ['recipient_email', 'body'])],
    ['FETCH_EMAILS', 'Fetch recent messages from the inbox.', schema({ max_results: { type: 'integer' } })],
    ['REPLY_TO_THREAD', 'Reply to an existing email thread.', schema({ thread_id: { type: 'string' }, body: { type: 'string' } }, ['thread_id', 'body'])],
    ['CREATE_EMAIL_DRAFT', 'Create a draft email.', schema({ subject: { type: 'string' } })],
  ]
  const out = named.map(([remote, description, parameters]) => ({ remote, description, parameters }))
  for (let i = out.length; i < n; i++) out.push({ remote: `GMAIL_OP_${i}`, description: `Mailbox maintenance operation ${i}.`, parameters: schema({}) })
  return out
}

function filler(prefix, n, what) {
  return Array.from({ length: n }, (_, i) => ({ remote: `${prefix}_${String(i).padStart(2, '0')}`, description: `${what} operation ${i}.`, parameters: schema({ id: { type: 'string' } }) }))
}

/** 事故那一份（§0）：4 个 Drive、Sheets、Docs、Slides、2 个 Gmail。 */
function incident({ recommend = false } = {}) {
  const server = (id, name, connector, tools, extra = {}) => ({
    id,
    name,
    connector,
    ...extra,
    tools: tools.map((t) => ({ name: reg(id.replace(/-/g, '_'), t.remote), remote: t.remote, description: t.description, parameters: t.parameters })),
  })
  const gmailRec = recommend ? { recommendedTools: ['GMAIL_SEND_EMAIL', 'GMAIL_FETCH_EMAILS'] } : {}
  return [
    server('d1', 'Google Drive (syrius)', 'googledrive', driveTools(50)),
    server('d2', 'Google Drive (personal)', 'googledrive', driveTools(50)),
    server('d3', 'Google Drive (diana)', 'googledrive', driveTools(50)),
    // 员工在这一把上关掉了几个：组里要标「仅 xxx」。
    server('d4', 'Google Drive (team)', 'googledrive', driveTools(50).filter((t) => t.remote !== 'SHARE_FILE')),
    server('sh', 'Google Sheets (syrius)', 'googlesheets', filler('SHEET_OP', 44, 'Spreadsheet')),
    server('dc', 'Google Docs (syrius)', 'googledocs', filler('DOC_OP', 20, 'Document')),
    server('sl', 'Google Slides (syrius)', 'googleslides', filler('SLIDE_OP', 11, 'Presentation')),
    server('g1', 'Gmail (work)', 'gmail', gmailTools(25), gmailRec),
    server('g2', 'Gmail (personal)', 'gmail', gmailTools(25), gmailRec),
  ]
}

const cfg = (over = {}) => ({ ...toolSearchConfig({}), ...over })
const out = {}

// ── id 表 ────────────────────────────────────────────────────────────────
{
  const index = buildToolIndex(incident())
  const ids = index.entries.map((e) => e.id)
  const find = lookupToolId(index, 'google_drive_personal:FIND_FILE')
  out.ids = {
    total: index.entries.length,
    unique: new Set(ids).size === ids.length,
    connName: find?.conn,
    resolves: find?.name === reg('d2', 'FIND_FILE'),
    caseInsensitive: lookupToolId(index, 'Google_Drive_Personal:find_file')?.name === find?.name,
    fullRemote: lookupToolId(index, 'google_drive_personal:GOOGLEDRIVE_FIND_FILE')?.name === find?.name,
    unknown: lookupToolId(index, 'google_drive_personal:NOPE') === undefined,
    noColon: lookupToolId(index, 'FIND_FILE') === undefined,
    groupLabel: find?.groupLabel,
  }
  // 两把连接压出同一个连接名：后来的补 _2，不许静默丢。
  const clash = buildToolIndex([
    { id: 'a', name: 'Gmail (a b)', connector: 'gmail', tools: [{ name: 'mcp_x1', remote: 'SEND_EMAIL' }] },
    { id: 'b', name: 'Gmail (a_b)', connector: 'gmail', tools: [{ name: 'mcp_x2', remote: 'SEND_EMAIL' }] },
  ])
  out.ids.clash = clash.entries.map((e) => e.id).sort()
  // toolkit 前缀去掉：公司 MCP 列出来带前缀时也认得出来。
  const prefixed = buildToolIndex([{ id: 'p', name: 'Notion (work)', connector: 'notion', tools: [{ name: 'mcp_p', remote: 'NOTION_CREATE_PAGE' }] }])
  out.ids.prefixStripped = prefixed.entries[0].id
}

// ── 四档 ──────────────────────────────────────────────────────────────────
{
  const index = buildToolIndex(incident())
  const all = incident().map((s) => s.id)
  const plan = planTools(index, { serverIds: all, config: cfg() })
  out.incident = {
    tier: plan.tier,
    deferred: plan.deferred.length,
    direct: plan.direct.size,
    groups: plan.groups.map((g) => `${g.label}:${g.conns.length}:${g.tools}`),
    listingTokens: plan.listingTokens,
    listingHasDrive: plan.listing.includes('Google Drive — 连接：google_drive_diana、google_drive_personal、google_drive_syrius、google_drive_team'),
    onlyMarked: /SHARE_FILE[^\n]*（仅 google_drive_diana、google_drive_personal、google_drive_syrius）/.test(plan.listing),
    // 同一份输入算两次，逐字节一样（§13 第 1 条）。
    stable: planTools(index, { serverIds: [...all].reverse(), config: cfg() }).listing === plan.listing,
  }
  // 小窗口：预算跟着窗口 × 5% 走，退到第 3 档。
  const tiny = planTools(index, { serverIds: all, config: cfg(), window: 8000 })
  out.incident.tinyTier = tiny.tier
  out.incident.tinyListing = tiny.listing.split('\n')[0]
  // 很宽的预算：第 1 档，带描述。
  const wide = planTools(index, { serverIds: all, config: cfg({ listingMax: 100000 }) })
  out.incident.wideTier = wide.tier
  out.incident.wideHasDesc = wide.listing.includes('FIND_FILE — Search for files and folders')

  // 推荐集：Gmail 两个连接各两把直出，其余延迟。
  const recIndex = buildToolIndex(incident({ recommend: true }))
  const rec = planTools(recIndex, { serverIds: all, config: cfg() })
  out.recommended = {
    direct: [...rec.direct].sort(),
    notInDeferred: !rec.deferred.some((e) => rec.direct.has(e.name)),
  }
  // 推荐集合起来超过线：连接多的 toolkit 先退。
  const capped = planTools(recIndex, { serverIds: all, config: cfg({ directMax: 3 }) })
  out.recommended.cappedDirect = capped.direct.size

  // 边界：恰好 30 把是第 0 档，31 把就切。
  const few = (n) => buildToolIndex([{ id: 's', name: 'Jira (work)', connector: 'jira', tools: filler('OP', n, 'Jira').map((t) => ({ name: `mcp_${t.remote}`, remote: t.remote, description: t.description })) }])
  out.boundary = {
    at30: planTools(few(30), { serverIds: ['s'], config: cfg() }).tier,
    at31: planTools(few(31), { serverIds: ['s'], config: cfg() }).tier,
    offAt300: planTools(few(300), { serverIds: ['s'], config: cfg({ mode: 'off' }) }).tier,
    onAt3: planTools(few(3), { serverIds: ['s'], config: cfg({ mode: 'on' }) }).tier,
    directMax5: planTools(few(6), { serverIds: ['s'], config: cfg({ directMax: 5 }) }).tier,
    tier0DirectAll: planTools(few(30), { serverIds: ['s'], config: cfg() }).direct.size,
    // 不在这颗 Bot 名单里的服务器不算。
    notAllowed: planTools(few(300), { serverIds: [], config: cfg() }).tier,
  }
  out.env = {
    defaults: toolSearchConfig({}),
    parsed: toolSearchConfig({ SATUWORK_TOOL_SEARCH: 'OFF', SATUWORK_TOOL_SEARCH_DIRECT_MAX: '12', SATUWORK_TOOL_SEARCH_LISTING_MAX: 'abc' }),
  }
}

// ── 搜索 ──────────────────────────────────────────────────────────────────
{
  const index = buildToolIndex(incident())
  const plan = planTools(index, { serverIds: incident().map((s) => s.id), config: cfg() })
  const search = buildSearchIndex(plan.deferred)
  const top = (q, n = 3) => searchTools(search, q, n).map((h) => h.entries[0].slug)
  const sendHits = searchTools(search, 'send email', 5)
  out.search = {
    english: top('send email'),
    findFile: top('find file'),
    zhSend: top('帮我发邮件'),
    zhFind: top('去 Drive 里找 7-11 方案'),
    zhShare: top('把文件共享给同事'),
    zhSheet: searchTools(search, '表格', 3).map((h) => h.entries[0].groupLabel),
    exactSlug: top('SHARE_FILE', 1),
    exactId: top('gmail_work:REPLY_TO_THREAD', 1),
    // 最稀有的那个词必须命中：pull request 在这批里一个都没有，不许随便凑。
    rare: top('pull request'),
    nonsense: top('zzzz qqqq'),
    // 合并：四个 Drive 的 FIND_FILE 是一个结果，「也在」列另外三个。
    mergedConns: searchTools(search, 'find file', 1)[0]?.entries.map((e) => e.conn),
    rendered: renderHit(searchTools(search, 'find file', 1)[0]?.entries ?? []),
    sendMerged: sendHits[0]?.entries.length,
    tokens: tokenize('GOOGLEDRIVE_FIND_FILE 共享文件夹 emails'),
    concepts: conceptsOf('帮我发邮件').map((c) => c.alts.join('|')),
  }
}

// ── 签名 ──────────────────────────────────────────────────────────────────
out.signature = signatureOf({
  type: 'object',
  properties: {
    q: { type: 'string' },
    folder_id: { type: 'string' },
    page_size: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } },
    opts: { type: 'object', properties: { a: { type: 'string' } } },
    mode: { enum: ['a', 'b'] },
    maybe: { type: ['string', 'null'] },
  },
  required: ['q'],
})

// ── tool_call 的壳：确认卡上是真名 ────────────────────────────────────────
{
  const index = buildToolIndex(incident())
  publishToolIndex(index)
  const call = { name: 'tool_call', arguments: JSON.stringify({ id: 'gmail_work:SEND_EMAIL', arguments: { recipient_email: 'a@b.c', subject: '你好', body: '正文' } }) }
  const un = unwrapCall(call)
  const form = formOf(call)
  out.unwrap = {
    tool: un.tool,
    args: un.args,
    prefix: un.prefix,
    formKind: form.kind,
    formTool: form.tool,
    bodyKey: form.fields.find((f) => f.label === '正文')?.key,
    // 参数被字符串化了也剥得开。
    stringArgs: unwrapCall({ name: 'tool_call', arguments: JSON.stringify({ id: 'gmail_work:SEND_EMAIL', arguments: '{"body":"x"}' }) }).args,
    // 认不出的 id：用 id 本身，总比壳名好认。
    unknown: unwrapCall({ name: 'tool_call', arguments: JSON.stringify({ id: 'nope:X', arguments: {} }) }).tool,
  }
}

console.log('__RESULT__' + JSON.stringify(out))
