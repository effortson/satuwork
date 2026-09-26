/**
 * 「停用 / 启用」那颗按钮。**这一页和账号详情页共用**，两处的规矩必须一样。
 *
 * 什么时候一颗都不给：
 *
 *  - **自己**。服务端也挡着（`不能改自己的角色或状态`）——一个人在这一页上把自己停掉，
 *    下一次请求就 401，谁也开不回来。
 *  - **待接受**。它要停也停得掉，但那一步该在「重发邀请 / 撤销」那条路上做，不是在
 *    这里；而「启用」更不行——口令得由本人用邀请链接设，管理员直接激活等于凭空造出一个
 *    没有口令的活账号（服务端同样挡着）。
 *
 * 停用是**掉线级**的动作（`tokenRevokedAt` 当场作废他手上的票），所以先弹确认；启用不弹，
 * 它没有会让人后悔的即时后果，顶多因为席位满了被 409 挡回来。
 */
function userStatusButton(a) {
  if (!a || a.id === memberMeId() || a.status === 'invited') return ''
  const next = a.status === 'disabled' ? 'active' : 'disabled'
  const label = next === 'disabled' ? t('停用') : t('启用')
  return `<button type="button" class="satu-linkbtn"${next === 'disabled' ? ' style="color: var(--color-accent-800);"' : ''} data-act="user-status" data-id="${esc(a.id)}" data-next="${next}" data-name="${esc(a.name || a.email || '')}" ${state.busy ? 'disabled' : ''}>${label}</button>`
}

/** 平台用户、套餐与订单、余额面板，以及「我的资料」。 */
function usersPage() {
  const view = pageSlice('users', state.users)
  const rows = view.rows
    .map((a) => {
      const company = a.company ? `${a.company.name} (${a.company.slug})` : t('平台')
      const initial = (a.email || '·').slice(0, 1).toUpperCase()
      const st = MEMBER_STATUS[a.status] || MEMBER_STATUS.active
      return `<div class="satu-memberrow" style="cursor: pointer;" data-act="go" data-href="/users/${esc(a.id)}">
        <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
          <span style="width: 34px; height: 34px; flex: none; border-radius: 999px; background: var(--color-accent-200); color: var(--color-accent-800); display: flex; align-items: center; justify-content: center; font-family: var(--font-heading);">${esc(initial)}</span>
          <div style="min-width: 0;">
            <div style="font-size: 14px; font-weight: 600;">${esc(a.email)}</div>
            <div style="font-size: 12px; color: var(--muted-foreground);">${esc(company)}</div>
          </div>
        </div>
        ${roleTag(a.role)}
        ${/* 状态原来是**空的一格**：这一页列着全平台的人，而「这个人还能不能登录」正是
             owner 最常来这一页问的一件事，得从行上就看得见，不用点进去。 */ ''}
        <span class="tag ${st.tag}">${t(st.label)}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(fmtTime(a.createdAt))}</span>
        ${/* 按钮自己带 data-act，点它不会顺着行跳进详情（事件委托取的是最里面那个）。 */ ''}
        <span style="display: flex; justify-content: flex-end;">${userStatusButton(a)}</span>
      </div>`
    })
    .join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('用户')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('平台账号与各公司管理员、员工。')}</p>
        </div>
        ${flashes()}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-memberhead">
            <span>${t('账号')}</span><span>${t('角色')}</span><span>${t('状态')}</span><span>${t('加入时间')}</span><span></span>
          </div>
          ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有用户')}</div>`}
          ${listPager('users', view, '个')}
        </div>
      </div>
    </div>`
}

function userSecretRow(label, kind, value) {
  const revealed = Boolean(state.userReveal && state.userReveal[kind])
  const shown = value ? (revealed ? value : '••••••••') : '—'
  const actions = value
    ? ` <button type="button" class="satu-linkbtn" data-act="user-secret-reveal" data-kind="${esc(kind)}">${revealed ? t('隐藏') : t('显示')}</button> <button type="button" class="satu-linkbtn" data-act="user-secret-copy" data-kind="${esc(kind)}">${t('复制')}</button>`
    : ''
  return `<div class="satu-kv"><span>${esc(label)}</span><span style="word-break: break-all;">${esc(shown)}${actions}</span></div>`
}

function userDetailPage() {
  const d = state.userDetail
  if (!d || !d.account) {
    return `<div class="gw-page"><div class="gw-page-inner">${flashes()}<p style="color: var(--muted-foreground);">${t('载入中…')}</p></div></div>`
  }
  const a = d.account
  const company = d.company
  const st = MEMBER_STATUS[a.status] || MEMBER_STATUS.active
  const ownerSeat = a.role === 'owner'
  const secrets = ownerSeat
    ? `<p style="margin: var(--space-3) 0 0; font-size: 13px; color: var(--muted-foreground);">${t('平台账号不占席位，没有 API Key 和 access token。')}</p>`
    : `${userSecretRow('API Key', 'apiKey', d.apiKey)}${userSecretRow('access token', 'accessToken', d.accessToken)}`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('账号详情')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${esc(a.email || '')}</p>
        </div>
        ${flashes()}
        <div class="satu-panel">
          <span class="satu-panel-title">${t('账号信息')}</span>
          <div class="satu-kv"><span>${t('邮箱')}</span><span>${esc(a.email || '—')}</span></div>
          <div class="satu-kv"><span>${t('名称')}</span><span>${esc(a.name || '—')}</span></div>
          <div class="satu-kv"><span>${t('角色')}</span><span>${roleTag(a.role)}</span></div>
          <div class="satu-kv"><span>${t('公司')}</span><span>${esc(company ? `${company.name} (${company.slug})` : t('平台'))}</span></div>
          <div class="satu-kv"><span>${t('状态')}</span><span style="display: flex; align-items: center; gap: var(--space-3);"><span class="tag ${st.tag}">${t(st.label)}</span>${userStatusButton(a)}</span></div>
          <div class="satu-kv"><span>${t('加入时间')}</span><span>${esc(fmtTime(a.createdAt))}</span></div>
        </div>
        <div class="satu-panel">
          <span class="satu-panel-title">${t('席位密钥')}</span>
          ${secrets}
        </div>
      </div>
    </div>`
}

function planSkuModal() {
  const edit = state.planSkuEdit
  if (!edit) return ''
  const cur = edit.id ? (state.planSkus || []).find((p) => p.id === edit.id) : null
  // 开着改的那条被别人删了/列表没刷上，宁可什么都不显示，也别拿空表单假装是它。
  if (edit.id && !cur) return ''
  const title = cur ? t('修改套餐') : t('新建套餐')
  // 金额和额度都走 milsOf：服务端比前端旧时字段名不一样，直接读会得到 undefined，
  // 让必填框变空——那时候连保存都点不动。
  const v = edit.draft || {
    name: cur?.name || '',
    nameEn: cur?.nameEn || '',
    amount: cur ? milsOf(cur, 'amount') / 1000 : '',
    seats: cur ? cur.seats : 1,
    period: cur ? cur.period : 'month',
    bonus: cur ? milsOf(cur, 'bonus') / 1000 : 0,
  }
  return `<div class="gw-modal-backdrop" data-act="plan-sku-close">
    <form id="plan-sku-form" class="gw-modal" style="max-width: 460px;" data-id="${esc(cur?.id || '')}" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${esc(title)}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('改价目表不会动已经开出去的公司席位。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="plan-sku-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div class="field">
        <label for="plan-sku-name">${t('名称（中文）')}</label>
        <input class="input" id="plan-sku-name" name="name" value="${esc(v.name)}" required>
      </div>
      <div class="field">
        <label for="plan-sku-name-en">${t('名称（English）')}</label>
        <input class="input" id="plan-sku-name-en" name="nameEn" value="${esc(v.nameEn)}" placeholder="${esc(t('选填，留空则英文界面显示中文名'))}">
      </div>
      <div class="field">
        <label for="plan-sku-amount">${t('金额（美元）')}</label>
        ${/* $ 贴在输入框里而不是标签上：填的时候就看得见单位，不用回头看标签。 */ ''}
        <div class="satu-money">
          <span aria-hidden="true">$</span>
          <input class="input" id="plan-sku-amount" name="amount" type="number" min="0" step="0.001" value="${esc(v.amount)}" required>
        </div>
        <p style="margin: 6px 0 0; font-size: 12px; color: var(--muted-foreground);">${t('最小到厘（小数点后 3 位）。')}</p>
      </div>
      <div class="field">
        <label for="plan-sku-period">${t('类型')}</label>
        <select class="input" id="plan-sku-period" name="period">
          ${PLAN_PERIODS.map((k) => `<option value="${esc(k)}" ${k === (v.period || 'month') ? 'selected' : ''}>${esc(periodLabel(k))}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="plan-sku-seats">${t('席位')}</label>
        <input class="input" id="plan-sku-seats" name="seats" type="number" min="1" step="1" value="${esc(v.seats)}" required>
      </div>
      <div class="field">
        <label for="plan-sku-bonus">${t('赠送 Token 额度（美元）')}</label>
        <div class="satu-money">
          <span aria-hidden="true">$</span>
          <input class="input" id="plan-sku-bonus" name="bonusTokens" type="number" min="0" step="0.001" value="${esc(v.bonus)}" required>
        </div>
        <p style="margin: 6px 0 0; font-size: 12px; color: var(--muted-foreground);">${t('随套餐赠送的额度，可用于消费 token。0 表示不送。')}</p>
      </div>
      ${state.planSkuError ? `<div class="gw-flash gw-flash-err">${esc(state.planSkuError)}</div>` : ''}
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="plan-sku-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : t('保存')}</button>
      </div>
    </form>
  </div>`
}

/**
 * 套餐名按当前语言取。名字是数据不是文案，译表管不了它——英文名留空就回落到中文名，
 * 宁可显示中文，也不要空白。
 */
function planName(p) {
  return (localeMode === 'en' ? p.nameEn || p.name : p.name) || ''
}

/**
 * 取金额的「厘」值。服务端进程比前端旧时（改了代码没重启），返回的还是老字段，
 * 这时用 amount 折算回厘——版本错开时宁可显示价格，也别显示一个「—」。
 */
function milsOf(row, key) {
  const mils = row[`${key}Mils`]
  if (mils != null) return Number(mils)
  // 依次回落：新接口的美元字段 → 迁移前的老字段。
  // 老字段的数值当美元看，跟迁移里 ×1000 的算法一致，错开期间读数不会跳。
  const legacy = key === 'amount' ? row.amountCents / 100 : row.bonusTokens
  const dollars = row[key] ?? legacy
  return dollars == null || Number.isNaN(Number(dollars)) ? NaN : Math.round(Number(dollars) * 1000)
}

/** 副标题给另一种语言的名字；没填就退回 id（调试时还认得出是哪条）。 */
function planSubName(p) {
  const other = localeMode === 'en' ? p.name : p.nameEn
  return other && other !== planName(p) ? other : p.id
}

/** 周期存英文枚举，显示时才翻——中文名进了库就换不了语言。 */
const PLAN_PERIODS = ['month', 'quarter', 'year']
function periodLabel(p) {
  return { month: t('月包'), quarter: t('季包'), year: t('年包') }[p] || t('月包')
}

/** 多一列赠送额度，5 列的 satu-memberrow 不够用，这里单独排。 */
const PLAN_COLS = 'minmax(140px, 2fr) 92px 68px 72px 104px minmax(88px, 1fr) 84px'

/** 订单状态是算出来的，不存库——存了就得有人定时去改它。 */
function orderStatus(o) {
  const now = Date.now()
  // 没付款就不是订阅，只是一张待收的账单，日期到了也不生效。
  if (o.payStatus !== 'paid') return { label: t('待付款'), tag: 'tag-neutral' }
  // 充值没有账期：付了就是到账，谈不上「生效中」或「已过期」。
  if (o.kind === 'topup') return { label: t('已到账'), tag: 'tag-accent-2' }
  if (now < o.startAt) return { label: t('未开始'), tag: 'tag-neutral' }
  if (now > o.endAt) return { label: t('已过期'), tag: 'tag-neutral' }
  return { label: t('生效中'), tag: 'tag-accent-2' }
}

function orderPlanName(o) {
  return (localeMode === 'en' ? o.planNameEn || o.planName : o.planName) || '—'
}

function payStatusTag(status) {
  return status === 'paid'
    ? `<span class="tag tag-accent-2">${t('已付款')}</span>`
    : `<span class="tag tag-neutral">${t('未付款')}</span>`
}

// 最后一列要同时放状态标签和「修改」按钮，给够宽度，否则按钮会被切掉。
const ORDER_COLS = 'minmax(110px, 1.3fr) 64px minmax(96px, 1.1fr) 84px 84px 56px 108px 80px 148px'

function orderModal() {
  const edit = state.orderEdit
  if (!edit) return ''
  const cur = edit.id ? (state.orders || []).find((o) => o.id === edit.id) : null
  if (edit.id && !cur) return ''
  const skus = state.planSkus || []
  const orgs = state.orgs || []
  const v = edit.draft || {
    kind: cur?.kind || edit.kind || 'plan',
    companyId: cur?.companyId || edit.companyId || orgs[0]?.id || '',
    planId: cur?.planId || skus[0]?.id || '',
    period: cur?.period || 'month',
    seats: cur ? cur.seats : skus[0]?.seats ?? 1,
    amount: cur ? cur.amount : skus[0]?.amount ?? 0,
    bonus: cur ? cur.bonus : skus[0]?.bonus ?? 0,
    startAt: dayISO(cur ? cur.startAt : Date.now()),
    payStatus: cur?.payStatus || 'unpaid',
    note: cur?.note || '',
  }
  // 一张表单两种单子：套餐单要选套餐、席位、账期，充值单只有金额和备注。
  const topup = v.kind === 'topup'
  return `<div class="gw-modal-backdrop" data-act="order-close">
    <form id="order-form" class="gw-modal" style="max-width: 480px; max-height: 88vh; overflow-y: auto;" data-id="${esc(cur?.id || '')}" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${cur ? t('修改订单') : topup ? t('新建充值单') : t('新建套餐单')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${topup ? t('充值单付款后才开充值记录，余额也是那时候才涨。') : t('下单时套餐内容会抄进订单，之后改价目表不影响它。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="order-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div class="field">
        <label for="order-kind">${t('单据类型')}</label>
        <select class="input" id="order-kind" name="kind" data-act="order-kind-pick" ${cur ? 'disabled' : ''}>
          <option value="plan" ${!topup ? 'selected' : ''}>${t('套餐')}</option>
          <option value="topup" ${topup ? 'selected' : ''}>${t('充值')}</option>
        </select>
        ${cur ? `<p style="margin: 6px 0 0; font-size: 12px; color: var(--muted-foreground);">${t('类型不能改，要换请另开一单。')}</p>` : ''}
      </div>
      <div class="field">
        <label for="order-company">${t('公司')}</label>
        <select class="input" id="order-company" name="companyId" required>
          ${orgs.map((c) => `<option value="${esc(c.id)}" ${c.id === v.companyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('') || `<option value="">${t('还没有公司')}</option>`}
        </select>
      </div>
      ${topup ? '' : `
      <div class="field">
        <label for="order-plan">${t('套餐')}</label>
        <select class="input" id="order-plan" name="planId" data-act="order-plan-pick" required>
          ${skus.map((p) => `<option value="${esc(p.id)}" ${p.id === v.planId ? 'selected' : ''}>${esc(planName(p))}</option>`).join('') || `<option value="">${t('还没有套餐')}</option>`}
        </select>
        <p style="margin: 6px 0 0; font-size: 12px; color: var(--muted-foreground);">${t('选套餐会带出下面几项，可以再改。')}</p>
      </div>
      <div class="field">
        <label for="order-period">${t('类型')}</label>
        <select class="input" id="order-period" name="period">
          ${PLAN_PERIODS.map((k) => `<option value="${esc(k)}" ${k === v.period ? 'selected' : ''}>${esc(periodLabel(k))}</option>`).join('')}
        </select>
      </div>
      `}
      <div class="field">
        <label for="order-amount">${topup ? t('充值金额（美元）') : t('金额（美元）')}</label>
        <div class="satu-money">
          <span aria-hidden="true">$</span>
          <input class="input" id="order-amount" name="amount" type="number" min="0" step="0.001" value="${esc(v.amount)}" required>
        </div>
      </div>
      ${topup ? `
      <div class="field">
        <label for="order-note">${t('备注')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
        <input class="input" id="order-note" name="note" value="${esc(v.note)}" placeholder="${esc(t('例如：线下转账补充'))}">
      </div>
      <div class="field">
        <label for="order-start">${t('日期')}</label>
        <input class="input" id="order-start" name="startAt" type="date" value="${esc(v.startAt)}" required>
      </div>
      ` : `
      <div class="field">
        <label for="order-seats">${t('席位')}</label>
        <input class="input" id="order-seats" name="seats" type="number" min="1" step="1" value="${esc(v.seats)}" required>
      </div>
      <div class="field">
        <label for="order-bonus">${t('赠送 Token 额度（美元）')}</label>
        <div class="satu-money">
          <span aria-hidden="true">$</span>
          <input class="input" id="order-bonus" name="bonusTokens" type="number" min="0" step="0.001" value="${esc(v.bonus)}" required>
        </div>
      </div>
      <div class="field">
        <label for="order-start">${t('开始日期')}</label>
        <input class="input" id="order-start" name="startAt" type="date" value="${esc(v.startAt)}" required>
        <p style="margin: 6px 0 0; font-size: 12px; color: var(--muted-foreground);">${t('结束日期按类型自动算。')}</p>
      </div>
      `}
      <div class="field">
        <label for="order-pay">${t('付款状态')}</label>
        <select class="input" id="order-pay" name="payStatus">
          <option value="unpaid" ${v.payStatus !== 'paid' ? 'selected' : ''}>${t('未付款')}</option>
          <option value="paid" ${v.payStatus === 'paid' ? 'selected' : ''}>${t('已付款')}</option>
        </select>
        <p style="margin: 6px 0 0; font-size: 12px; color: var(--muted-foreground);">${topup ? t('未付款不记账，改成已付款才开充值记录、余额才涨。') : t('未付款只开账单；改成已付款才写这家公司的订阅。')}</p>
      </div>
      ${state.orderError ? `<div class="gw-flash gw-flash-err">${esc(state.orderError)}</div>` : ''}
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="order-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : t('保存')}</button>
      </div>
    </form>
  </div>`
}

function ordersPage() {
  const rows = (state.orders || [])
    .map((o) => {
      const st = orderStatus(o)
      const topup = o.kind === 'topup'
      return `<div class="satu-memberrow" style="grid-template-columns: ${ORDER_COLS};">
        <div style="min-width: 0;">
          <div style="font-size: 14px; font-weight: 600;">${esc(o.company?.name || '—')}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(o.company?.slug || o.companyId)}</div>
        </div>
        <span class="tag ${topup ? 'tag-neutral' : 'tag-accent'}">${topup ? t('充值') : t('套餐')}</span>
        <div style="min-width: 0;">
          <div style="font-size: 13px;">${esc(topup ? o.note || t('充值') : orderPlanName(o))}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(topup ? '—' : periodLabel(o.period))}</div>
        </div>
        <span style="font-size: 13px; font-weight: 600;">${esc(usd(milsOf(o, 'amount')))}</span>
        <span style="font-size: 13px;">${topup ? '—' : esc(usd(milsOf(o, 'bonus')))}</span>
        <span style="font-size: 13px;">${topup ? '—' : t(`${esc(o.seats)} 席`, `${esc(o.seats)} seat${o.seats === 1 ? '' : 's'}`)}</span>
        <!-- 起止两行：挤一行会被省略号切掉，日期切一半等于没显示。 -->
        <div style="font-size: 12px; color: var(--muted-foreground); line-height: 1.5;">
          ${topup ? esc(dayISO(o.startAt)) : `<div>${esc(dayISO(o.startAt))} →</div><div>${esc(dayISO(o.endAt))}</div>`}
        </div>
        ${payStatusTag(o.payStatus)}
        <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-2);">
          <span class="tag ${st.tag}">${esc(st.label)}</span>
          <button type="button" class="btn btn-secondary" data-act="order-edit" data-id="${esc(o.id)}">${t('修改')}</button>
        </div>
      </div>`
    })
    .join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('购买与充值')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('买套餐和充值走同一张单：付了款，套餐才生效、充值余额才到账。')}</p>
          </div>
          <div style="display: flex; gap: var(--space-2); flex: none;">
            <button type="button" class="btn btn-secondary" data-act="order-new" data-kind="topup">${t('新建充值单')}</button>
            <button type="button" class="btn btn-primary" data-act="order-new" data-kind="plan">${t('新建套餐单')}</button>
          </div>
        </div>
        ${flashes()}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-memberhead" style="grid-template-columns: ${ORDER_COLS};">
            <span>${t('公司')}</span><span>${t('类型')}</span><span>${t('内容')}</span><span>${t('金额')}</span><span>${t('赠送 Token')}</span><span>${t('席位')}</span><span>${t('账期')}</span><span>${t('付款状态')}</span><span></span>
          </div>
          ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有订单')}</div>`}
        </div>
      </div>
      ${orderModal()}
    </div>`
}

/**
 * 两笔额度分开画，别加在一起：
 * 套餐赠送的跟着套餐到期清零，单独充的不过期——合成一个数就分不出哪部分会没。
 */
/**
 * 平台看某一家公司的额度。
 *
 * **大字是「还剩多少」，不是「发了多少」。** `state.balance` 报的是发放额（订单和充值
 * 的和），账单接口那份 `balance` 才带着扣完之后的余数。只报发放额的话，界面上那个数
 * 永远不动——而这一屏存在的理由正是回答「这家还能用多久」。
 */
function balancePanel() {
  const b = state.balance || { planBonusMils: 0, planBonusExpiresAt: null, topupMils: 0 }
  const live = state.billing?.balance || null
  const cell = (label, big, sub) => `<div>
    <div style="font-size: 12px; color: var(--muted-foreground);">${esc(label)}</div>
    <div style="font-family: var(--font-heading); font-size: 24px; line-height: 1.3;">${esc(big)}</div>
    <div style="font-size: 12px; color: var(--muted-foreground);">${sub}</div>
  </div>`
  const expiry = b.planBonusExpiresAt
    ? t(`${esc(dayISO(b.planBonusExpiresAt))} 到期，没用完清零`, `Expires ${esc(dayISO(b.planBonusExpiresAt))}, unused amount is cleared`)
    : t('没有生效中的套餐')
  const dry = live && Number(live.leftMicros) <= 0
  return `<div class="satu-panel">
    <span class="satu-panel-title">${t('额度')}</span>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-4);">
      ${cell(
        t('套餐赠送余额'),
        live ? live.planBonusLeft : usd(b.planBonusMils || 0),
        `${live ? `${t('本期发放')} ${esc(usd(b.planBonusMils || 0))} · ` : ''}${expiry}`,
      )}
      ${cell(
        t('充值余额'),
        live ? live.topupLeft : usd(b.topupMils || 0),
        `${live ? `${t('累计充值')} ${esc(usd(b.topupMils || 0))} · ` : ''}${t('不过期，用完为止')}`,
      )}
      ${live ? cell(t('本期已扣'), live.spentThisPeriod, t('模型、连接器、网页搜索合计', 'model + connector + web search')) : ''}
    </div>
    ${dry ? `<div class="gw-flash gw-flash-err" style="margin: 0;">${esc(live.enforce ? t('额度已用完，这家公司需要计费的调用已经停下来了。') : t('额度已用完。平台没开熔断，调用还在继续，钱是欠着的。'))}</div>` : ''}
    <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('充值在「充值」页里做，跟套餐赠送分开记。扣费顺序是先赠送后充值。')}</p>
  </div>`
}

/** 公司详情里的充值记录：只有付了款的充值单才会有记录，所以这张表天然只列已到账的。 */
const TOPUP_COLS = 'minmax(120px, 1fr) 104px minmax(160px, 2fr) minmax(120px, 1fr)'

function topupRecordsPanel() {
  const rows = (state.orgTopups || [])
    .map(
      (r) => `<div class="satu-memberrow" style="grid-template-columns: ${TOPUP_COLS};">
        <span style="font-size: 13px;">${esc(fmtTime(r.createdAt))}</span>
        <span style="font-size: 13px; font-weight: 600;">${esc(usd(milsOf(r, 'amount')))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(r.note || '—')}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(r.createdByName || '—')}</span>
      </div>`,
    )
    .join('')
  return `<div style="display: flex; flex-direction: column; gap: var(--space-3);">
    <h2 style="font-size: 18px; margin: 0;">${t('充值记录')}</h2>
    <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
      <div class="satu-memberhead" style="grid-template-columns: ${TOPUP_COLS};">
        <span>${t('时间')}</span><span>${t('金额')}</span><span>${t('备注')}</span><span>${t('操作人')}</span>
      </div>
      ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有充值记录。已付款的充值单才会记在这里。')}</div>`}
    </div>
  </div>`
}

function plansPage() {
  const skuRows = (state.planSkus || [])
    .map((p) => {
      return `<div class="satu-memberrow" style="grid-template-columns: ${PLAN_COLS};">
        <div style="min-width: 0;">
          <div style="font-size: 14px; font-weight: 600;">${esc(planName(p))}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(planSubName(p))}</div>
        </div>
        <span style="font-size: 13px; font-weight: 600;">${esc(usd(milsOf(p, 'amount')))}</span>
        <span style="font-size: 13px;">${esc(periodLabel(p.period))}</span>
        <span style="font-size: 13px;">${t(`${esc(p.seats)} 席`, `${esc(p.seats)} seat${p.seats === 1 ? '' : 's'}`)}</span>
        <span style="font-size: 13px;">${esc(usd(milsOf(p, 'bonus')))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(fmtTime(p.updatedAt))}</span>
        <div class="satu-rowactions">
          <button type="button" class="btn btn-secondary" data-act="plan-sku-edit" data-id="${esc(p.id)}">${t('修改')}</button>
        </div>
      </div>`
    })
    .join('')
  // 改某家公司的席位不在这页——那是公司详情页「订阅」面板的事。这页只管价目表。
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('套餐')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('价目表：一条套餐 = 一个金额 + 一个席位数。')}</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" data-act="plan-sku-new">${t('新建套餐')}</button>
        </div>
        ${flashes()}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-memberhead" style="grid-template-columns: ${PLAN_COLS};">
            <span>${t('套餐')}</span><span>${t('金额')}</span><span>${t('类型')}</span><span>${t('席位')}</span><span>${t('赠送 Token')}</span><span>${t('更新时间')}</span><span></span>
          </div>
          ${skuRows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有套餐')}</div>`}
        </div>
      </div>
      ${planSkuModal()}
    </div>`
}

function initialOf(user) {
  return (user?.name || user?.email || '·').trim().slice(0, 1).toUpperCase()
}

function profileForm() {
  const u = state.me?.account || {}
  return state.profileDraft ?? { name: u.name || '', title: u.title || '', phone: u.phone || '' }
}

function profileDirty() {
  const u = state.me?.account || {}
  const d = state.profileDraft
  if (!d) return false
  return d.name !== (u.name || '') || d.title !== (u.title ?? '') || d.phone !== (u.phone ?? '')
}

function roleLabelOfAccount(role) {
  return ({ owner: t('所有者', 'Owner'), admin: t('管理员', 'Admin'), member: t('成员', 'Member') })[role] || role
}

function dayOf(ts) {
  if (!ts) return t('从未修改', 'never')
  return new Date(ts).toLocaleDateString(localeMode === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function whenOf(ts) {
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return t('刚刚', 'just now')
  if (m < 60) return t(`${m} 分钟前`, `${m} min ago`)
  if (m < 60 * 24) return t(`${Math.floor(m / 60)} 小时前`, `${Math.floor(m / 60)} h ago`)
  return t(`${Math.floor(m / 1440)} 天前`, `${Math.floor(m / 1440)} d ago`)
}

/** User-Agent → 一句人话。认不出来就说认不出来，别猜。 */
function deviceName(agent) {
  if (!agent) return t('未知设备', 'Unknown device')
  const os = /Mac OS X/.test(agent)
    ? 'macOS'
    : /Windows/.test(agent)
      ? 'Windows'
      : /Android/.test(agent)
        ? 'Android'
        : /iPhone|iPad/.test(agent)
          ? 'iOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : null
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Chrome\//.test(agent)
      ? 'Chrome'
      : /Safari\//.test(agent)
        ? 'Safari'
        : /Firefox\//.test(agent)
          ? 'Firefox'
          : null
  if (!os && !browser) return t('未知设备', 'Unknown device')
  return [browser, os].filter(Boolean).join(' · ')
}

function paintProfileActions() {
  const dirty = profileDirty()
  const cancel = document.querySelector('[data-act="profile-cancel"]')
  const save = document.querySelector('[data-act="profile-save"]')
  const saved = document.querySelector('[data-profile-saved]')
  if (cancel instanceof HTMLButtonElement) cancel.disabled = !dirty
  if (save instanceof HTMLButtonElement) save.disabled = !dirty || state.busy
  if (saved) saved.hidden = !state.profileSaved
}

function passwordModal() {
  if (!state.pwOpen) return ''
  const f = state.pwForm
  const check = svg(['m5 13 4 4L19 7'], 13)
  return `<div class="gw-modal-backdrop" data-act="pw-close">
    <form id="pw-form" class="gw-modal" style="max-width: 420px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t('修改口令', 'Change password')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('改完之后，其他设备上的登录会立即失效。', 'Every other device is signed out immediately.')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${t('关闭', 'Close')}" data-act="pw-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div class="field">
        <label for="pw-old">${t('当前口令', 'Current password')}</label>
        <input class="input" id="pw-old" name="current" data-pw="current" type="password" autocomplete="current-password" required value="${esc(f.current)}">
      </div>
      <div class="field">
        <label for="pw-new">${t('新口令', 'New password')}</label>
        <input class="input" id="pw-new" name="next" data-pw="next" type="password" autocomplete="new-password" required value="${esc(f.next)}" placeholder="${t('至少 10 位', 'At least 10 characters')}">
      </div>
      <div class="field">
        <label for="pw-new2">${t('确认新口令', 'Confirm new password')}</label>
        <input class="input" id="pw-new2" name="confirm" data-pw="confirm" type="password" autocomplete="new-password" required value="${esc(f.confirm)}">
      </div>
      <div style="display: flex; flex-direction: column; gap: 5px; padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
        <span class="satu-panel-title">${t('要求', 'Requirements')}</span>
        <div class="satu-step" style="color: var(--muted-foreground);">${check} ${t('至少 10 个字符', 'At least 10 characters')}</div>
        <div class="satu-step" style="color: var(--muted-foreground);">${check} ${t('不能与当前口令相同', 'Different from the current one')}</div>
      </div>
      ${state.pwError ? `<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-sm); padding: 10px var(--space-3);">${esc(state.pwError)}</div>` : ''}
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="pw-close">${t('取消', 'Cancel')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…', 'Saving…') : t('保存新口令', 'Save new password')}</button>
      </div>
    </form>
  </div>`
}

/**
 * 个人设置。
 *
 * 真的那些：基本资料（写回 /me）、修改口令（验旧口令、改完其他 JWT 全部作废）、
 * 外观与语言（本机立刻生效，并同步到账号）。
 *
 * 不真的那些，都在旁边写了缺什么：通知三项没有投递渠道，渠道配对码没有渠道。
 * 登录设备只有当前这一次——Gateway 用 JWT，没有会话表。
 */
function profilePage() {
  const u = state.me?.account || {}
  const form = profileForm()
  const dirty = profileDirty()
  const themes = [
    { key: 'light', label: t('浅色', 'Light'), hint: t('始终使用浅色', 'Always light') },
    { key: 'dark', label: t('深色', 'Dark'), hint: t('始终使用深色', 'Always dark') },
    { key: 'system', label: t('跟随系统', 'System'), hint: t('跟随操作系统设置', 'Follow your OS setting') },
  ]
  const langs = [
    { key: 'zh', label: '中文' },
    { key: 'en', label: 'English' },
  ]
  const notices = [
    {
      key: 'digest',
      title: t('每日工作摘要', 'Daily digest'),
      desc: t('每天 09:00 汇总 AI 员工的执行结果发到邮箱', 'A 09:00 roundup of what your AI employees did, by email'),
    },
    {
      key: 'review',
      title: t('待复核提醒', 'Review requests'),
      desc: t('有任务需要人工确认时立即通知我', 'Notify me the moment a task needs human confirmation'),
    },
    {
      key: 'fail',
      title: t('任务失败提醒', 'Failure alerts'),
      desc: t('定时任务执行失败时发送站内通知', 'In-app notice when a scheduled task fails'),
    },
  ]
  const themeCards = themes
    .map(
      (item) => `<button type="button" class="satu-themecard" aria-pressed="${String(themeMode === item.key)}" data-act="profile-theme" data-mode="${item.key}">
                    <span class="satu-themeswatch" data-mode="${item.key}">
                      <span class="satu-themebar"></span>
                      <span class="satu-themebody"></span>
                    </span>
                    <span style="font-size: 13px; font-weight: 600;">${esc(t(item.label))}</span>
                    <span style="font-size: 11.5px; color: var(--muted-foreground); text-align: center;">${esc(t(item.hint))}</span>
                  </button>`,
    )
    .join('')
  const langPills = langs
    .map(
      (l) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(localeMode === l.key)}" data-act="profile-locale" data-locale="${l.key}">${esc(l.label)}</button>`,
    )
    .join('')
  const noticeRows = notices
    .map(
      (n) => `<div class="satu-toggleRow">
                <div style="min-width: 0;">
                  <div style="font-size: 13.5px; font-weight: 600;">${esc(t(n.title))}</div>
                  <div style="font-size: 12px; color: var(--muted-foreground);">${esc(t(n.desc))}</div>
                </div>
                <button type="button" class="satu-switch" aria-pressed="${String(!state.notifyOff.includes(n.key))}" aria-label="${esc(t(n.title))}" data-act="profile-notify" data-notify="${n.key}"><span></span></button>
              </div>`,
    )
    .join('')
  const sessionAt = u.lastSeenAt || Date.now()
  const agent = navigator.userAgent
  return `
    <div class="gw-page">
      <div class="gw-page-inner gw-profile">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('个人设置', 'Preferences')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('管理你的账号信息、偏好与安全设置。', 'Manage your account details, preferences, and security.')}</p>
        </div>

        <div style="display: flex; align-items: center; gap: var(--space-4); padding: var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg);">
          <div style="width: 56px; height: 56px; flex: none; border-radius: 999px; background: var(--color-accent-200); display: flex; align-items: center; justify-content: center; font-family: var(--font-heading); font-size: 22px; color: var(--color-accent-800);">${esc(initialOf(u))}</div>
          <div style="flex: 1; min-width: 0;">
            <div style="font-size: 16px; font-weight: 600;">${esc(u.name || u.email || '')}</div>
            <div style="font-size: 13px; color: var(--muted-foreground);">
              ${esc(u.email || '')} · ${esc(roleLabelOfAccount(u.role))} · ${t('加入于', 'Joined')} ${esc(dayOf(u.createdAt))}
            </div>
          </div>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('基本资料', 'Profile')}</span>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
            <div class="field">
              <label for="pf-name">${t('姓名', 'Name')}</label>
              <input class="input" id="pf-name" data-profile="name" type="text" value="${esc(form.name)}">
            </div>
            <div class="field">
              <label for="pf-title">${t('职位', 'Job title')}</label>
              <input class="input" id="pf-title" data-profile="title" type="text" value="${esc(form.title)}" placeholder="${t('例如：运营负责人', 'e.g. Head of Operations')}">
            </div>
            <div class="field">
              <label for="pf-email">${t('邮箱', 'Email')}</label>
              <input class="input" id="pf-email" type="email" value="${esc(u.email || '')}" readonly disabled>
              <span style="font-size: 12px; color: var(--muted-foreground);">${t('邮箱是登录身份，改它要另一套验证流程，暂时不开放。', 'Email is your sign-in identity; changing it needs a verification flow we do not have yet.')}</span>
            </div>
            <div class="field">
              <label for="pf-phone">${t('手机号', 'Phone')}</label>
              <input class="input" id="pf-phone" data-profile="phone" type="tel" value="${esc(form.phone)}" placeholder="${t('选填', 'Optional')}">
            </div>
          </div>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('渠道配对码', 'Channel pairing code')}</span>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
            ${t('用于将 Telegram 私聊绑定到你的账号。请先在「渠道」页面绑定 Bot，再使用页面生成的一次性配对码。', 'Connect a private Telegram chat to your account. Bind a bot on the Channels page, then use the one-time pairing code shown there.')}
          </p>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('偏好', 'Preferences')}</span>
          <div class="field">
            <label>${t('界面外观', 'Appearance')}</label>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3);">
              ${themeCards}
            </div>
          </div>
          <div class="field">
            <label>${t('界面语言', 'Language')}</label>
            <div style="display: flex; gap: var(--space-2); flex-wrap: wrap;">
              ${langPills}
            </div>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('你和 Bot 的对话生成审计总结时，摘要和每一项的评分原因也按这个语言写（对之后生成的生效）。', 'Audit summaries of your conversations, including the reason behind each score, are written in this language (applies to summaries generated from now on).')}</span>
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">
            ${t('两项都存在这台机器上，并同步到你的账号——换台机器登录会自动跟过去。', 'Both are stored on this machine and synced to your account, so they follow you to another machine.')}
          </span>
          ${noticeRows}
          <span style="font-size: 12px; color: var(--muted-foreground);">
            ${t('这三项还没有落点：发通知要先有定时任务与通知渠道，两者都还没做。开关是真的，记不住。', 'These three have nowhere to land yet — notifications need the scheduler and a delivery channel, and neither exists. The switches move, but nothing is stored.')}
          </span>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('安全', 'Security')}</span>
          <div class="satu-toggleRow">
            <div>
              <div style="font-size: 13.5px; font-weight: 600;">${t('登录口令', 'Password')}</div>
              <div style="font-size: 12px; color: var(--muted-foreground);">${t('上次修改于', 'Last changed')} ${esc(dayOf(u.passwordChangedAt || u.createdAt))}</div>
            </div>
            <button type="button" class="btn btn-secondary" style="flex: none;" data-act="pw-open">${t('修改口令', 'Change password')}</button>
          </div>
        </div>

        <div class="satu-panel">
          <div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3);">
            <span class="satu-panel-title">${t('登录设备', 'Signed-in devices')}</span>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('共 1 个会话', '1 session(s)')}</span>
          </div>
          <div class="satu-toggleRow">
            <div style="min-width: 0;">
              <div style="font-size: 13.5px; font-weight: 600;">${esc(deviceName(agent))}${t(' · 当前设备', ' · this device')}</div>
              <div style="font-size: 12px; color: var(--muted-foreground);">${t('登录于', 'Signed in')} ${esc(whenOf(sessionAt))}</div>
            </div>
            <span class="tag tag-accent-2" style="flex: none;">${t('使用中', 'Active')}</span>
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">
            ${t('Gateway 用 JWT，没有会话表，列不出也注销不了其他设备。改口令会作废所有已签发的票；当前这次会发一张新票。', 'Gateway uses JWTs and has no session table, so other devices cannot be listed or revoked. Changing your password voids every issued ticket; this browser gets a new one.')}
          </span>
        </div>

        ${state.profileError ? `<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-md); padding: 10px var(--space-4);">${esc(state.profileError)}</div>` : ''}

        <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4);">
          <button type="button" class="satu-linkbtn" style="text-align: left;" data-act="logout">${t('退出登录', 'Sign out')}</button>
          <div style="display: flex; align-items: center; gap: var(--space-3);">
            <span data-profile-saved style="font-size: 12.5px; color: var(--muted-foreground);" ${state.profileSaved ? '' : 'hidden'}>${t('已保存', 'Saved')}</span>
            <button type="button" class="btn btn-secondary" data-act="profile-cancel" ${dirty ? '' : 'disabled'}>${t('取消', 'Cancel')}</button>
            <button type="button" class="btn btn-primary" data-act="profile-save" ${dirty && !state.busy ? '' : 'disabled'}>${state.busy ? t('保存中…', 'Saving…') : t('保存更改', 'Save changes')}</button>
          </div>
        </div>
      </div>
    </div>
    ${passwordModal()}`
}
