/**
 * 插件：员工自己的那一份连接器（`/plugins`、`/plugins/:id`）。
 *
 * 「插件」= 员工视角的连接器，和 pages-connectors.js 里 owner 的上架屏、admin 的禁用屏
 * 是同一批东西。零件（connectorLogo / connectionRow / addAccountRow / connectorToolsBox）
 * 和动作（connectorAct 里的 conn-*）都在那边，这里只管两屏怎么摆。
 *
 * **为什么从弹窗改成页面。** 弹窗当初的理由是「跳走一整页，回来时草稿没了」——可授权
 * 早就改在新标签页里做了（见 pages-connectors.js 的 startAddAccount），装插件本身不再把人从对话里带走。而弹窗
 * 里要塞的是三层：清单 → 详情 → 动辄几百个工具的开关，挤在 88vh 里互相抢滚动条；返回键、
 * 刷新、深链也都不认它。改成和「渠道」「知识库」并排的内置页之后，这些都是现成的。
 *
 * **这一屏回答两个问题，按这个顺序：**
 * 1. 我装了的那几个，现在能不能用？——装了但没连账号的，Bot 一个工具也拿不到，却和连好的
 *    长得一模一样。所以「已安装」排在最上面，没连上的标出来、排在前面、按钮直接写「去连接」。
 * 2. 还能装什么？——市场排在下面，按分组收拢，分组多时给一排筛选。
 */

// ── 清单 ─────────────────────────────────────────────────────────────

function pluginHref(id) {
  return `/plugins/${encodeURIComponent(id)}`
}

function pluginsPage() {
  return `<div class="gw-page">
    <div class="gw-page-inner satu-plugpage">
      <div class="satu-plughead">
        <div style="min-width: 0;">
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('插件', 'Plugins')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t(
            '装上并连好账号之后，你名下的每一个 Bot 都能用——不用为每个 Bot 各连一次。',
            'Add a plugin and connect your account once — every bot you own can use it.',
          )}</p>
        </div>
        <input class="input satu-plugsearch" type="search" data-act="plugins-q" value="${esc(state.pluginQ || '')}"
          placeholder="${esc(t('搜索插件', 'Search plugins'))}" aria-label="${esc(t('搜索插件', 'Search plugins'))}">
      </div>
      ${flashes()}
      <div id="plugins-body" class="satu-plugbody">${pluginsBody()}</div>
    </div>
  </div>`
}

/**
 * 正文**单独一个函数**：搜索框边打边过滤、点分组筛选时只重画这一块。整页 render()
 * 会把输入框换掉，正在打字的人立刻丢焦点。
 */
function pluginsBody() {
  const all = state.market
  if (!all) return emptyBox(t('加载中…'))
  if (!all.length) return emptyBox(t('平台还没上架任何插件。', 'No plugins are available yet.'))
  const q = (state.pluginQ || '').trim().toLowerCase()
  const hit = (c) => !q || `${c.name} ${c.toolkit} ${c.description || ''} ${c.category || ''}`.toLowerCase().includes(q)
  const mine = all.filter((c) => c.installed && hit(c))
  const rest = all.filter((c) => !c.installed && hit(c))
  if (q && !mine.length && !rest.length) return emptyBox(t('没有匹配的插件', 'No plugins match that'))
  return pluginsMine(mine, q) + pluginsMarket(rest, q)
}

function paintPluginsBody() {
  const box = document.getElementById('plugins-body')
  if (box) box.innerHTML = pluginsBody()
}

function pluginsSectionHead(title, n) {
  return `<div class="satu-plughdr"><h2>${esc(title)}</h2><span>${n}</span></div>`
}

function pluginsMine(mine, q) {
  const head = pluginsSectionHead(t('已安装', 'Installed'), mine.length)
  if (!mine.length) {
    // 搜索时没中就整段不出：一行「还没装」会被读成「你搜的那个没装」。
    if (q) return ''
    return `<section>${head}<div class="satu-plugempty">${t(
      '还没装插件。在下面挑一个，装上之后连上你的账号，Bot 就能替你操作它。',
      'No plugins yet. Pick one below, connect your account, and your bots can work with it.',
    )}</div></section>`
  }
  // 装了却没连上的排前面：那几个是「以为能用、其实用不了」的，最该被看见。被禁的沉底。
  const rank = (c) => (c.blocked ? 2 : c.connected ? 1 : 0)
  const rows = [...mine].sort((a, b) => rank(a) - rank(b))
  return `<section>${head}<div class="satu-pluggrid">${rows.map(pluginMineCard).join('')}</div></section>`
}

function pluginMineCard(c) {
  const todo = !c.connected && !c.blocked
  const stat = c.blocked
    ? `<span class="satu-plugstate">${t('本公司已禁用', 'Disabled by your company')}</span>`
    : c.connected
      ? `<span class="satu-plugstate is-on">${t('已连接', 'Connected')}</span>`
      : `<span class="satu-plugstate is-warn">${t('还没连账号', 'No account connected')}</span>`
  return `<div class="satu-plugcard${c.blocked ? ' is-blocked' : ''}">
    <button type="button" class="satu-plugmain" data-act="go" data-href="${esc(pluginHref(c.id))}">
      ${connectorLogo(c)}
      <span class="satu-plugmeta">
        <span class="satu-plugname">${esc(c.name)}</span>
        ${stat}
      </span>
    </button>
    <button type="button" class="btn ${todo ? 'btn-secondary' : 'btn-ghost'}" style="flex: none;" data-act="go" data-href="${esc(pluginHref(c.id))}">${
      todo ? t('去连接', 'Connect') : t('管理')
    }</button>
  </div>`
}

function pluginsMarket(rest, q) {
  const groups = connectorGroups(rest)
  const names = groups.map(([name]) => name)
  // 选中的分组被搜没了就当没选：停在一个空分组上，人会以为整个市场都空了。
  const cat = names.includes(state.pluginCat) ? state.pluginCat : ''
  const chips =
    names.length > 1
      ? `<div class="satu-plugchips">${[['', t('全部', 'All')], ...names.map((n) => [n, n])]
          .map(
            ([key, label]) =>
              `<button type="button" class="satu-chip2" aria-pressed="${String(cat === key)}" data-act="plugins-cat" data-cat="${esc(key)}">${esc(label)}</button>`,
          )
          .join('')}</div>`
      : ''
  const shown = cat ? groups.filter(([name]) => name === cat) : groups
  const body = rest.length
    ? shown
        .map(
          ([name, list]) => `<div class="satu-pluggroup">
          ${cat || names.length < 2 ? '' : `<p class="satu-plugcat">${esc(name)}</p>`}
          <div class="satu-pluggrid">${[...list].sort((a, b) => Number(a.blocked) - Number(b.blocked)).map(pluginMarketCard).join('')}</div>
        </div>`,
        )
        .join('')
    : `<div class="satu-plugempty">${t('能装的都已经装上了。', 'You have added everything available.')}</div>`
  // 搜索时市场没中、而已安装那边中了：这一段整个不出，别留一行「都装上了」误导人。
  if (q && !rest.length) return ''
  return `<section>${pluginsSectionHead(t('添加插件', 'Add plugins'), rest.length)}${chips}${body}</section>`
}

function pluginMarketCard(c) {
  const desc = c.blocked
    ? `${t('本公司已禁用', 'Disabled by your company')}${c.blockedReason ? `：${c.blockedReason}` : ''}`
    : c.description || c.toolkit
  return `<div class="satu-plugcard${c.blocked ? ' is-blocked' : ''}">
    <button type="button" class="satu-plugmain" data-act="go" data-href="${esc(pluginHref(c.id))}">
      ${connectorLogo(c)}
      <span class="satu-plugmeta">
        <span class="satu-plugname">${esc(c.name)}</span>
        <span class="satu-plugdesc">${esc(desc)}</span>
      </span>
    </button>
    ${
      c.blocked
        ? `<span class="tag" style="flex: none;">${t('已禁用')}</span>`
        : `<button type="button" class="btn btn-secondary" style="flex: none;" data-act="conn-install" data-id="${esc(c.id)}">${t('添加', 'Add')}</button>`
    }
  </div>`
}

// ── 一个插件 ─────────────────────────────────────────────────────────

/**
 * 详情。装了的是「两步」：先连账号，再挑工具——没连账号时工具开得再全也没用，所以
 * 第一步没完成就明说，而不是让人对着一列已勾的工具以为万事俱备。
 *
 * 没装的也能点进来看：先看清它有哪些工具再决定装不装，比装完再卸干净。
 */
function pluginDetailPage() {
  const id = pluginIdOfPath(state.path)
  const detail = state.connectorDetail
  if (!detail || detail.connector?.id !== id) {
    return `<div class="gw-page"><div class="gw-page-inner satu-plugpage">${flashes()}${emptyBox(t('加载中…'))}</div></div>`
  }
  const c = detail.connector
  const installed = Boolean(detail.install)
  const live = (detail.connections || []).some((x) => x.status === 'active')
  const tag = !installed
    ? `<span class="tag tag-neutral">${t('未添加', 'Not added')}</span>`
    : live
      ? `<span class="tag tag-accent-2">${t('已连接', 'Connected')}</span>`
      : `<span class="tag tag-warn">${t('还没连账号', 'No account connected')}</span>`
  const action = installed
    ? `<button type="button" class="btn btn-ghost" data-act="conn-uninstall" data-id="${esc(c.id)}">${t('卸载')}</button>`
    : c.blocked
      ? ''
      : `<button type="button" class="btn btn-primary" data-act="conn-install" data-id="${esc(c.id)}">${t('添加', 'Add')}</button>`
  return `<div class="gw-page">
    <div class="gw-page-inner satu-plugpage">
      <div class="satu-plugtop">
        <span class="satu-pluglogo">${connectorLogo(c)}</span>
        <div style="min-width: 0; flex: 1;">
          <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
            <h1 style="font-size: 22px; margin: 0;">${esc(c.name)}</h1>${tag}
          </div>
          <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted-foreground);">${esc(c.description || c.toolkit)}${
            c.category ? ` · ${esc(c.category)}` : ''
          }</p>
        </div>
        <div style="flex: none; display: flex; gap: var(--space-2);">${action}</div>
      </div>
      ${flashes()}
      ${c.blocked ? `<div class="gw-flash gw-flash-err" style="margin: 0;">${t('本公司已禁用这个连接器')}${c.blockedReason ? `：${esc(c.blockedReason)}` : ''}</div>` : ''}
      ${installed ? pluginSetup(detail, live) : pluginPreview(detail)}
    </div>
    ${connAddModal(c)}
  </div>`
}

/**
 * 「添加账号」弹窗。两步：先起名字、点「去授权」（新标签页里开 OAuth），然后停在
 * 「等你授权」上，直到人回到这一页（pages-connectors.js 的 focus 监听会把它收掉并刷新）
 * 或者自己点「我已完成授权」。
 *
 * 只认当前这个插件的：从别的插件详情页带过来的那一份不画。
 */
function connAddModal(c) {
  const a = state.connAdd
  if (!a || a.id !== c.id) return ''
  const name = a.name || c.name
  if (a.phase === 'waiting') {
    // 桌面端的授权页开在系统浏览器里，不是「新标签页」（见 pages-connectors.js 的 startAddAccount）。
    const desktop = Boolean(window.__SATUWORK_DESKTOP__)
    return `<div class="gw-modal-backdrop" data-act="conn-add-close">
      <div class="gw-modal" style="max-width: 460px;" data-stop role="dialog" aria-modal="true">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${
            desktop ? t('在浏览器里完成授权', 'Finish in your browser') : t('在新页面里完成授权', 'Finish in the new tab')
          }</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${
            desktop
              ? t(
                  `已经在浏览器里打开了 ${name} 的授权页。在那里登录并同意，完成后回到这里就会自动刷新；没刷新就点「我已完成授权」。`,
                  `${name} authorization is open in your browser. Sign in and approve there, then come back — this window refreshes, or click "I have finished".`,
                )
              : t(
                  `已经在新标签页里打开了 ${name} 的授权页。在那里登录并同意，完成后关掉那一页，回到这里就会自动刷新。`,
                  `${name} authorization is open in a new tab. Sign in and approve there, then close it — this page refreshes when you come back.`,
                )
          }</p>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
          <button type="button" class="btn btn-ghost" data-act="conn-add-close">${t('关闭')}</button>
          <button type="button" class="btn btn-primary" data-act="conn-add-done">${t('我已完成授权', 'I have finished')}</button>
        </div>
      </div>
    </div>`
  }
  return `<div class="gw-modal-backdrop" data-act="conn-add-close">
    <div class="gw-modal" style="max-width: 460px;" data-stop role="dialog" aria-modal="true">
      <div>
        <h2 style="font-size: 20px; margin: 0 0 4px;">${t(`添加 ${name} 账号`, `Add a ${name} account`)}</h2>
        <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t(
          '起个名字分清是哪一个，然后去授权。',
          'Name it so you can tell accounts apart, then authorize.',
        )}</p>
      </div>
      ${a.error ? `<div class="gw-flash gw-flash-err" style="margin: 0;">${esc(a.error)}</div>` : ''}
      <form id="conn-add-form" data-id="${esc(c.id)}" style="display: flex; flex-direction: column; gap: var(--space-4);">
        <div class="field">
          <label for="conn-label">${t('账号名', 'Account label')}</label>
          <input class="input" id="conn-label" data-input="conn-label" autocomplete="off" maxlength="16" autofocus
            placeholder="${esc(t('如 personal、work', 'e.g. personal, work'))}">
          <span style="font-size: 12px; color: var(--muted-foreground);">${t(
            `会出现在工具名里（如 ${c.toolkit}_personal），模型靠它判断该用哪一个。小写字母、数字、- 和 _，最多 16 个字；留空就叫 default。`,
            `Shows up in tool names (${c.toolkit}_personal), which is how the model tells accounts apart. Lowercase letters, digits, - and _, up to 16; blank means "default".`,
          )}</span>
        </div>
        <div style="border: 1px solid var(--border); border-radius: 12px; padding: var(--space-3); font-size: 13px; color: var(--muted-foreground);">
          ${t(
            `点「去授权」会新开一页，在 ${name} 那边登录并同意授权；这一页不动。`,
            `Authorize opens ${name} in a new tab where you sign in and approve; this page stays as it is.`,
          )}
        </div>
        <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
          <button type="button" class="btn btn-ghost" data-act="conn-add-close">${t('取消')}</button>
          <button type="submit" class="btn btn-primary" ${a.busy ? 'disabled' : ''}>${a.busy ? t('打开中…', 'Opening…') : t('去授权', 'Authorize')}</button>
        </div>
      </form>
    </div>
  </div>`
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !state.connAdd) return
  state.connAdd = null
  render()
})

function pluginStep(n, done, title, sub) {
  return `<div class="satu-plugstep">
    <span class="satu-plugnum${done ? ' is-done' : ''}">${done ? svg(['M5 12l5 5L20 7'], 13) : n}</span>
    <div style="min-width: 0;">
      <h2>${esc(title)}</h2>
      <p>${esc(sub)}</p>
    </div>
  </div>`
}

function pluginSetup(detail, live) {
  const c = detail.connector
  const conns = detail.connections || []
  return `<section class="satu-panel">
      ${pluginStep(
        1,
        live,
        t('连接账号', 'Connect an account'),
        t(
          'Bot 用你授权的账号去操作它。可以连好几个，比如工作和个人各一个；每个账号默认所有 Bot 都能用，也可以只给指定的 Bot。',
          'Bots act through the accounts you authorize. You can connect several — say, one for work and one personal. Every bot can use an account by default, or you can limit it to specific bots.',
        ),
      )}
      ${
        live
          ? ''
          : `<div class="gw-flash gw-flash-note" style="margin: 0;">${t(
              '还没连上账号——连上之前，Bot 用不了这个插件。',
              'No account connected yet — bots cannot use this plugin until you connect one.',
            )}</div>`
      }
      <div class="satu-plugconns">
        ${conns.map((x) => connectionRow(x, c.id)).join('')}
        ${addAccountRow(c.id)}
      </div>
    </section>
    <section class="satu-panel">
      ${pluginStep(
        2,
        false,
        t('选择工具', 'Choose tools'),
        t(
          '开着的工具会进每一个能用这些账号的 Bot 的工具表（每个账号的「可用 Bot」里设）。用不上的关掉——装得多了，工具表会把上下文撑满，模型也更容易选错。',
          'Enabled tools go into every bot that can use these accounts (set under each account’s “Bots”). Turn off what you do not need — a long tool list crowds the context and makes the model pick wrong.',
        ),
      )}
      ${connectorToolsBox(detail)}
    </section>`
}

/** 没装时那一屏：装了会发生什么，以及它带哪些工具。 */
function pluginPreview(detail) {
  const tools = detail.tools || []
  const MAX = 30
  const list = tools
    .slice(0, MAX)
    .map(
      (tool) => `<div class="satu-plugtool">
        <span style="font-family: var(--font-mono, monospace); font-size: 12px;">${esc(tool.slug)}</span>
        ${tool.description ? `<span style="display: block; color: var(--muted-foreground);">${esc(tool.description)}</span>` : ''}
      </div>`,
    )
    .join('')
  return `<section class="satu-panel">
      <h2 class="satu-plugh2">${t('添加之后', 'After you add it')}</h2>
      <ol class="satu-plugsteps">
        <li>${t('连上你的账号——在新标签页里授权，这一页不动。', 'Connect your account — authorization opens in a new tab.')}</li>
        <li>${t('挑出要开的工具。', 'Pick the tools to enable.')}</li>
        <li>${t('你名下的每一个 Bot 都能用上，不用为每个 Bot 各连一次。', 'Every bot you own can use it — no per-bot setup.')}</li>
      </ol>
    </section>
    ${
      detail.toolsError
        ? `<div style="font-size: 13px; color: var(--muted-foreground);">${t('拉不到工具清单')}：${esc(detail.toolsError)}</div>`
        : tools.length
          ? `<section class="satu-panel">
          <h2 class="satu-plugh2">${t('提供的工具', 'Tools')} <span style="font-weight: 400; color: var(--muted-foreground);">${tools.length}</span></h2>
          <div class="satu-plugtools">${list}</div>
          ${
            tools.length > MAX
              ? `<p class="satu-plughint">${t(`还有 ${tools.length - MAX} 个，添加之后在这里逐个开关。`, `${tools.length - MAX} more — you can toggle each one after adding.`)}</p>`
              : ''
          }
        </section>`
          : ''
    }`
}

// ── 工具开关：筛选、全开全关、未保存的数 ─────────────────────────────

/**
 * 这几样都**只动 DOM、不 render**：复选框是不受控的，勾到一半整页重画，没保存的勾选
 * 就全丢了。保存（conn-tools-save）也是从 DOM 里读的，所以 DOM 就是唯一的真相。
 */
function toolBoxes() {
  return [...document.querySelectorAll('[data-act="conn-tool"]')]
}

function paintToolCount() {
  const el = document.getElementById('conn-tools-count')
  if (!el) return
  const boxes = toolBoxes()
  const n = boxes.filter((b) => b.checked).length
  // defaultChecked 就是画出来时那一份（后端存的），和它不一样就是还没保存。
  const dirty = boxes.some((b) => b.checked !== b.defaultChecked)
  el.textContent = t(`${n} / ${boxes.length} 个已开启`) + (dirty ? t('（未保存）', ' (unsaved)') : '')
}

function filterToolRows(q) {
  const s = String(q || '').trim().toLowerCase()
  for (const row of document.querySelectorAll('[data-tool-row]')) {
    // 行本身是 `display: flex`，这里不能写 ''——那会连行内的 flex 一起抹掉。
    row.style.display = !s || row.textContent.toLowerCase().includes(s) ? 'flex' : 'none'
  }
}

/** 全开 / 全关只管**筛出来的那些**：先筛「issue」再点全开，开的就是和 issue 有关的那几个。 */
function setVisibleTools(on) {
  for (const b of toolBoxes()) {
    const row = b.closest('[data-tool-row]')
    if (row && row.style.display === 'none') continue
    b.checked = on
  }
  paintToolCount()
}
