/**
 * 连接器：owner 的上架屏、admin 的禁用屏，以及员工插件页（pages-plugins.js）用的零件和动作。
 *
 * 三样东西分得很清（docs/connectors.md §4）：**上架**（owner 决定市场里有什么）、
 * **安装**（员工自己装）、**连接**（员工授权自己的账号）。上架在这里；安装和连接的
 * 画面在 /plugins，按钮的动作（conn-install、conn-add-open、startAddAccount……）仍在本文件底部。
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
 * 「添加账号」那一行：只有一颗按钮，账号名在弹窗里填（pages-plugins.js 的 connAddModal）。
 *
 * 以前是一格输入框挨着按钮摆在账号列表底下：不填也能点，填了也看不出它会进工具名，
 * 而授权要开新标签页这件事要到点下去才知道。挪进弹窗之后这三件事能一次说清。
 */
function addAccountRow(id) {
  return `<div style="padding: var(--space-3) 0;">
      <button type="button" class="btn btn-secondary" data-act="conn-add-open" data-id="${esc(id)}">${svg(PLUS_ICON, 14)} ${t('添加账号')}</button>
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
            ${rows || emptyBox(ready ? t('还没上架任何连接器。点右上角从 Composio 的清单里选一个。') : t('先配好 Composio 密钥，才能拉到可上架的清单。'))}
          </div>
        </div>
      </div>
      ${connectorPublishModal()}
      ${connectorEditModal()}
    </div>`
}

// ── 员工：一个连接器的零件（插件页用，见 pages-plugins.js）──────────

/**
 * 「可用 Bot」收起时那颗按钮上的字（docs/connector-bot-scope.md）。名单里的 Bot 全被删了时
 * 是红字「没有 Bot 可用」——后端那时谁都不给，不是回到全部，界面要照实说。
 */
function connBotsSummary(c, bots) {
  const s = c.bots
  if (!s || s.mode !== 'bots') return { text: t('所有 Bot', 'All bots'), warn: false }
  const n = s.botIds.length
  if (!n) return { text: t('没有 Bot 可用', 'No bots'), warn: true }
  if (n === 1) {
    const b = bots.find((x) => x.id === s.botIds[0])
    return { text: b ? b.name : t('1 个 Bot', '1 bot'), warn: false }
  }
  return { text: t(`${n} 个 Bot`, `${n} bots`), warn: false }
}

/**
 * 展开之后那一块：两档单选，选「指定 Bot」时下面是名单。
 *
 * 单选和勾选**只动 DOM、不 render**（见 connectorAct 的 conn-bots-mode / conn-bots-pick）：
 * 没保存的选择只在 DOM 里，整页重画会把它们抹掉。保存时从这一块里读。
 */
function connBotsPanel(c, connectorId, bots) {
  const s = c.bots || { mode: 'all', botIds: [], missing: 0 }
  const some = s.mode === 'bots'
  const picked = new Set(s.botIds || [])
  const name = `conn-bots-mode-${c.id}`
  const rows = bots.length
    ? bots
        .map(
          (b) => `<label style="display: flex; align-items: center; gap: var(--space-2); padding: 4px 0; font-size: 13px;">
          <input type="checkbox" data-act="conn-bots-pick" data-bot="${esc(b.id)}" ${picked.has(b.id) ? 'checked' : ''}>
          <span style="flex: none; display: inline-flex;">${botAvatar(b.icon, 18, b.origin)}</span>
          <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(b.name)}</span>
        </label>`,
        )
        .join('')
    : `<div style="font-size: 13px; color: var(--muted-foreground);">${t('你还没有 Bot。', 'You have no bots yet.')}</div>`
  return `<div data-conn-bots="${esc(c.id)}" style="flex-basis: 100%; min-width: 0; display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius);">
    <label style="display: flex; align-items: center; gap: var(--space-2); font-size: 13px;">
      <input type="radio" name="${esc(name)}" value="all" data-act="conn-bots-mode" ${some ? '' : 'checked'}>
      ${t('所有 Bot（以后新建的也算）', 'All bots (including ones you create later)')}
    </label>
    <label style="display: flex; align-items: center; gap: var(--space-2); font-size: 13px;">
      <input type="radio" name="${esc(name)}" value="bots" data-act="conn-bots-mode" ${some ? 'checked' : ''}>
      ${t('指定 Bot', 'Only these bots')}
    </label>
    <div data-conn-bots-list ${some ? '' : 'hidden'} style="padding-left: var(--space-5); max-height: 240px; overflow: auto;">${rows}</div>
    ${
      some && s.missing
        ? `<div style="font-size: 12px; color: var(--color-accent-800);">${t(
            `之前选的 Bot 里有 ${s.missing} 个已经删掉了。`,
            `${s.missing} of the bots picked before have been deleted.`,
          )}</div>`
        : ''
    }
    <div style="font-size: 12px; color: var(--muted-foreground);">${t(
      '没勾上的 Bot 看不到这个账号的工具，也不能 @ 它。选「指定 Bot」时，以后新建的 Bot 不会自动加进来。保存后 Bot 一分钟内生效。',
      'Bots left unchecked cannot see this account’s tools or @ it. With “Only these bots”, bots you create later are not added automatically. Bots pick up the change within a minute.',
    )}</div>
    <div data-conn-bots-err hidden style="font-size: 12px; color: var(--color-accent-800);"></div>
    <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
      <button type="button" class="btn btn-ghost" data-act="conn-bots-close">${t('取消')}</button>
      <button type="button" class="btn btn-primary" data-act="conn-bots-save" data-id="${esc(c.id)}" data-connector="${esc(connectorId)}"
        ${some && !picked.size ? 'disabled' : ''}>${t('保存')}</button>
    </div>
  </div>`
}

/** 这把连接那一行的 DOM 节点。不用 CSS.escape：id 是 uuid，但别赌它。 */
function connRowEl(id) {
  return [...document.querySelectorAll('[data-conn-row]')].find((el) => el.getAttribute('data-conn-row') === id) || null
}

/**
 * 收起所有展开着的「可用 Bot」，**就地摘节点，不 render**：同一屏「选择工具」里没保存的勾选
 * 只在 DOM 里（见 pages-plugins.js 的 toolBoxes），整页重画会把它们一起抹掉。
 */
function closeConnBots() {
  state.connBotsOpen = null
  for (const el of document.querySelectorAll('[data-conn-bots]')) el.remove()
  for (const b of document.querySelectorAll('[data-act="conn-bots-open"]')) b.setAttribute('aria-expanded', 'false')
}

/** 展开着的那一块里，「保存」该不该能按：选了「指定 Bot」却一个没勾时不能。 */
function paintConnBotsSave(panel) {
  if (!panel) return
  const some = panel.querySelector('[data-act="conn-bots-mode"][value="bots"]')?.checked === true
  const list = panel.querySelector('[data-conn-bots-list]')
  if (list) list.hidden = !some
  const n = [...panel.querySelectorAll('[data-act="conn-bots-pick"]')].filter((x) => x.checked).length
  const save = panel.querySelector('[data-act="conn-bots-save"]')
  if (save) save.disabled = some && n === 0
}

/** 一把连接一行：名字、状态、「仅 @ 时可用」、「可用 Bot」、断开。 */
function connectionRow(c, connectorId) {
  const status =
    c.status === 'active'
      ? `<span style="font-size: 13px; color: var(--color-accent-2-800);">${t('已连接')}</span>`
      : c.status === 'pending'
        ? `<span style="font-size: 13px; color: var(--muted-foreground);">${t('未完成')}</span>`
        : `<span style="font-size: 13px; color: var(--color-accent-800);">${esc(c.error || t('失败'))}</span>`
  const company = c.scope === 'company'
  /**
   * 「可用 Bot」：这把账号哪些 Bot 用得上。公司共用那把也有这一格——别的按钮它都没有，
   * 但范围是每个人给自己的 Bot 设的，和那一行连接本身无关。
   */
  const bots = state.connectorDetail?.bots || []
  const open = state.connBotsOpen === c.id
  const sum = connBotsSummary(c, bots)
  const botsBtn = `<button type="button" class="satu-linkbtn" data-act="conn-bots-open" data-id="${esc(c.id)}" aria-expanded="${open}"
      title="${esc(t('哪些 Bot 用得上这个账号', 'Which bots can use this account'))}"
      style="font-size: 12px;${sum.warn ? ' color: var(--color-accent-800);' : ''}">${t('可用 Bot', 'Bots')}：${esc(sum.text)}</button>`
  return `<div data-conn-row="${esc(c.id)}" style="display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); padding: var(--space-3) 0; border-bottom: 1px solid var(--border);">
    <div style="min-width: 0; flex: 1; display: flex; align-items: center; gap: var(--space-2);">
      <span style="font-size: 14px; font-weight: 600; flex: none;">${esc(c.label)}</span>
      ${/* 供应商认出来的账号（邮箱、登录名）。账号名是人自己起的，连了两个 Gmail 时只有
            这一格分得清哪个是哪个。认不出就不画，不写「未知」。 */ ''}
      ${c.accountName ? `<span class="satu-connwho" title="${esc(c.accountName)}">${esc(c.accountName)}</span>` : ''}
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
    ${botsBtn}
    ${company ? '' : `<button type="button" class="satu-linkbtn" data-act="conn-disconnect" data-id="${esc(c.id)}" data-connector="${esc(connectorId)}">${t('断开')}</button>`}
    ${open ? connBotsPanel(c, connectorId, bots) : ''}
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
      (tool) => `<label data-tool-row style="display: flex; align-items: flex-start; gap: var(--space-2); padding: 6px 0; font-size: 13px;">
      <input type="checkbox" data-act="conn-tool" data-tool="${esc(tool.slug)}" ${all || enabled.has(tool.slug) ? 'checked' : ''}>
      <span style="min-width: 0;">
        <span style="font-family: var(--font-mono, monospace); font-size: 12px;">${esc(tool.slug)}</span>
        ${tool.description ? `<span style="display: block; color: var(--muted-foreground);">${esc(tool.description)}</span>` : ''}
      </span>
    </label>`,
    )
    .join('')
  // 筛选和全开全关只动 DOM，不 render——见 pages-plugins.js 的 toolBoxes。
  return `<div>
    <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-2);">
      <span id="conn-tools-count" style="flex: 1; min-width: 120px; font-size: 13px; color: var(--muted-foreground);">${t(`${on} / ${tools.length} 个已开启`)}</span>
      ${
        tools.length > 8
          ? `<input class="input" type="search" style="width: 200px; max-width: 100%;" data-act="conn-tool-q"
              placeholder="${esc(t('筛选工具', 'Filter tools'))}" aria-label="${esc(t('筛选工具', 'Filter tools'))}">`
          : ''
      }
      <button type="button" class="btn btn-ghost" data-act="conn-tools-all" data-on="1" title="${esc(t('只动筛出来的那些', 'Only the filtered ones'))}">${t('全开', 'All on')}</button>
      <button type="button" class="btn btn-ghost" data-act="conn-tools-all" data-on="0" title="${esc(t('只动筛出来的那些', 'Only the filtered ones'))}">${t('全关', 'All off')}</button>
      <button type="button" class="btn btn-primary" data-act="conn-tools-save" data-connector="${esc(detail.connector.id)}">${t('保存')}</button>
    </div>
    ${toolModeNote(detail, on, cap)}
    <div style="max-height: 420px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-1) var(--space-3);">${rows}</div>
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

// ── 公司管理员：禁用、谁装了什么、花了多少 ───────────────────────────

function adminConnectorsPage() {
  const list = state.orgConnectors || []
  const stats = state.connectorStats
  const blocked = list.filter((c) => c.blocked).length
  const rows = list.map((c) => connectorRow(c,
    `${esc(c.toolkit)}${c.blocked && c.blockedReason ? ` · ${esc(c.blockedReason)}` : ''}`,
    `<span class="mg-connector-usage">${t(`${c.installs} 人安装`, `${c.installs} installed`)}</span>
    <span class="tag ${c.blocked ? 'tag-neutral' : 'mg-status-ok'}">${c.blocked ? t('已禁用', 'Blocked') : t(`${c.connections} 个连接`, `${c.connections} connections`)}</span>
    <div class="satu-rowactions"><button type="button" class="btn btn-ghost" data-act="${c.blocked ? 'conn-unblock' : 'conn-block'}" data-id="${esc(c.id)}">${c.blocked ? t('解禁') : t('禁用')}</button></div>`
  )).join('')
  const who = (stats?.installs || []).map((x) => `<div class="mg-install-row"><span>${esc(x.accountName)}</span><span class="mg-help">${esc(x.name || x.connector)}</span></div>`).join('')
  return `<div class="gw-page"><div class="gw-page-inner">
    ${pageHead(t('连接器'), t('管理公司可用的外部服务，查看员工连接情况与调用费用。', 'Manage external services available to your company and review connections and usage costs.'))}
    ${flashes()}
    ${managementStats([
      { label: t('可用连接器', 'Available connectors'), value: list.length - blocked, note: t(`${blocked} 个已禁用`, `${blocked} blocked`) },
      { label: t('已连接账号', 'Connected accounts'), value: list.reduce((sum, c) => sum + (Number(c.connections) || 0), 0), note: t('由员工自行授权', 'Authorized individually by members') },
      { label: t('调用次数'), value: stats ? stats.total.calls : '—' },
      { label: t('调用费用', 'Usage cost'), value: stats ? `$${(stats.total.amount ?? 0).toFixed(4)}` : '—' },
    ])}
    <div class="mg-sectionhead"><h2>${t('服务访问', 'Service access')}</h2><span class="mg-help">${t('禁用后，公司成员将无法使用该连接器。', 'Blocked connectors are unavailable to company members.')}</span></div>
    <div class="mg-table mg-connector-table"><div class="satu-provhead"><span>${t('连接器')}</span><span>${t('安装情况', 'Installed')}</span><span>${t('状态')}</span><span></span></div>${rows || emptyBox(t('平台还没上架任何连接器。'))}</div>
    <section class="satu-panel"><div class="mg-sectionhead"><div><h2>${t('员工安装记录', 'Member installations')}</h2><p>${t('员工自行安装并授权，这里展示公司内的使用情况。', 'Members install and authorize their accounts individually.')}</p></div></div>${who || emptyBox(t('还没有员工安装连接器。', 'No member installations yet.'))}</section>
  </div></div>`
}

function connectorsPage() {
  if (isOwner()) return ownerConnectorsPage()
  // 管理员管的是禁令和账，不是自己的账号；他要装连接器走的是同一个市场，但那是员工身份
  // 的事，两屏分开——混在一起的话「本公司谁装了什么」会被自己的安装卡片挤到底下。
  // 员工那一份市场搬去了 /plugins（data.js 的 loadPage 会把他从 /connectors 折过去），
  // 这里兜底照画插件页，别让一次没折过去的渲染变成白屏。
  return isAdmin() ? adminConnectorsPage() : pluginsPage()
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
  if (pluginIdOfPath(state.path) !== id) return
  // 那个「等你授权」的弹窗到这儿就完成使命了：新账号（或者一行「未完成」）就在底下。
  if (state.connAdd?.phase === 'waiting') state.connAdd = null
  loadConnectorDetail(id).then(render, () => {})
})

/**
 * 发起授权：向后端要 OAuth 地址，在新标签页里打开。
 *
 * 弹窗那张表单的 submit 走这里（app.js 的 submit 分流 → submitConnAdd）。
 *
 * **标签页要在这一下手势里就开出来。** 地址得先向后端要（那一趟才生成 OAuth 链接），
 * 而 `await` 之后浏览器已经不认这是用户点出来的动作了，`window.open` 会被拦掉——
 * 所以先开一个空页占住手势，拿到地址再把它送过去。调用方不能在这之前 await 任何东西。
 *
 * 不用 `noopener` 这个 feature：带上它 `window.open` 直接返回 null，就没有句柄可以
 * 送地址了。改成拿到句柄后手动断开 `opener`，防的是同一件事（反向标签劫持）。
 *
 * **桌面端不开空页。** 壳把 `window.open` 换成了「地址交给系统浏览器、返回 null」
 * （desktop/src-tauri/src/nav.rs 的 LINK_SCRIPT），没有句柄可拿，也没有手势要占：
 * 拿到地址再 `window.open` 一次，照样进「等你授权」。以前这里落进整页跳转那条兜底，
 * 跳转被壳拦下送进浏览器、窗口原地不动，按钮就一直停在「打开中…」。
 */
async function startAddAccount(id, label) {
  const desktop = Boolean(window.__SATUWORK_DESKTOP__)
  let tab = null
  if (!desktop) {
    try {
      tab = window.open('', '_blank')
      if (tab) tab.opener = null
    } catch {
      tab = null
    }
  }
  if (state.connAdd) Object.assign(state.connAdd, { error: '', busy: true })
  render()
  try {
    const r = await api('POST', `/me/connectors/${encodeURIComponent(id)}/connections`, label ? { label } : {})
    // 被拦截器挡下来（tab 是 null）就还是整页跳走：把人卡在原地、什么都不发生，
    // 比换一页更糟——那时他只会以为按钮坏了。
    if (desktop || (tab && !tab.closed)) {
      authReturn = id
      if (desktop) window.open(r.redirectUrl, '_blank')
      else tab.location.href = r.redirectUrl
      if (state.connAdd) Object.assign(state.connAdd, { phase: 'waiting', busy: false })
      // 新建的那一行（pending）先画出来：人回来时看得见「未完成」，而不是什么都没有。
      await loadConnectorDetail(id).catch(() => {})
    } else {
      location.href = r.redirectUrl
      return
    }
  } catch (e) {
    // 开都没开成，那页空白着没有意义。
    if (tab && !tab.closed) tab.close()
    if (state.connAdd) Object.assign(state.connAdd, { error: e.message, busy: false })
    else flash('err', e.message)
  }
  render()
}

function submitConnAdd(e) {
  e.preventDefault()
  const id = e.target.getAttribute('data-id') || state.connAdd?.id || ''
  if (!id || state.connAdd?.busy) return
  void startAddAccount(id, valueOf('conn-label', '').toLowerCase())
}

// ── 动作 ─────────────────────────────────────────────────────────────

/** 返回 true 表示这一下已经处理掉了，app.js 那条链不用再往下走。 */
async function connectorAct(act, btn) {
  // 插件页的搜索框和分组：只重画正文那一块（见 pages-plugins.js 的 pluginsBody）。
  if (act === 'plugins-q' || act === 'conn-tool-q') return true
  if (act === 'plugins-cat') {
    state.pluginCat = btn.getAttribute('data-cat') || ''
    paintPluginsBody()
    return true
  }
  if (act === 'conn-tools-all') {
    setVisibleTools(btn.getAttribute('data-on') === '1')
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
      const to = pluginHref(id)
      if (state.path === to) {
        // 从「没装」的详情页上点的：人已经在这一屏了，原地刷新就好。
        await loadConnectorDetail(id)
        render()
      } else {
        go(to)
      }
    } catch (e) {
      flash('err', e.message)
      render()
    }
    return true
  }
  if (act === 'conn-uninstall') {
    const id = btn.getAttribute('data-id')
    if (!confirm(t('卸载会把你在它下面连的所有账号一起断掉。继续？'))) return true
    try {
      await api('DELETE', `/me/connectors/${encodeURIComponent(id)}/install`)
      go('/plugins')
      flash('ok', t('已卸载', 'Removed'))
    } catch (e) {
      flash('err', e.message)
      render()
    }
    return true
  }
  if (act === 'conn-add-open') {
    const id = btn.getAttribute('data-id')
    const c = state.connectorDetail?.connector
    state.connAdd = { id, name: c && c.id === id ? c.name : '', phase: 'form', error: '' }
    render()
    document.getElementById('conn-label')?.focus()
    return true
  }
  if (act === 'conn-add-close') {
    state.connAdd = null
    render()
    return true
  }
  if (act === 'conn-add-done') {
    // 「我已完成授权」：不等回到这一页的 focus（同一个窗口里切标签页不一定触发）。
    const id = state.connAdd?.id || ''
    authReturn = ''
    state.connAdd = null
    if (id) await loadConnectorDetail(id).catch(() => {})
    render()
    return true
  }
  if (act === 'conn-disconnect') {
    const id = btn.getAttribute('data-id')
    const connectorId = btn.getAttribute('data-connector')
    if (!confirm(t('断开这个账号？'))) return true
    try {
      await api('DELETE', `/me/connectors/${encodeURIComponent(connectorId)}/connections/${encodeURIComponent(id)}`)
      await loadConnectorDetail(connectorId)
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
      await loadConnectorDetail(connectorId)
    } catch (e) {
      flash('err', e.message)
    }
    render()
    return true
  }
  if (act === 'conn-bots-open') {
    const id = btn.getAttribute('data-id')
    const was = state.connBotsOpen
    closeConnBots()
    if (was === id) return true
    const detail = state.connectorDetail
    const c = (detail?.connections || []).find((x) => x.id === id)
    const row = connRowEl(id)
    if (!c || !row) return true
    state.connBotsOpen = id
    row.insertAdjacentHTML('beforeend', connBotsPanel(c, detail.connector.id, detail.bots || []))
    btn.setAttribute('aria-expanded', 'true')
    return true
  }
  if (act === 'conn-bots-close') {
    closeConnBots()
    return true
  }
  if (act === 'conn-bots-mode' || act === 'conn-bots-pick') {
    // 单选 / 复选的 click 到的时候状态已经翻过来了。只动这一块的 DOM，不 render。
    paintConnBotsSave(btn.closest('[data-conn-bots]'))
    return true
  }
  if (act === 'conn-bots-save') {
    const id = btn.getAttribute('data-id')
    const connectorId = btn.getAttribute('data-connector')
    const panel = btn.closest('[data-conn-bots]')
    const some = panel?.querySelector('[data-act="conn-bots-mode"][value="bots"]')?.checked === true
    const botIds = some
      ? [...panel.querySelectorAll('[data-act="conn-bots-pick"]')].filter((x) => x.checked).map((x) => x.getAttribute('data-bot'))
      : []
    if (some && !botIds.length) return true
    const err = panel?.querySelector('[data-conn-bots-err]')
    btn.disabled = true
    try {
      await api(
        'PUT',
        `/me/connectors/${encodeURIComponent(connectorId)}/connections/${encodeURIComponent(id)}/bots`,
        some ? { mode: 'bots', botIds } : { mode: 'all' },
      )
      await loadConnectorDetail(connectorId)
    } catch (e) {
      // 错就写在这一块里，不 render：重画会把人刚勾的那些按存着的值重置掉，还得重勾一遍。
      if (err) {
        err.textContent = errText(e.message)
        err.hidden = false
      }
      btn.disabled = false
      return true
    }
    // 只换这一行：按钮上的字就是「存上了」的回执。整页重画会抹掉「选择工具」里没保存的勾选。
    closeConnBots()
    const c = (state.connectorDetail?.connections || []).find((x) => x.id === id)
    const row = connRowEl(id)
    if (c && row) row.outerHTML = connectionRow(c, connectorId)
    else render()
    return true
  }
  if (act === 'conn-tool') {
    // 复选框的 click 到的时候状态已经翻过来了，数一下就是新的。
    paintToolCount()
    return true
  }
  if (act === 'conn-tools-save') {
    const connectorId = btn.getAttribute('data-connector')
    const boxes = toolBoxes()
    const all = boxes.length && boxes.every((b) => b.checked)
    // 全勾上 = 空数组（后端口径：空 = 全开）。存一份「当前全部工具」的快照，
    // 供应商下次加了新工具就永远进不来了——那不是用户勾的意思。
    const enabledTools = all ? [] : boxes.filter((b) => b.checked).map((b) => b.getAttribute('data-tool'))
    try {
      await api('PUT', `/me/connectors/${encodeURIComponent(connectorId)}/tools`, { enabledTools })
      await loadConnectorDetail(connectorId)
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

/** 输入框现读现取——它们不受控，render() 一来就会被换掉。 */
function valueOf(name, fallback) {
  const el = document.querySelector(`[data-input="${name}"]`)
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
