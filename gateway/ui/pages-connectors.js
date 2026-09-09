/**
 * 连接器：owner 的上架屏 + 公司里所有人的市场。
 *
 * 三样东西分得很清（docs/connectors.md §4）：**上架**（owner 决定市场里有什么）、
 * **安装**（员工自己装）、**连接**（员工授权自己的账号）。这一屏现在只做第一样和
 * 市场的只读视图。
 *
 * 动作全部走本文件底部的 connectorAct()，不往 app.js 那条 if 链上堆——那条链已经
 * 六百多行了。
 */

function connectorVendor() {
  return (state.connectorVendors || []).find((v) => v.vendor === 'composio') || null
}

/** 上架列表按分组收拢。没填分组的归到「其他」，不另起一组空标题。 */
function connectorGroups(list) {
  const map = new Map()
  for (const c of list || []) {
    const key = c.category || t('其他')
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(c)
  }
  return [...map.entries()]
}

function connectorLogo(c) {
  if (c.logo) {
    /**
     * 图标 404 时换成方形占位（`mark`）。
     *
     * 这里原来是一段**写在 HTML 属性里的 JS**，要转义两次：JSON.stringify 管 JS 那一层
     * （引号变 \"），可反斜杠对 HTML 解析器毫无意义——它看到 \" 里的那个引号就把属性
     * 收了，后面半截 `GI"))">` 漏成正文，于是每张卡片名字后面挂一串乱码。
     *
     * 现在名字原样放在 `data-mark` 上，替换由 shell.js 的 mediaFallback 用 textContent
     * 做完：只剩属性这一层要转义，那个坑连同内联脚本一起没了（CSP 也不用为它放开
     * script-src 的 'unsafe-inline'）。
     */
    return `<img src="${esc(c.logo)}" alt="" style="width: 34px; height: 34px; border-radius: 8px; object-fit: cover; flex: none;"
      data-onerror="mark" data-mark="${esc(c.name)}">`
  }
  return mark(c.name)
}

// ── owner：供应商 + 上架 ─────────────────────────────────────────────

function connectorVendorCard() {
  const v = connectorVendor()
  const busy = state.tests['connector:composio']?.status === 'busy'
  const status = v?.configured
    ? `<span class="tag tag-accent">${t('已配置')}</span>`
    : `<span class="tag">${t('缺密钥')}</span>`
  return `<div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover); padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3);">
    <div style="display: flex; align-items: center; gap: var(--space-3);">
      ${mark('Composio')}
      <div style="min-width: 0; flex: 1;">
        <div style="font-size: 14px; font-weight: 600;">Composio</div>
        <div style="font-size: 12px; color: var(--muted-foreground);">${t('连接器供应商。密钥只存在 Gateway，保存后不回显，也不会下发到席位机器。')}</div>
      </div>
      ${status}
    </div>
    <div style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
      <form class="gw-secret" style="flex: 1; min-width: 220px;" data-form="connector-vendor">
        <input class="input" name="secret" type="password" autocomplete="off"
          placeholder="${esc(v?.configured ? t('输入新密钥以更新') : t('粘贴 Composio API 密钥'))}" required>
      </form>
      <button type="button" class="btn btn-primary" data-act="conn-vendor-save">${t('保存')}</button>
      <button type="button" class="btn btn-ghost" data-act="conn-vendor-ping" ${busy ? 'disabled' : ''}>${t('测试连接')}</button>
      ${testMark('connector', 'composio') ? `<div class="gw-testline">${testMark('connector', 'composio')}</div>` : ''}
    </div>
  </div>`
}

/**
 * 候选清单。**单独一个函数**，因为搜索框边打边过滤时只重画这一块——整页 render()
 * 会把输入框换掉，正在打字的人立刻丢焦点。
 */
function connectorPickRows() {
  const draft = state.connectorDraft
  if (!draft) return ''
  const q = (draft.q || '').trim().toLowerCase()
  const taken = new Set((state.connectors || []).map((c) => c.toolkit))
  const list = (state.connectorToolkits || [])
    .filter((tk) => !q || tk.slug.includes(q) || (tk.name || '').toLowerCase().includes(q))
    .slice(0, 60)
  const rows = list
    .map((tk) => {
      const on = draft.toolkit === tk.slug
      const already = taken.has(tk.slug)
      return `<button type="button" class="btn ${on ? 'btn-primary' : 'btn-ghost'}" style="justify-content: flex-start; width: 100%;"
        data-act="conn-pick" data-toolkit="${esc(tk.slug)}" ${already ? 'disabled' : ''}>
        <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${esc(tk.name || tk.slug)} <span style="color: var(--muted-foreground);">${esc(tk.slug)}</span>
        </span>
        ${already ? `<span class="tag" style="margin-left: auto;">${t('已上架')}</span>` : ''}
      </button>`
    })
    .join('')
  return (
    rows ||
    `<div style="padding: var(--space-4); text-align: center; font-size: 13px; color: var(--muted-foreground);">${
      (state.connectorToolkits || []).length ? t('没有匹配的连接器') : t('先配好密钥再来这里')
    }</div>`
  )
}

function paintConnectorPicks() {
  const box = document.getElementById('conn-picks')
  if (box) box.innerHTML = connectorPickRows()
}

/**
 * 按次单价。单位是**微元**（百万分之一美元）——一次调用值半厘是常态，用厘存会被舍成 0。
 * 界面上让人填美元，存的时候乘一百万。
 */
function connectorPricingCard() {
  const pricing = state.settings?.connectorPricing || { defaultMicros: 0, byToolkit: {} }
  const rows = (state.connectors || [])
    .map((c) => {
      const v = pricing.byToolkit?.[c.toolkit]
      return `<div style="display: flex; align-items: center; gap: var(--space-2); padding: 4px 0;">
        <span style="flex: 1; min-width: 0; font-size: 13px;">${esc(c.name)} <span style="color: var(--muted-foreground);">${esc(c.toolkit)}</span></span>
        <input class="input" style="max-width: 140px;" data-input="price-${esc(c.toolkit)}"
          value="${v == null ? '' : esc(String(v / 1000000))}" placeholder="${esc(t('跟默认'))}">
        <span style="font-size: 12px; color: var(--muted-foreground);">${t('美元 / 次')}</span>
      </div>`
    })
    .join('')
  return `<div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover); padding: var(--space-4);">
    <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-2);">
      <div>
        <div style="font-size: 14px; font-weight: 600;">${t('按次单价')}</div>
        <div style="font-size: 12px; color: var(--muted-foreground);">${t('每成功调用一次工具收多少钱，从公司余额里扣。留空跟默认单价走；0 = 不收费。')}</div>
      </div>
      <button type="button" class="btn btn-primary" style="flex: none;" data-act="conn-price-save">${t('保存')}</button>
    </div>
    <div style="display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-3);">
      <span style="flex: 1; min-width: 0; font-size: 13px; font-weight: 600;">${t('默认单价')}</span>
      <input class="input" style="max-width: 140px;" data-input="price-default" value="${esc(String((pricing.defaultMicros || 0) / 1000000))}">
      <span style="font-size: 12px; color: var(--muted-foreground);">${t('美元 / 次')}</span>
    </div>
    ${rows ? `<div style="margin-top: var(--space-2); border-top: 1px solid var(--border); padding-top: var(--space-2);">${rows}</div>` : ''}
    <p style="margin: var(--space-3) 0 0; font-size: 12px; color: var(--muted-foreground);">
      ${t('改单价不影响已经落地的流水：历史账按当时的价固化，不会跟着一起变。')}
    </p>
  </div>`
}

function connectorPublishModal() {
  const draft = state.connectorDraft
  if (!draft) return ''
  return `<div class="gw-modal-backdrop" data-act="conn-close">
    <div class="gw-modal" role="dialog" aria-modal="true" style="max-width: 560px;">
      <h2 style="margin: 0 0 4px; font-size: 18px;">${t('上架连接器')}</h2>
      <p style="margin: 0 0 var(--space-3); font-size: 13px; color: var(--muted-foreground);">
        ${t('从 Composio 的清单里选一个，填上它在 Composio 那边的 auth config id。上架之后所有公司的员工都能在市场里看到并自己安装。')}
      </p>
      ${draft.error ? `<div class="gw-flash gw-flash-err" style="margin-bottom: var(--space-3);">${esc(draft.error)}</div>` : ''}
      <input class="input" placeholder="${esc(t('搜索'))}" value="${esc(draft.q || '')}" data-act="conn-field" data-field="q" style="margin-bottom: var(--space-2);">
      <div id="conn-picks" style="max-height: 240px; overflow: auto; display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-2);">
        ${connectorPickRows()}
      </div>
      <label style="display: block; margin-top: var(--space-3); font-size: 13px;">${t('auth config id')}
        <input class="input" data-act="conn-field" data-field="authConfigId" value="${esc(draft.authConfigId || '')}" placeholder="ac_..." style="margin-top: 4px;">
      </label>
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-4);">
        <button type="button" class="btn btn-ghost" data-act="conn-close">${t('取消')}</button>
        <button type="button" class="btn btn-primary" data-act="conn-publish" ${draft.toolkit ? '' : 'disabled'}>${t('上架')}</button>
      </div>
    </div>
  </div>`
}

function connectorEditModal() {
  const edit = state.connectorEdit
  if (!edit) return ''
  return `<div class="gw-modal-backdrop" data-act="conn-edit-close">
    <div class="gw-modal" role="dialog" aria-modal="true" style="max-width: 480px;">
      <h2 style="margin: 0 0 var(--space-3); font-size: 18px;">${esc(edit.name)}</h2>
      ${edit.error ? `<div class="gw-flash gw-flash-err" style="margin-bottom: var(--space-3);">${esc(edit.error)}</div>` : ''}
      <p style="margin: 0 0 var(--space-3); font-size: 12px; color: var(--muted-foreground);">
        ${t('供应商和 toolkit 建完就不给改了——它们已经写进流水和员工已有的连接。要换就下架再上一条新的。')}
      </p>
      <label style="display: block; font-size: 13px;">${t('显示名')}
        <input class="input" data-input="conn-edit-name" value="${esc(edit.name)}" style="margin-top: 4px;">
      </label>
      <label style="display: block; margin-top: var(--space-2); font-size: 13px;">${t('说明')}
        <input class="input" data-input="conn-edit-desc" value="${esc(edit.description || '')}" style="margin-top: 4px;">
      </label>
      <label style="display: block; margin-top: var(--space-2); font-size: 13px;">${t('auth config id')}
        <input class="input" data-input="conn-edit-auth" value="${esc(edit.authConfigId || '')}" placeholder="${esc(edit.authReady ? t('已配置，留空则不改') : 'ac_...')}" style="margin-top: 4px;">
      </label>
      <label style="display: block; margin-top: var(--space-2); font-size: 13px;">${t('装上默认开哪几个工具')}
        <textarea class="input" data-input="conn-edit-recommended" rows="4" placeholder="GITHUB_CREATE_ISSUE&#10;GITHUB_LIST_ISSUES" style="margin-top: 4px; font-family: var(--font-mono, monospace); font-size: 12px;">${esc((edit.recommendedTools || []).join('\n'))}</textarea>
      </label>
      <p style="margin: 4px 0 0; font-size: 12px; color: var(--muted-foreground);">
        ${t('一行一个 slug。留空 = 装上就全开——GitHub 有五百个工具，全开的话员工要点四百多次才关得完，「自己关」这条路等于没有。挑十几个常用的。')}
      </p>
      <label style="display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-3); font-size: 13px;">
        <input type="checkbox" data-input="conn-edit-enabled" ${edit.enabled ? 'checked' : ''}>
        ${t('在市场里可见')}
      </label>
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-4);">
        <button type="button" class="btn btn-ghost" data-act="conn-edit-close">${t('取消')}</button>
        <button type="button" class="btn btn-primary" data-act="conn-edit-save">${t('保存')}</button>
      </div>
    </div>
  </div>`
}

/**
 * 「添加账号」那一行。owner 详情页和员工侧栏各用一次，逐字相同。
 *
 * 单独收起来是因为它其实是一份**契约**：`data-input="conn-label"` 和
 * `data-act="conn-add-account"` 要和 app.js 的事件委托对上，改名字得两头一起改。
 */
function addAccountRow(id) {
  return `<div style="padding: var(--space-3) 0; display: flex; align-items: center; gap: var(--space-2);">
      <input class="input" style="max-width: 200px;" data-input="conn-label" placeholder="${esc(t('账号名，如 personal'))}">
      <button type="button" class="btn btn-secondary" data-act="conn-add-account" data-id="${esc(id)}">${t('添加账号')}</button>
    </div>`
}

/**
 * 连接器名单里的一行：左边是 logo + 名字 + 一句小字，右边几格由调用方给。
 *
 * owner 那张（上架管理）和 admin 那张（本公司禁用）左半边一模一样，右半边完全不同
 * ——所以左半边留在这儿，右半边当参数传。
 */
function connectorRow(c, sub, cells) {
  return `<div class="satu-provrow" style="grid-template-columns: 1fr auto auto auto;">
      <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
        ${connectorLogo(c)}
        <div style="min-width: 0;">
          <div style="font-size: 14px; font-weight: 600;">${esc(c.name)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${sub}</div>
        </div>
      </div>
      ${cells}
    </div>`
}

function ownerConnectorsPage() {
  const list = state.connectors || []
  const rows = list
    .map(
      (c) =>
        connectorRow(
          c,
          `${esc(c.vendor)} · ${esc(c.toolkit)}${c.description ? ` · ${esc(c.description)}` : ''}`,
          `${c.authReady ? `<span class="tag tag-accent">${t('可授权')}</span>` : `<span class="tag">${t('缺 auth config')}</span>`}
      ${c.enabled ? '' : `<span class="tag">${t('已隐藏')}</span>`}
      <div style="display: flex; gap: var(--space-2);">
        <button type="button" class="btn btn-ghost" data-act="conn-edit" data-id="${esc(c.id)}">${t('编辑')}</button>
        <button type="button" class="satu-linkbtn" data-act="conn-unpublish" data-id="${esc(c.id)}">${t('下架')}</button>
      </div>`,
        ),
    )
    .join('')
  const ready = connectorVendor()?.configured
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('连接器')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('上架之后，所有公司的员工都能在自己的市场里安装并授权自己的账号。公司管理员可以禁掉其中某几个。')}</p>
          </div>
          <div style="flex: none;">
            <button type="button" class="btn btn-primary" data-act="conn-publish-open" ${ready ? '' : 'disabled'}>${t('上架连接器')}</button>
          </div>
        </div>
        ${flashes()}
        <div style="margin-top: var(--space-4); display: flex; flex-direction: column; gap: var(--space-4);">
          ${connectorVendorCard()}
          ${connectorPricingCard()}
          <div class="gw-credlist" style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${ready ? t('还没上架任何连接器。点右上角从 Composio 的清单里选一个。') : t('先配好 Composio 密钥，才能拉到可上架的清单。')}</div>`}
          </div>
        </div>
      </div>
      ${connectorPublishModal()}
      ${connectorEditModal()}
    </div>`
}

// ── 公司里的所有人：市场 ─────────────────────────────────────────────

function marketCard(c) {
  const blocked = c.blocked
  const installed = c.installed
  const action = blocked
    ? `<span class="tag" style="flex: none;">${t('已禁用')}</span>`
    : installed
      ? `<button type="button" class="btn btn-ghost" style="flex: none;" data-act="go" data-href="/connectors/${esc(c.id)}">${t('管理')}</button>`
      : `<button type="button" class="btn btn-secondary" style="flex: none;" data-act="conn-install" data-id="${esc(c.id)}">${t('安装')}</button>`
  return `<div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover); padding: var(--space-4); display: flex; gap: var(--space-3); align-items: flex-start; ${blocked ? 'opacity: 0.55;' : ''}">
    ${connectorLogo(c)}
    <div style="min-width: 0; flex: 1;">
      <div style="font-size: 14px; font-weight: 600;">${esc(c.name)}${installed ? ` <span class="tag tag-accent">${t('已安装')}</span>` : ''}</div>
      <div style="font-size: 12px; color: var(--muted-foreground); margin-top: 2px;">${esc(c.description || c.toolkit)}</div>
      ${blocked ? `<div style="font-size: 12px; color: var(--muted-foreground); margin-top: var(--space-2);">${t('本公司已禁用')}${c.blockedReason ? `：${esc(c.blockedReason)}` : ''}</div>` : ''}
    </div>
    ${action}
  </div>`
}

// ── 员工：一个连接器的详情 ───────────────────────────────────────────

/** 一把连接一行：名字、状态、「仅 @ 时可用」、断开。 */
function connectionRow(c, connectorId) {
  const status =
    c.status === 'active'
      ? `<span style="font-size: 13px; color: var(--color-accent-2-800);">${t('已连接')}</span>`
      : c.status === 'pending'
        ? `<span style="font-size: 13px; color: var(--muted-foreground);">${t('未完成')}</span>`
        : `<span style="font-size: 13px; color: var(--color-accent-800);">${esc(c.error || t('失败'))}</span>`
  const company = c.scope === 'company'
  return `<div style="display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) 0; border-bottom: 1px solid var(--border);">
    <div style="min-width: 0; flex: 1; display: flex; align-items: center; gap: var(--space-2);">
      <span style="font-size: 14px;">${esc(c.label)}</span>
      ${company ? `<span class="tag">${t('公司共用')}</span>` : ''}
    </div>
    ${status}
    ${
      company
        ? ''
        : `<label style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted-foreground);"
             title="${esc(t('打开之后，只有在消息里 @ 它才用得上；不点名的对话碰不到这个账号。'))}">
        <input type="checkbox" data-act="conn-mention-only" data-id="${esc(c.id)}" data-connector="${esc(connectorId)}" ${c.mentionOnly ? 'checked' : ''}>
        ${t('仅 @ 时可用')}
      </label>`
    }
    ${company ? '' : `<button type="button" class="satu-linkbtn" data-act="conn-disconnect" data-id="${esc(c.id)}" data-connector="${esc(connectorId)}">${t('断开')}</button>`}
  </div>`
}

function connectorToolsBox(detail) {
  const tools = detail.tools || []
  if (detail.toolsError) {
    return `<div style="font-size: 13px; color: var(--muted-foreground);">${t('拉不到工具清单')}：${esc(detail.toolsError)}</div>`
  }
  if (!tools.length) return `<div style="font-size: 13px; color: var(--muted-foreground);">${t('这个连接器没有可用工具')}</div>`
  const enabled = new Set(detail.install?.enabledTools || [])
  // 空 = 全开。这是后端的口径，界面上也照这个显示，不然「一个都没勾」会被读成「全关」。
  const all = enabled.size === 0
  /**
   * **数字用后端算好的 `enabledCount`，不自己数 `enabledTools`。**
   *
   * 自己数的是「存了几个」，后端数的是「有几个真的在清单里」。存着一个供应商已经改名
   * 的 slug 时，两者会差开——界面写「1 / 500 个已开启」，底下 500 个复选框一个没勾，
   * Bot 那边一个工具也没有。三处对不上，还查不出为什么。
   */
  const on = Number.isFinite(detail.enabledCount) ? detail.enabledCount : all ? tools.length : enabled.size
  const cap = Number(detail.toolCap) || 0
  const rows = tools
    .map(
      (tool) => `<label style="display: flex; align-items: flex-start; gap: var(--space-2); padding: 6px 0; font-size: 13px;">
      <input type="checkbox" data-act="conn-tool" data-tool="${esc(tool.slug)}" ${all || enabled.has(tool.slug) ? 'checked' : ''}>
      <span style="min-width: 0;">
        <span style="font-family: var(--font-mono, monospace); font-size: 12px;">${esc(tool.slug)}</span>
        ${tool.description ? `<span style="display: block; color: var(--muted-foreground);">${esc(tool.description)}</span>` : ''}
      </span>
    </label>`,
    )
    .join('')
  return `<div>
    <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-2);">
      <span style="font-size: 13px; color: var(--muted-foreground);">${t(`${on} / ${tools.length} 个已开启`)}</span>
      <button type="button" class="btn btn-primary" data-act="conn-tools-save" data-connector="${esc(detail.connector.id)}">${t('保存')}</button>
    </div>
    <p style="margin: 0 0 var(--space-2); font-size: 12px; color: var(--muted-foreground);">
      ${t('开着的工具会进你每一个 Bot 的工具表。用不上的关掉——装得多了，工具表会把上下文撑满，模型也更容易选错。')}
    </p>
    ${toolModeNote(detail, on, cap)}
    <div style="max-height: 320px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-3);">${rows}</div>
  </div>`
}

/**
 * 工具数超了之后那一条提示。
 *
 * **档位由后端给（`detail.toolMode`），界面不许自己按 `on > cap` 去推**——推的那一刻它就
 * 和 Gateway 的分档逻辑分叉了，而分叉的表现是界面说一套、Bot 拿到另一套（tool-search.md §9）。
 *
 * 语气分两种，这个区别是要紧的：
 * - `search` / `listing`：**没有东西被丢掉**，只是多一两轮往返。是一句说明，不是警告
 * - `direct` 且超了：这是 `CONNECTOR_TOOL_SEARCH=off` 那一档，真的会截断。红字
 */
function toolModeNote(detail, on, cap) {
  const mode = detail.toolMode || 'direct'
  // 开着的 slug 在清单里找不到：既不下发也不报错，界面上必须看得见。供应商改名、
  // 下线一个工具都会走到这里，不只是填错。
  const gone = detail.unknownTools || []
  // 名字要转义：服务端存 enabledTools 时只 String().trim()，没有 slug 校验，所以
  // 这几个字符串是**用户写进去的**，原样拼进 innerHTML 就是一条现成的注入。
  const goneLine = gone.length
    ? `<div class="gw-flash gw-flash-err" style="margin-bottom: var(--space-2);">${t(
        `开着的 ${gone.length} 个工具在这个连接器的清单里已经没有了，不会下发给 Bot：${esc(gone.join('、'))}。保存一次就能把它们清掉。`,
      )}</div>`
    : ''
  if (mode === 'search' || mode === 'listing') {
    return goneLine + `<div class="gw-flash gw-flash-note" style="margin-bottom: var(--space-2);">${t(
      `开了 ${on} 个，超过 ${cap} 个——这个连接会切到搜索模式：Bot 先搜工具再调，${on} 个全都用得上，代价是每次多一两轮往返。关掉用不上的能回到直连模式。`,
    )}</div>`
  }
  if (!cap || on <= cap) return goneLine
  return goneLine + `<div class="gw-flash gw-flash-err" style="margin-bottom: var(--space-2);">${t(
    `开了 ${on} 个，超过上限 ${cap} 个——多出来的 ${on - cap} 个不会下发给 Bot。关掉一些用不上的。`,
  )}</div>`
}

function connectorDetailPage() {
  const detail = state.connectorDetail
  if (!detail || !detail.connector) {
    return `<div class="gw-page"><div class="gw-page-inner">${flashes()}<p style="font-size: 13px; color: var(--muted-foreground);">${t('加载中…')}</p></div></div>`
  }
  const c = detail.connector
  const conns = detail.connections || []
  const installed = Boolean(detail.install)
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-start; gap: var(--space-3);">
          ${connectorLogo(c)}
          <div style="min-width: 0; flex: 1;">
            <h1 style="font-size: 20px; margin: 0;">${esc(c.name)}</h1>
            <p style="margin: 2px 0 0; font-size: 13px; color: var(--muted-foreground);">${esc(c.description || c.toolkit)}</p>
          </div>
          ${
            installed
              ? `<button type="button" class="btn btn-ghost" data-act="conn-uninstall" data-id="${esc(c.id)}">${t('卸载')}</button>`
              : `<button type="button" class="btn btn-secondary" data-act="conn-install" data-id="${esc(c.id)}">${t('安装')}</button>`
          }
        </div>
        ${flashes()}
        ${c.blocked ? `<div class="gw-flash gw-flash-err" style="margin-top: var(--space-3);">${t('本公司已禁用这个连接器')}${c.blockedReason ? `：${esc(c.blockedReason)}` : ''}</div>` : ''}
        ${
          installed
            ? `<section style="margin-top: var(--space-6);">
                <h2 style="font-size: 13px; font-weight: 600; color: var(--muted-foreground); margin: 0 0 var(--space-2);">${t('账号')}</h2>
                <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover); padding: 0 var(--space-4);">
                  ${conns.map((x) => connectionRow(x, c.id)).join('') || ''}
                  ${addAccountRow(c.id)}
                </div>
                <p style="margin: var(--space-2) 0 0; font-size: 12px; color: var(--muted-foreground);">
                  ${t('账号名会出现在工具名里（如 gmail_personal），模型靠它判断该用哪一个。')}
                </p>
              </section>
              <section style="margin-top: var(--space-6);">
                <h2 style="font-size: 13px; font-weight: 600; color: var(--muted-foreground); margin: 0 0 var(--space-2);">${t('工具')}</h2>
                ${connectorToolsBox(detail)}
              </section>`
            : `<p style="margin-top: var(--space-6); font-size: 13px; color: var(--muted-foreground);">${t('先安装，再连接你的账号。')}</p>`
        }
      </div>
    </div>`
}

function marketPage() {
  const groups = connectorGroups(state.market || [])
  const body = groups
    .map(
      ([name, list]) => `<section style="margin-top: var(--space-6);">
      <h2 style="font-size: 13px; font-weight: 600; color: var(--muted-foreground); margin: 0 0 var(--space-2);">${esc(name)}</h2>
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--space-3);">
        ${list.map(marketCard).join('')}
      </div>
    </section>`,
    )
    .join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <h1 style="font-size: 24px; margin: 0 0 4px;">${t('连接器')}</h1>
        <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('装上之后，你名下的每一个 Bot 都能用——不用为每个 Bot 各连一次。')}</p>
        ${flashes()}
        ${body || `<div style="margin-top: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('平台还没上架任何连接器。')}</div>`}
      </div>
    </div>`
}

// ── 公司管理员：禁用、谁装了什么、花了多少 ───────────────────────────

function adminConnectorsPage() {
  const list = state.orgConnectors || []
  const stats = state.connectorStats
  const rows = list
    .map(
      (c) =>
        connectorRow(
          c,
          `${esc(c.toolkit)}${c.blocked && c.blockedReason ? ` · ${esc(c.blockedReason)}` : ''}`,
          `<span style="font-size: 13px; color: var(--muted-foreground);">${t(`${c.installs} 人装了`)}</span>
      <span style="font-size: 13px; color: var(--muted-foreground);">${t(`${c.connections} 个已连接`)}</span>
      <div style="display: flex; gap: var(--space-2);">
        ${
          c.blocked
            ? `<button type="button" class="btn btn-ghost" data-act="conn-unblock" data-id="${esc(c.id)}">${t('解禁')}</button>`
            : `<button type="button" class="satu-linkbtn" data-act="conn-block" data-id="${esc(c.id)}">${t('禁用')}</button>`
        }
      </div>`,
        ),
    )
    .join('')
  const usage = stats
    ? `<div style="display: flex; gap: var(--space-4); flex-wrap: wrap;">
        ${[
          [t('调用次数'), String(stats.total.calls)],
          [t('费用'), `$${(stats.total.amount ?? 0).toFixed(4)}`],
        ]
          .map(
            ([k, v]) => `<div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover); padding: var(--space-3) var(--space-4); min-width: 140px;">
            <div style="font-size: 12px; color: var(--muted-foreground);">${esc(k)}</div>
            <div style="font-size: 20px; font-weight: 600;">${esc(v)}</div>
          </div>`,
          )
          .join('')}
      </div>`
    : ''
  const who = (stats?.installs || [])
    .map(
      (x) => `<div style="display: flex; gap: var(--space-3); padding: 6px 0; font-size: 13px; border-bottom: 1px solid var(--border);">
      <span style="flex: 1; min-width: 0;">${esc(x.accountName)}</span>
      <span style="color: var(--muted-foreground);">${esc(x.name || x.connector)}</span>
    </div>`,
    )
    .join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <h1 style="font-size: 24px; margin: 0 0 4px;">${t('连接器')}</h1>
        <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('员工自己安装、自己授权。这里管的是「本公司哪几个不许用」，以及谁在用、花了多少。')}</p>
        ${flashes()}
        <div style="margin-top: var(--space-4); display: flex; flex-direction: column; gap: var(--space-4);">
          ${usage}
          <div class="gw-credlist" style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('平台还没上架任何连接器。')}</div>`}
          </div>
          ${
            who
              ? `<section>
                  <h2 style="font-size: 13px; font-weight: 600; color: var(--muted-foreground); margin: 0 0 var(--space-2);">${t('谁装了什么')}</h2>
                  <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover); padding: 0 var(--space-4);">${who}</div>
                </section>`
              : ''
          }
        </div>
      </div>
    </div>`
}

function connectorsPage() {
  if (isOwner()) return ownerConnectorsPage()
  // 管理员管的是禁令和账，不是自己的账号；他要装连接器走的是同一个市场，但那是员工身份
  // 的事，两屏分开——混在一起的话「本公司谁装了什么」会被自己的安装卡片挤到底下。
  return isAdmin() ? adminConnectorsPage() : marketPage()
}

// ── 插件弹窗：对话那一侧的入口 ───────────────────────────────────────

/**
 * 「插件」= 员工视角的连接器。同一批东西，两个入口。
 *
 * **为什么是弹窗而不是又一个页面**：装插件是**为了把话说完**才做的事——「让它读一下
 * 我的邮件」说到一半才发现 Gmail 还没装。跳走一整页，回来时草稿、滚动位置、刚选好的
 * 那颗 Bot 全没了。弹窗盖在对话上面，关掉就回到原处。
 *
 * 市场那两个页面没有撤：OAuth 回调落在 `/connectors/:id`（`connectors.ts` 那个 302），
 * 深链和刷新也还得有人接。撤掉的只是员工侧栏里那一行——同一件事两个并排的入口，
 * 只会让人问「这两个有什么不一样」。
 */
function pluginsModal() {
  const p = state.plugins
  if (!p) return ''
  return `<div class="gw-modal-backdrop" data-act="plugins-close">
    <div class="gw-modal gw-plugins" data-stop role="dialog" aria-modal="true" style="max-width: 720px; max-height: 88vh; overflow: hidden;">
      ${p.id ? pluginDetailBody() : pluginMarketBody()}
    </div>
  </div>`
}

function pluginsHead(title, back) {
  return `<div style="display: flex; align-items: center; gap: var(--space-2);">
    ${back ? `<button type="button" class="btn btn-ghost btn-icon" style="flex: none;" data-act="plugins-back" aria-label="${esc(t('返回'))}">${svg(BACK_ARROW, 17)}</button>` : ''}
    <h2 style="flex: 1; min-width: 0; margin: 0; font-size: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(title)}</h2>
    <button type="button" class="btn btn-ghost btn-icon" style="flex: none;" data-act="plugins-close" aria-label="${esc(t('关闭'))}">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
  </div>`
}

function pluginMarketBody() {
  const p = state.plugins
  return `${pluginsHead(t('插件', 'Plugins'), false)}
    <div style="display: flex; align-items: center; gap: var(--space-2);">
      <div style="display: flex; gap: 4px; flex: none;">
        ${[
          ['market', t('市场', 'Marketplace')],
          ['mine', t('已安装', 'Yours')],
        ]
          .map(
            ([key, label]) =>
              `<button type="button" class="btn ${p.tab === key ? 'btn-secondary' : 'btn-ghost'}" data-act="plugins-tab" data-tab="${key}">${esc(label)}</button>`,
          )
          .join('')}
      </div>
      <input class="input" style="flex: 1; min-width: 0;" placeholder="${esc(t('搜索插件', 'Search plugins'))}"
        value="${esc(p.q || '')}" data-act="plugins-field">
    </div>
    ${p.error ? `<div class="gw-flash gw-flash-err">${esc(p.error)}</div>` : ''}
    ${/* 「已保存」「已断开」这些走的是共用的 flash()，而它画在页面正文里——弹窗盖着
          正文，不在这儿再画一遍等于没画。 */ ''}
    ${flashes()}
    <div id="plugins-list" style="min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--space-4);">
      ${pluginListRows()}
    </div>`
}

/**
 * 清单那一块**单独一个函数**：搜索框边打边过滤时只重画这里。整页 render() 会把输入框
 * 换掉，正在打字的人立刻丢焦点——上架弹窗那边（connectorPickRows）栽过同一个坑。
 */
function pluginListRows() {
  const p = state.plugins
  if (!p) return ''
  if (p.loading) return `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('加载中…')}</div>`
  const q = (p.q || '').trim().toLowerCase()
  const list = (state.market || []).filter((c) => {
    if (p.tab === 'mine' && !c.installed) return false
    if (!q) return true
    return `${c.name} ${c.toolkit} ${c.description || ''}`.toLowerCase().includes(q)
  })
  if (!list.length) {
    const empty = q
      ? t('没有匹配的插件', 'No plugins match that')
      : p.tab === 'mine'
        ? t('还没装任何插件。到「市场」里挑一个。', 'Nothing installed yet — pick one from the marketplace.')
        : t('平台还没上架任何连接器。')
    return `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${esc(empty)}</div>`
  }
  return connectorGroups(list)
    .map(
      ([name, rows]) => `<section>
      <p style="margin: 0 0 var(--space-2); font-size: 12px; font-weight: 600; color: var(--muted-foreground);">${esc(name)}</p>
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--space-2);">
        ${rows.map(pluginRow).join('')}
      </div>
    </section>`,
    )
    .join('')
}

function pluginRow(c) {
  // 被公司禁掉的既不给装也不给点进去：点进去只有一句「已禁用」，白跑一趟。
  const action = c.blocked
    ? `<span class="tag" style="flex: none;">${t('已禁用')}</span>`
    : c.installed
      ? `<button type="button" class="btn btn-ghost" style="flex: none;" data-act="plugins-detail" data-id="${esc(c.id)}">${t('管理')}</button>`
      : `<button type="button" class="btn btn-secondary" style="flex: none;" data-act="conn-install" data-id="${esc(c.id)}">${t('添加', 'Add')}</button>`
  return `<div style="display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius); ${c.blocked ? 'opacity: 0.55;' : ''}">
    ${connectorLogo(c)}
    <div style="min-width: 0; flex: 1;">
      <div style="font-size: 14px; font-weight: 600;">${esc(c.name)}${c.installed ? ` <span class="tag tag-accent">${t('已安装')}</span>` : ''}</div>
      <div style="font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
        ${esc(c.blocked && c.blockedReason ? `${t('本公司已禁用')}：${c.blockedReason}` : c.description || c.toolkit)}
      </div>
    </div>
    ${action}
  </div>`
}

/**
 * 装完之后的那一屏：连账号、挑工具。和详情页是同一套零件（connectionRow /
 * connectorToolsBox），只是外面换了个壳——两份画法迟早会漂。
 */
function pluginDetailBody() {
  const p = state.plugins
  const detail = state.pluginDetail
  if (!detail || detail.connector?.id !== p.id) {
    return `${pluginsHead(t('插件', 'Plugins'), true)}
      ${p.error ? `<div class="gw-flash gw-flash-err">${esc(p.error)}</div>` : ''}
      <p style="font-size: 13px; color: var(--muted-foreground);">${t('加载中…')}</p>`
  }
  const c = detail.connector
  const conns = detail.connections || []
  return `${pluginsHead(c.name, true)}
    <div style="display: flex; align-items: center; gap: var(--space-3);">
      ${connectorLogo(c)}
      <div style="min-width: 0; flex: 1; font-size: 13px; color: var(--muted-foreground);">${esc(c.description || c.toolkit)}</div>
      <button type="button" class="btn btn-ghost" style="flex: none;" data-act="conn-uninstall" data-id="${esc(c.id)}">${t('卸载')}</button>
    </div>
    ${p.error ? `<div class="gw-flash gw-flash-err">${esc(p.error)}</div>` : ''}
    ${flashes()}
    ${c.blocked ? `<div class="gw-flash gw-flash-err">${t('本公司已禁用这个连接器')}${c.blockedReason ? `：${esc(c.blockedReason)}` : ''}</div>` : ''}
    <div style="min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--space-6);">
      <section>
        <h3 style="font-size: 13px; font-weight: 600; color: var(--muted-foreground); margin: 0 0 var(--space-2);">${t('账号')}</h3>
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 0 var(--space-4);">
          ${conns.map((x) => connectionRow(x, c.id)).join('')}
          ${addAccountRow(c.id)}
        </div>
        <p style="margin: var(--space-2) 0 0; font-size: 12px; color: var(--muted-foreground);">
          ${t('点「添加账号」会新开一页去授权，这一边不动；授权完关掉那页就行。账号名会出现在工具名里（如 gmail_personal），模型靠它判断该用哪一个。', 'Adding an account opens authorization in a new tab and leaves this one alone — close that tab when you are done. The label shows up in the tool name (gmail_personal), which is how the model tells accounts apart.')}
        </p>
      </section>
      <section>
        <h3 style="font-size: 13px; font-weight: 600; color: var(--muted-foreground); margin: 0 0 var(--space-2);">${t('工具')}</h3>
        ${connectorToolsBox(detail)}
      </section>
    </div>`
}

/**
 * 连接器控件的查询根。
 *
 * 弹窗和 `/connectors/:id` 那一页有**同名**的输入框和勾选框（`conn-label`、
 * `conn-tool`），而弹窗能盖在那一页上面。不分根的话 querySelector 先中的是底下那页，
 * 于是在弹窗里填的账号名发不出去、勾的工具存的是别人那一份。
 */
function connRoot() {
  return (state.plugins && document.querySelector('.gw-plugins')) || document
}

function paintPluginList() {
  const box = document.getElementById('plugins-list')
  if (box) box.innerHTML = pluginListRows()
}

/**
 * 正在等哪个连接器的授权回来（空串 = 没有在等）。
 *
 * 授权是在**另一个标签页**里完成的，这一边一个事件都收不到：账号列表停在点「添加账号」
 * 之前，不补一次就一直少一行，人会以为没授权成功，然后再点一次。回到这一页时补取，
 * 而且只补这一次——每次切回标签页都重打一趟网络没有道理。
 */
let authReturn = ''

window.addEventListener('focus', () => {
  const id = authReturn
  if (!id) return
  authReturn = ''
  const inPop = state.plugins && state.plugins.id === id
  const inPage = connectorIdOfPath(state.path) === id
  if (!inPop && !inPage) return
  ;(inPop ? loadPluginDetail(id) : loadConnectorDetail(id)).then(render, () => {})
})

/** 弹窗里翻到某个插件的详情。装完之后也走这条——装和管理落到同一屏。 */
async function openPluginDetail(id, opts) {
  if (!id || !state.plugins) return
  Object.assign(state.plugins, { id, error: '' })
  state.pluginDetail = null
  render()
  try {
    // 市场那一份要重取：刚装完，「添加」得变成「管理」，「已安装」那一栏也得有它。
    await Promise.all([loadPluginDetail(id), opts?.reloadMarket ? loadMarket() : null])
  } catch (e) {
    if (state.plugins) state.plugins.error = e.message
  }
  render()
}

/**
 * 详情重取。弹窗和页面各存各的（见 loadPluginDetail），改完账号要刷的是**当前这一份**——
 * 认错了的话，弹窗里断开一把连接，画面上那一行还在。
 */
function refreshConnectorDetail(id) {
  return state.plugins ? loadPluginDetail(id) : loadConnectorDetail(id)
}

// ── 动作 ─────────────────────────────────────────────────────────────

/** 返回 true 表示这一下已经处理掉了，app.js 那条链不用再往下走。 */
async function connectorAct(act, btn) {
  if (act === 'plugins-open') {
    state.plugins = { q: '', tab: 'market', id: '', loading: true, error: '' }
    state.pluginDetail = null
    // 上一屏留下的那条 flash 别跟进弹窗——它说的是别处的事。
    state.error = ''
    state.notice = ''
    // 先画一个空壳再去取：市场那一条要打一次网络，不先画的话点了半天没反应。
    render()
    try {
      await loadMarket()
    } catch (e) {
      if (state.plugins) state.plugins.error = e.message
    }
    if (state.plugins) state.plugins.loading = false
    render()
    return true
  }
  if (act === 'plugins-close') {
    // 底下停的是哪个连接器的详情页。空串 = 停在别处（对话、市场），没什么要补的。
    const behind = connectorIdOfPath(state.path)
    state.plugins = null
    state.pluginDetail = null
    // 弹窗里那条「已保存」也不该留到底下那页去。
    state.error = ''
    state.notice = ''
    // 先关，别让人等一次网络往返。
    render()
    // 弹窗里刚做的改动（断开、卸载、改工具）只落在弹窗那一份上。底下正好是同一个
    // 连接器的详情页时不补这一次，关掉之后那页还列着已经断掉的账号——点它会打到一个
    // 不存在的连接上。取不到就维持原样：这一屏本来就是它自己加载的，没必要为一次
    // 后台刷新弹一句错。
    if (behind) {
      try {
        await loadConnectorDetail(behind)
        render()
      } catch {}
    }
    return true
  }
  if (act === 'plugins-back') {
    if (state.plugins) Object.assign(state.plugins, { id: '', error: '' })
    state.pluginDetail = null
    render()
    return true
  }
  if (act === 'plugins-tab') {
    if (state.plugins) state.plugins.tab = btn.getAttribute('data-tab')
    render()
    return true
  }
  if (act === 'plugins-field') return true
  if (act === 'plugins-detail') {
    if (!state.plugins) return true
    await openPluginDetail(btn.getAttribute('data-id'))
    return true
  }
  if (act === 'conn-price-save') {
    const bad = []
    const defaultMicros = dollarsToMicros(valueOf('price-default', '0'))
    if (defaultMicros === null) bad.push(t('默认单价'))
    const pricing = { defaultMicros: defaultMicros ?? 0, byToolkit: {} }
    for (const c of state.connectors || []) {
      const raw = valueOf(`price-${c.toolkit}`, '')
      // 留空 = 跟默认走，不写这一条。写 0 是「这个连接器免费」，两回事。
      if (raw === '') continue
      const micros = dollarsToMicros(raw)
      // 认不出来的不存。默默按 0 存下去就是一条「免费」的覆盖，而人看到的是「已保存」。
      if (micros === null) bad.push(c.name || c.toolkit)
      else pricing.byToolkit[c.toolkit] = micros
    }
    if (bad.length) {
      flash('err', t('这几项不是合法的价钱，没保存：') + bad.join('、'))
      return true
    }
    try {
      await api('PUT', '/platform/settings', { connectorPricing: pricing })
      await loadSettings()
      flash('ok', t('已保存'))
    } catch (e) {
      flash('err', e.message)
    }
    render()
    return true
  }
  if (act === 'conn-block') {
    const id = btn.getAttribute('data-id')
    const reason = prompt(t('禁用原因（会显示给员工）'), '')
    if (reason === null) return true
    try {
      await api('PUT', `/orgs/${encodeURIComponent(orgId())}/connectors/${encodeURIComponent(id)}/block`, {
        blocked: true,
        reason,
      })
      await loadOrgConnectors()
      flash('ok', t('已禁用'))
    } catch (e) {
      flash('err', e.message)
    }
    render()
    return true
  }
  if (act === 'conn-unblock') {
    const id = btn.getAttribute('data-id')
    try {
      await api('PUT', `/orgs/${encodeURIComponent(orgId())}/connectors/${encodeURIComponent(id)}/block`, { blocked: false })
      await loadOrgConnectors()
      flash('ok', t('已解禁'))
    } catch (e) {
      flash('err', e.message)
    }
    render()
    return true
  }
  if (act === 'conn-install') {
    const id = btn.getAttribute('data-id')
    try {
      await api('POST', `/me/connectors/${encodeURIComponent(id)}/install`)
      // 装完直接进详情：装了还没连的话它什么也干不了，下一步就在那一屏。
      // 弹窗里装的就留在弹窗里——跳走一整页，对话那边的草稿和滚动位置都没了。
      if (state.plugins) await openPluginDetail(id, { reloadMarket: true })
      else go(`/connectors/${encodeURIComponent(id)}`)
    } catch (e) {
      if (state.plugins) {
        state.plugins.error = e.message
        render()
      } else {
        flash('err', e.message)
        render()
      }
    }
    return true
  }
  if (act === 'conn-uninstall') {
    const id = btn.getAttribute('data-id')
    if (!confirm(t('卸载会把你在它下面连的所有账号一起断掉。继续？'))) return true
    try {
      await api('DELETE', `/me/connectors/${encodeURIComponent(id)}/install`)
      if (state.plugins) {
        Object.assign(state.plugins, { id: '', error: '' })
        state.pluginDetail = null
        await loadMarket()
        render()
      } else go('/connectors')
    } catch (e) {
      if (state.plugins) state.plugins.error = e.message
      else flash('err', e.message)
      render()
    }
    return true
  }
  if (act === 'conn-add-account') {
    const id = btn.getAttribute('data-id')
    const label = valueOf('conn-label', '')
    /**
     * 授权开**新标签页**，不把这一页顶掉。
     *
     * 整页跳走的代价在插件弹窗上尤其重：回来时对话的草稿、滚动位置、刚选好的那颗 Bot
     * 全没了，而人只是想加一个邮箱。开新页之后这一边原封不动，授权完关掉那页就行。
     *
     * **标签页要在点击这一下里就开出来。** 地址得先向后端要（那一趟才生成 OAuth 链接），
     * 而 `await` 之后浏览器已经不认这是用户点出来的动作了，`window.open` 会被拦掉——
     * 所以先开一个空页占住手势，拿到地址再把它送过去。
     *
     * 不用 `noopener` 这个 feature：带上它 `window.open` 直接返回 null，就没有句柄可以
     * 送地址了。改成拿到句柄后手动断开 `opener`，防的是同一件事（反向标签劫持）。
     */
    let tab = null
    try {
      tab = window.open('', '_blank')
      if (tab) tab.opener = null
    } catch {
      tab = null
    }
    try {
      const r = await api('POST', `/me/connectors/${encodeURIComponent(id)}/connections`, label ? { label } : {})
      // 被拦截器挡下来（tab 是 null）就还是整页跳走：把人卡在原地、什么都不发生，
      // 比换一页更糟——那时他只会以为按钮坏了。
      if (tab && !tab.closed) {
        authReturn = id
        tab.location.href = r.redirectUrl
      } else {
        location.href = r.redirectUrl
      }
    } catch (e) {
      // 开都没开成，那页空白着没有意义。
      if (tab && !tab.closed) tab.close()
      if (state.plugins) state.plugins.error = e.message
      else flash('err', e.message)
      render()
    }
    return true
  }
  if (act === 'conn-disconnect') {
    const id = btn.getAttribute('data-id')
    const connectorId = btn.getAttribute('data-connector')
    if (!confirm(t('断开这个账号？'))) return true
    try {
      await api('DELETE', `/me/connectors/${encodeURIComponent(connectorId)}/connections/${encodeURIComponent(id)}`)
      await refreshConnectorDetail(connectorId)
      flash('ok', t('已断开'))
    } catch (e) {
      flash('err', e.message)
    }
    render()
    return true
  }
  if (act === 'conn-mention-only') {
    const id = btn.getAttribute('data-id')
    const connectorId = btn.getAttribute('data-connector')
    // checkbox 的 click 在状态**已经翻过来之后**才到，所以直接读它现在的值。
    const on = btn.checked === true
    try {
      await api('PATCH', `/me/connectors/${encodeURIComponent(connectorId)}/connections/${encodeURIComponent(id)}`, { mentionOnly: on })
      await refreshConnectorDetail(connectorId)
    } catch (e) {
      flash('err', e.message)
    }
    render()
    return true
  }
  if (act === 'conn-tool') return true
  if (act === 'conn-tools-save') {
    const connectorId = btn.getAttribute('data-connector')
    const boxes = [...connRoot().querySelectorAll('[data-act="conn-tool"]')]
    const all = boxes.length && boxes.every((b) => b.checked)
    // 全勾上 = 空数组（后端口径：空 = 全开）。存一份「当前全部工具」的快照，
    // 供应商下次加了新工具就永远进不来了——那不是用户勾的意思。
    const enabledTools = all ? [] : boxes.filter((b) => b.checked).map((b) => b.getAttribute('data-tool'))
    try {
      await api('PUT', `/me/connectors/${encodeURIComponent(connectorId)}/tools`, { enabledTools })
      await refreshConnectorDetail(connectorId)
      flash('ok', t('已保存'))
    } catch (e) {
      flash('err', e.message)
    }
    render()
    return true
  }
  if (act === 'conn-vendor-save') {
    const form = document.querySelector('[data-form="connector-vendor"]')
    const secret = form ? String(new FormData(form).get('secret') || '').trim() : ''
    if (!secret) {
      flash('err', t('密钥不能为空'))
      render()
      return true
    }
    try {
      await api('PUT', '/platform/connector-vendors/composio', { secret })
      await loadConnectorVendors()
      flash('ok', t('已保存'))
    } catch (e) {
      flash('err', e.message)
    }
    render()
    return true
  }
  if (act === 'conn-vendor-ping') {
    state.tests['connector:composio'] = { status: 'busy' }
    render()
    try {
      const r = await api('POST', '/platform/connector-vendors/composio/ping')
      state.tests['connector:composio'] = r.ok ? { status: 'ok', text: t('通') } : { status: 'err', text: r.error }
    } catch (e) {
      state.tests['connector:composio'] = { status: 'err', text: e.message }
    }
    render()
    return true
  }
  if (act === 'conn-publish-open') {
    state.connectorDraft = { toolkit: '', authConfigId: '', q: '', error: '' }
    render()
    // 清单现拉：owner 上架是低频动作，缓存它只会让「刚在 Composio 那边加的东西看不见」。
    try {
      await loadConnectorToolkits()
    } catch (e) {
      if (state.connectorDraft) state.connectorDraft.error = e.message
    }
    render()
    return true
  }
  if (act === 'conn-close') {
    state.connectorDraft = null
    render()
    return true
  }
  if (act === 'conn-pick') {
    if (!state.connectorDraft) return true
    state.connectorDraft.toolkit = btn.getAttribute('data-toolkit')
    render()
    return true
  }
  if (act === 'conn-field') return true
  if (act === 'conn-publish') {
    const draft = state.connectorDraft
    if (!draft?.toolkit) return true
    const tk = (state.connectorToolkits || []).find((x) => x.slug === draft.toolkit)
    try {
      await api('POST', '/platform/connectors', {
        vendor: 'composio',
        toolkit: draft.toolkit,
        name: tk?.name || draft.toolkit,
        description: tk?.description || '',
        logo: tk?.logo || '',
        category: tk?.categories?.[0] || '',
        authConfigId: draft.authConfigId,
      })
      state.connectorDraft = null
      await loadConnectors()
      flash('ok', t('已上架'))
    } catch (e) {
      draft.error = e.message
    }
    render()
    return true
  }
  if (act === 'conn-edit') {
    const c = (state.connectors || []).find((x) => x.id === btn.getAttribute('data-id'))
    if (!c) return true
    state.connectorEdit = { ...c, authConfigId: '', error: '' }
    render()
    return true
  }
  if (act === 'conn-edit-close') {
    state.connectorEdit = null
    render()
    return true
  }
  if (act === 'conn-edit-save') {
    const edit = state.connectorEdit
    if (!edit) return true
    const body = {
      name: valueOf('conn-edit-name', edit.name),
      description: valueOf('conn-edit-desc', edit.description || ''),
      enabled: document.querySelector('[data-input="conn-edit-enabled"]')?.checked !== false,
    }
    // 留空 = 不改。已经配好的 auth config 不该因为「打开弹窗又保存」被清掉。
    const auth = valueOf('conn-edit-auth', '')
    if (auth) body.authConfigId = auth
    // 这一格不一样：留空**就是**「不挑，装上全开」，所以照原样提交，不能当成「不改」。
    body.recommendedTools = valueOf('conn-edit-recommended', '')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
    try {
      await api('PATCH', `/platform/connectors/${encodeURIComponent(edit.id)}`, body)
      state.connectorEdit = null
      await loadConnectors()
      flash('ok', t('已保存'))
    } catch (e) {
      edit.error = e.message
    }
    render()
    return true
  }
  if (act === 'conn-unpublish') {
    const id = btn.getAttribute('data-id')
    const c = (state.connectors || []).find((x) => x.id === id)
    if (!confirm(t(`下架「${c?.name || id}」？已经装了它的员工会立刻失去这些工具。`))) return true
    try {
      await api('DELETE', `/platform/connectors/${encodeURIComponent(id)}`)
      await loadConnectors()
      flash('ok', t('已下架'))
    } catch (e) {
      flash('err', e.message)
    }
    render()
    return true
  }
  return false
}

/** 弹窗里的输入框现读现取——它们不受控，render() 一来就会被换掉。 */
function valueOf(name, fallback) {
  const el = connRoot().querySelector(`[data-input="${name}"]`)
  return el ? String(el.value || '').trim() : fallback
}

/** 美元 → 微元。界面上填的是美元，存的是整数微元，只在这一处换算。 */
/**
 * 一个美元数 → micros。**认不出来的返回 null，不是 0。**
 *
 * 返回 0 是有含义的（「这个连接器免费」），而 `Number('0,05')` 是 NaN——把它折成 0
 * 等于把一次手滑存成一条「免费」的价格覆盖，界面上还回一句「已保存」。调用方看到
 * null 就该拦下来让人改，不该替他决定。
 */
function dollarsToMicros(v) {
  const raw = String(v ?? '').trim()
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 1000000)
}
