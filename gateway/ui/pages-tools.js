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
  // 知识库：单价、相似度门槛、向量库状态（docs/knowledge-base.md §10）。
  { key: 'kb', label: '知识库' },
]

const WEB_BACKEND_NAMES = {
  tavily: 'Tavily',
  searxng: 'SearXNG',
  duckduckgo: 'DuckDuckGo',
  firecrawl: 'Firecrawl',
  document: '文档直取（PDF / Word / Excel）',
}

const WEB_BACKEND_NOTES = {
  tavily: '托管服务，搜索和提取都有，1000 次/月免费额度。',
  searxng: '自托管，查询词不出自己的网。只有搜索；实例的 settings.yml 里要开 json 输出。',
  duckduckgo: '无密钥、零配置的兜底。没有商务约定，会限流也可能封 IP，别当主力用。',
  firecrawl: '托管服务，搜索和提取都有。提取那头是真渲染的浏览器——SPA 页面 Tavily 拿不到正文时用它。',
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
  const tabs = TOOL_TABS.map(
    (x) =>
      `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(tab === x.key)}" data-act="tools-tab" data-tab="${esc(x.key)}">${t(x.label)}</button>`,
  ).join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('工具配置')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('Bot 能用的平台级工具。配一次，所有公司共用；按调用次数计价。')}</p>
        </div>
        ${flashes()}
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">${tabs}</div>
        ${tab === 'web' ? webToolsPanel() : ''}
        ${tab === 'kb' ? knowledgeToolsPanel() : ''}
      </div>
    </div>`
}

function knowledgeToolsPanel() {
  const k = state.settings?.knowledge || { pricing: { queryMils: 0, ingestMils: 0 }, scoreMin: 0.35 }
  const st = state.kbStatus
  const status = !st
    ? t('状态读取中…', 'Reading status…')
    : !st.configured
      ? t('未配置。给 Gateway 配 UPSTASH_VECTOR_REST_URL / UPSTASH_VECTOR_REST_TOKEN 就开通了；索引要选内置 embedding 模型（推荐 bge-m3）。', 'Not configured. Set UPSTASH_VECTOR_REST_URL / UPSTASH_VECTOR_REST_TOKEN on the gateway; the index must use a built-in embedding model (bge-m3 recommended).')
      : st.error
        ? t(`已配置，但连不上：${st.error}`, `Configured, but unreachable: ${st.error}`)
        : t(`已连接 · 索引里 ${st.vectors} 个向量 · ${st.dimension} 维`, `Connected · ${st.vectors} vectors · ${st.dimension} dims`)
  return `
    <div style="display: flex; flex-direction: column; gap: var(--space-5);">
      <div class="satu-panel">
        <div>
          <h2 style="font-size: 16px; margin: 0 0 4px;">${t('向量库', 'Vector store')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${esc(status)}</p>
        </div>
      </div>
      <div class="satu-panel" style="gap: var(--space-3);">
        <div>
          <h2 style="font-size: 16px; margin: 0 0 4px;">${t('单价')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('按 Upstash 请求次数计：一次检索 = 查了几个库；一份文件入库 = 分片数 ÷ 100 向上取整。0 = 不收钱、不熔断。倍率沿用模型配置里的那一个。', 'Priced per Upstash request: one search = number of knowledge bases queried; one ingest = chunks ÷ 100 rounded up. 0 = free and never cut off. The multiplier from model settings applies.')}</p>
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
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('低于这个分数的命中丢掉。太低模型会拿到一堆不相干的段落还当真话说，太高查不到东西。bge-m3 上 0.35 大致是「有点关系」的门槛。', 'Hits below this score are dropped. Too low and the model gets unrelated passages; too high and nothing is found. On bge-m3, 0.35 is roughly “somewhat related”.')}</p>
        </div>
        <div class="satu-toggleRow">
          <div style="min-width: 0;"><div style="font-size: 13.5px; font-weight: 600;">${t('最低分', 'Minimum score')}</div></div>
          <input class="input" style="width: 140px; flex: none;" type="number" min="0" max="1" step="0.01" value="${esc(String(k.scoreMin ?? 0.35))}" data-act="kb-score">
        </div>
      </div>
    </div>`
}
