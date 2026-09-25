/** 管理侧的页面：概览、模型配置、供应商、统计、公司资料、成员与分组。 */
function overviewPage() {
  // 公司侧（管理员和员工）的 / 就是对话页；概览那一屏已经去掉了。
  if (isOwner()) return ownerOverviewPage()
  return chatPage()
}

function ownerOverviewPage() {
  const orgs = state.orgs || []
  const users = state.users || []
  const configured = [...configuredSet()]
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('概览')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('平台公司、用户、已配置供应商，以及日常 / utility 模型。')}</p>
        </div>
        ${flashes()}
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--space-3);">
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('公司')}</span>
            <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(orgs.length)}</span>
          </div>
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('用户')}</span>
            <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(users.length)}</span>
          </div>
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('日常任务模型')}</span>
            <span style="font-family: var(--font-heading); font-size: 18px; line-height: 1.2;">${esc(roleLabel('daily'))}</span>
          </div>
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('Utility 模型')}</span>
            <span style="font-family: var(--font-heading); font-size: 18px; line-height: 1.2;">${esc(roleLabel('utility'))}</span>
          </div>
        </div>
        <div class="satu-panel">
          <span class="satu-panel-title">${t('已配置供应商')}</span>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('只显示名称。密钥不会出现在这里。')}</p>
          <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">
            ${
              configured.length
                ? configured.map((p) => `<span class="tag tag-accent">${esc(p)}</span>`).join('')
                : `<span style="font-size: 13px; color: var(--muted-foreground);">${t('还没有配置供应商。到「供应商」页添加密钥。')}</span>`
            }
          </div>
        </div>
      </div>
    </div>`
}


function configuredProviders() {
  const configured = configuredSet()
  const list = state.catalog.filter((p) => configured.has(p.provider)).map((p) => ({
    provider: p.provider,
    name: p.name || p.provider,
    models: p.models || [],
  }))
  const seen = new Set(list.map((p) => p.provider))
  for (const provider of configured) {
    if (!seen.has(provider)) list.push({ provider, name: provider, models: [] })
  }
  return list
}

function providerOptions(selected) {
  const list = configuredProviders()
  if (selected && !list.some((p) => p.provider === selected)) list.unshift({ provider: selected, name: selected, models: [] })
  return list.map((p) => `<option value="${esc(p.provider)}" ${p.provider === selected ? 'selected' : ''}>${esc(p.name || p.provider)}</option>`).join('')
}

function modelOptions(provider, selected) {
  const shown = state.catalog.find((p) => p.provider === provider)
  const models = shown?.models?.length ? shown.models : selected ? [{ id: selected }] : []
  if (selected && !models.some((m) => m.id === selected)) models.unshift({ id: selected })
  return models.map((m) => `<option value="${esc(m.id)}" ${m.id === selected ? 'selected' : ''}>${esc(m.id)}</option>`).join('')
}

/** 当前生效的报价倍率。没设过就是 1（按原价）。 */
function priceMultiplier() {
  const n = Number(state.settings?.priceMultiplier)
  return Number.isFinite(n) && n > 0 ? n : 1
}

/**
 * 目录里「没有价」和「免费」长得一样：pi-ai 对没收录价格的模型（zai 这些）
 * 一律填 0。两个方向都是 0 时按「不知道」画成 —— 写成 $0.000 会被读成免费。
 */
function hasRates(cost) {
  return Number(cost?.input) > 0 || Number(cost?.output) > 0
}

/** 平台覆盖表里有没有这一条。有就以它为准，目录里的价只是默认值。 */
function priceOverride(provider, id) {
  const table = state.settings?.modelPricing
  if (!table || typeof table !== 'object') return null
  return table[`${provider}/${id}`] || null
}

/** 平台兜底单价。覆盖和目录都查不到时按它收，四项全 0 = 没设。 */
function defaultRate() {
  const r = state.settings?.defaultModelRate
  return r && typeof r === 'object' ? r : {}
}

/** 兜底设了没有。只看 input / output——和服务端 rateOf 最后那一刀同一个判据。 */
function hasDefaultRate() {
  return hasRates(defaultRate())
}

/**
 * 实际生效的四项单价。**按字段合并，不是整份顶掉**——和服务端 `rateOf` 必须是同一
 * 套规则，否则这一屏画的价和真收的价对不上，而对不上的时候没人会先怀疑界面。
 * 0 读作「这一项没填」，往下一层要。
 *
 * 三层，和服务端一字不差：**覆盖 → 目录 → 平台兜底**。
 */
function effectiveCost(provider, id, cost) {
  const base = cost && typeof cost === 'object' ? cost : {}
  const o = priceOverride(provider, id) || {}
  const f = defaultRate()
  const pick = (k) => Number(o[k]) || Number(base[k]) || Number(f[k]) || 0
  return { input: pick('input'), output: pick('output'), cacheRead: pick('cacheRead'), cacheWrite: pick('cacheWrite') }
}

/**
 * 哪几项是**兜底兜出来的**。表里要把这些画成另一个样子——兜底是运营拍的一个估数，看不出
 * 是估数的话，一个离谱的价会一直收下去，没人会去查（和缓存回落那两格同一个办法）。
 *
 * **逐项判，不是整行判。** 服务端 `rateOf` 是按字段回落的：一颗只填了 input 的模型，
 * output 完全可能是兜底给的。整行判（「两项都没有才算」）会让这种行画成普通实线，于是
 * 一个纯属拍脑袋的 output 单价看上去和目录价一模一样。
 */
function fellBackRates(provider, id, cost) {
  const base = cost && typeof cost === 'object' ? cost : {}
  const o = priceOverride(provider, id) || {}
  const f = defaultRate()
  const fell = (k) => !(Number(o[k]) || Number(base[k])) && !!Number(f[k])
  return { input: fell('input'), output: fell('output') }
}

/** 兜底那一项的画法：浅一档 + 虚下划线 + 悬浮说明。和缓存回落那两格同一套。 */
function fallbackCell(text) {
  return `<span style="opacity: 0.55; border-bottom: 1px dotted currentColor;" title="${esc(t('目录和覆盖里都没有这一项的单价，按「单价倍率」里的兜底价收', 'Neither the catalog nor the overrides price this field; it is charged at the default rate from Pricing'))}">${text}</span>`
}

function ratePair(cost, factor, fell = {}) {
  if (!hasRates(cost)) return `<span title="${esc(t('目录里没有这个模型的价格', 'The catalog has no price for this model'))}">—</span>`
  const cell = (k) => {
    const shown = esc(money(Number(cost[k] || 0) * factor))
    return fell[k] ? fallbackCell(shown) : shown
  }
  return `${cell('input')} / ${cell('output')}`
}

/**
 * 缓存那两项。**回落来的价要画成另一种样子**——它是按输入价算的，而缓存读通常便宜
 * 一个数量级。看不出是回落的话，一个高估十倍的价会一直收下去，没人会去查。
 */
function cacheRatePair(cost, factor) {
  if (!hasRates(cost)) return ''
  const input = Number(cost.input || 0)
  const read = Number(cost.cacheRead || 0)
  const write = Number(cost.cacheWrite || 0)
  const cell = (v, label) => {
    const fell = !v
    const shown = money((v || input) * factor)
    return fell
      ? `<span style="opacity: 0.55; border-bottom: 1px dotted currentColor;" title="${esc(t(`没填${label}单价，按输入价算`, `No ${label} price set; charged at the input rate`))}">${esc(shown)}</span>`
      : esc(shown)
  }
  return `<div style="font-size: 11.5px; color: var(--muted-foreground); margin-top: 2px;">${t('缓存', 'cache')} ${cell(read, t('缓存读', 'cache read'))} / ${cell(write, t('缓存写', 'cache write'))}</div>`
}

/** 兜底单价那四个框。改完即存，和倍率一样。 */
const DEFAULT_RATE_FIELDS = [
  ['input', '输入', 'Input'],
  ['output', '输出', 'Output'],
  ['cacheRead', '缓存读', 'Cache read'],
  ['cacheWrite', '缓存写', 'Cache write'],
]

/**
 * 倍率和兜底单价。改完即存，和上面两个角色面板一样不设「保存」按钮。
 *
 * 两件事放同一块，是因为它们回答的是同一个问题——「这一次调用收多少钱」。倍率管加成，
 * 兜底管**查不到价的时候收什么**：没有兜底时这类调用记的是金额 0 + `unpriced`，而账单上
 * 的 $0 和「免费」长得一模一样，月底真扣的钱就少了那一截，还没有一屏对得出来。
 *
 * 兜底**压在目录价下面**，不是盖在上面：已经有价的模型照旧按自己的价收。这句话要写在
 * 界面上——不然一个四位数的兜底看着像是要把整个目录顶掉，没人敢填。
 */
function pricePanel() {
  const mult = priceMultiplier()
  const def = defaultRate()
  const on = hasDefaultRate()
  const busy = state.savingDefaultRate ? 'disabled' : ''
  const cell = ([key, zh, en]) => `
    <label style="display: flex; flex-direction: column; gap: 4px; min-width: 0;">
      <span style="font-size: 12px; color: var(--muted-foreground);">${t(zh, en)}</span>
      <input class="input" type="number" inputmode="decimal" min="0" step="0.01"
        placeholder="0" value="${esc(Number(def[key]) ? String(def[key]) : '')}"
        data-act="default-rate" data-field="${esc(key)}" ${busy}>
    </label>`
  return `
    <div class="satu-panel">
      <span class="satu-panel-title">${t('单价倍率')}</span>
      <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('对外报价 = 模型原价 × 倍率。填 1 就是按原价。', 'Quoted price = list price × multiplier. 1 means list price.')}</p>
      <div class="satu-toggleRow">
        <div style="min-width: 0;"><div style="font-size: 13.5px; font-weight: 600;">${t('倍率')}</div></div>
        <input class="input" style="width: 250px; flex: none;" type="number" inputmode="decimal"
          min="0.01" max="100" step="0.05" value="${esc(String(mult))}"
          data-act="price-multiplier" ${state.savingMultiplier ? 'disabled' : ''}>
      </div>
      <div class="satu-toggleRow">
        <div style="min-width: 0; font-size: 12px; color: var(--muted-foreground);">${t(`当前 ${mult} 倍，表里「倍率单价」按它算。`, `Currently ${mult}×; the "marked-up" column uses it.`)}</div>
      </div>
      <div style="border-top: 1px solid var(--border); margin-top: var(--space-2); padding-top: var(--space-3); display: flex; flex-direction: column; gap: var(--space-2);">
        <div style="font-size: 13.5px; font-weight: 600;">${t('兜底单价 / 1M tok', 'Default price / 1M tok')}</div>
        <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('目录和覆盖里都查不到单价的模型，按这里的价收，不按 $0 收——账单上的 $0 会被读成免费，那一截钱月底就少了。兜底压在目录价下面：已经有价的模型照旧按自己的价收。', 'Models with no price in the catalog or the overrides are charged at these rates instead of $0 — a $0 on the invoice reads as free, and that money is simply gone at month end. The default sits below the catalog: models that already have a price keep it.')}</p>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: var(--space-2);">
          ${DEFAULT_RATE_FIELDS.map(cell).join('')}
        </div>
        <div style="font-size: 12px; color: var(--muted-foreground);">
          ${
            on
              ? t('缓存那两项留空就按输入价算（和改价弹层同一条规矩）。倍率照样乘在上面。', 'Leave the two cache fields blank to charge them at the input rate (same rule as the price dialog). The multiplier still applies on top.')
              : t('四项留空 = 不兜底。查不到单价的调用照旧记 $0 并在统计屏上标「没单价」。', 'All four blank = no default. Calls with no price keep recording $0 and are flagged "no price" on the statistics screen.')
          }
        </div>
      </div>
    </div>`
}

const REASONING_LABELS = {
  off: ['关闭', 'Off'],
  minimal: ['极低', 'Minimal'],
  low: ['低', 'Low'],
  medium: ['中', 'Medium'],
  high: ['高', 'High'],
  xhigh: ['极高', 'Extra high'],
  max: ['最高', 'Max'],
}

/** 目录里的这一个模型。找不到就是 undefined（供应商没配、或者模型已经下架）。 */
function catalogModel(provider, model) {
  return state.catalog.find((p) => p.provider === provider)?.models.find((m) => m.id === model)
}

/**
 * 推理强度那一格的选项。角色面板和备选列表共用：这个模型支持哪几档、当前那一档还在
 * 不在里面（换了模型之后多半不在了，那就落回「关闭」）。
 */
function reasoningOptions(picked, current) {
  const levels = picked?.reasoning
    ? (Array.isArray(picked.reasoningLevels) ? picked.reasoningLevels : ['off', 'minimal', 'low', 'medium', 'high'])
    : ['off']
  const effort = levels.includes(current) ? current : 'off'
  return levels
    .map((level) => {
      const label = REASONING_LABELS[level] || [level, level]
      return `<option value="${esc(level)}" ${effort === level ? 'selected' : ''}>${esc(t(label[0], label[1]))}</option>`
    })
    .join('')
}

function rolePanel(role, title, hint) {
  const cur = state.settings?.[role] || { provider: '', model: '', reasoningEffort: 'off' }
  const picked = catalogModel(cur.provider, cur.model)
  const effortOptions = reasoningOptions(picked, cur.reasoningEffort)
  return `
    <div class="satu-panel">
      <span class="satu-panel-title">${esc(title)}</span>
      <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${esc(hint)}</p>
      <div class="satu-toggleRow">
        <div style="min-width: 0;"><div style="font-size: 13.5px; font-weight: 600;">${t('供应商')}</div></div>
        <select class="input" style="width: 250px; flex: none;" data-act="role-provider" data-role="${esc(role)}">
          <option value="">${t('选择供应商')}</option>
          ${providerOptions(cur.provider)}
        </select>
      </div>
      <div class="satu-toggleRow">
        <div style="min-width: 0;"><div style="font-size: 13.5px; font-weight: 600;">${t('模型')}</div></div>
        <select class="input" style="width: 250px; flex: none;" data-act="role-model" data-role="${esc(role)}">
          <option value="">${t('选择模型')}</option>
          ${modelOptions(cur.provider, cur.model)}
        </select>
      </div>
      <div class="satu-toggleRow">
        <div style="min-width: 0;">
          <div style="font-size: 13.5px; font-weight: 600;">${t('推理强度', 'Reasoning effort')}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${picked?.reasoning ? t('控制推理模型在每次任务中投入的思考量。', 'Controls how much reasoning the model uses for each task.') : t('当前模型不支持推理。', 'The selected model does not support reasoning.')}</div>
        </div>
        <select class="input" style="width: 250px; flex: none;" data-act="role-reasoning" data-role="${esc(role)}" ${picked?.reasoning ? '' : 'disabled'}>
          ${effortOptions}
        </select>
      </div>
      <div class="satu-toggleRow">
        <div style="min-width: 0;">${testMark('role', role)}</div>
        <button type="button" class="btn btn-ghost" style="flex: none;" data-act="test-role" data-role="${esc(role)}" ${!cur.provider || !cur.model || state.tests['role:' + role]?.status === 'busy' ? 'disabled' : ''}>${t('测试连通性')}</button>
      </div>
    </div>`
}

/** 备选上限。和 Gateway 的 DAILY_ALTERNATES_MAX 同一个数，写端那头会再挡一次。 */
const DAILY_ALTERNATES_MAX = 8

function dailyAlternates() {
  return Array.isArray(state.settings?.dailyAlternates) ? state.settings.dailyAlternates : []
}

function isAlternate(provider, model) {
  return dailyAlternates().some((r) => r.provider === provider && r.model === model)
}

/**
 * 还能加进备选的模型：供应商配好了密钥、上架了（enabledModels 空 = 全部）、
 * 不是默认那个、也不已经在备选里。按供应商分组，一个下拉框就能挑完。
 */
function alternateCandidates() {
  const daily = state.settings?.daily || {}
  const enabled = Array.isArray(state.settings?.enabledModels) ? state.settings.enabledModels : []
  return configuredProviders()
    .map((p) => ({
      ...p,
      models: p.models.filter((m) =>
        (!enabled.length || enabled.includes(`${p.provider}/${m.id}`)) &&
        !(daily.provider === p.provider && daily.model === m.id) &&
        !isAlternate(p.provider, m.id)),
    }))
    .filter((p) => p.models.length)
}

/**
 * 日常模型的备选。人在对话框里能把自己和某颗 Bot 的对话换成这里的任意一个；
 * 一个都不配，对话框里就不画选择器（只有默认那一个，没得选）。
 *
 * 不塞进上面那两块 sticky 的角色面板里：那一栏是吸顶的，列表一长就把下面的模型表盖住。
 */
function alternatesPanel() {
  const list = dailyAlternates()
  const rows = list
    .map((r, i) => {
      const picked = catalogModel(r.provider, r.model)
      const effortOptions = reasoningOptions(picked, r.reasoningEffort)
      const key = `${r.provider}/${r.model}`
      const test = state.tests['alt:' + key]
      return `<div class="satu-toggleRow">
        <div style="min-width: 0;">
          <div style="font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere;">${esc(picked?.name || r.model)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground); overflow-wrap: anywhere;">${esc(key)}${test ? ` · <span style="color: ${test.status === 'err' ? 'var(--destructive)' : 'inherit'};">${esc(test.text)}</span>` : ''}</div>
        </div>
        <div style="display: flex; align-items: center; gap: var(--space-2); flex: none; flex-wrap: wrap; justify-content: flex-end;">
          <select class="input" style="width: 120px; flex: none;" title="${esc(t('推理强度', 'Reasoning effort'))}" data-act="alt-reasoning" data-index="${i}" ${picked?.reasoning ? '' : 'disabled'}>${effortOptions}</select>
          <button type="button" class="satu-linkbtn" data-act="alt-test" data-provider="${esc(r.provider)}" data-model="${esc(r.model)}" ${test?.status === 'busy' ? 'disabled' : ''}>${t('测试')}</button>
          <button type="button" class="satu-linkbtn" data-act="alt-up" data-index="${i}" ${i === 0 ? 'disabled' : ''} aria-label="${esc(t('上移'))}">↑</button>
          <button type="button" class="satu-linkbtn" data-act="alt-default" data-index="${i}">${t('设为默认')}</button>
          <button type="button" class="satu-linkbtn" data-act="alt-remove" data-index="${i}">${t('移除')}</button>
        </div>
      </div>`
    })
    .join('')
  const groups = alternateCandidates()
  const full = list.length >= DAILY_ALTERNATES_MAX
  const add = full
    ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t(`最多 ${DAILY_ALTERNATES_MAX} 个`, `Up to ${DAILY_ALTERNATES_MAX}`)}</span>`
    : `<select class="input" style="width: 250px; flex: none;" data-act="alt-add" ${groups.length ? '' : 'disabled'}>
        <option value="">${groups.length ? t('添加备选模型') : t('没有可添加的模型')}</option>
        ${groups
          .map((p) => `<optgroup label="${esc(p.name)}">${p.models.map((m) => `<option value="${esc(`${p.provider}/${m.id}`)}">${esc(m.name || m.id)}</option>`).join('')}</optgroup>`)
          .join('')}
      </select>`
  return `
    <div class="satu-panel">
      <span class="satu-panel-title">${t('日常模型备选')}</span>
      <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('成员可以在对话框里把自己和某个 Bot 的对话换成这些模型，也可以在渠道里发 /model 切换。一个都不配时只用默认的日常模型。', 'Members can switch their conversation with a bot to any of these, from the chat box or with /model in a channel. With none configured, the default daily model is used.')}</p>
      ${rows || `<div class="satu-toggleRow"><span style="font-size: 13px; color: var(--muted-foreground);">${t('还没有备选。')}</span></div>`}
      <div class="satu-toggleRow">
        <div style="min-width: 0; font-size: 12px; color: var(--muted-foreground);">${t('只列出已启用、且不是默认的模型。', 'Only enabled models other than the default are listed.')}</div>
        ${add}
      </div>
    </div>`
}

function modelsPage() {
  const shown = state.catalog.find((p) => p.provider === state.selectedProvider)
  const selected = shown?.provider || state.selectedProvider || ''
  const daily = state.settings?.daily || {}
  const utility = state.settings?.utility || {}
  const mult = priceMultiplier()

  const modelRows = (shown?.models || [])
    .map((m) => {
      const isDaily = daily.provider === shown.provider && daily.model === m.id
      const isUtil = utility.provider === shown.provider && utility.model === m.id
      const cost = effectiveCost(shown.provider, m.id, m.cost)
      // 这一行里哪几项是兜底兜出来的：那几个数画成虚线的浅色，一眼看得出是估数。
      const fellBack = fellBackRates(shown.provider, m.id, m.cost)
      const overridden = !!priceOverride(shown.provider, m.id)
      const actions = `
        <div class="satu-rowactions">
          ${isDaily ? `<span class="tag tag-accent">${t('日常')}</span>` : `<button type="button" class="satu-linkbtn" data-act="set-role" data-role="daily" data-provider="${esc(shown.provider)}" data-model="${esc(m.id)}">${t('设为日常')}</button>`}
          ${isDaily ? '' : isAlternate(shown.provider, m.id) ? `<span class="tag">${t('备选')}</span>` : `<button type="button" class="satu-linkbtn" data-act="alt-add-row" data-provider="${esc(shown.provider)}" data-model="${esc(m.id)}" ${dailyAlternates().length >= DAILY_ALTERNATES_MAX ? 'disabled' : ''}>${t('加入备选')}</button>`}
          ${isUtil ? '<span class="tag tag-accent-2">utility</span>' : `<button type="button" class="satu-linkbtn" data-act="set-role" data-role="utility" data-provider="${esc(shown.provider)}" data-model="${esc(m.id)}">${t('设为 utility')}</button>`}
          ${isOwner() ? `<button type="button" class="satu-linkbtn" data-act="model-price" data-provider="${esc(shown.provider)}" data-model="${esc(m.id)}">${overridden ? t('已改价') : t('改价')}</button>` : ''}
        </div>`
      return `<div class="satu-modelrow">
        <div class="satu-tasklink" style="cursor: default;">
          <span style="font-weight: 600; font-size: 14px;">${esc(m.name)}</span>
          <span style="font-size: 12px; color: var(--muted-foreground);">${esc(m.id)}</span>
        </div>
        <span style="font-size: 13px;">${esc(shown.name || shown.provider)}</span>
        <div class="gw-caps">${capTags(m)}</div>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(tokens(m.contextWindow))}${m.maxTokens ? t(` · 出 ${esc(tokens(m.maxTokens))}`, ` · out ${esc(tokens(m.maxTokens))}`) : ''}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${ratePair(cost, 1, fellBack)}${cacheRatePair(cost, 1)}</span>
        <span style="font-size: 13px; color: var(--foreground);">${ratePair(cost, mult, fellBack)}${cacheRatePair(cost, mult)}</span>
        ${actions}
      </div>`
    })
    .join('')

  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('模型配置')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('目录来自 pi-ai；密钥在供应商页配置。密钥留在 Gateway，不会出现在本机磁盘或环境。')}</p>
        </div>
        ${flashes()}
        <div class="gw-roles">
          ${rolePanel('daily', t('日常任务模型'), t('用于日常工作。'))}
          ${rolePanel('utility', t('Utility 模型'), t('用于轻量、快速的任务。'))}
        </div>
        ${isOwner() ? alternatesPanel() : ''}
        ${isOwner() ? pricePanel() : ''}
        ${discoveryPanel()}
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
            <div style="display: flex; align-items: baseline; gap: var(--space-3);">
              <h2 style="font-size: 18px; margin: 0;">${t(`${esc(shown?.name || shown?.provider || '模型')} 的模型`, `${esc(shown?.name || shown?.provider || 'Provider')} models`)}</h2>
              <span style="font-size: 12px; color: var(--muted-foreground);">${t(`共 ${shown?.models.length ?? 0} 个`, `${shown?.models.length ?? 0} total`)}</span>
            </div>
            <select class="input" style="width: 220px; flex: none;" data-act="select-provider">
              <option value="">${t('选择供应商')}</option>
              ${providerOptions(selected)}
            </select>
          </div>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-modelhead">
              <span>${t('模型')}</span><span>${t('供应商')}</span><span>${t('能力')}</span><span>${t('上下文 / 输出')}</span><span>${t('单价 / 1M tok', 'Price / 1M tok')}<br><span style="font-weight: 400; text-transform: none;">${t('输入 / 输出 · 缓存读 / 写', 'in / out · cache read / write')}</span></span><span>${t(`倍率单价 ×${mult}`, `Marked-up ×${mult}`)}</span><span></span>
            </div>
            ${modelRows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('选择已配置的供应商查看模型。')}</div>`}
          </div>
        </div>
      </div>
    </div>
    ${modelPriceModal()}`
}

/**
 * 自动发现的状态条。
 *
 * 存在的理由和改价那张表一样，是同一件真事的两面：**上游上了新模型，不该等
 * pi-ai 发版才用得上**。改价解决的是「价变了」，这里解决的是「模型多了」。
 *
 * 把「上次刷新于」摆出来，是因为这件事一旦不灵，症状只有一个——「新模型怎么还没
 * 出来」。没有这一行，回答它就只能去翻网关日志。
 */
function discoveryPanel() {
  const d = state.discovery
  if (!isOwner() || !d) return ''
  const hours = Math.round((d.intervalMs || 0) / 36e5)
  const cadence = d.intervalMs
    ? t(`每 ${hours} 小时自动拉一次`, `auto-refreshed every ${hours}h`)
    : t('自动刷新已关闭', 'auto-refresh is off')
  return `
    <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover); padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-2);">
      <div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
        <h2 style="font-size: 16px; margin: 0;">${t('模型自动发现', 'Model discovery')}</h2>
        <button type="button" class="satu-linkbtn" data-act="discovery-refresh" ${state.busy ? 'disabled' : ''}>${t('立即刷新', 'Refresh now')}</button>
      </div>
      <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
        ${t('内置目录是编译进 pi-ai 的静态快照，上游上新模型它不会自己更新。这里按同一个数据源（models.dev）在运行时把差集补进目录，只加不改——内置目录里已有的模型一律不碰。', 'The built-in catalog is a static snapshot compiled into pi-ai and never updates itself. This pulls the same source pi uses (models.dev) at runtime and adds only what the snapshot is missing; models already in the catalog are never touched.')}
      </p>
      <div style="font-size: 13px;">
        ${d.lastError
          ? `<span style="color: var(--color-warn-800);">${t('上次刷新失败', 'Last refresh failed')}：${esc(d.lastError)}</span>`
          : `<span style="color: var(--muted-foreground);">${t('上次刷新', 'Last refreshed')}：${esc(fmtTime(d.fetchedAt))} · ${esc(cadence)}</span>`}
      </div>
      <div style="font-size: 13px; color: var(--muted-foreground);">
        ${t(`models.dev 收录 ${d.upstream} 个可用模型，其中 ${d.added} 个是内置目录里没有的，已补进目录并标为「自动发现」。`,
             `models.dev lists ${d.upstream} usable models; ${d.added} of them are missing from the built-in catalog and have been added, tagged "discovered".`)}
      </div>
    </div>`
}

/**
 * 单价覆盖。**目录里的价只是默认值**，这张表压在它上面。
 *
 * 存在的理由是两件真事：pi-ai 没收录价格的模型（目录里四项全是 0）得有地方补；
 * 上游调价的那天不该等 pi-ai 发版才能跟上。
 */
function modelPriceModal() {
  const d = state.priceDraft
  if (!d) return ''
  /**
   * 占位符 = **留空的话真正会收的价**，所以目录价没有时要往下落到兜底价。
   * 目录里四项全 0 的模型（pi-ai 没收录价格的那批）正是兜底要接的那一批，占位符
   * 仍旧写 0 的话，这一屏会告诉人「留空就是免费」——而它现在按兜底收。
   */
  const dflt = defaultRate()
  // 留空的话这几个框会按什么价收：只要有一项的占位符来自兜底，这句提示就该换成兜底那一版。
  const onDefault = hasDefaultRate() && ['input', 'output'].some((k) => !Number(d.catalog[k]) && Number(dflt[k]))
  const ph = (key) => String(Number(d.catalog[key]) || Number(dflt[key]) || 0)
  const field = (label, key, hint) => `
    <div class="field">
      <label>${esc(label)}</label>
      <input class="input" type="number" min="0" step="0.01" data-act="price-field" data-field="${esc(key)}" value="${esc(d[key])}" placeholder="${esc(hint || '')}">
    </div>`
  return `
    <div class="gw-modal-backdrop" data-act="model-price-close">
      <div class="gw-modal" data-stop role="dialog" aria-modal="true" style="max-width: 560px;">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t('改价')} · ${esc(d.key)}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('每 100 万 token 多少美元，和内置目录同一个单位。留空的那一项就用目录价（占位符里显示的就是它），四项全留空 = 撤掉覆盖。', 'USD per 1M tokens, same unit as the built-in catalog. A blank field keeps the catalog price (shown as the placeholder); clearing all four drops the override.')}</p>
        </div>
        ${state.priceError ? `<div class="gw-flash gw-flash-err">${esc(state.priceError)}</div>` : ''}
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
          ${field(t('输入单价 / 1M'), 'input', ph('input'))}
          ${field(t('输出单价 / 1M'), 'output', ph('output'))}
          ${field(t('缓存读单价 / 1M'), 'cacheRead', String(Number(d.catalog.cacheRead) || Number(d.catalog.input) || Number(dflt.cacheRead) || Number(dflt.input) || 0))}
          ${field(t('缓存写单价 / 1M'), 'cacheWrite', String(Number(d.catalog.cacheWrite) || Number(d.catalog.input) || Number(dflt.cacheWrite) || Number(dflt.input) || 0))}
        </div>
        <div style="font-size: 12px; color: var(--muted-foreground);">
          ${
            onDefault
              ? t('目录里没有这个模型的价，占位符是「单价倍率」里那份兜底价——留空就按它收，不是免费。填上之后这个模型就用自己的价，不再吃兜底。', 'The catalog has no price for this model, so the placeholders are the default rate from Pricing — leaving them blank charges at that rate, not at zero. Fill them in and this model uses its own price instead of the default.')
              : t('占位符是目录里的价。0 读作「没填」，不是「这一项免费」——要真免费，去掉这个模型的授权，别把单价填成 0。', 'Placeholders are the catalog prices. A 0 reads as "not set", not "free" — to actually stop offering a model, remove it, do not price it at 0.')
          }
        </div>
        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('目录里也没有的缓存单价按输入价算。改价只影响之后的调用——已经落账的金额不会跟着变。', 'Cache prices missing from the catalog too fall back to the input rate. A price change only affects later calls; amounts already booked never move.')}</p>
        <div style="display: flex; justify-content: space-between; gap: var(--space-2);">
          <button type="button" class="satu-linkbtn" data-act="model-price-clear" ${state.busy ? 'disabled' : ''}>${t('撤掉覆盖')}</button>
          <div style="display: flex; gap: var(--space-2);">
            <button type="button" class="btn btn-ghost" data-act="model-price-close">${t('取消')}</button>
            <button type="button" class="btn btn-primary" data-act="model-price-save" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
          </div>
        </div>
      </div>
    </div>`
}

function addProviderModal() {
  if (!state.addOpen) return ''
  // 配过的不再列。（这一页只有 owner 进得来，所以只有平台那一份口径。）
  const taken = configuredSet()
  const available = state.catalog.filter((p) => !taken.has(p.provider))
  const options = available.length
    ? available.map((p) => `<option value="${esc(p.provider)}">${esc(p.name || p.provider)}</option>`).join('')
    : `<option value="">${t('没有可添加的供应商')}</option>`
  return `
    <div class="gw-modal-backdrop" data-act="add-close">
      <div class="gw-modal" data-act="add-dialog" role="dialog" aria-modal="true" aria-labelledby="add-prov-title">
        <div>
          <h2 id="add-prov-title" style="font-size: 20px; margin: 0 0 4px;">${t('添加供应商')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('从目录选择尚未配置的供应商，粘贴 API 密钥。密钥只存在 Gateway，保存后不会回显。')}</p>
        </div>
        <form data-form="add-cred" style="display: flex; flex-direction: column; gap: var(--space-4);">
          <div class="field">
            <label for="add-provider">${t('供应商')}</label>
            <select class="input" id="add-provider" name="provider" required ${available.length ? '' : 'disabled'}>
              ${options}
            </select>
          </div>
          <div class="field">
            <label for="add-secret">${t('API 密钥')}</label>
            <input class="input" id="add-secret" name="secret" type="password" autocomplete="off" placeholder="${esc(t('API 密钥'))}" required>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
            <button type="button" class="btn btn-ghost" data-act="add-close">${t('取消')}</button>
            <button type="submit" class="btn btn-primary" ${state.busy || !available.length ? 'disabled' : ''}>${t('保存')}</button>
          </div>
        </form>
      </div>
    </div>`
}

/**
 * 列表 = 已配好密钥的内置供应商 ∪ 全部自定义供应商。
 *
 * 自定义的即使还没配密钥也要列出来——它是刚建出来的，不列的话没有地方能给它贴密钥。
 */
function providerRows() {
  const credBy = new Map((state.creds || []).map((c) => [c.provider, c]))
  const rows = configuredProviders().map((p) => ({
    provider: p.provider,
    name: p.name || p.provider,
    models: p.models || [],
    custom: null,
    cred: credBy.get(p.provider),
  }))
  const seen = new Set(rows.map((r) => r.provider))
  for (const c of state.customProviders || []) {
    const models = state.catalog.find((x) => x.provider === c.id)?.models || []
    const existing = rows.find((r) => r.provider === c.id)
    if (existing) {
      existing.custom = c
      existing.name = c.name || c.id
      continue
    }
    seen.add(c.id)
    rows.push({ provider: c.id, name: c.name || c.id, models, custom: c, cred: credBy.get(c.id) })
  }
  return rows.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'))
}

/** 用量金额。可能很小（$0.0004），也可能很大；小额要多给两位，否则全是 $0.00。 */
function usage$(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return '—'
  if (x === 0) return '$0'
  if (x < 0.01) return `$${x.toFixed(4)}`
  if (x < 1) return `$${x.toFixed(3)}`
  return `$${x.toFixed(2)}`
}

/** 账本上的金额是**微元**（百万分之一美元）。显示时换成美元，运算永远用微元。 */
function usageMicros$(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return '—'
  return usage$(x / 1_000_000)
}

/** 精确的 token 数。tokens() 是给目录里的窗口用的，会四舍五入成 128K，统计不能那样。 */
function exactTokens(n) {
  return Number(n || 0).toLocaleString('en-US')
}

/**
 * 用量屏上的汇总 token 数，一律按 M 画。几千万的数字一长串，读的人得数位数；
 * 统一成 M 之后几张卡片、成员表那一列能直接横着比。精确值挂在 title 上。
 */
function megaTokens(n) {
  const x = Number(n) || 0
  if (!x) return '0'
  const m = x / 1_000_000
  return m < 0.01 ? '<0.01M' : `${m.toFixed(2)}M`
}

/**
 * 计费明细的单行 token 数：一次调用从几十到几十万都有，所以按量级挑单位——
 * 不到 1K 原样，到 K 没到 M 用 K，到 M 用 M。最多两位小数，末尾的 0 去掉。
 */
function scaledTokens(n) {
  const x = Number(n) || 0
  const fmt = (v, unit) => `${String(Number(v.toFixed(2)))}${unit}`
  // 999,999 按 K 四舍五入会成「1000K」，那一档直接进 M。
  if (x >= 1_000_000 || Number((x / 1000).toFixed(2)) >= 1000) return fmt(x / 1_000_000, 'M')
  if (x >= 1000) return fmt(x / 1000, 'K')
  return exactTokens(x)
}

/**
 * 计费明细：一次调用一行。
 *
 * 这张表回答的是三个 `*-stats` 回答不了的那个问题——「这个月为什么是这个数」。
 * 每行摊开当时的计量、当时的单价、当时的倍率，乘出来就是金额；改过价之后仍然对得上。
 *
 * `scope` 决定画不画公司那一列：平台看全平台要，公司自己看不要。
 * `forOrg` 是「看的是哪一家」——owner 在公司详情页上看的不是自己的公司，
 * 翻页时得把这个 id 带上，否则请求会打到 `/orgs//charges`。
 */
function chargeTable(scope, forOrg) {
  const d = state.charges
  const list = d?.charges || []
  /**
   * 单价和倍率只画给平台自己看。公司那边（管理员、员工）看到的是「用了多少、扣了多少」，
   * 中间那一步怎么定价的是平台的事——把倍率摊在客户面前，等于把成本价一起交出去了。
   */
  const withPrice = isOwner()
  const kinds = [
    { key: '', label: t('全部', 'All') },
    { key: 'llm', label: t('模型', 'Model') },
    { key: 'connector', label: t('连接器', 'Connector') },
    { key: 'web', label: t('网页', 'Web') },
  ]
    .map(
      (k) =>
        `<button type="button" class="satu-assignee" style="padding: 4px 12px;" aria-pressed="${String((state.chargesKind || '') === k.key)}" data-act="charges-kind" data-kind="${esc(k.key)}" data-scope="${esc(scope)}" data-org="${esc(forOrg || '')}">${esc(k.label)}</button>`,
    )
    .join('')
  const cols = scope === 'platform' ? '150px 1.2fr 1fr 1.6fr 1fr 100px' : '150px 1fr 1.6fr 1fr 100px'
  // 金额那一列的数字是右对齐的，表头也得跟着右对齐——否则「金额」两个字停在列的
  // 左边、数字停在右边，读的人得横着找一下才知道这一列叫什么。
  const amountHead = `<span style="text-align: right;">${t('金额')}</span>`
  const head = scope === 'platform'
    ? `<span>${t('时间')}</span><span>${t('公司')}</span><span>${t('成员')}</span><span>${t('对象')}</span><span>${t('计量')}</span>${amountHead}`
    : `<span>${t('时间')}</span><span>${t('成员')}</span><span>${t('对象')}</span><span>${t('计量')}</span>${amountHead}`
  const rows = list
    .map((c) => {
      const who = `<span title="${esc(c.accountId)}">${esc(c.accountName)}${c.departed ? ` <span class="tag">${t('已离职', 'former')}</span>` : ''}</span>`
      return `<div class="satu-billrow" style="grid-template-columns: ${cols}; align-items: start; font-variant-numeric: tabular-nums;">
        <span style="font-size: 12.5px; color: var(--muted-foreground);">${esc(fmtTime(c.createdAt))}</span>
        ${scope === 'platform' ? `<span style="font-size: 13px;">${esc(c.companyName)}</span>` : ''}
        <span style="font-size: 13px;">${who}</span>
        <div style="min-width: 0;">
          <div style="font-size: 13px; font-weight: 600; overflow-wrap: anywhere;">${esc(c.subject)}</div>
          <div style="font-size: 11.5px; color: var(--muted-foreground);">${esc(kindLabel(c.kind))}${c.status !== 'ok' ? ` · ${esc(statusLabel(c.status))}` : ''}${c.unpriced ? ` · <span title="${esc(t('这次没查到单价，金额不是 0 而是算不出来', 'No price found; the 0 means unknown, not free'))}">${t('无单价', 'unpriced')}</span>` : ''}</div>
        </div>
        <div style="min-width: 0; font-size: 11.5px; color: var(--muted-foreground);">${chargeQuantity(c, withPrice)}</div>
        <div style="text-align: right;">
          <div style="font-size: 13px; font-weight: 600;">${esc(usageMicros$(c.amountMicros))}</div>
          ${c.amountMicros > 0 ? `<div style="font-size: 11px; color: var(--muted-foreground);">${t('赠送', 'bonus')} ${esc(usageMicros$(c.bonusMicros))}</div>` : ''}
        </div>
      </div>`
    })
    .join('')
  const page = state.chargesCursors.length
  const more = d?.hasMore
  return `
    <div style="display: flex; flex-direction: column; gap: var(--space-3);">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
        <h2 style="font-size: 18px; margin: 0;">${t('计费明细')}</h2>
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">${kinds}</div>
      </div>
      <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
        <div class="satu-billhead" style="grid-template-columns: ${cols};">${head}</div>
        ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${state.chargesLoading ? t('加载中…') : t('这个范围里还没有计费记录。')}</div>`}
      </div>
      ${
        // 只有真有第二页时才画翻页——不然就是两颗永远点不动的按钮（同公司那几张表）。
        more || page > 1
          ? `<div style="display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2);">
              <span style="font-size: 12px; color: var(--muted-foreground);">${t(`第 ${page} 页`, `Page ${page}`)}</span>
              <button type="button" class="btn btn-ghost" data-act="charges-prev" data-scope="${esc(scope)}" data-org="${esc(forOrg || '')}" ${page > 1 && !state.chargesLoading ? '' : 'disabled'}>${t('上一页')}</button>
              <button type="button" class="btn btn-ghost" data-act="charges-next" data-scope="${esc(scope)}" data-org="${esc(forOrg || '')}" ${more && !state.chargesLoading ? '' : 'disabled'}>${t('下一页')}</button>
            </div>`
          : ''
      }
      ${/* 这句讲的是单价和倍率怎么定死的，只对看得见那两样的人有意义；
            公司那边看到的是「用了多少、扣了多少」，不需要一句解释定价的话垫底。 */ ''}
      ${withPrice ? `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('金额是写行那一刻按当时单价和倍率算的，之后改价不会追溯改动这些数。', 'Amounts are computed when the row is written, from the price and multiplier of that moment; later price changes are not retroactive.')}</p>` : ''}
    </div>`
}

function kindLabel(kind) {
  if (kind === 'llm') return t('模型', 'Model')
  if (kind === 'connector') return t('连接器', 'Connector')
  if (kind === 'web') return t('网页', 'Web')
  return kind
}

function statusLabel(status) {
  const map = {
    ok: t('成功', 'ok'),
    failed: t('失败', 'failed'),
    timeout: t('超时', 'timeout'),
    denied: t('被拒', 'denied'),
    error: t('出错', 'error'),
  }
  return map[status] || status
}

/**
 * 计量那一格。**平台侧同时画计量和单价**——「4000 token × $1.00」比单看哪一个都有用，
 * 对平台来说这一列存在的全部意义就是让人自己乘一遍对得上金额。
 *
 * `withPrice` 为假时只画消耗（token 数、条数、次数）：公司那边看到的是自己被扣了多少，
 * 单价和倍率是平台怎么定价的，不摊在客户面前。金额那一列照画——那是真扣掉的钱。
 */
function chargeQuantity(c, withPrice) {
  const q = c.quantity || {}
  const p = c.unitPrice || {}
  const lines = []
  if (c.kind === 'llm') {
    const line = (label, tok, rate) => (tok ? `${label} ${scaledTokens(tok)}${withPrice ? ` × ${money(rate)}` : ''}` : '')
    const cached = Number(q.cachedTokens || 0)
    const written = Number(q.cacheWriteTokens || 0)
    const fresh = Math.max(0, Number(q.promptTokens || 0) - cached - written)
    lines.push(line(t('输入', 'in'), fresh, p.input))
    if (cached) lines.push(line(t('缓存读', 'cache read'), cached, p.cacheRead))
    if (written) lines.push(line(t('缓存写', 'cache write'), written, p.cacheWrite))
    lines.push(line(t('输出', 'out'), Number(q.completionTokens || 0), p.output))
  } else if (c.kind === 'web') {
    const units = Number(q.units || 0)
    lines.push(withPrice
      ? t(`${units} 条 × ${usageMicros$(p.unit)}`, `${units} units × ${usageMicros$(p.unit)}`)
      : t(`${units} 条`, `${units} units`))
  } else {
    lines.push(withPrice
      ? t(`1 次 × ${usageMicros$(p.unit)}`, `1 call × ${usageMicros$(p.unit)}`)
      : t('1 次', '1 call'))
  }
  /**
   * 带单价的那一版里，倍率对**所有**按倍率报价的种类都要画出来，不只是模型：
   * 这一列的意义是让人自己乘一遍对得上金额。以前倍率只加在模型那一支，
   * 于是倍率 1.2 时网页那行写着「4 条 × $0.0080」（=$0.032）、旁边金额是 $0.0384——
   * 对账的人会先怀疑金额算错了。不画单价的那一版里它没有对手，一起收起来。
   */
  const mult = Number(c.multiplier)
  if (withPrice && Number.isFinite(mult) && mult !== 1) {
    lines.push(t(`倍率 ×${trimNum(mult)}`, `multiplier ×${trimNum(mult)}`))
  }
  return lines.filter(Boolean).map((x) => `<div>${esc(x)}</div>`).join('') || '—'
}

/**
 * 倍率的显示。库里那一列以前是 float4，`1.2` 读回来是 `1.2000000476837158`；
 * 迁移 0009 换成了 double precision，但**老行还是那个数**，所以显示这一步仍要收一下。
 * 六位小数够表达任何人手填得出来的倍率，多出来的位数只会让人以为是别的数。
 */
function trimNum(n) {
  return String(Number(n.toFixed(6)))
}

/**
 * 输入 token 里命中缓存的那一截。**是子集，不是加项**——所以画在输入那一格里面，
 * 不另起一列：另起一列的话，两个数会被读成可以相加。
 */
/**
 * 金额下面那个角标。**三种「这个 $0 不是真的 $0」要各标各的**，因为它们要人办的事
 * 完全不同：
 *
 *   · 没单价   —— 目录里查不到这个模型的价，去模型配置页补上就好了
 *   · 没用量   —— 单价是有的，缺的是那几次调用的用量（上游流里一个 usage 字段都没回、
 *                 或者管家拿了授权之后再也没回来）。**别去改配置，那里没毛病**
 *   · 无账本   —— 那段历史压根没记过账（多半在计费账本上线之前），补不回来
 *
 * 从前「没单价」和「没用量」共用一个「不全」，于是单价明明配着，界面却一口咬定
 * 「目录里没有单价」，人会跑去配置页找一个不存在的问题。
 *
 * 画在数字**下面一行**而不是后面：这一列是右对齐的数字列，角标跟在数字后面会把
 * 数字往左顶，顶多少取决于角标有多长——于是同一列里 `$4.02`、`$0`、`$0.0034`
 * 各停在各自的位置，一列数字读起来不再是一列。和上面的「缓存」那行同一个办法。
 */
function amountNote(row) {
  const bits = []
  if (row.unpricedCalls) {
    bits.push(`<span title="${esc(t('有调用用的是没有单价的模型，金额没算进去'))}">${t('没单价', 'no price')}</span>`)
  }
  if (row.unmeteredCalls) {
    bits.push(`<span title="${esc(t(`${row.unmeteredCalls} 次调用结算时没拿到用量，单价是有的，金额算不出来`, `${row.unmeteredCalls} call(s) reported no usage at settle time; the price is there, the amount is not computable`))}">${t('没用量', 'no usage')}</span>`)
  }
  if (row.unledgeredCalls) {
    bits.push(`<span title="${esc(t(`${row.unledgeredCalls} 次调用在账本上没有记录，金额补不回来`, `${row.unledgeredCalls} call(s) have no ledger row; the amount cannot be reconstructed`))}">${t('无账本', 'no ledger')}</span>`)
  }
  return bits.length ? `<div style="font-size: 11.5px; opacity: 0.7;">${bits.join(' · ')}</div>` : ''
}

function cacheNote(row) {
  const cached = Number(row.cachedTokens || 0)
  const written = Number(row.cacheWriteTokens || 0)
  if (!cached && !written) return ''
  const bits = []
  if (cached) bits.push(t(`读 ${exactTokens(cached)}`, `read ${exactTokens(cached)}`))
  if (written) bits.push(t(`写 ${exactTokens(written)}`, `write ${exactTokens(written)}`))
  return `<div style="font-size: 11.5px; opacity: 0.7;" title="${esc(t('这一截包含在左边的输入 token 里，单价另算', 'Included in the input tokens on the left; priced separately'))}">${t('缓存', 'cache')} ${bits.join(' · ')}</div>`
}

function statsPage() {
  const d = state.stats
  const month = state.statsMonth || thisMonth()
  const pill = (key, label) =>
    `<button type="button" class="btn ${state.statsRange === key ? 'btn-primary' : 'btn-ghost'}" data-act="stats-range" data-range="${key}">${label}</button>`

  const totals = d?.totals || { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, costMicros: 0, amountMicros: 0, unpricedCalls: 0, unmeteredCalls: 0, unledgeredCalls: 0 }
  const hitRate = totals.promptTokens > 0 ? Math.round((totals.cachedTokens / totals.promptTokens) * 100) : 0
  /**
   * 网页工具按**条**收、连接器按**次**收，跟 token 不是一个量纲，所以下面各有各的表；
   * 但钱是同一笔——月底从余额里扣掉的是三条路的和。上面这两张金额卡因此报的是**总数**，
   * 而不只是模型那一份：只报模型的话，卡上的数字比账单小，少掉的那截在这一屏上找不着。
   */
  const zero = { calls: 0, amountMicros: 0, costMicros: 0 }
  const spend = d?.money || { llm: zero, connector: zero, web: zero, all: zero }
  const web = d?.web || { byCompany: [], byBackend: [], totals: { calls: 0, units: 0, amountMicros: 0 } }
  const conn = d?.connector || { byConnector: [], totals: { calls: 0, amountMicros: 0 } }
  /**
   * 金额卡底下那行拆分。**只有真有两条以上的路花了钱才画**——单独一条路的时候，
   * 这一行就是把上面那个数原样抄一遍。
   */
  const split = (pick) => {
    const parts = [
      [t('模型', 'model'), spend.llm],
      [t('网页', 'web'), spend.web],
      [t('连接器', 'connector'), spend.connector],
    ].filter(([, m]) => pick(m) > 0)
    // 每一截自己不许断行：卡只有 150px 宽，不管的话会在「网页」和它的金额之间折，
    // 折出来的下一行以一个孤零零的 $0.050 开头，看着像另一个数。
    return parts.length > 1
      ? parts.map(([label, m]) => `<span style="white-space: nowrap;">${esc(label)} ${esc(usageMicros$(pick(m)))}</span>`).join(' · ')
      : ''
  }
  // 调用次数那张卡数的是模型调用（下面的 token 都是它的）。另外两条路的次数挂在底下，
  // 免得「6 次网页调用」在这一屏上只能靠翻表数出来。
  const nowrap = (x) => `<span style="white-space: nowrap;">${esc(x)}</span>`
  const otherCalls = [
    web.totals.calls ? nowrap(t(`网页 ${exactTokens(web.totals.calls)}`, `web ${exactTokens(web.totals.calls)}`)) : '',
    conn.totals.calls ? nowrap(t(`连接器 ${exactTokens(conn.totals.calls)}`, `connector ${exactTokens(conn.totals.calls)}`)) : '',
  ].filter(Boolean)
  const cards = [
    [t('调用次数'), exactTokens(totals.calls), otherCalls.length ? t(`另有 ${otherCalls.join(' · ')}`, `plus ${otherCalls.join(' · ')}`) : ''],
    [t('输入 Tokens'), exactTokens(totals.promptTokens)],
    [t('输出 Tokens'), exactTokens(totals.completionTokens)],
    // 缓存读是 promptTokens 的子集，不是加项。单独一张卡，因为它直接解释「为什么
    // token 涨了金额没怎么涨」——缓存读的单价通常低一个数量级。
    [t('缓存命中'), `${hitRate}%`],
    [t('原价'), usageMicros$(spend.all.costMicros), split((m) => m.costMicros)],
    [t('已扣'), usageMicros$(spend.all.amountMicros), split((m) => m.amountMicros)],
  ]
    .map(
      ([label, value, note]) => `<div class="satu-panel" style="gap: 4px;">
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(label)}</span>
        <span style="font-size: 22px; font-weight: 600;">${esc(value)}</span>
        ${/* note 是上面拼好的 HTML（每一截自带 nowrap），里面的文字已经转义过了。 */ ''}
        ${note ? `<span style="font-size: 11.5px; color: var(--muted-foreground);">${note}</span>` : ''}
      </div>`,
    )
    .join('')

  const rows = (d?.byCompany || [])
    .map(
      (c) => `<div class="satu-statrow">
        <div style="min-width: 0;">
          <div style="font-size: 14px; font-weight: 600;">${esc(c.name)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${c.lastAt ? esc(fmtTime(c.lastAt)) : t('无调用')}</div>
        </div>
        <span style="font-size: 13px;">${esc(exactTokens(c.calls))}</span>
        <div style="font-size: 13px; color: var(--muted-foreground);">${esc(exactTokens(c.promptTokens))}${cacheNote(c)}</div>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(exactTokens(c.completionTokens))}</span>
        <span style="font-size: 13px; font-weight: 600;">${esc(exactTokens(c.promptTokens + c.completionTokens))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(usageMicros$(c.costMicros))}</span>
        <div style="font-size: 13px;">${esc(usageMicros$(c.amountMicros))}${amountNote(c)}</div>
      </div>`,
    )
    .join('')

  const modelRows = (d?.byModel || [])
    .map(
      (m) => `<div class="satu-statrow" style="grid-template-columns: 2fr 1fr 1fr 1fr 1fr 1fr 1fr;">
        <div style="min-width: 0;">
          <div style="font-size: 13.5px; font-weight: 600;">${esc(m.model)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(m.provider)}</div>
        </div>
        <span style="font-size: 13px;">${esc(exactTokens(m.calls))}</span>
        <div style="font-size: 13px; color: var(--muted-foreground);">${esc(exactTokens(m.promptTokens))}${cacheNote(m)}</div>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(exactTokens(m.completionTokens))}</span>
        <span style="font-size: 13px; font-weight: 600;">${esc(exactTokens(m.promptTokens + m.completionTokens))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${m.priced ? esc(usageMicros$(m.costMicros)) : `<span title="${esc(t('目录里没有这个模型的单价'))}">—</span>`}</span>
        <div style="font-size: 13px;">${m.priced ? `${esc(usageMicros$(m.amountMicros))}${amountNote(m)}` : '—'}</div>
      </div>`,
    )
    .join('')

  const unpriced = d?.unpricedModels || []
  const unmetered = d?.unmeteredModels || []
  const unledgered = d?.unledgeredModels || []

  /**
   * 网页工具和连接器都按**次**算钱，跟 token 不是一个量纲，所以各自单开一块，
   * 不混进 token 那几列。金额是写行那一刻的报价，这里只求和，不重算——
   * 重算会让改价追溯改动历史账单。（`web` / `conn` 在上面取，金额卡也要用。）
   */
  const webRows = (web.byBackend || [])
    .map(
      (b) => `<div class="satu-statrow" style="grid-template-columns: 2fr 1fr 1fr 1fr 1fr;">
        <span style="font-size: 13.5px; font-weight: 600;">${esc(b.backend)}</span>
        <span style="font-size: 13px;">${esc(String(b.search))}</span>
        <span style="font-size: 13px;">${esc(String(b.extract))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(String(b.units))}</span>
        <span style="font-size: 13px; font-weight: 600;">${esc(usageMicros$(b.amountMicros))}</span>
      </div>`,
    )
    .join('')

  const connRows = (conn.byConnector || [])
    .map(
      (c) => `<div class="satu-statrow" style="grid-template-columns: 2fr 1fr 1fr;">
        <span style="font-size: 13.5px; font-weight: 600;">${esc(c.connector)}</span>
        <span style="font-size: 13px;">${esc(exactTokens(c.calls))}</span>
        <span style="font-size: 13px; font-weight: 600;">${esc(usageMicros$(c.amountMicros))}</span>
      </div>`,
    )
    .join('')

  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('统计')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('各公司的 token 消耗。「已扣」是账本上真实扣掉的钱（写行那一刻定价，改价不追溯）；「原价」是它除以当时的倍率倒推的。上面那两张金额卡是模型、网页工具、连接器三条路的合计，下面几张表各只管自己那一条。', 'Token consumption per company. "Charged" is what the ledger actually deducted (priced when written; later price changes are not retroactive); "list" divides it back out by the multiplier of the day. The two amount cards sum all three paths — models, web tools and connectors — while each table below covers only its own.')}</p>
        </div>
        ${flashes()}
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
          ${pill('today', t('今日'))}
          ${pill('7d', t('近 7 天'))}
          ${pill('month', t('月'))}
          ${state.statsRange === 'month' ? `<input class="input" type="month" style="width: 170px; flex: none;" value="${esc(month)}" data-act="stats-month">` : ''}
          <select class="input" style="width: 200px; flex: none;" data-act="stats-company">
            <option value="">${t('全部公司')}</option>
            ${(d?.companies || []).map((c) => `<option value="${esc(c.id)}" ${c.id === state.statsCompany ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
          <span style="font-size: 12px; color: var(--muted-foreground);">${state.statsLoading ? t('统计中…') : d ? `${esc(fmtTime(d.from))} — ${esc(fmtTime(d.to))}` : ''}</span>
        </div>
        ${
          unpriced.length
            ? `<div class="gw-flash gw-flash-err">${esc(t(`${unpriced.length} 个模型在目录里没有单价（${unpriced.slice(0, 3).join('、')}${unpriced.length > 3 ? ' …' : ''}），它们的调用没有计入金额。`, `${unpriced.length} model(s) have no price in the catalog (${unpriced.slice(0, 3).join(', ')}${unpriced.length > 3 ? ' …' : ''}); their calls are excluded from the amounts.`))}</div>`
            : ''
        }
        ${
          /**
           * 和「没单价」分开说：那个是配置漏了、现在就能补；这个是**单价好好的**，只是
           * 那几次调用结算时没拿到用量（上游的流一个 usage 字段都没回、或者管家没回来
           * 结算被清扫按 0 元收了口）。去配置页补价补不出这笔钱。
           *
           * 从前这两种共用一句「目录里没有单价」，于是配着价的模型也被这么说，人只能
           * 跑去配置页反复确认一个并不存在的问题。
           */
          unmetered.length
            ? `<div class="gw-flash">${esc(t(`这个时间段里有 ${totals.unmeteredCalls} 次调用在结算时没拿到用量（${unmetered.slice(0, 3).join('、')}${unmetered.length > 3 ? ' …' : ''}），金额算不出来，没计入。这几个模型的单价是有的，不用去改配置。`, `${totals.unmeteredCalls} call(s) in this range reported no usage at settle time (${unmetered.slice(0, 3).join(', ')}${unmetered.length > 3 ? ' …' : ''}); their amounts could not be computed and are excluded. These models do have a price — nothing to change in the settings.`))}</div>`
            : ''
        }
        ${
          // 和上面两条又不一样：那段历史压根没记过账（多半在计费账本上线之前），补不回来。
          // 混成一句话会让人去配置页白找。
          unledgered.length
            ? `<div class="gw-flash">${esc(t(`这个时间段里有 ${totals.unledgeredCalls} 次调用在计费账本上没有记录（${unledgered.slice(0, 3).join('、')}${unledgered.length > 3 ? ' …' : ''}），多半发生在账本上线之前。它们的 token 算数，金额补不回来——这里的 $0 不代表免费。`, `${totals.unledgeredCalls} call(s) in this range have no row in the billing ledger (${unledgered.slice(0, 3).join(', ')}${unledgered.length > 3 ? ' …' : ''}), most likely from before the ledger shipped. Their tokens count; the amounts cannot be reconstructed — the $0 here does not mean free.`))}</div>`
            : ''
        }
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-3);">
          ${cards}
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <h2 style="font-size: 18px; margin: 0;">${t('按公司')}</h2>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-stathead">
              <span>${t('公司')}</span><span>${t('调用')}</span><span>${t('输入')}</span><span>${t('输出')}</span><span>${t('总计')}</span><span>${t('原价')}</span><span>${t('已扣')}</span>
            </div>
            ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${state.statsLoading ? t('统计中…') : t('这个时间段里没有调用。')}</div>`}
          </div>
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <div style="display: flex; align-items: baseline; gap: var(--space-3); flex-wrap: wrap;">
            <h2 style="font-size: 18px; margin: 0;">${t('网页工具')}</h2>
            <span style="font-size: 12px; color: var(--muted-foreground);">
              ${t(`${web.totals.calls} 次调用 · ${web.totals.units} 条 · ${esc(usageMicros$(web.totals.amountMicros))}`, `${web.totals.calls} calls · ${web.totals.units} units · ${esc(usageMicros$(web.totals.amountMicros))}`)}
            </span>
          </div>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-stathead" style="grid-template-columns: 2fr 1fr 1fr 1fr 1fr;">
              <span>${t('后端')}</span><span>${t('搜索')}</span><span>${t('提取')}</span><span>${t('计费条数')}</span><span>${t('报价')}</span>
            </div>
            ${webRows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${state.statsLoading ? t('统计中…') : t('这个时间段里没有网页调用。')}</div>`}
          </div>
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <div style="display: flex; align-items: baseline; gap: var(--space-3); flex-wrap: wrap;">
            <h2 style="font-size: 18px; margin: 0;">${t('连接器')}</h2>
            <span style="font-size: 12px; color: var(--muted-foreground);">
              ${t(`${conn.totals.calls} 次调用 · ${esc(usageMicros$(conn.totals.amountMicros))}`, `${conn.totals.calls} calls · ${esc(usageMicros$(conn.totals.amountMicros))}`)}
            </span>
          </div>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-stathead" style="grid-template-columns: 2fr 1fr 1fr;">
              <span>${t('连接器')}</span><span>${t('调用')}</span><span>${t('已扣')}</span>
            </div>
            ${connRows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${state.statsLoading ? t('统计中…') : t('这个时间段里没有连接器调用。')}</div>`}
          </div>
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <h2 style="font-size: 18px; margin: 0;">${t('按模型')}</h2>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-stathead" style="grid-template-columns: 2fr 1fr 1fr 1fr 1fr 1fr 1fr;">
              <span>${t('模型')}</span><span>${t('调用')}</span><span>${t('输入')}</span><span>${t('输出')}</span><span>${t('总计')}</span><span>${t('原价')}</span><span>${t('已扣')}</span>
            </div>
            ${modelRows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${state.statsLoading ? t('统计中…') : t('这个时间段里没有调用。')}</div>`}
          </div>
        </div>
        ${chargeTable('platform')}
      </div>
    </div>`
}

/**
 * 供应商页。**只有 owner 进得来**（见 state.js 的 allowedHrefs / pathAllowed）。
 *
 * 这一页曾经是三副面孔：owner 配平台那份、公司管理员配本公司那份、员工只读。后两副
 * 撤了——供应商只由平台配，公司既不配也不看。跟着撤掉的是 canEditCreds()（谁改得动
 * 已经没有第二种答案）、credScopeTag()（每行的「本公司密钥 / 平台共用」标，现在全是
 * 平台的）、只读那一整套行，以及「平台共用那把删不掉」的灰按钮。
 */
function providersPage() {
  const list = providerRows()

  const rows = list
    .map((p, i) => {
      const busy = state.tests['provider:' + p.provider]?.status === 'busy'
      const status = p.custom?.broken
        ? `<span class="tag tag-accent">${t('定义有误')}</span>`
        : p.cred
          ? `<span class="tag tag-accent">${t('已配置')}</span>`
          : `<span class="tag">${t('缺密钥')}</span>`
      const delBtn = `<button type="button" class="satu-linkbtn" data-act="prov-delete" data-provider="${esc(p.provider)}" data-custom="${p.custom ? '1' : ''}">${t('删除')}</button>`
      return `<div class="satu-provrow">
        <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
          ${mark(p.name, i % 2 === 1)}
          <div style="min-width: 0;">
            <div style="font-size: 14px; font-weight: 600;">${esc(p.name)}${p.custom ? ` <span class="tag tag-accent-2">${t('自定义')}</span>` : ''}</div>
            <div style="font-size: 12px; color: var(--muted-foreground);">${esc(p.provider)}${p.custom && !p.custom.broken ? ` · ${esc(p.custom.api)}` : ''}</div>
          </div>
        </div>
        <span style="font-size: 13px; color: var(--muted-foreground);">${t(`${p.models.length} 个`, `${p.models.length} models`)}</span>
        <span style="display: flex; gap: var(--space-2); flex-wrap: wrap;">${status}</span>
        <form class="gw-secret" data-form="cred" data-provider="${esc(p.provider)}" data-id="${esc(p.cred?.id || '')}">
          <input class="input" name="secret" type="password" autocomplete="off" placeholder="${esc(p.cred ? t('输入新密钥以更新') : t('粘贴 API 密钥'))}" required>
        </form>
        <div class="gw-provactions">
          ${testMark('provider', p.provider) ? `<div class="gw-testline">${testMark('provider', p.provider)}</div>` : ''}
          ${p.custom ? `<button type="button" class="btn btn-ghost" data-act="prov-edit" data-provider="${esc(p.provider)}">${t('编辑')}</button>` : ''}
          ${p.custom ? `<button type="button" class="btn btn-ghost" data-act="prov-models" data-provider="${esc(p.provider)}">${t(`模型 ${p.custom.models?.length ?? 0}`, `Models ${p.custom.models?.length ?? 0}`)}</button>` : ''}
          <button type="button" class="btn btn-ghost" data-act="test-provider" data-provider="${esc(p.provider)}" ${busy ? 'disabled' : ''}>${t('测试')}</button>
          <button type="button" class="btn btn-primary" data-act="save-cred" data-provider="${esc(p.provider)}" data-id="${esc(p.cred?.id || '')}">${t('更新')}</button>
          ${delBtn}
        </div>
      </div>`
    })
    .join('')

  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('供应商')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t(
              '这一页只配模型供应商：内置的配好密钥才列出来，自定义的建出来就一直在。这几把密钥全平台共用——公司不再各自贴 key。密钥只存在 Gateway，保存后不会回显。',
              'Model providers only. Built-in ones appear once a key is saved; custom ones stay once created. These keys are shared platform-wide — companies no longer paste their own. Keys live only on the Gateway and are never echoed back.',
            )}</p>
            ${/* 连接器和搜索后端的密钥跟模型供应商同住一张表，但它们不是供应商——
                  一行里「几个模型、测一下、哪个角色在用」这些列对它们全都答不上来。
                  清单已经在接口那头滤掉了（见 modelProviderCreds），这里把去处说明白，
                  免得有人在这一页找 Composio 找半天。 */ ''}
            <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted-foreground);">${t(
              '连接器（Composio）的密钥在「连接器」页存，网页搜索与提取后端在「工具配置」页存——它们不是模型供应商，不会出现在这份清单里。',
              'Connector keys (Composio) are saved on the Connectors page and web search/extract backends on the Tools page — neither is a model provider, so neither shows up here.',
            )}</p>
          </div>
          <div style="display: flex; gap: var(--space-2); flex: none;">
            <button type="button" class="btn btn-secondary" data-act="prov-new">${t('添加自定义供应商')}</button>
            <button type="button" class="btn btn-primary" data-act="add-open">${t('添加供应商')}</button>
          </div>
        </div>
        ${flashes()}
        <div class="gw-credlist" style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-provhead">
            <span>${t('供应商')}</span><span>${t('模型')}</span><span>${t('状态')}</span><span>${t('密钥')}</span><span></span>
          </div>
          ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${
            t('还没有配置供应商。点击「添加供应商」从目录里选一家并粘贴密钥，或者「添加自定义供应商」接一个自建端点。')
          }</div>`}
        </div>
      </div>
      ${addProviderModal()}
      ${customProviderModal()}
      ${providerModelsModal()}
    </div>`
}

/** 建 / 改自定义供应商。字段就是 pi-ai createProvider 的入参。 */
function customProviderModal() {
  const d = state.providerDraft
  if (!d) return ''
  const apis = state.customApis?.length ? state.customApis : ['openai-completions']
  return `
    <div class="gw-modal-backdrop" data-act="prov-close">
      <div class="gw-modal" data-stop role="dialog" aria-modal="true">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${d.editing ? t('编辑自定义供应商') : t('添加自定义供应商')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('字段与 pi-ai 的 createProvider 一致。建好之后在这一行贴密钥、加模型。', 'Fields match pi-ai createProvider. Add the key and models on the row afterwards.')}</p>
        </div>
        ${d.error ? `<div class="gw-flash gw-flash-err">${esc(d.error)}</div>` : ''}
        <div class="field">
          <label>${t('id')}</label>
          <input class="input" data-act="prov-field" data-field="id" value="${esc(d.id)}" ${d.editing ? 'disabled' : ''}
            placeholder="my-llm" autocomplete="off">
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('小写字母开头，字母数字和连字符。建好之后不能改——角色、密钥、用量都按它存。', 'Lowercase start, alphanumerics and hyphens. Immutable once created.')}</span>
        </div>
        <div class="field">
          <label>${t('名称')}</label>
          <input class="input" data-act="prov-field" data-field="name" value="${esc(d.name)}" placeholder="My LLM" autocomplete="off">
        </div>
        <div class="field">
          <label>baseUrl</label>
          <input class="input" data-act="prov-field" data-field="baseUrl" value="${esc(d.baseUrl)}" placeholder="https://api.example.com/v1" autocomplete="off">
        </div>
        <div class="field">
          <label>api</label>
          <select class="input" data-act="prov-field" data-field="api">
            ${apis.map((a) => `<option value="${esc(a)}" ${a === d.api ? 'selected' : ''}>${esc(a)}</option>`).join('')}
          </select>
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('自建端点大多是 openai-completions。', 'Self-hosted endpoints are usually openai-completions.')}</span>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
          <button type="button" class="btn btn-ghost" data-act="prov-close">${t('取消')}</button>
          <button type="button" class="btn btn-primary" data-act="prov-save" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
        </div>
      </div>
    </div>`
}

/** 某个自定义供应商的模型清单。改完一次性提交整个 models 数组。 */
function providerModelsModal() {
  if (!state.modelsFor) return ''
  const p = customProvider(state.modelsFor)
  if (!p) return ''
  const d = state.modelDraft
  const rows = (p.models || [])
    .map(
      (m) => `<div class="satu-provrow" style="grid-template-columns: 2fr 1fr 1fr 112px;">
        <div style="min-width: 0;">
          <div style="font-size: 13.5px; font-weight: 600;">${esc(m.name)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(m.id)}</div>
        </div>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(tokens(m.contextWindow))} / ${esc(tokens(m.maxTokens))}</span>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(money(m.cost?.input))} / ${esc(money(m.cost?.output))}<br>${t('缓存', 'cache')} ${esc(money(m.cost?.cacheRead || m.cost?.input))} / ${esc(money(m.cost?.cacheWrite || m.cost?.input))}</span>
        <div style="display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2);">
          <button type="button" class="satu-linkbtn" data-act="prov-model-edit" data-model="${esc(m.id)}">${t('编辑')}</button>
          <button type="button" class="satu-linkbtn" data-act="prov-model-del" data-model="${esc(m.id)}">${t('删除')}</button>
        </div>
      </div>`,
    )
    .join('')
  return `
    <div class="gw-modal-backdrop" data-act="prov-models-close">
      <div class="gw-modal" data-stop role="dialog" aria-modal="true" style="max-width: 720px;">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t(`${esc(p.name)} 的模型`, `${esc(p.name)} models`)}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('单价按每 100 万 token 的美元填，和内置目录同一个单位。', 'Prices are USD per 1M tokens, same unit as the built-in catalog.')}</p>
        </div>
        ${state.providerError ? `<div class="gw-flash gw-flash-err">${esc(state.providerError)}</div>` : ''}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg);">
          ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有模型。')}</div>`}
        </div>
        ${
          d
            ? `<div class="satu-panel">
          <span class="satu-panel-title">${d.editing ? t('编辑模型', 'Edit model') : t('新模型')}</span>
          <div class="field"><label>${t('模型 id')}</label><input class="input" data-act="model-field" data-field="id" value="${esc(d.id)}" placeholder="my-model" autocomplete="off" ${d.editing ? 'disabled' : ''}>${d.editing ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t('模型 id 建好后不能改，避免已配置的模型角色和用量记录失去引用。', 'The model id is immutable so configured roles and usage records keep their reference.')}</span>` : ''}</div>
          <div class="field"><label>${t('名称')}</label><input class="input" data-act="model-field" data-field="name" value="${esc(d.name)}" placeholder="My Model" autocomplete="off"></div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
            <div class="field"><label>${t('上下文窗口')}</label><input class="input" type="number" min="1" data-act="model-field" data-field="contextWindow" value="${esc(d.contextWindow)}"></div>
            <div class="field"><label>${t('最大输出')}</label><input class="input" type="number" min="1" data-act="model-field" data-field="maxTokens" value="${esc(d.maxTokens)}"></div>
            <div class="field"><label>${t('输入单价 / 1M')}</label><input class="input" type="number" min="0" step="0.01" data-act="model-field" data-field="costInput" value="${esc(d.costInput)}"></div>
            <div class="field"><label>${t('输出单价 / 1M')}</label><input class="input" type="number" min="0" step="0.01" data-act="model-field" data-field="costOutput" value="${esc(d.costOutput)}"></div>
            <div class="field"><label>${t('缓存读单价 / 1M')}</label><input class="input" type="number" min="0" step="0.01" data-act="model-field" data-field="costCacheRead" value="${esc(d.costCacheRead)}"></div>
            <div class="field"><label>${t('缓存写单价 / 1M')}</label><input class="input" type="number" min="0" step="0.01" data-act="model-field" data-field="costCacheWrite" value="${esc(d.costCacheWrite)}"></div>
          </div>
          <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('缓存那两项留空就按输入价算。缓存读通常便宜一个数量级，缓存写反而比输入贵——留空等于按最贵的收。', 'Leave the cache prices blank and they fall back to the input price. Cache reads are usually an order of magnitude cheaper and cache writes cost more than input, so blank means charging the highest rate.')}</p>
          <div class="satu-toggleRow">
            <div style="font-size: 13.5px; font-weight: 600;">${t('推理模型')}</div>
            <input type="checkbox" data-act="model-field" data-field="reasoning" ${d.reasoning ? 'checked' : ''}>
          </div>
          <div class="satu-toggleRow">
            <div style="font-size: 13.5px; font-weight: 600;">${t('支持图片输入')}</div>
            <input type="checkbox" data-act="model-field" data-field="image" ${d.image ? 'checked' : ''}>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
            <button type="button" class="btn btn-ghost" data-act="prov-model-cancel">${t('取消')}</button>
            <button type="button" class="btn btn-primary" data-act="prov-model-save" ${state.busy ? 'disabled' : ''}>${d.editing ? t('保存') : t('添加')}</button>
          </div>
        </div>`
            : `<button type="button" class="btn btn-secondary" data-act="prov-model-new">${t('添加模型')}</button>`
        }
        <div style="display: flex; justify-content: flex-end;">
          <button type="button" class="btn btn-ghost" data-act="prov-models-close">${t('完成')}</button>
        </div>
      </div>
    </div>`
}

function companyPage() {
  const c = state.org || state.me?.company || {}
  const plan = state.plan || state.me?.plan || { seats: 1, used: 0 }
  return `
    <div class="gw-page">
      <div class="gw-page-inner narrow">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('公司')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('名称、slug、联系人和访问地址。席位由系统管理员分配。')}</p>
        </div>
        ${flashes()}
        <form id="company-form" class="satu-panel" style="gap: var(--space-4);">
          <span class="satu-panel-title">${t('资料')}</span>
          <div class="field">
            <label for="co-name">${t('名称')}</label>
            <input class="input" id="co-name" name="name" value="${esc(c.name || '')}" required>
          </div>
          <div class="field">
            <label for="co-slug">slug</label>
            <input class="input" id="co-slug" name="slug" value="${esc(c.slug || '')}" required>
          </div>
          <div class="field">
            <label for="co-url">${t('访问地址')}</label>
            <input class="input" id="co-url" name="accessUrl" value="${esc(c.accessUrl || '')}" placeholder="https://acme.satuwork.com">
          </div>
          <div class="field">
            <label for="co-contact-name">${t('联系人')}</label>
            <input class="input" id="co-contact-name" name="contactName" value="${esc(c.contactName || '')}" required>
          </div>
          <div class="field">
            <label for="co-contact-phone">${t('电话')}</label>
            ${phoneField('co-contact-phone', c.contactPhone)}
          </div>
          <div class="field">
            <label for="co-contact-email">${t('联系邮箱')}</label>
            <input class="input" id="co-contact-email" name="contactEmail" type="email" value="${esc(c.contactEmail || '')}" required>
          </div>
          <div class="field">
            <label for="co-address">${t('公司地址')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
            <input class="input" id="co-address" name="address" value="${esc(c.address || '')}">
          </div>
          <div class="field">
            <label for="co-website">${t('网站')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
            <input class="input" id="co-website" name="website" value="${esc(c.website || '')}" placeholder="https://acme.com">
          </div>
          ${/* 转人工的对外通知（见 docs/handoff.md §6 第 3 层）。摆在公司资料里而不是
                Bot 模版里：它是一家公司往哪儿发消息，跟某一颗 Bot 怎么干活无关。 */ ''}
          <div class="field">
            <label for="co-handoff-hook">${t('转人工通知地址', 'Handoff webhook')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
            <input class="input" id="co-handoff-hook" name="handoffWebhook" value="${esc(c.handoffWebhook || '')}" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…">
            <span style="font-size: 12px; color: var(--muted-foreground);">${t(
              '飞书 / 企业微信 / Slack 群机器人的 webhook。Bot 卡住、需要人处理时往这里发一条——浏览器关着的时候（比如半夜的日常任务），这是唯一叫得醒人的路。留空就只在站内提醒。',
              'A Feishu / WeCom / Slack bot webhook. When a bot hands something over, a message goes here — with no browser open (a routine at 3am, say) this is the only way anyone finds out. Leave empty for in-app only.',
            )}</span>
          </div>
          <div class="field">
            <label>${t('席位')}</label>
            <p style="margin: 0; font-size: 14px;">${t(`已用 ${esc(plan.used || 0)} / ${esc(plan.seats || 0)}`, `${esc(plan.used || 0)} / ${esc(plan.seats || 0)} used`)}</p>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('席位由系统管理员分配')}</span>
          </div>
          <div class="field">
            <label>${t('订阅套餐')}</label>
            <p style="margin: 0; font-size: 14px;">${esc(planLabel(plan) || t('无套餐'))}</p>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('到期时间')} ${esc(plan.expiresAt ? dayISO(plan.expiresAt) : t('不限期'))}</span>
          </div>
          <div style="display: flex; justify-content: flex-end;">
            <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
          </div>
        </form>
      </div>
    </div>`
}

function memberMeId() {
  return state.memberMe?.id || state.me?.account?.id || ''
}

function roleLabelOf(role) {
  if (role === 'admin') return t('管理员')
  if (role === 'owner') return t('系统管理员')
  return t('成员')
}

const GROUP_ICONS = [
  { key: 'chat', name: '对话', paths: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'] },
  { key: 'chart', name: '数据', paths: ['M3 3v16a2 2 0 0 0 2 2h16', 'M8 17v-4', 'M13 17v-9', 'M18 17v-6'] },
  {
    key: 'users',
    name: '团队',
    paths: [
      'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
      'M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
      'M22 21v-2a4 4 0 0 0-3-3.87',
      'M16 3.13a4 4 0 0 1 0 7.75',
    ],
  },
  { key: 'guest', name: '外部', paths: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3a13 13 0 0 1 0 18 13 13 0 0 1 0-18z'] },
  { key: 'code', name: '研发', paths: ['m8 8-4 4 4 4', 'm16 8 4 4-4 4', 'm13 6-2 12'] },
  { key: 'deal', name: '销售', paths: ['M3 3h8l10 10-8 8L3 11z', 'M7 7h.01'] },
  { key: 'shield', name: '权限', paths: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'm9 12 2 2 4-4'] },
  { key: 'star', name: '重点', paths: ['m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z'] },
]

function groupIcon(key, size = 16) {
  const g = GROUP_ICONS.find((x) => x.key === key) || GROUP_ICONS[0]
  return svg(g.paths, size)
}

function emptyGroupForm() {
  return { name: '', desc: '', icon: 'chat', role: 'member', members: [] }
}

function syncGroupForm() {
  const name = document.getElementById('gp-name')
  const desc = document.getElementById('gp-desc')
  if (name instanceof HTMLInputElement) state.groupForm.name = name.value
  if (desc instanceof HTMLInputElement) state.groupForm.desc = desc.value
}

function groupById(id) {
  return (state.groups || []).find((g) => g.id === id)
}

const MEMBER_STATUS = {
  active: { label: '已激活', tag: 'tag-accent-2', hint: '可正常登录并使用已授权的 AI 员工。' },
  invited: { label: '待接受', tag: 'tag-accent', hint: '等 TA 用邀请链接设完口令，会自动转为已激活。' },
  disabled: { label: '已停用', tag: 'tag-neutral', hint: '立即断开其全部登录，且无法再登录。历史记录保留。' },
}

function ago(ts) {
  if (!ts) return t('从未登录')
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return t('刚刚')
  if (m < 60) return t(`${m} 分钟前`, `${m} min ago`)
  if (m < 60 * 24) return t(`${Math.floor(m / 60)} 小时前`, `${Math.floor(m / 60)} h ago`)
  return t(`${Math.floor(m / 1440)} 天前`, `${Math.floor(m / 1440)} d ago`)
}

function canBeStatus(member, key) {
  return key === 'invited' ? member.status === 'invited' : member.status !== 'invited' || key === 'disabled'
}

function whyNotStatus(key) {
  return key === 'invited'
    ? t('已激活的账号退不回待接受。要让 TA 重设口令，用下面的重置链接。')
    : t('等 TA 用邀请链接设完口令，会自动转为已激活。')
}

function iconCopy() {
  return svg(
    [
      'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z',
      'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
    ],
    15,
  )
}

function statCard(label, value) {
  return `<div class="satu-stat">
    <span style="font-size: 12px; color: var(--muted-foreground);">${esc(label)}</span>
    <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(value)}</span>
  </div>`
}

function confirmModal() {
  const c = state.confirm
  if (!c) return ''
  return `<div class="gw-modal-backdrop" data-act="confirm-cancel">
    <div class="gw-modal" data-stop>
      <div>
        <h2 style="font-size: 20px; margin: 0 0 4px;">${esc(c.title)}</h2>
        <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${esc(c.body)}</p>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="confirm-cancel">${t('取消')}</button>
        <button type="button" class="btn btn-primary" data-act="confirm-ok">${esc(t(c.label))}</button>
      </div>
    </div>
  </div>`
}

function secretModal() {
  const s = state.secret
  if (!s) return ''
  const days = Math.max(0, Math.round((s.expiresAt - Date.now()) / 86400000))
  const hours = Math.max(0, Math.round((s.expiresAt - Date.now()) / 3600000))
  const ttl = days >= 1 ? t(`${days} 天后过期`, `expires in ${days} d`) : t(`${hours || 1} 小时内有效`, `valid for ${hours || 1} h`)
  return `<div class="gw-modal-backdrop" data-act="secret-close">
    <div class="gw-modal" data-stop>
      <div>
        <h2 style="font-size: 20px; margin: 0 0 4px;">${esc(s.title)}</h2>
        <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
          ${t(`把这条链接发给 <b>${esc(s.email)}</b>，他打开后自行设置口令。链接只显示这一次，${esc(ttl)}，用过即失效。`, `Send this link to <b>${esc(s.email)}</b>; they set their own password. Shown once, ${esc(ttl)}, single use.`)}
        </p>
      </div>
      <div style="display: flex; align-items: center; gap: var(--space-2);">
        <code class="satu-code" style="flex: 1; min-width: 0; padding: 10px var(--space-3); font-size: 12.5px; overflow-x: auto; white-space: nowrap;">${esc(s.url)}</code>
        <button type="button" class="btn btn-secondary" style="flex: none;" data-act="secret-copy">${iconCopy()} ${state.inviteCopied && state.secret ? t('已复制') : t('复制')}</button>
      </div>
      <div style="display: flex; justify-content: flex-end;">
        <button type="button" class="btn btn-primary" data-act="secret-close">${t('我记下了')}</button>
      </div>
    </div>
  </div>`
}

function inviteModal() {
  if (!state.inviteOpen) return ''
  const f = state.inviteForm
  const link = state.inviteLink
  const btn = state.busy
    ? t('生成中…')
    : link
      ? state.inviteCopied
        ? t('已复制')
        : t('再复制一次')
      : t('生成并复制链接')
  return `<div class="gw-modal-backdrop" data-act="invite-close">
    <form id="invite-form" class="gw-modal" style="max-width: 500px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t('邀请成员')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('生成一条一次性邀请链接，发给要加入的同事。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="invite-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
        <div class="field">
          <label for="iv-name">${t('姓名')}</label>
          <input class="input" id="iv-name" name="name" type="text" value="${esc(f.name)}" placeholder="${esc(t('受邀人姓名'))}" ${link ? 'disabled' : ''}>
        </div>
        <div class="field">
          <label for="iv-email">${t('邮箱')}</label>
          <input class="input" id="iv-email" name="email" type="email" required value="${esc(f.email)}" placeholder="name@acme.com" ${link ? 'disabled' : ''}>
        </div>
      </div>
      <span style="font-size: 12px; color: var(--muted-foreground); margin-top: calc(var(--space-3) * -1);">${t('链接只对该邮箱有效，对方打开后仅需设置口令即可加入。')}</span>
      <div class="field">
        <label for="iv-link">${t('一次性邀请链接')}</label>
        <input class="input" id="iv-link" type="text" readonly value="${esc(link)}" placeholder="${esc(t('点下方按钮生成'))}" style="min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;">
        <span style="font-size: 12px; color: var(--muted-foreground);">${t('仅可使用 1 次，生成后按下方有效期失效。链接只显示这一次。')}</span>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
        <div class="field">
          <label for="iv-role">${t('角色')}</label>
          <select class="input" id="iv-role" name="role" ${link ? 'disabled' : ''}>
            <option value="member" ${f.role === 'member' ? 'selected' : ''}>${t('成员')}</option>
            <option value="admin" ${f.role === 'admin' ? 'selected' : ''}>${t('管理员')}</option>
          </select>
        </div>
        <div class="field">
          <label for="iv-ttl">${t('链接有效期')}</label>
          <select class="input" id="iv-ttl" name="ttlDays" ${link ? 'disabled' : ''}>
            <option value="1" ${String(f.ttlDays) === '1' ? 'selected' : ''}>${t('1 天')}</option>
            <option value="7" ${String(f.ttlDays) === '7' ? 'selected' : ''}>${t('7 天')}</option>
            <option value="30" ${String(f.ttlDays) === '30' ? 'selected' : ''}>${t('30 天')}</option>
          </select>
        </div>
      </div>
      ${state.inviteError ? `<div class="gw-flash gw-flash-err">${esc(state.inviteError)}</div>` : ''}
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="invite-close">${link ? t('完成') : t('取消')}</button>
        <button type="submit" class="btn btn-primary" style="min-width: 104px;" ${state.busy ? 'disabled' : ''}>${btn}</button>
      </div>
    </form>
  </div>`
}

function groupModal() {
  if (!state.groupDialog) return ''
  const f = state.groupForm
  const editing = !!(state.groupDialog && state.groupDialog.id)
  const icons = GROUP_ICONS.map((g) => {
    const on = f.icon === g.key
    return `<button type="button" class="satu-iconpick" aria-pressed="${String(on)}" aria-label="${esc(g.name)}" title="${esc(g.name)}" data-act="group-icon" data-icon="${esc(g.key)}">${svg(g.paths)}</button>`
  }).join('')
  const roles = ['admin', 'member']
    .map(
      (key) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(f.role === key)}" data-act="group-role" data-role="${key}">${roleLabelOf(key)}</button>`,
    )
    .join('')
  const picked = new Set(f.members || [])
  const people = (state.accounts || [])
    .map((m) => {
      const on = picked.has(m.id)
      const label = m.name ? `${m.name} · ${m.email}` : m.email
      return `<button type="button" class="satu-fileitem" aria-current="${String(on)}" data-act="group-toggle-member" data-id="${esc(m.id)}">
        <span class="satu-avatar" style="width: 24px; height: 24px; font-size: 11px; background: var(--color-neutral-300); color: var(--color-neutral-800);">${esc((m.name || m.email).slice(0, 1).toUpperCase())}</span>
        <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(label)}</span>
        ${on ? `<span style="margin-left: auto; display: flex;">${svg(['m5 13 4 4L19 7'], 14)}</span>` : ''}
      </button>`
    })
    .join('')
  return `<div class="gw-modal-backdrop" data-act="group-close">
    <form id="group-form" class="gw-modal" style="max-width: 460px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${editing ? t('管理分组') : t('新建分组')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('分组用于批量授权与统计，成员可同时属于多个分组。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="group-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div class="field">
        <label for="gp-name">${t('分组名称')}</label>
        <input class="input" id="gp-name" name="name" type="text" required value="${esc(f.name)}" placeholder="${esc(t('例如：客服组'))}">
      </div>
      <div class="field">
        <label for="gp-desc">${t('说明（可选）')}</label>
        <input class="input" id="gp-desc" name="desc" type="text" value="${esc(f.desc)}" placeholder="${esc(t('这个分组负责什么'))}">
      </div>
      <div class="field">
        <label>${t('分组图标')}</label>
        <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${icons}</div>
      </div>
      <div class="field">
        <label>${t('默认角色')}</label>
        <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${roles}</div>
        <span style="font-size: 12px; color: var(--muted-foreground);">${t('只影响之后被加进这个组的人，不改动已有成员的角色。')}</span>
      </div>
      <div class="field">
        <label>${t('成员')}</label>
        <div style="display: flex; flex-direction: column; gap: 1px; border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-2); max-height: 220px; overflow-y: auto;">
          ${people || `<span style="font-size: 12px; color: var(--muted-foreground); padding: 6px var(--space-2);">${t('还没有成员')}</span>`}
        </div>
        <span style="font-size: 12px; color: var(--muted-foreground);">${t(`已选 ${picked.size} 人`, `${picked.size} selected`)}</span>
      </div>
      ${state.groupError ? `<div class="gw-flash gw-flash-err">${esc(state.groupError)}</div>` : ''}
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="group-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : editing ? t('保存') : t('创建分组')}</button>
      </div>
    </form>
  </div>`
}

function editModal() {
  const member = state.editing
  if (!member) return ''
  const isSelf = member.id === memberMeId()
  const f = state.editForm
  const statusBtns = ['active', 'disabled', 'invited']
    .map((key) => {
      const ok = canBeStatus(member, key)
      const disabled = isSelf || !ok
      return `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(f.status === key)}" ${disabled ? 'disabled' : ''} title="${ok ? '' : esc(whyNotStatus(key))}" data-act="edit-status" data-status="${key}">${t(MEMBER_STATUS[key].label)}</button>`
    })
    .join('')
  const roleBtns = ['admin', 'member']
    .map(
      (key) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(f.role === key)}" ${isSelf ? 'disabled' : ''} data-act="edit-role" data-role="${key}">${roleLabelOf(key)}</button>`,
    )
    .join('')
  const hint = MEMBER_STATUS[f.status]?.hint || ''
  return `<div class="gw-modal-backdrop" data-act="edit-close">
    <form id="edit-member-form" class="gw-modal" style="max-width: 460px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t('编辑成员')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('修改角色与状态，或给 TA 发一条口令重置链接。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="edit-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div style="display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
        <span class="satu-avatar" style="background: var(--color-accent-2-200); color: var(--color-accent-2-800);">${esc((member.name || member.email).slice(0, 1).toUpperCase())}</span>
        <div style="min-width: 0;">
          <div style="font-size: 14px; font-weight: 600;">${esc(member.name)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(member.email)}</div>
        </div>
      </div>
      <div class="field">
        <label for="em-name">${t('姓名')}</label>
        <input class="input" id="em-name" name="name" type="text" required value="${esc(f.name)}">
      </div>
      <div class="field">
        <label>${t('角色')}</label>
        <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${roleBtns}</div>
      </div>
      <div class="field">
        <label>${t('状态')}</label>
        <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${statusBtns}</div>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(hint)}</span>
      </div>
      ${isSelf ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t('不能改自己的角色与状态——手滑一次就把自己关在门外。')}</span>` : ''}
      <div style="display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3);">
          <div style="min-width: 0;">
            <div style="font-size: 13.5px; font-weight: 600;">${t('口令重置链接')}</div>
            <div style="font-size: 12px; color: var(--muted-foreground);">${t('生成后自行发给成员，1 小时内有效且仅能使用一次。生成的同时，TA 的旧口令就不能再用了')}</div>
          </div>
          <button type="button" class="btn btn-secondary" style="flex: none;" data-act="edit-reset">${state.editLink ? t('重新生成') : t('生成链接')}</button>
        </div>
        ${
          state.editLink
            ? `<div style="display: flex; align-items: center; gap: var(--space-2);">
            <code class="satu-code" style="flex: 1; min-width: 0; padding: 8px var(--space-3); font-size: 12px; overflow-x: auto; white-space: nowrap;">${esc(state.editLink)}</code>
            <button type="button" class="btn btn-secondary" style="flex: none;" data-act="edit-copy">${iconCopy()} ${state.editCopied ? t('已复制') : t('复制')}</button>
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('生成的同时，TA 当前的登录和旧口令都已失效，只能用这条链接重新设口令。链接只显示这一次。')}</span>`
            : ''
        }
      </div>
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="edit-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : t('保存')}</button>
      </div>
    </form>
  </div>`
}

function memberRow(m) {
  const meId = memberMeId()
  const isSelf = m.id === meId
  const st = MEMBER_STATUS[m.status] || MEMBER_STATUS.active
  const last =
    isSelf ? t('正在使用') : m.status === 'invited' ? t(`邀请于 ${new Date(m.createdAt).toLocaleDateString('zh-CN')}`, `Invited ${new Date(m.createdAt).toLocaleDateString('en-US')}`) : ago(m.lastSeenAt)
  const canManage = isAdmin() || isOwner()
  const menu = state.menu === m.id
    ? `<div class="satu-menu" data-flip="${String(!!state.menuFlip)}">
        <button type="button" class="satu-menuitem" data-act="edit-open" data-id="${esc(m.id)}">${t('编辑成员')}</button>
        <button type="button" class="satu-menuitem" data-act="member-reset" data-id="${esc(m.id)}">${m.status === 'invited' ? t('重发邀请') : t('重置口令')}</button>
        ${
          m.status !== 'active'
            ? `<button type="button" class="satu-menuitem" ${m.status === 'invited' ? 'disabled' : ''} title="${m.status === 'invited' ? t('等 TA 用邀请链接设完口令，会自动转为已激活。') : ''}" data-act="member-enable" data-id="${esc(m.id)}">${t(MEMBER_STATUS.active.label)}</button>`
            : ''
        }
        ${
          m.status !== 'disabled'
            ? `<button type="button" class="satu-menuitem" data-act="member-disable" data-id="${esc(m.id)}">${t(MEMBER_STATUS.disabled.label)}</button>`
            : ''
        }
        <div style="height: 1px; background: var(--border); margin: 4px 0;"></div>
        <button type="button" class="satu-menuitem" data-danger="true" data-act="member-delete" data-id="${esc(m.id)}">${t('删除')}</button>
      </div>`
    : ''
  return `<div class="satu-memberrow">
    <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
      <span class="satu-avatar" style="background: var(--color-neutral-300); color: var(--color-neutral-800);">${esc((m.name || m.email).slice(0, 1).toUpperCase())}</span>
      <div style="min-width: 0;">
        <div style="font-size: 13.5px; font-weight: 600;">${esc(m.name || m.email)}${isSelf ? t(' · 你') : ''}</div>
        <div style="font-size: 12px; color: var(--muted-foreground);">${esc(m.email)}</div>
      </div>
    </div>
    <span style="font-size: 13px;">${esc(roleLabelOf(m.role))}</span>
    <span class="tag ${st.tag}">${t(st.label)}</span>
    <span style="font-size: 13px; color: var(--muted-foreground);">${esc(last)}</span>
    <div class="satu-rowactions" style="display: flex; justify-content: flex-end; position: relative;">
      ${isSelf ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t('你')}</span>` : ''}
      ${
        canManage
          ? `<button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('编辑成员'))}" data-act="edit-open" data-id="${esc(m.id)}">${svg(['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'], 15)}</button>`
          : ''
      }
      ${
        canManage && !isSelf
          ? `<button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('更多操作'))}" data-menu-toggle data-act="menu-toggle" data-id="${esc(m.id)}">${svg(['M12 6h.01', 'M12 12h.01', 'M12 18h.01'], 16)}</button>`
          : ''
      }
      ${menu}
    </div>
  </div>`
}

function groupRow(g) {
  const canManage = isAdmin() || isOwner()
  const markStyle = g.builtin
    ? 'background: var(--color-accent-100); color: var(--color-accent-800);'
    : 'background: var(--color-accent-2-100); color: var(--color-accent-2-800);'
  const actions = g.builtin
    ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t('自动包含全部成员')}</span>`
    : `<button type="button" class="satu-linkbtn" ${canManage ? '' : 'disabled'} data-act="group-edit" data-id="${esc(g.id)}">${t('管理成员')}</button>
       <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('删除分组'))}" ${canManage ? '' : 'disabled'} data-act="group-delete" data-id="${esc(g.id)}">${svg(['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14'], 15)}</button>`
  const role = g.builtin ? t('按成员设置') : roleLabelOf(g.role)
  const created = g.createdAt ? new Date(g.createdAt).toISOString().slice(0, 10) : '—'
  const n = Array.isArray(g.members) ? g.members.length : 0
  return `<div class="satu-grouprow">
    <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
      <span class="satu-providermark" style="${markStyle}">${groupIcon(g.icon, 16)}</span>
      <div style="min-width: 0;">
        <div style="display: flex; align-items: center; gap: var(--space-2);">
          <span style="font-size: 14px; font-weight: 600;">${esc(g.name)}</span>
          ${g.builtin ? `<span class="tag tag-accent-2">${t('固定分组')}</span>` : ''}
        </div>
        <div style="font-size: 12px; color: var(--muted-foreground);">${esc(g.desc || '')}</div>
      </div>
    </div>
    <span style="font-size: 13px;">${t(`${n} 人`, `${n} people`)}</span>
    <span style="font-size: 13px;">${esc(role)}</span>
    <span style="font-size: 13px; color: var(--muted-foreground);">${esc(created)}</span>
    <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-3); justify-content: flex-end;">${actions}</div>
  </div>`
}

function accountsPage() {
  const members = state.accounts || []
  const groups = state.groups || []
  const seats = state.seats || { total: 0, used: 0 }
  const admins = members.filter((m) => m.role === 'admin').length
  const pending = members.filter((m) => m.status === 'invited').length
  const left = (seats.total || 0) - (seats.used || 0)
  const canManage = isAdmin() || isOwner()
  const tab = state.accountsTab === 'groups' ? 'groups' : 'members'
  const headerAct = tab === 'members' ? 'invite-open' : 'group-open'
  const headerLabel = tab === 'members' ? t('邀请成员') : t('新建分组')
  const tabs = [
    { key: 'members', label: '成员' },
    { key: 'groups', label: '分组' },
  ]
    .map(
      (item) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(tab === item.key)}" data-act="accounts-tab" data-tab="${item.key}">${t(item.label)}</button>`,
    )
    .join('')
  const membersBody = `
        <div style="display: flex; flex-direction: column; gap: var(--space-6);">
          <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-3);">
            ${statCard(t('成员'), members.length)}
            ${statCard(t('管理员'), admins)}
            ${statCard(t('待接受邀请'), pending)}
            ${statCard(t('席位余量'), left)}
          </div>
          <div style="display: flex; flex-direction: column; gap: var(--space-3);">
            <div style="display: flex; align-items: baseline; justify-content: space-between;">
              <h2 style="font-size: 18px; margin: 0;">${t('成员')}</h2>
              <span style="font-size: 12px; color: var(--muted-foreground);">${t(`共 ${members.length} 人`, `${members.length} people`)}</span>
            </div>
            <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
              <div class="satu-memberhead">
                <span>${t('成员')}</span><span>${t('角色')}</span><span>${t('状态')}</span><span>${t('最近活跃')}</span><span></span>
              </div>
              ${members.map(memberRow).join('') || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有成员')}</div>`}
            </div>
          </div>
        </div>`
  const groupsBody = `
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-grouphead">
              <span>${t('分组')}</span><span>${t('成员')}</span><span>${t('默认角色')}</span><span>${t('创建时间')}</span><span></span>
            </div>
            ${groups.map(groupRow).join('') || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有分组')}</div>`}
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('「全体成员」为系统固定分组，新成员加入后自动进入，不可删除或移除成员。')}</span>
        </div>`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('账号管理')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('邀请同事加入，并管理成员角色与权限。')}</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" ${canManage ? '' : 'disabled'} title="${canManage ? '' : t('需要管理员权限')}" data-act="${headerAct}">
            ${svg(['M12 5v14', 'M5 12h14'], 15)} ${headerLabel}
          </button>
        </div>
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">${tabs}</div>
        ${flashes()}
        ${tab === 'members' ? membersBody : groupsBody}
        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('成员这一半是真的：停用会当场作废对方已签发的 JWT（签发早于作废时间的票会被拒），重置口令同样作废旧登录，旧口令也一并失效。角色与权限的判断在服务端，界面上的禁用只是提前告诉你结果。Gateway 没有会话表，未过期且签发于作废之后的 JWT 仍可用，直到过期；停用账号登录会被拒绝。')}</p>
      </div>
    </div>
    ${inviteModal()}
    ${editModal()}
    ${groupModal()}
    ${secretModal()}`
}
