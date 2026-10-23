/**
 * 连接器：平台上架（owner）与市场（所有人可见）。
 *
 * 见 docs/connectors.md。这一组只管**上架**这一层；安装、连接、工具下发、计费在
 * 后面的里程碑里接上。
 */
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Req, type Router } from '../http.ts'
import { ProviderError, VENDORS, isVendor, providerFor, type ToolDef } from '../connectors/index.ts'
import { MAX_TOOLS, applyConnectorPatch, blockMapOf, checkRecommended, connectorDefOf, matchTools, newConnectorDefinition, publicConnector, toolsOf } from '../lib/connectors.ts'
import { toolModeOf } from '../lib/tool-search.ts'
import { bodyOf, strField } from '../lib/validate.ts'
import { isUniqueViolation } from '../db.ts'
import { originOf, rangeQuery, requireOrgUser, requireOwnerUser, requireUser } from '../lib/guards.ts'
import { COMPANY_CONNECTION_LABEL, CONNECTION_LABEL_RE, DEFAULT_CONNECTION_LABEL, type Account, type ConnectorConnection, type ConnectorDef, externalUserIdOf } from '../db.ts'
import { publicConnection, publicInstall } from '../lib/connectors.ts'
import { publicPlatformCred } from '../lib/org.ts'
import { botIconOf } from '../lib/catalog.ts'

/** 授权回来之后那一页要说的三种话。见 authDonePage。 */
type AuthDone = 'ok' | 'pending' | 'failed'

/** 供应商侧的失败一律转成 HTTP，别把栈丢给调用方。 */
function asHttp(e: unknown): never {
  if (e instanceof ProviderError) {
    // 0 = 根本没连上（含超时）；上游的 4xx 原样带出去更有用（authConfigId 写错就是 404）。
    const status = e.status >= 400 && e.status < 600 ? e.status : 502
    throw new HttpError(status, e.message)
  }
  throw e
}

export function attachConnectors(router: Router, ctx: RouteCtx) {
  const { db, keys } = ctx

  // ── 供应商（owner）─────────────────────────────────────────────────

  /**
   * 有哪几家、各自配了没有。**密钥不回显**，只说配没配。
   *
   * 没配密钥也照样返回这一行——不然 owner 那一屏连「还没配」都画不出来。
   */
  router.get('/platform/connector-vendors', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const vendors: unknown[] = []
    for (const vendor of VENDORS) {
      const provider = await providerFor(db, vendor)
      const cred = await db.platformCredential(vendor)
      vendors.push({
        vendor,
        configured: provider.configured(),
        caps: provider.caps,
        credential: cred ? publicPlatformCred(cred) : null,
      })
    }
    json(res, 200, { vendors })
  })

  router.put('/platform/connector-vendors/:vendor', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const vendor = req.params.vendor
    if (!isVendor(vendor)) throw new HttpError(404, '没有这家供应商')
    const existed = Boolean(await db.platformCredential(vendor))
    const row = await db.upsertPlatformCredential(vendor, strField(bodyOf(req), 'secret'))
    await db.audit({
      companyId: 'platform',
      accountId: account.id,
      action: existed ? 'platform.credential.update' : 'platform.credential.create',
      detail: { provider: vendor },
    })
    json(res, existed ? 200 : 201, { credential: publicPlatformCred(row) })
  })

  router.delete('/platform/connector-vendors/:vendor', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const vendor = req.params.vendor
    if (!isVendor(vendor)) throw new HttpError(404, '没有这家供应商')
    if (!(await db.platformCredential(vendor))) throw new HttpError(404, '密钥不存在')
    await db.deletePlatformCredential(vendor)
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.credential.delete', detail: { provider: vendor } })
    json(res, 200, { deleted: true, vendor })
  })

  /** 拨一下看看通不通。**不抛错**：连不通本身就是要显示的结果。 */
  router.post('/platform/connector-vendors/:vendor/ping', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const vendor = req.params.vendor
    if (!isVendor(vendor)) throw new HttpError(404, '没有这家供应商')
    const provider = await providerFor(db, vendor)
    if (!provider.configured()) {
      json(res, 200, { ok: false, error: '还没配密钥' })
      return
    }
    json(res, 200, await provider.ping())
  })

  // ── 供应商那边有什么（owner 上架时的选单）──────────────────────────

  /**
   * 选单那两条的共同开场：认 owner、认 `?vendor=`、并确认那家配过密钥。
   *
   * 合在一起是因为这三道关卡必须同时成立才有下一步——少判一道的表现不是报错，
   * 是拿着一份没有密钥的 provider 去调上游，报出来的会是一句供应商的 401。
   */
  async function ownerVendor(req: Req) {
    await requireOwnerUser(req, db, keys)
    const vendor = (req.query.get('vendor') || VENDORS[0]).trim()
    if (!isVendor(vendor)) throw new HttpError(400, `没有这家供应商：${vendor}`)
    const provider = await providerFor(db, vendor)
    if (!provider.configured()) throw new HttpError(402, `还没配 ${vendor} 的密钥`)
    return { vendor, provider }
  }


  router.get('/platform/connector-toolkits', async (req, res) => {
    const { vendor, provider } = await ownerVendor(req)
    try {
      json(res, 200, { vendor, toolkits: await provider.listToolkits() })
    } catch (e) {
      asHttp(e)
    }
  })

  router.get('/platform/connector-toolkits/:slug/tools', async (req, res) => {
    const { vendor, provider } = await ownerVendor(req)
    try {
      json(res, 200, { vendor, toolkit: req.params.slug, tools: await provider.listTools(req.params.slug) })
    } catch (e) {
      asHttp(e)
    }
  })

  // ── 上架（owner）───────────────────────────────────────────────────

  async function globalConnector(id: string) {
    const item = await db.catalog((id || '').trim())
    if (!item || item.kind !== 'connector' || item.scope !== 'global') throw new HttpError(404, '没有这个连接器')
    return item
  }

  router.get('/platform/connectors', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    json(res, 200, { connectors: (await db.visibleCatalog('connector', null)).map(publicConnector) })
  })

  router.post('/platform/connectors', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const def = newConnectorDefinition(bodyOf(req))
    /**
     * 同一个 (vendor, toolkit) 只上架一次。
     *
     * 上了两条一样的，员工市场里就会并排两个「Gmail」，装哪个都对——直到有人发现
     * 两条的 authConfigId 不一样，而已经授权的人分散在两条上。库里加唯一约束不划算
     * （定义在 jsonb 里），这里挡住就够：上架是 owner 的低频动作。
     */
    const dup = (await db.visibleCatalog('connector', null)).find((i) => {
      const d = connectorDefOf(i)
      return d.vendor === def.vendor && d.toolkit === def.toolkit
    })
    if (dup) throw new HttpError(409, `${def.vendor} 的 ${def.toolkit} 已经上架过了`)
    const item = await db.insertCatalog({
      kind: 'connector',
      scope: 'global',
      companyId: null,
      name: def.name,
      // 推荐工具集要拿真清单核过才落库，写错的 slug 会变成新员工的一张空工具表。
      definition: await checkRecommended(db, def),
    })
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'connector.publish', detail: { id: item.id, toolkit: def.toolkit } })
    json(res, 201, { connector: publicConnector(item) })
  })

  router.get('/platform/connectors/:connectorId', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    json(res, 200, { connector: publicConnector(await globalConnector(req.params.connectorId)) })
  })

  router.patch('/platform/connectors/:connectorId', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const item = await globalConnector(req.params.connectorId)
    const cur = connectorDefOf(item)
    // 带上上一版：没动推荐集的那些编辑（改名、改说明、上下架）不该被拖去核清单。
    const def = await checkRecommended(db, applyConnectorPatch(cur, bodyOf(req)), cur.recommendedTools)
    const next = await db.updateCatalog(item.id, { name: def.name, definition: def })
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'connector.update', detail: { id: item.id } })
    json(res, 200, { connector: publicConnector(next) })
  })

  /**
   * 下架。安装和连接靠外键级联删掉（`on delete cascade`），但**流水不删**——
   * `connector_calls` 存的是字面量 slug，没有外键，「上个月谁烧了多少」查得到。
   */
  router.delete('/platform/connectors/:connectorId', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const item = await globalConnector(req.params.connectorId)
    await db.deleteCatalog(item.id)
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'connector.unpublish', detail: { id: item.id } })
    json(res, 200, { deleted: true, id: item.id })
  })

  // ── 安装与连接（员工自己）─────────────────────────────────────────

  /**
   * 员工只能操作**自己公司看得见**的那些连接器。owner 没有公司，也就没有安装。
   *
   * `allowDisabled`：平台把连接器停掉之后，员工手上的安装和授权还在——卸载 / 断开这
   * 两条路必须仍然走得通，不然那把授权就永远挂在供应商那边收不回来。装、连、调用
   * 的路照旧把停掉的当成不存在。
   */
  async function seatConnector(account: Account, id: string, opts: { allowDisabled?: boolean } = {}) {
    if (!account.companyId) throw new HttpError(403, '平台账号没有连接器')
    const items = await db.visibleCatalog('connector', account.companyId)
    const item = items.find((i) => i.id === (id || '').trim() && i.scope === 'global')
    if (!item) throw new HttpError(404, '没有这个连接器')
    const def = connectorDefOf(item)
    if (!def.enabled && !opts.allowDisabled) throw new HttpError(404, '没有这个连接器')
    const block = blockMapOf(items).get(item.id)
    return { item, def, blocked: block?.blocked === true, blockedReason: block?.reason ?? '', companyId: account.companyId }
  }

  /**
   * 刷新还在 `pending` 的那几把。
   *
   * **不信回调带回来的状态**（见 /connectors/callback），所以真相只有一个来源：
   * 回头问供应商。只刷 pending 的——已经 active 的每次进页面都去问一遍，是白白
   * 给供应商刷请求，而撤销授权那条路走的是别的信号。
   */
  async function refreshPending(rows: ConnectorConnection[], def: ConnectorDef): Promise<ConnectorConnection[]> {
    const out: ConnectorConnection[] = []
    for (const row of rows) {
      if (row.status !== 'pending' || !row.externalId) {
        out.push(row)
        continue
      }
      try {
        const provider = await providerFor(db, def.vendor)
        const st = await provider.status(row.externalId)
        if (st.status === 'pending') {
          out.push(row)
          continue
        }
        out.push(
          (await db.updateConnectorConnection(row.id, {
            status: st.status === 'active' ? 'active' : 'failed',
            lastError: st.error ?? null,
            connectedAt: st.status === 'active' ? Date.now() : null,
          })) ?? row,
        )
      } catch {
        // 供应商暂时不可达：状态原样留着，下次进页面再问。这一步失败不该让整屏 500。
        out.push(row)
      }
    }
    return out
  }

  /**
   * 授权完之后那一页。**它唯一的正事是关掉自己。**
   *
   * 页面里一个字节的用户数据都没有：这条回调无登录态，谁都打得到（`?c=` 只是个 id），
   * 所以只说「成不成」，不说是谁的哪个账号。
   *
   * 只有成了才自动关。没成的话那句话得留在屏幕上让人读完——自动关掉等于把唯一一次
   * 说明的机会也关了。关不掉（不是脚本开出来的窗口，比如人手动打开了这个地址）就把
   * 按钮和那条回去的链接留着，别让人对着一个不知道该干什么的页面。
   */
  function authDonePage(done: AuthDone, back: string): string {
    const say = {
      ok: { icon: '✓', title: '授权完成', body: '这个页面可以关掉了，回 Satuwork 继续。' },
      pending: { icon: '…', title: '还在等供应商确认', body: '授权可能还没走完。关掉这一页，回 Satuwork 里看那把连接的状态。' },
      failed: { icon: '!', title: '授权没成功', body: '关掉这一页，回 Satuwork 里再连一次。' },
    }[done]
    // 自动关只给成功那一档。400ms 是让人来得及看见那个勾，不是等什么东西。
    const auto = done === 'ok' ? 'setTimeout(close, 400)' : ''
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${say.title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font: 15px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #faf8f5; color: #2b2622; }
  @media (prefers-color-scheme: dark) { body { background: #1b1917; color: #ece7e1; } }
  main { max-width: 320px; padding: 32px 24px; text-align: center; }
  .mark { width: 44px; height: 44px; margin: 0 auto 16px; border-radius: 999px; display: flex;
    align-items: center; justify-content: center; font-size: 22px; background: #c05621; color: #fff; }
  h1 { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
  p { margin: 0 0 20px; opacity: 0.75; }
  button { font: inherit; padding: 8px 18px; border: 0; border-radius: 999px; cursor: pointer;
    background: #c05621; color: #fff; }
  a { display: block; margin-top: 12px; font-size: 13px; color: inherit; opacity: 0.6; }
</style></head>
<body><main>
  <div class="mark">${say.icon}</div>
  <h1>${say.title}</h1>
  <p>${say.body}</p>
  <button id="x" type="button">关掉这一页</button>
  <a href="${back}">或者回 Satuwork</a>
</main>
<script>
  // 这一页是 window.open 开出来的，所以关得掉自己。
  var close = function () { window.close() }
  document.getElementById('x').addEventListener('click', close)
  ${auto}
</script>
</body></html>`
  }

  /**
   * 供应商的 OAuth 回调。**无登录态**——它是浏览器的顶层跳转，带不了 Authorization 头。
   *
   * 所以这里**一个字节都不信**：`?c=` 只用来找回是哪一行，状态一律回头问供应商。
   * 带着别人的 id 来打这条，最多是替别人同步一次状态，读不到任何东西。
   *
   * **路径特意不放在 `/connectors/*` 下面。** `/connectors` 和 `/connectors/:id` 是
   * 浏览器的页面地址（SPA），API 一律走 `/me/connectors/*`——两边撞在一起的话，
   * 路由器先中的是 API，人在地址栏敲 `/connectors` 会拿到一坨 JSON 而不是界面。
   */
  router.get('/oauth/connectors/callback', async (req, res) => {
    const id = (req.query.get('c') || '').trim()
    const row = id ? await db.connectorConnection(id) : undefined
    // 这一页要说的话，取决于上游怎么答。问不到就当「还没完成」——那是实情。
    let done: AuthDone = 'pending'
    if (row?.externalId) {
      try {
        const provider = await providerFor(db, row.vendor)
        const st = await provider.status(row.externalId)
        done = st.status === 'active' ? 'ok' : st.status === 'pending' ? 'pending' : 'failed'
        if (st.status !== 'pending') {
          await db.updateConnectorConnection(row.id, {
            status: st.status === 'active' ? 'active' : 'failed',
            lastError: st.error ?? null,
            connectedAt: st.status === 'active' ? Date.now() : null,
          })
        }
      } catch {
        // 问不到就让它留在 pending：详情页再进一次会重问。这里绝不能 500——
        // 用户看到的是从 Google 跳回来的一个白屏。
      }
    }
    /**
     * **不跳回应用，把这一页关掉。**
     *
     * 授权是在**新开的那一页**里做的（见 `gateway/ui/pages-connectors.js` 的
     * `conn-add-account`），原来那一页原封不动地在旁边等着。这一页的使命到授权完成
     * 为止，302 回 `/connectors/:id` 只会在旁边多开一个应用副本——人正看着的那一页
     * 还在另一个标签里，两份状态从此各走各的。
     *
     * 关掉之后原来那一页拿回焦点，会自己重取一次账号列表（`authReturn`），新连上的
     * 那一把就出现了。
     *
     * 早先这里跳回去是对的：那时是整页跳走的，不跳回来人就留在供应商的域名上。
     */
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(authDonePage(done, row ? `/connectors/${encodeURIComponent(row.connectorId)}` : '/'))
  })

  /**
   * 一个连接器的详情：我装了没有、连了哪几个账号、有哪些工具可开。
   *
   * 工具清单从供应商现拉——员工要在这里逐个勾。拉不到就给空清单加一条错，
   * 别让整屏挂掉：装和连都还能用。
   */
  router.get('/me/connectors/:connectorId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const { item, def, blocked, blockedReason } = await seatConnector(account, req.params.connectorId)
    const install = await db.connectorInstall(item.id, account.id)
    const mine = (await db.connectionsFor(account.id, account.companyId)).filter((c) => c.connectorId === item.id)
    const rows = await refreshPending(mine, def)
    let tools: ToolDef[] = []
    let toolsError = ''
    try {
      const provider = await providerFor(db, def.vendor)
      // 走共用的那份缓存（五分钟），不是每次打开详情页都同步等一趟供应商——
      // 勾工具是要来回试的，每一次都卡在网络往返上没有道理。
      if (provider.configured()) tools = await toolsOf(db, def.vendor, def.toolkit)
    } catch (e) {
      toolsError = (e as Error).message
    }
    /**
     * 开着的里面有几个是真的、哪几个对不上。
     *
     * **数「真的」而不是数「存了几个」**：供应商改名或下线一个工具之后，存着的那个 slug
     * 既不下发也不报错，而界面按存了几个来数，会显示「1 / 500 个已开启」而底下一个都
     * 没勾——人看到的数字和 Bot 拿到的工具对不上，还查不出为什么。
     *
     * 清单拉不到（`toolsError`）时不做这个判断：那时 `tools` 是空的，全判成对不上是错的。
     */
    const enabled = install?.enabledTools ?? []
    const hit = tools.length ? matchTools(tools, enabled) : { matched: enabled, unknown: [] }
    const enabledCount = install ? (enabled.length ? hit.matched.length : tools.length) : 0
    // 超上限之后这把连接会切到搜索模式（docs/tool-search.md §4）。**档位由后端算，界面
    // 不许自己按 enabledCount > toolCap 去推**——推的那一刻它就和这里分叉了，而分叉的
    // 表现是界面说一套、Bot 拿到另一套。
    const on = enabled.length ? new Set(hit.matched) : null
    const toolMode = toolModeOf(on ? tools.filter((t) => on.has(t.slug)) : tools)
    json(res, 200, {
      connector: { ...publicConnector(item), blocked, blockedReason },
      install: install ? publicInstall(install) : null,
      connections: rows.map(publicConnection),
      tools,
      toolCap: MAX_TOOLS,
      enabledCount,
      toolMode,
      // 对不上的那些。空数组时不出现，界面据此决定要不要画那条红字。
      ...(hit.unknown.length ? { unknownTools: hit.unknown } : {}),
      ...(toolsError ? { toolsError } : {}),
    })
  })

  router.post('/me/connectors/:connectorId/install', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const { item, blocked, blockedReason } = await seatConnector(account, req.params.connectorId)
    if (blocked) throw new HttpError(403, blockedReason ? `本公司已禁用这个连接器：${blockedReason}` : '本公司已禁用这个连接器')
    // 上架时挑好的那一小撮。owner 没挑就还是全开，由 tool-search 那边的降级兜底。
    const install = await db.installConnector({
      connectorId: item.id,
      accountId: account.id,
      companyId: account.companyId!,
      enabledTools: connectorDefOf(item).recommendedTools,
    })
    await db.audit({ companyId: account.companyId!, accountId: account.id, action: 'connector.install', detail: { connectorId: item.id } })
    json(res, 201, { install: publicInstall(install) })
  })

  /**
   * 卸载。**连带断开我在它下面的所有连接**——留着一把没人管的 OAuth 授权比什么都糟：
   * 界面上看不见了，供应商那边还能用。
   */
  router.delete('/me/connectors/:connectorId/install', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const { item, def } = await seatConnector(account, req.params.connectorId, { allowDisabled: true })
    const install = await db.connectorInstall(item.id, account.id)
    if (!install) throw new HttpError(404, '还没装这个连接器')
    const mine = (await db.connectionsFor(account.id, account.companyId)).filter((c) => c.connectorId === item.id && c.scope === 'user')
    // 供应商那边断不掉的，记下来。**这一句以前是空的**：注释写着「孤儿授权记进审计的
    // detail，人工去清」，可 detail 里只有连接器 id 和条数——真出现孤儿时，哪一把是
    // 孤儿哪儿都查不到，而它在供应商侧仍然是一把活着的授权。
    const orphans: { id: string; externalId: string; error: string }[] = []
    for (const row of mine) {
      if (row.externalId) {
        try {
          await (await providerFor(db, def.vendor)).disconnect(row.externalId)
        } catch (e) {
          // 供应商那边断不掉也要把本地这条删了：留着它，界面上会显示一把其实已经
          // 不属于任何安装的连接。
          orphans.push({ id: row.id, externalId: row.externalId, error: String((e as Error).message || e).slice(0, 200) })
        }
      }
      await db.deleteConnectorConnection(row.id)
    }
    await db.deleteConnectorInstall(install.id)
    await db.audit({
      companyId: account.companyId!,
      accountId: account.id,
      action: 'connector.uninstall',
      detail: { connectorId: item.id, connections: mine.length, ...(orphans.length ? { orphans } : {}) },
    })
    json(res, 200, { deleted: true, id: item.id })
  })

  /**
   * 开哪几个工具。空数组 = 全开。
   *
   * 存**开着的**那些而不是关掉的那些：上游加了新工具，默认是不给的。员工没点过头的
   * 东西不该因为供应商发版就自己出现在他的 Bot 里。
   */
  router.put('/me/connectors/:connectorId/tools', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const { item } = await seatConnector(account, req.params.connectorId)
    const install = await db.connectorInstall(item.id, account.id)
    if (!install) throw new HttpError(404, '还没装这个连接器')
    const raw = bodyOf(req).enabledTools
    if (!Array.isArray(raw)) throw new HttpError(400, 'enabledTools 必须是数组')
    const tools = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))].slice(0, 500)
    const next = await db.setInstallTools(install.id, tools)
    // 开了哪些工具决定了 Bot 能替这个人碰什么，和装 / 卸一样要留痕。只记个数不记名单：
    // 名单可到 500 条，审计里塞不下也没人看。
    await db.audit({
      companyId: account.companyId!,
      accountId: account.id,
      action: 'connector.tools.update',
      detail: { connectorId: item.id, enabledTools: tools.length, mode: tools.length ? 'subset' : 'all' },
    })
    json(res, 200, { install: publicInstall(next!) })
  })

  function labelOf(v: unknown, fallback: string): string {
    const label = (typeof v === 'string' ? v : '').trim().toLowerCase() || fallback
    if (!CONNECTION_LABEL_RE.test(label)) throw new HttpError(400, '账号名只能是小写字母数字和 _ -，最多 16 位')
    if (label === COMPANY_CONNECTION_LABEL) throw new HttpError(400, `${COMPANY_CONNECTION_LABEL} 是公司共用那把的名字，换一个`)
    return label
  }

  /**
   * 连一个账号。同一个连接器可以连好几个（`default` / `personal`），`label` 是员工
   * 自己起的名字——它会进工具名的前缀，模型要靠它判断「往哪个邮箱发」。
   */
  router.post('/me/connectors/:connectorId/connections', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const { item, def, blocked, blockedReason } = await seatConnector(account, req.params.connectorId)
    if (blocked) throw new HttpError(403, blockedReason ? `本公司已禁用这个连接器：${blockedReason}` : '本公司已禁用这个连接器')
    if (!(await db.connectorInstall(item.id, account.id))) throw new HttpError(409, '先安装再连接')
    if (!def.authConfigId) throw new HttpError(402, '平台还没给这个连接器配 auth config')
    const provider = await providerFor(db, def.vendor)
    if (!provider.configured()) throw new HttpError(402, `还没配 ${def.vendor} 的密钥`)

    const label = labelOf(bodyOf(req).label, DEFAULT_CONNECTION_LABEL)
    const mine = (await db.connectionsFor(account.id, account.companyId)).filter((c) => c.connectorId === item.id && c.scope === 'user')
    if (mine.some((c) => c.label === label)) throw new HttpError(409, `已经有一个叫「${label}」的账号了`)
    if (!def.multiAccount && mine.length) throw new HttpError(409, '这个连接器只支持一个账号')

    const row = await db.insertConnectorConnection({
      connectorId: item.id,
      vendor: def.vendor,
      scope: 'user',
      label,
      accountId: account.id,
      companyId: account.companyId!,
      externalUserId: externalUserIdOf('user', account.id),
    })
    try {
      const started = await provider.initiate({
        toolkit: def.toolkit,
        authConfigId: def.authConfigId,
        externalUserId: row.externalUserId,
        // **我们自己的 id 挂在回调地址上。** 回调是从公网进来的，那时没有登录态，
        // 只能靠它找回这一行——但它不是凭据，回调只做「回头问供应商」这一件事。
        callbackUrl: `${originOf(req)}/oauth/connectors/callback?c=${encodeURIComponent(row.id)}`,
      })
      const next = await db.updateConnectorConnection(row.id, { externalId: started.externalId })
      await db.audit({
        companyId: account.companyId!,
        accountId: account.id,
        action: 'connector.connect',
        detail: { connectorId: item.id, label, connectionId: row.id },
      })
      json(res, 201, { connection: publicConnection(next!), redirectUrl: started.redirectUrl })
    } catch (e) {
      // 发起失败就把这一行收掉：留着一条永远 pending、连 externalId 都没有的记录，
      // 界面上会显示「未完成」，而它其实连开始都没开始。
      await db.deleteConnectorConnection(row.id)
      asHttp(e)
    }
  })

  /** 我自己的那一把。公司共用的不归员工改。 */
  async function ownConnection(account: Account, connectorId: string, id: string) {
    const row = await db.connectorConnection((id || '').trim())
    if (!row || row.connectorId !== connectorId || row.scope !== 'user' || row.accountId !== account.id) {
      throw new HttpError(404, '没有这个账号')
    }
    return row
  }

  router.patch('/me/connectors/:connectorId/connections/:connectionId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const { item } = await seatConnector(account, req.params.connectorId)
    const row = await ownConnection(account, item.id, req.params.connectionId)
    const body = bodyOf(req)
    const patch: { label?: string; mentionOnly?: boolean } = {}
    if ('label' in body) {
      const label = labelOf(body.label, row.label)
      const siblings = (await db.connectionsFor(account.id, account.companyId)).filter(
        (c) => c.connectorId === item.id && c.scope === 'user' && c.id !== row.id,
      )
      if (siblings.some((c) => c.label === label)) throw new HttpError(409, `已经有一个叫「${label}」的账号了`)
      patch.label = label
    }
    if ('mentionOnly' in body) patch.mentionOnly = body.mentionOnly === true
    const next = await db.updateConnectorConnection(row.id, patch)
    if ('mentionOnly' in patch) {
      // 这一条改的是「它会不会被隐式调用」，是权限边界，不是显示偏好——要留档。
      await db.audit({
        companyId: account.companyId!,
        accountId: account.id,
        action: 'connector.connection.update',
        detail: { connectionId: row.id, mentionOnly: patch.mentionOnly },
      })
    }
    json(res, 200, { connection: publicConnection(next!) })
  })

  router.delete('/me/connectors/:connectorId/connections/:connectionId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const { item, def } = await seatConnector(account, req.params.connectorId, { allowDisabled: true })
    const row = await ownConnection(account, item.id, req.params.connectionId)
    let orphan: { externalId: string; error: string } | null = null
    if (row.externalId) {
      try {
        await (await providerFor(db, def.vendor)).disconnect(row.externalId)
      } catch (e) {
        // 供应商那边断不掉也要把本地这条删了，理由同卸载；断不掉的那一把要留下线索，
        // 否则一把活着的授权就此从记录里消失。
        orphan = { externalId: row.externalId, error: String((e as Error).message || e).slice(0, 200) }
      }
    }
    await db.deleteConnectorConnection(row.id)
    await db.audit({
      companyId: account.companyId!,
      accountId: account.id,
      action: 'connector.disconnect',
      detail: { connectorId: item.id, label: row.label, connectionId: row.id, ...(orphan ? { orphan } : {}) },
    })
    json(res, 200, { deleted: true, id: row.id })
  })

  // ── 公司这一层：禁用与公司共用的连接（admin）───────────────────────

  /**
   * 本公司的连接器清单：市场那一份，外加禁令和**谁装了什么**。
   *
   * 装机量必须给：自助安装之下，这是 admin 唯一能看清攻击面的地方——他连该禁什么
   * 都得先知道有人在用什么。
   */
  router.get('/orgs/:orgId/connectors', async (req, res) => {
    await requireOrgUser(req, db, keys, req.params.orgId, true)
    const items = await db.visibleCatalog('connector', req.params.orgId)
    const blocks = blockMapOf(items)
    const installs = await db.connectorInstallsOfCompany(req.params.orgId)
    const connections = await db.connectionsOfCompany(req.params.orgId)
    const connectors = items
      .filter((i) => i.scope === 'global')
      .map((item) => {
        const block = blocks.get(item.id)
        const mine = installs.filter((x) => x.connectorId === item.id)
        const conns = connections.filter((x) => x.connectorId === item.id)
        return {
          ...publicConnector(item),
          blocked: block?.blocked === true,
          blockedReason: block?.reason ?? '',
          installs: mine.length,
          installedBy: mine.map((x) => x.accountId),
          connections: conns.filter((c) => c.status === 'active').length,
          companyConnection: conns.filter((c) => c.scope === 'company').map(publicConnection)[0] ?? null,
        }
      })
    json(res, 200, { connectors })
  })

  /**
   * 禁 / 解禁。公司这一层只存**否定**：默认放行，不是「启用了才能装」——
   * 每加一个连接器都要等管理员点一下，市场就没有意义了。
   */
  router.put('/orgs/:orgId/connectors/:connectorId/block', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.orgId, true)
    const items = await db.visibleCatalog('connector', req.params.orgId)
    const item = items.find((i) => i.id === req.params.connectorId && i.scope === 'global')
    if (!item) throw new HttpError(404, '没有这个连接器')
    const body = bodyOf(req)
    const blocked = body.blocked === true
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : ''
    const existing = items.find((i) => i.scope === 'company' && blockMapOf([i]).get(item.id))
    const definition = { connectorId: item.id, blocked, reason }
    if (existing) await db.updateCatalog(existing.id, { name: item.name, definition })
    else {
      try {
        await db.insertCatalog({
          kind: 'connector',
          scope: 'company',
          companyId: req.params.orgId,
          name: item.name,
          definition,
        })
      } catch (e) {
        /**
         * 双击「禁用」两个请求都查到 existing 为空，各插一行。库上的部分唯一索引
         * （见迁移 0005）会把第二个挡下来——这时回头找到那一行改它。少了这一手，
         * 两行并存，之后「解禁」只解掉其中一行，界面显示已解禁而连接器还是禁着的。
         */
        if (!isUniqueViolation(e)) throw e
        const again = (await db.visibleCatalog('connector', req.params.orgId)).find(
          (i) => i.scope === 'company' && blockMapOf([i]).get(item.id),
        )
        if (again) await db.updateCatalog(again.id, { name: item.name, definition })
      }
    }
    await db.audit({
      companyId: req.params.orgId,
      accountId: account.id,
      action: blocked ? 'connector.block' : 'connector.unblock',
      detail: { connectorId: item.id, reason },
    })
    json(res, 200, { connectorId: item.id, blocked, reason })
  })

  /**
   * 公司共用的那一把。发起人必须是 admin，`externalUserId` 用公司的。
   *
   * 统一成「连接 = (连接器 × 主体 × label)」之后，它和个人连接在下游是同一种东西——
   * 合成工具、计费、统计都不用分叉。差别只在谁能建、谁能删。
   */
  router.post('/orgs/:orgId/connectors/:connectorId/connections', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.orgId, true)
    const items = await db.visibleCatalog('connector', req.params.orgId)
    const item = items.find((i) => i.id === req.params.connectorId && i.scope === 'global')
    if (!item) throw new HttpError(404, '没有这个连接器')
    const def = connectorDefOf(item)
    /**
     * **下架的、被本公司禁掉的，都不许再发起新授权。**
     *
     * 个人那条路（seatConnector + 下面几处 403）两样都查，公司这条一样都没查。少了它，
     * 平台出事后把连接器 `enabled: false` 下架，公司管理员照样能去供应商那边完成一次
     * 全新的公司级授权——调用会被 mcp.ts 的 gate() 拒掉，但那把授权在供应商侧是真的
     * 建起来了，平台以为已经关掉的东西留下一个活着的授权。
     */
    if (!def.enabled) throw new HttpError(404, '没有这个连接器')
    const block = blockMapOf(items).get(item.id)
    if (block?.blocked === true) {
      throw new HttpError(403, block.reason ? `本公司已禁用这个连接器：${block.reason}` : '本公司已禁用这个连接器')
    }
    if (!def.authConfigId) throw new HttpError(402, '平台还没给这个连接器配 auth config')
    const provider = await providerFor(db, def.vendor)
    if (!provider.configured()) throw new HttpError(402, `还没配 ${def.vendor} 的密钥`)
    const existing = (await db.connectionsOfCompany(req.params.orgId)).filter(
      (c) => c.connectorId === item.id && c.scope === 'company',
    )
    if (existing.length) throw new HttpError(409, '这个连接器已经有一把公司共用的连接了')

    const row = await db.insertConnectorConnection({
      connectorId: item.id,
      vendor: def.vendor,
      scope: 'company',
      label: COMPANY_CONNECTION_LABEL,
      accountId: null,
      companyId: req.params.orgId,
      externalUserId: externalUserIdOf('company', req.params.orgId),
    })
    try {
      const started = await provider.initiate({
        toolkit: def.toolkit,
        authConfigId: def.authConfigId,
        externalUserId: row.externalUserId,
        callbackUrl: `${originOf(req)}/oauth/connectors/callback?c=${encodeURIComponent(row.id)}`,
      })
      const next = await db.updateConnectorConnection(row.id, { externalId: started.externalId })
      await db.audit({
        companyId: req.params.orgId,
        accountId: account.id,
        action: 'connector.connect',
        detail: { connectorId: item.id, scope: 'company', connectionId: row.id },
      })
      json(res, 201, { connection: publicConnection(next!), redirectUrl: started.redirectUrl })
    } catch (e) {
      await db.deleteConnectorConnection(row.id)
      asHttp(e)
    }
  })

  router.delete('/orgs/:orgId/connectors/:connectorId/connections/:connectionId', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.orgId, true)
    const row = await db.connectorConnection(req.params.connectionId)
    if (!row || row.scope !== 'company' || row.companyId !== req.params.orgId || row.connectorId !== req.params.connectorId) {
      throw new HttpError(404, '没有这个连接')
    }
    if (row.externalId) {
      try {
        await (await providerFor(db, row.vendor)).disconnect(row.externalId)
      } catch {
        /* 同上：本地这条一定要删掉 */
      }
    }
    await db.deleteConnectorConnection(row.id)
    await db.audit({
      companyId: req.params.orgId,
      accountId: account.id,
      action: 'connector.disconnect',
      detail: { connectorId: row.connectorId, scope: 'company', connectionId: row.id },
    })
    json(res, 200, { deleted: true, id: row.id })
  })

  // ── `@` 选单与校验 ────────────────────────────────────────────────

  /**
   * `@` 选单的候选。
   *
   * 一个接口给全，前端不用拼三份。现在只有连接器这一类——Bot 和 Routine 也在那个
   * 选单里，但它们走各自的路，等接上了往这里加一段即可，形状已经定死。
   */
  router.get('/mentions', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const q = (req.query.get('q') || '').trim().toLowerCase()
    const companyId = account.role === 'owner' ? null : account.companyId
    const items = await db.visibleCatalog('connector', companyId)
    const blocks = blockMapOf(items)
    const byId = new Map(items.filter((i) => i.scope === 'global').map((i) => [i.id, connectorDefOf(i)]))
    const conns = (await db.connectionsFor(account.id, companyId)).filter((c) => c.status === 'active')
    const mentions = conns
      .map((c) => {
        const def = byId.get(c.connectorId)
        if (!def || !def.enabled || blocks.get(c.connectorId)?.blocked) return null
        return {
          kind: 'connector' as const,
          id: c.id,
          label: c.scope === 'company' ? `${def.name} (${COMPANY_CONNECTION_LABEL})` : `${def.name} (${c.label})`,
          connectorId: c.connectorId,
          toolkit: def.toolkit,
          logo: def.logo,
          /** 「仅 @ 时可用」的在选单里要看得出来：不点名它就不干活。 */
          mentionOnly: c.mentionOnly,
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .filter((x) => !q || x.label.toLowerCase().includes(q) || x.toolkit.includes(q))
    /**
     * 名单上别的 Bot 也能 @（docs/bot-tasks.md）：@ 一颗 Bot = 让主 Bot 把这件事派给它。
     *
     * **只有设了主 Bot 的人才给**，而且只在主 Bot 的对话里有意义——别的 Bot 没有 assign_task。
     * 这条接口不知道人开着哪条对话，所以把 mainBotId 一起给出来，由界面按当前 Bot 决定画不画；
     * 发消息那一跳再按会话的 Bot 校验一次（routes/runtime.ts），界面漏了也进不去。
     */
    const mainBotId = account.role === 'owner' ? null : await db.mainBotOf(account.id)
    const bots = mainBotId
      ? (await db.botsFor(companyId, account.id))
          .filter((b) => b.id !== mainBotId)
          .map((b) => {
            const origin = b.scope === 'global' ? 'global' : 'company'
            return { kind: 'bot' as const, id: b.id, label: b.name, icon: botIconOf((b.definition as { icon?: unknown } | undefined)?.icon, origin), origin }
          })
          .filter((b) => !q || b.label.toLowerCase().includes(q))
      : []
    json(res, 200, { mentions: [...mentions, ...bots], mainBotId })
  })

  // ── 统计（三个范围）───────────────────────────────────────────────

  /**
   * 金额一律以**微元**给出，同时给一个折好的美元数。
   *
   * 两个都给的理由和套餐那边一样：微元是权威值（整数，不会有浮点误差），美元是给人看的。
   * 前端拿哪个都不用自己跟浮点数较劲。
   */
  function money(micros: number) {
    return { amountMicros: micros, amount: micros / 1_000_000 }
  }

  router.get('/platform/connector-stats', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const range = rangeQuery(req)
    const rows = await db.connectorUsageByCompany(range)
    const companies = new Map((await db.companies()).map((c) => [c.id, c]))
    const byCompany = new Map<string, { companyId: string | null; name: string; calls: number; amountMicros: number; lastAt: number | null }>()
    for (const row of rows) {
      const key = row.companyId ?? ''
      const cur = byCompany.get(key) ?? {
        companyId: row.companyId,
        name: row.companyId ? (companies.get(row.companyId)?.name ?? row.companyId) : '平台（系统管理员）',
        calls: 0,
        amountMicros: 0,
        lastAt: null,
      }
      cur.calls += row.calls
      cur.amountMicros += row.amountMicros
      cur.lastAt = Math.max(cur.lastAt ?? 0, row.lastAt ?? 0) || null
      byCompany.set(key, cur)
    }
    const all = await db.connectorUsage({}, range)
    json(res, 200, {
      total: { calls: all.total.calls, lastAt: all.total.lastAt, ...money(all.total.amountMicros) },
      byCompany: [...byCompany.values()].map((c) => ({ ...c, ...money(c.amountMicros) })),
      byConnector: all.byConnector.map((c) => ({ ...c, ...money(c.amountMicros) })),
      byTool: all.byTool.map((c) => ({ ...c, ...money(c.amountMicros) })),
      byStatus: all.byStatus.map((c) => ({ ...c, ...money(c.amountMicros) })),
    })
  })

  router.get('/orgs/:orgId/connector-stats', async (req, res) => {
    await requireOrgUser(req, db, keys, req.params.orgId, true)
    const range = rangeQuery(req)
    const usage = await db.connectorUsage({ companyId: req.params.orgId }, range)
    const accounts = new Map((await db.accountsOf(req.params.orgId)).map((a) => [a.id, a]))
    const installs = await db.connectorInstallsOfCompany(req.params.orgId)
    const items = await db.visibleCatalog('connector', req.params.orgId)
    const nameOf = new Map(items.filter((i) => i.scope === 'global').map((i) => [i.id, connectorDefOf(i)]))
    json(res, 200, {
      total: { calls: usage.total.calls, lastAt: usage.total.lastAt, ...money(usage.total.amountMicros) },
      byStatus: usage.byStatus.map((c) => ({ ...c, ...money(c.amountMicros) })),
      byAccount: usage.byAccount.map((row) => {
        const one = accounts.get(row.accountId)
        return {
          ...row,
          ...money(row.amountMicros),
          // 人可能已经离职，流水还在（留档要求）。那时按 id 显示，不装作查不到。
          name: one ? one.name || one.email : row.accountId,
          departed: !one,
        }
      }),
      byConnector: usage.byConnector.map((c) => ({ ...c, ...money(c.amountMicros) })),
      /** 「谁装了什么」——自助安装之下，admin 唯一能看清攻击面的地方。 */
      installs: installs.map((x) => ({
        connectorId: x.connectorId,
        connector: nameOf.get(x.connectorId)?.toolkit ?? '',
        name: nameOf.get(x.connectorId)?.name ?? '',
        accountId: x.accountId,
        accountName: accounts.get(x.accountId)?.name || accounts.get(x.accountId)?.email || x.accountId,
        createdAt: x.createdAt,
      })),
    })
  })

  router.get('/me/connector-stats', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const range = rangeQuery(req)
    const usage = await db.connectorUsage({ accountId: account.id }, range)
    json(res, 200, {
      total: { calls: usage.total.calls, lastAt: usage.total.lastAt, ...money(usage.total.amountMicros) },
      byConnector: usage.byConnector.map((c) => ({ ...c, ...money(c.amountMicros) })),
      byTool: usage.byTool.map((c) => ({ ...c, ...money(c.amountMicros) })),
      byStatus: usage.byStatus.map((c) => ({ ...c, ...money(c.amountMicros) })),
    })
  })

  // ── 市场（公司里的所有人）─────────────────────────────────────────

  /**
   * 我看得见的连接器。**默认放行**：上架了就在市场里，除非本公司禁了。
   *
   * 公司那一层只存否定（`{ blocked, reason }`），和 Skill/MCP 那种「公司自己建一条」
   * 不是一回事——连接器不是员工或公司能新建的东西。
   */
  router.get('/me/connectors', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const companyId = account.role === 'owner' ? null : account.companyId
    const items = await db.visibleCatalog('connector', companyId)
    const blocks = blockMapOf(items)
    const installs = new Set((await db.connectorInstalls(account.id)).map((x) => x.connectorId))
    const active = new Set(
      (await db.connectionsFor(account.id, companyId)).filter((c) => c.status === 'active').map((c) => c.connectorId),
    )
    const connectors = items
      .filter((i) => i.scope === 'global')
      .map((item) => {
        const block = blocks.get(item.id)
        return {
          ...publicConnector(item),
          blocked: block?.blocked === true,
          blockedReason: block?.reason ?? '',
          installed: installs.has(item.id),
          connected: active.has(item.id),
        }
      })
      .filter((c) => c.enabled)
    json(res, 200, { connectors })
  })
}
