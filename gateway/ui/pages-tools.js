/**
 * 平台「工具配置」屏。首发只有「网页与搜索」一个 tab。
 *
 * 留 tab 而不是直接做成单页，是因为下一件要配的东西（沙箱、邮件、图像）迟早会来，
 * 届时加一个 tab 就行，不必再动导航。
 *
 * 密钥框和后端下拉在同一屏，但走的是两个接口：配置进 /platform/tools/web，
 * 密钥进 /platform/credentials——密钥那条路自带「存进去、不回显」的规矩，
 * 把它挪进配置对象里就等于把密钥也塞进了 payload。
 */
const TOOL_TABS = [
  { key: 'web', label: '网页与搜索' },
  // 知识库：向量模型、向量库状态、单价、相似度门槛（docs/knowledge-base.md §3.2、§10）。
  { key: 'kb', label: '知识库' },
]

const WEB_BACKEND_NAMES = {
  tavily: 'Tavily',
  searxng: 'SearXNG',
  duckduckgo: 'DuckDuckGo',
  firecrawl: 'Firecrawl',
  anysearch: 'AnySearch',
  document: '文档直取（PDF / Word / Excel）',
}

const WEB_BACKEND_NOTES = {
  tavily: '托管服务，搜索和提取都有，1000 次/月免费额度。',
  searxng: '自托管，查询词不出自己的网。只有搜索；实例的 settings.yml 里要开 json 输出。',
  duckduckgo: '无密钥、零配置的兜底。没有商务约定，会限流也可能封 IP，别当主力用。',
  firecrawl: '托管服务，搜索和提取都有。提取那头是真渲染的浏览器——SPA 页面 Tavily 拿不到正文时用它。',
  anysearch: '托管服务，搜索和提取都有，按查询意图自己挑数据源。不支持按时间过滤。',
  document: 'PDF / Word / Excel 由 Gateway 自己下载，提取后端一次都不会被调用，所以单独一档价。填 0 就是不额外收费。',
}

function webCfg() {
  return state.webTools?.web || { searchBackend: '', extractBackend: '', searxngUrl: '', pricing: {} }
}

function webBackends() {
  return state.webTools?.backends || []
}

function webBackend(id) {
  return webBackends().find((b) => b.id === id)
}

function webPrice(id, kind) {
  const p = webCfg().pricing?.[id]
  return p && Number.isFinite(Number(p[kind])) ? Number(p[kind]) : 0
}

/** 单价存的是整数「厘」，界面上按美元显示——人是按美元想的，不是按千分之一。 */
function milsToUsd(mils) {
  return (Number(mils || 0) / 1000).toFixed(3)
}

function webBackendOptions(selected, cap) {
  const rows = webBackends().filter((b) => b.selectable !== false && b[cap])
  const opts = rows
    .map((b) => `<option value="${esc(b.id)}" ${selected === b.id ? 'selected' : ''}>${esc(WEB_BACKEND_NAMES[b.id] || b.id)}</option>`)
    .join('')
  return `<option value="" ${selected ? '' : 'selected'}>${t('未配置')}</option>${opts}`
}

/** 选中的后端要什么就显示什么：密钥框、实例地址框，或者一句提醒。 */
function webBackendNeeds(id) {
  if (!id) return ''
  const b = webBackend(id)
  const name = WEB_BACKEND_NAMES[id] || id
  const note = `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${esc(t(WEB_BACKEND_NOTES[id] || ''))}</p>`
  if (id === 'searxng') {
    return `
      <div class="field">
        <label for="searxng-url">${t('SearXNG 实例地址')}</label>
        <input class="input" id="searxng-url" name="searxngUrl" type="url" placeholder="http://10.0.0.9:8888"
               value="${esc(webCfg().searxngUrl || '')}" data-act="web-field" data-field="searxngUrl">
      </div>
      ${note}`
  }
  if (!b?.needsSecret) return note
  const state$ = b?.configured
    ? `<span class="tag tag-accent-2">${t('已配置密钥')}</span>`
    : `<span class="tag">${t('还没有密钥')}</span>`
  return `
    <form data-form="web-secret" data-provider="${esc(id)}" style="display: flex; gap: var(--space-2); align-items: flex-end;">
      <div class="field" style="flex: 1;">
        <label for="web-secret-${esc(id)}">${t(`${esc(name)} API 密钥`, `${esc(name)} API key`)} ${state$}</label>
        <input class="input" id="web-secret-${esc(id)}" name="secret" type="password" autocomplete="off"
               placeholder="${esc(t('粘贴密钥，保存后不再回显'))}">
      </div>
      <button type="submit" class="btn btn-secondary" ${state.busy ? 'disabled' : ''}>${t('保存密钥')}</button>
    </form>
    ${note}`
}

function webPriceRows() {
  const mult = state.webTools?.priceMultiplier ?? 1
  return webBackends()
    .filter((b) => b.implemented)
    .map((b) => {
      const cell = (kind, can) =>
        can
          ? `<input class="input" style="width: 110px;" type="number" min="0" step="0.001" value="${milsToUsd(webPrice(b.id, kind))}"
                    data-act="web-price" data-backend="${esc(b.id)}" data-kind="${kind}">`
          : `<span style="font-size: 13px; color: var(--muted-foreground);">—</span>`
      const quoted = (kind, can) => {
        if (!can) return '—'
        const unit = webPrice(b.id, kind)
        if (!unit) return t('免费')
        return `$${(unit * mult / 1000).toFixed(4)}`
      }
      return `<div class="satu-modelrow" style="grid-template-columns: 1fr 130px 130px 1fr;">
        <span style="font-weight: 600; font-size: 14px;">${esc(WEB_BACKEND_NAMES[b.id] || b.label || b.id)}</span>
        ${cell('search', b.search)}
        ${cell('extract', b.extract)}
        <span style="font-size: 13px; color: var(--muted-foreground);">
          ${t('按倍率报价')} ×${esc(String(mult))}：${quoted('search', b.search)} / ${quoted('extract', b.extract)}
        </span>
      </div>`
    })
    .join('')
}

function webTestMark(kind) {
  const res = state.tests[`web:${kind}`]
  if (!res) return ''
  if (res.status === 'busy') return `<span style="font-size: 12px; color: var(--muted-foreground);">${t('自检中…')}</span>`
  const color = res.status === 'ok' ? 'var(--color-accent-2-800)' : 'var(--color-accent-800)'
  return `<span style="font-size: 12px; color: ${color};">${esc(res.text)}</span>`
}

function webToolsPanel() {
  const cfg = webCfg()
  const notPriced = webBackends().some(
    (b) => b.implemented && (b.id === cfg.searchBackend || b.id === cfg.extractBackend) && !webPrice(b.id, 'search') && !webPrice(b.id, 'extract'),
  )
  return `
    <div style="display: flex; flex-direction: column; gap: var(--space-6);">
      <div class="gw-roles">
        <div class="satu-panel">
          <div>
            <h2 style="font-size: 16px; margin: 0 0 4px;">${t('搜索后端')}</h2>
            <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('web_search 用它。密钥只存在 Gateway，不会下发到席位机器。')}</p>
          </div>
          <select class="input" data-act="web-backend" data-cap="search">${webBackendOptions(cfg.searchBackend, 'search')}</select>
          ${webBackendNeeds(cfg.searchBackend)}
          <div style="display: flex; align-items: center; gap: var(--space-3);">
            <button type="button" class="btn btn-ghost" data-act="web-test" data-kind="search" ${cfg.searchBackend ? '' : 'disabled'}>${t('自检')}</button>
            ${webTestMark('search')}
          </div>
        </div>
        <div class="satu-panel">
          <div>
            <h2 style="font-size: 16px; margin: 0 0 4px;">${t('提取后端')}</h2>
            <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('web_extract 用它。只列真的支持提取的后端。')}</p>
          </div>
          <select class="input" data-act="web-backend" data-cap="extract">${webBackendOptions(cfg.extractBackend, 'extract')}</select>
          ${webBackendNeeds(cfg.extractBackend)}
          <div style="display: flex; align-items: center; gap: var(--space-3);">
            <button type="button" class="btn btn-ghost" data-act="web-test" data-kind="extract" ${cfg.extractBackend ? '' : 'disabled'}>${t('自检')}</button>
            ${webTestMark('extract')}
          </div>
        </div>
      </div>

      <div class="satu-panel">
        <div>
          <h2 style="font-size: 16px; margin: 0 0 4px;">${t('每家公司每天的调用上限')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
            ${t('0 = 不限。这道闸防的是跑飞（一个循环把额度打光），不是精确计费，按服务器时区的自然日算。')}
          </p>
        </div>
        <div class="satu-toggleRow">
          <div style="min-width: 0;"><div style="font-size: 13.5px; font-weight: 600;">${t('每天最多')}</div></div>
          <input class="input" style="width: 140px; flex: none;" type="number" min="0" step="1"
                 value="${esc(String(cfg.dailyLimit ?? 0))}" data-act="web-limit">
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: var(--space-3);">
        <div>
          <h2 style="font-size: 18px; margin: 0 0 4px;">${t('单价')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
            ${t('每次调用多少美元。提取按抓成功的地址条数算。倍率沿用模型配置里的那一个，改它去「模型配置」。')}
          </p>
        </div>
        ${notPriced ? `<div class="gw-flash">${t('选中的后端还没定价，现在的调用会按 0 记账。')}</div>` : ''}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-modelhead" style="grid-template-columns: 1fr 130px 130px 1fr;">
            <span>${t('后端')}</span><span>${t('搜索 / 次')}</span><span>${t('提取 / 条')}</span><span></span>
          </div>
          ${webPriceRows()}
        </div>
      </div>
    </div>`
}

function toolsPage() {
  const tab = state.toolsTab || 'web'
  const tabs = tabPills(TOOL_TABS, tab, 'tools-tab')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        ${pageHead(t('工具配置'), t('Bot 能用的平台级工具。配一次，所有公司共用；按调用次数计价。'))}
        ${flashes()}
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">${tabs}</div>
        ${tab === 'web' ? webToolsPanel() : ''}
        ${tab === 'kb' ? knowledgeToolsPanel() : ''}
      </div>
    </div>`
}

// ── 知识库 ──────────────────────────────────────────────────────────────
//
// 向量模型这一块走 /platform/knowledge/embedding（配置）和 …/embedding/key（密钥，不回显），
// 单价和门槛仍是 /platform/settings 的 knowledge 字段。区域只决定下拉里列哪几家。

const KB_REGIONS = [
  { key: 'cn', label: '中国区' },
  { key: 'intl', label: '国际区' },
]

function kbEmbedView() {
  return state.kbEmbed || { embedding: { region: '', provider: '' }, presets: [], keys: {}, status: null }
}

/** 下拉里当前选中的：刚选了「自定义」还没保存时以那一下为准。 */
function kbPickedProvider() {
  return state.kbEmbedPick || kbEmbedView().embedding.provider || ''
}

function kbPreset(id) {
  return kbEmbedView().presets.find((p) => p.id === id)
}

function kbProviderLabel(id) {
  if (id === 'custom') return t('自定义（OpenAI 兼容）', 'Custom (OpenAI-compatible)')
  if (id === 'env') return t('环境变量', 'Environment variables')
  const p = kbPreset(id)
  return p ? t(p.label, p.label) : id
}

/** 状态行：一个标签 + 一句话。四种局面——没配、表没建、要重建、能用。 */
function kbStatusLine() {
  const st = kbEmbedView().status
  if (!st) return { tag: `<span class="tag">${t('读取中', 'Loading')}</span>`, text: t('状态读取中…', 'Reading status…') }
  const count = st.vectors != null ? t(` · ${st.vectors} 个向量`, ` · ${st.vectors} vectors`) : ''
  if (!st.configured) return { tag: `<span class="tag">${t('未配置', 'Not configured')}</span>`, text: st.error || t('选一家向量服务并填好密钥。', 'Pick an embedding service and add its key.') }
  if (!st.initialized) return { tag: `<span class="tag tag-warn">${t('未初始化', 'Not initialized')}</span>`, text: st.error || t('向量表还没建，点「初始化向量表」。', 'The vector tables do not exist yet. Click “Initialize”.') }
  if (st.profileMatches === false) return { tag: `<span class="tag tag-warn">${t('需要重建', 'Rebuild needed')}</span>`, text: st.error }
  if (st.error) return { tag: `<span class="tag tag-warn">${t('异常', 'Error')}</span>`, text: st.error }
  return { tag: `<span class="tag tag-accent-2">${t('已就绪', 'Ready')}</span>`, text: `${st.model} · ${st.dimension} ${t('维', 'dims')}${count}` }
}

function kbProviderOptions(region, picked) {
  const presets = kbEmbedView().presets
  const inRegion = presets.filter((p) => p.region === region)
  // 当前选中的那家不在这个区域（刚切了区域）：照样列出来，不然下拉会凭空显示成另一家。
  const stray = presets.find((p) => p.id === picked && p.region !== region)
  const opt = (id, label) => `<option value="${esc(id)}" ${picked === id ? 'selected' : ''}>${esc(label)}</option>`
  if (!region) return `<option value="" selected>${t('先选本环境区域', 'Pick the deployment region first')}</option>`
  return [
    `<option value="" ${picked ? '' : 'selected'}>${t('未配置', 'Not configured')}</option>`,
    ...inRegion.map((p) => opt(p.id, t(p.label, p.label))),
    stray ? opt(stray.id, `${t(stray.label, stray.label)}（${t('其他区域', 'other region')}）`) : '',
    opt('custom', kbProviderLabel('custom')),
  ].join('')
}

/** 预设：地址固定、模型可换；自定义：地址、模型、批量、维度参数都要自己填，点保存才提交。 */
function kbProviderFields(picked) {
  const e = kbEmbedView().embedding
  if (!picked) return ''
  if (picked === 'custom') {
    const saved = e.provider === 'custom' ? e : { baseUrl: '', model: '', dimensions: false, batchSize: 16 }
    return `
      <form data-form="kb-embed-custom" style="display: flex; flex-direction: column; gap: var(--space-3);">
        <div class="field">
          <label for="kb-embed-base">${t('接口地址', 'Base URL')}</label>
          <input class="input" id="kb-embed-base" name="baseUrl" type="url" placeholder="https://api.example.com/v1" value="${esc(saved.baseUrl)}">
        </div>
        <div style="display: grid; grid-template-columns: 1fr 140px; gap: var(--space-3);">
          <div class="field">
            <label for="kb-embed-model-custom">${t('模型', 'Model')}</label>
            <input class="input" id="kb-embed-model-custom" name="model" placeholder="BAAI/bge-m3" value="${esc(saved.model)}">
          </div>
          <div class="field">
            <label for="kb-embed-batch">${t('单次条数', 'Batch size')}</label>
            <input class="input" id="kb-embed-batch" name="batchSize" type="number" min="1" max="64" step="1" value="${esc(String(saved.batchSize || 16))}">
          </div>
        </div>
        <label style="display: flex; align-items: center; gap: var(--space-2); font-size: 13px;">
          <input type="checkbox" name="dimensions" ${saved.dimensions ? 'checked' : ''}>
          ${t('请求里带 dimensions: 1024（原生不是 1024 维的模型要勾上）', 'Send dimensions: 1024 (needed for models that are not natively 1024-d)')}
        </label>
        <div style="display: flex; justify-content: flex-end;">
          <button type="submit" class="btn btn-secondary" ${state.busy ? 'disabled' : ''}>${t('保存', 'Save')}</button>
        </div>
      </form>`
  }
  const p = kbPreset(picked)
  if (!p) return ''
  const model = e.provider === picked && e.model ? e.model : p.model
  return `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
      <div class="field">
        <label for="kb-embed-model">${t('模型', 'Model')}</label>
        <input class="input" id="kb-embed-model" list="kb-embed-models" value="${esc(model)}" data-act="kb-embed-model">
        <datalist id="kb-embed-models">${p.models.map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>
      </div>
      <div class="field">
        <label>${t('接口地址', 'Base URL')}</label>
        <div style="font-size: 13px; color: var(--muted-foreground); padding: 8px 0; word-break: break-all;">${esc(p.baseUrl)}</div>
      </div>
    </div>`
}

function kbKeyForm(picked) {
  if (!picked) return ''
  const e = kbEmbedView().embedding
  // 自定义的密钥钉在已保存的地址上（换了主机要重填），地址没存之前没地方挂。
  if (picked === 'custom' && (e.provider !== 'custom' || !e.baseUrl)) {
    return `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('先保存接口地址，再填密钥。密钥只用于这个地址的主机，改了主机要重新填。', 'Save the base URL first, then add the key. The key is only sent to that host; changing the host requires re-entering it.')}</p>`
  }
  const key = kbEmbedView().keys[picked]
  const mark = key ? `<span class="tag tag-accent-2">${t('已配置密钥', 'Key saved')}</span>` : `<span class="tag">${t('还没有密钥', 'No key yet')}</span>`
  return `
    <form data-form="kb-embed-key" data-provider="${esc(picked)}" style="display: flex; gap: var(--space-2); align-items: flex-end;">
      <div class="field" style="flex: 1;">
        <label for="kb-embed-key">${t(`${kbProviderLabel(picked)} API 密钥`, `${kbProviderLabel(picked)} API key`)} ${mark}</label>
        <input class="input" id="kb-embed-key" name="secret" type="password" autocomplete="off" placeholder="${esc(t('粘贴密钥，保存后不再回显', 'Paste the key; it is never shown again'))}">
      </div>
      <button type="submit" class="btn btn-secondary" ${state.busy ? 'disabled' : ''}>${t('保存密钥', 'Save key')}</button>
    </form>`
}

function kbEmbedTestMark() {
  const res = state.tests['kb:embed']
  if (!res) return ''
  if (res.status === 'busy') return `<span style="font-size: 12px; color: var(--muted-foreground);">${t('自检中…', 'Testing…')}</span>`
  const color = res.status === 'ok' ? 'var(--color-accent-2-800)' : 'var(--color-accent-800)'
  return `<span style="font-size: 12px; color: ${color};">${esc(res.text)}</span>`
}

function kbEmbeddingPanel() {
  const v = kbEmbedView()
  const region = v.embedding.region || ''
  const picked = kbPickedProvider()
  const st = v.status
  const line = kbStatusLine()
  const fromEnv = st?.source === 'env' && !v.embedding.provider
  return `
    <div class="satu-panel" style="gap: var(--space-4);">
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
        <div style="min-width: 0;">
          <h2 style="font-size: 16px; margin: 0 0 4px;">${t('向量模型', 'Embedding model')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('文件入库和检索都用它把文字转成向量。固定 1024 维，存在本环境的数据库（pgvector）里。', 'Turns text into vectors for ingestion and search. Always 1024 dimensions, stored in this environment’s database (pgvector).')}</p>
        </div>
        ${line.tag}
      </div>
      ${fromEnv ? `<div class="gw-flash">${t(`现在用的是环境变量 KB_EMBEDDING_*（${st.model}）。在这里选好服务商并保存密钥后，以页面为准，环境变量不再生效。`, `Currently using the KB_EMBEDDING_* environment variables (${st.model}). Once you pick a provider here and save its key, this page takes over.`)}</div>` : ''}
      <div class="satu-toggleRow" style="border-top: 0; padding-top: 0;">
        <div style="min-width: 0;">
          <div style="font-size: 13.5px; font-weight: 600;">${t('本环境区域', 'Deployment region')}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${t('只决定下面列哪几家：中国区不列连不上的海外服务，国际区不把文档绕到国内。', 'Only filters the list below: China lists services reachable from China; International keeps documents outside China.')}</div>
        </div>
        <div style="display: flex; gap: var(--space-2); flex: none;">${tabPills(KB_REGIONS, region, 'kb-region')}</div>
      </div>
      <div class="field">
        <label for="kb-embed-provider">${t('服务商', 'Provider')}</label>
        <select class="input" id="kb-embed-provider" data-act="kb-embed-provider" ${region ? '' : 'disabled'}>${kbProviderOptions(region, picked)}</select>
      </div>
      ${kbProviderFields(picked)}
      ${kbKeyForm(picked)}
      <div style="display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;">
        <button type="button" class="btn btn-ghost" data-act="kb-embed-test" ${st?.configured ? '' : 'disabled'}>${t('自检', 'Test')}</button>
        ${kbEmbedTestMark()}
      </div>
    </div>`
}

function kbVectorStorePanel() {
  const st = kbEmbedView().status
  const rebuild = st?.initialized && st.profileMatches === false
  const unindexed = st?.initialized && st.profileMatches !== false ? st.unindexed || 0 : 0
  const actions = !st
    ? ''
    : !st.initialized
      ? `<button type="button" class="btn btn-secondary" data-act="kb-init" ${st.source === 'none' ? 'disabled' : ''}>${t('初始化向量表', 'Initialize vector tables')}</button>`
      : `<button type="button" class="btn ${rebuild || unindexed ? 'btn-secondary' : 'btn-ghost'}" data-act="kb-reindex" ${st.configured ? '' : 'disabled'}>${t('重建向量', 'Rebuild vectors')}</button>`
  const text = !st
    ? t('状态读取中…', 'Reading status…')
    : st.initialized
      ? t(`表里有 ${st.vectors ?? 0} 个向量，由 ${st.storedModel} 生成。`, `${st.vectors ?? 0} vectors, made by ${st.storedModel}.`)
      : t('向量表还没建，知识库暂时停用。保存好向量模型会自动建；没建成（多半是数据库权限）就点右边重试，或让运维跑 gateway/scripts/init-knowledge-vectors.ts。', 'The vector tables do not exist yet, so knowledge bases are disabled. Saving an embedding model creates them; if that failed (usually database permissions), retry on the right or have ops run gateway/scripts/init-knowledge-vectors.ts.')
  return `
    <div class="satu-panel">
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
        <div style="min-width: 0; flex: 1;">
          <h2 style="font-size: 16px; margin: 0 0 4px;">${t('向量库', 'Vector store')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${esc(text)}</p>
        </div>
        ${actions}
      </div>
      ${unindexed ? `<div class="gw-flash">${t(`有 ${unindexed} 个文件显示「可用」但还没有向量（从旧向量库迁来，或换模型时表是空的），检索查不到它们。点「重建向量」重新入库，按当前单价向各公司计费。`, `${unindexed} files are marked ready but have no vectors (migrated from the old vector store, or the model changed while the table was empty), so search cannot find them. Click “Rebuild vectors” to re-ingest them; this is billed to each company at the current price.`)}</div>` : ''}
      ${rebuild ? `<div class="gw-flash">${t('换了模型：旧向量和新模型不在一个空间里，不能混用，检索和入库已暂停。重建会删掉全部旧向量、所有文件重新排队入库，完成前检索命中变少；重新入库按当前单价计费。原文件和文本分片不受影响。', 'The model changed: old vectors live in a different space and cannot be mixed, so search and ingestion are paused. Rebuilding deletes all old vectors and re-queues every file; search returns fewer hits until it finishes, and re-ingestion is billed at the current price. Original files and text chunks are kept.')}</div>` : ''}
    </div>`
}

function knowledgeToolsPanel() {
  const k = state.settings?.knowledge || { pricing: { queryMils: 0, ingestMils: 0 }, scoreMin: 0.35 }
  return `
    <div style="display: flex; flex-direction: column; gap: var(--space-5);">
      ${kbEmbeddingPanel()}
      ${kbVectorStorePanel()}
      <div class="gw-roles">
        <div class="satu-panel" style="gap: var(--space-3);">
          <div>
            <h2 style="font-size: 16px; margin: 0 0 4px;">${t('单价', 'Pricing')}</h2>
            <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('一次检索 = 成功查询的库数；一份文件入库 = 分片数 ÷ 100 向上取整。0 = 不收钱、不熔断。倍率沿用模型配置里的那一个。', 'One search = knowledge bases successfully queried; one ingest = chunks ÷ 100 rounded up. 0 = free and never cut off. The multiplier from model settings applies.')}</p>
          </div>
          <div class="satu-toggleRow">
            <div style="min-width: 0;"><div style="font-size: 13.5px; font-weight: 600;">${t('检索 / 次（美元）', 'Search / request (USD)')}</div></div>
            <input class="input" style="width: 140px; flex: none;" type="number" min="0" step="0.001" value="${esc(((k.pricing?.queryMils || 0) / 1000).toFixed(3))}" data-act="kb-price" data-field="queryMils">
          </div>
          <div class="satu-toggleRow">
            <div style="min-width: 0;"><div style="font-size: 13.5px; font-weight: 600;">${t('入库 / 次（美元）', 'Ingest / request (USD)')}</div></div>
            <input class="input" style="width: 140px; flex: none;" type="number" min="0" step="0.001" value="${esc(((k.pricing?.ingestMils || 0) / 1000).toFixed(3))}" data-act="kb-price" data-field="ingestMils">
          </div>
        </div>
        <div class="satu-panel" style="gap: var(--space-3);">
          <div>
            <h2 style="font-size: 16px; margin: 0 0 4px;">${t('相似度门槛', 'Similarity threshold')}</h2>
            <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('低于这个分数的命中丢掉。太低模型会拿到不相干的段落，太高查不到东西。换了向量模型后分数分布会变，请用实际样本重新校准。', 'Hits below this score are dropped. Too low and the model gets unrelated passages; too high and nothing is found. Score distributions change with the embedding model; recalibrate with real examples after switching.')}</p>
          </div>
          <div class="satu-toggleRow">
            <div style="min-width: 0;"><div style="font-size: 13.5px; font-weight: 600;">${t('最低分', 'Minimum score')}</div></div>
            <input class="input" style="width: 140px; flex: none;" type="number" min="0" max="1" step="0.01" value="${esc(String(k.scoreMin ?? 0.35))}" data-act="kb-score">
          </div>
        </div>
      </div>
    </div>`
}
