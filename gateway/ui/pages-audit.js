/** 加入邀请页、审计总结，以及平台侧的公司列表。发布包在 pages-releases.js，公司详情在 pages-companies.js。 */
function joinView() {
  const inv = state.joinInvite || { loading: true }
  const side = authAside(t('加入同事的工作区，设置你自己的口令。'), t('管理员从头到尾看不到你的口令。链接只用一次。'))
  let inner
  if (inv.loading) {
    inner = `<p style="margin: 0; color: var(--muted-foreground);">${t('载入邀请…')}</p>`
  } else if (!inv.valid) {
    inner = `
      <div style="display: flex; flex-direction: column; gap: var(--space-4); align-items: flex-start;">
        <span class="tag tag-accent">${t('邀请已失效')}</span>
        <h1 style="font-size: 28px; margin: 0;">${t('这条邀请链接不可用')}</h1>
        <p style="margin: 0; color: var(--muted-foreground); font-size: 14px; line-height: 1.6;">${t('链接可能已过期、已被使用，或管理员重新生成了新的邀请。请联系邀请你的人重新发一条。')}</p>
        ${inv.error ? `<div class="gw-flash gw-flash-err">${esc(inv.error)}</div>` : ''}
        <button type="button" class="btn btn-secondary" data-act="join-login">${t('返回登录')}</button>
      </div>`
  } else {
    const f = state.joinForm
    inner = `
      <div style="display: flex; flex-direction: column; gap: var(--space-6);">
        <div>
          <span class="tag tag-accent-2">${t('邀请有效')}</span>
          <h1 style="font-size: 28px; margin: var(--space-3) 0 var(--space-2);">${t('设置登录口令')}</h1>
          <p style="margin: 0; color: var(--muted-foreground); font-size: 14px;">${t('你的账号信息已由管理员填好，设置口令即可加入。')}</p>
        </div>
        <form id="join-form" style="display: flex; flex-direction: column; gap: var(--space-4);">
          <div style="display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
            <span class="satu-avatar" style="background: var(--color-accent-200); color: var(--color-accent-800);">${esc((inv.name || inv.email).slice(0, 1).toUpperCase())}</span>
            <div style="min-width: 0;">
              <div style="font-size: 14px; font-weight: 600;">${esc(inv.name || '')}</div>
              <div style="font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(inv.email)}</div>
            </div>
          </div>
          <div class="field">
            <label for="jn-name">${t('姓名')}</label>
            <input class="input satu-input" id="jn-name" name="name" type="text" value="${esc(f.name)}" placeholder="${esc(t('你的姓名'))}" autocomplete="name">
          </div>
          <div class="field">
            <label for="jn-pw">${t('设置口令')}</label>
            <input class="input satu-input" id="jn-pw" name="password" type="password" required minlength="10" placeholder="${esc(t('至少 10 位'))}" autocomplete="new-password">
          </div>
          <div class="field">
            <label for="jn-pw2">${t('确认口令')}</label>
            <input class="input satu-input" id="jn-pw2" name="confirm" type="password" required minlength="10" placeholder="${esc(t('再输一次'))}" autocomplete="new-password">
          </div>
          ${state.joinError ? `<div class="gw-flash gw-flash-err">${esc(state.joinError)}</div>` : ''}
          <button type="submit" class="btn btn-primary btn-block" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? t('加入中…') : t('加入 Satuwork')}
            ${state.busy ? '' : svg(ARROW_RIGHT, 14)}
          </button>
          ${authConsent(t('加入 Satuwork'), 'Join Satuwork')}
        </form>
        <p style="text-align: center; margin: 0; font-size: 14px; color: color-mix(in srgb, var(--color-text) 60%, transparent);">
          ${t('已经有账号？')}
          <button type="button" class="satu-linkbtn" data-act="join-login">${t('直接登录')}</button>
        </p>
      </div>`
  }
  return `<div class="gw-login">${side}<div style="position: relative; display: flex; align-items: center; justify-content: center; padding: var(--space-8);"><div style="width: 100%; max-width: 400px;">${inner}</div></div></div>`
}


function auditTranscript(events) {
  const blocks = []
  for (const ev of events || []) {
    if (ev.type === 'user/message' || ev.type === 'assistant/message') {
      // messageText 收的是整条 message，不是它的 content 数组。
      const text = messageText(ev.data && ev.data.message)
      const role = ev.type === 'user/message' ? 'user' : 'ai'
      const label = role === 'user' ? t('员工') : t('助理')
      blocks.push(`<div class="satu-dbmsg" data-role="${role}" style="white-space: pre-wrap; overflow: visible;">
        <div style="font-size: 11.5px; font-weight: 600; margin-bottom: 4px; opacity: 0.7;">${label}</div>
        ${esc(text || t('（空）'))}
      </div>`)
      continue
    }
    if (ev.type === 'tool/call') {
      const name = (ev.data && ev.data.name) || t('工具')
      blocks.push(`<div style="font-size: 12px; color: var(--muted-foreground);">${esc(t('工具 ') + name)}</div>`)
      continue
    }
    if (ev.type === 'tool/result') {
      const text = (ev.data && ev.data.text) || ''
      blocks.push(`<div style="font-size: 12px; color: var(--muted-foreground);">${esc(t('结果 ') + String(text).slice(0, 240))}</div>`)
    }
  }
  if (!blocks.length) {
    return `<div style="padding: var(--space-4); font-size: 13px; color: var(--muted-foreground);">${t('没有消息')}</div>`
  }
  return `<div style="display: flex; flex-direction: column; gap: var(--space-3);">${blocks.join('')}</div>`
}

function auditOutcomeLabel(value) {
  const zh = ({ completed: '已完成', partial: '部分完成', failed: '失败', blocked: '受阻', answered: '已回答', unknown: '未知' })[value]
  return zh ? t(zh) : value || '—'
}

/**
 * 评分项目的名称和说明（只管怎么称呼它们）。**满分不在这里定**：条目自己带着评分时的满分
 * （`scoreMax`，席位按它那份规则写进来），规则改了老条目也照当时的画。`legacyMax` 只给
 * 0042 之前、没带满分的老条目用——那时的规则就是这一套。认不出来的键（将来加的、老模型
 * 自己编的）照原样画在最后。
 */
const AUDIT_SCORE_ITEMS = [
  { key: 'completion', label: ['完成度', 'Completion'], legacyMax: 40, hint: ['任务做完了没有、做到了哪一步', 'Whether the task got done, and how far'] },
  { key: 'evidence', label: ['证据可靠性', 'Evidence'], legacyMax: 25, hint: ['结论有没有工具结果或用户确认撑着', 'Whether claims are backed by tool results or user confirmation'] },
  { key: 'instructionFollowing', label: ['指令与边界', 'Instructions & limits'], legacyMax: 15, hint: ['照没照用户的要求做、有没有越界', 'Whether it followed the request and stayed in bounds'] },
  { key: 'efficiency', label: ['效率', 'Efficiency'], legacyMax: 10, hint: ['有没有绕远路、多余的步骤', 'Detours and unnecessary steps'] },
  { key: 'communication', label: ['沟通', 'Communication'], legacyMax: 10, hint: ['说得清不清楚、有没有如实交代', 'Clarity and honesty of the replies'] },
]

/**
 * 评分明细：每一项「得分 / 满分」加一句原因。原因是审计模型在同一次调用里写的（0042 之后
 * 的条目才有），语言跟着会话主人的界面语言走。老条目只有分数，那一格如实说没有，不编。
 */
function auditScoreTable(item) {
  const scores = item.scoreBreakdown || {}
  const reasons = item.scoreReasons || {}
  const maxes = item.scoreMax || {}
  // 条目带了满分就只认它的；一格都没带的是老条目，才按旧规则补。
  const legacy = !Object.keys(maxes).length
  const maxOf = (key, legacyMax) => (Number(maxes[key]) > 0 ? Number(maxes[key]) : legacy ? legacyMax ?? null : null)
  const known = AUDIT_SCORE_ITEMS.filter((x) => Object.hasOwn(scores, x.key))
  const extra = Object.keys(scores).filter((k) => !AUDIT_SCORE_ITEMS.some((x) => x.key === k))
  const rows = known
    .map((x) => ({ key: x.key, label: t(x.label[0], x.label[1]), hint: t(x.hint[0], x.hint[1]), max: maxOf(x.key, x.legacyMax) }))
    .concat(extra.map((k) => ({ key: k, label: k, hint: '', max: maxOf(k, null) })))
  if (!rows.length) return ''
  const anyReason = rows.some((r) => reasons[r.key])
  const body = rows
    .map((r) => {
      const score = Number(scores[r.key])
      const pct = r.max ? Math.max(0, Math.min(1, score / r.max)) : null
      const reason = reasons[r.key]
      return `<div class="satu-audit-score">
        <div style="min-width: 0;">
          <div style="font-size: 13.5px; font-weight: 600;">${esc(r.label)}</div>
          ${r.hint ? `<div style="font-size: 11.5px; color: var(--muted-foreground);">${esc(r.hint)}</div>` : ''}
        </div>
        <div style="text-align: right; font-variant-numeric: tabular-nums;">
          <span style="font-size: 15px; font-weight: 600;">${esc(String(Number.isFinite(score) ? score : '—'))}</span>${r.max ? `<span style="font-size: 12px; color: var(--muted-foreground);"> / ${r.max}</span>` : ''}
          ${pct == null ? '' : `<div class="satu-meter" style="margin-top: 4px;"><div class="satu-meterfill" style="width: ${Math.round(pct * 100)}%;"></div></div>`}
        </div>
        <div style="font-size: 13px; line-height: 1.6; ${reason ? '' : 'color: var(--muted-foreground);'}">${esc(reason || t('没有写原因', 'No reason given'))}</div>
      </div>`
    })
    .join('')
  return `<div class="satu-panel" style="margin: 0;">
    <span class="satu-panel-title">${t('评分明细')}</span>
    ${anyReason ? '' : `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('这条是早先生成的，当时的审计只给分数、不写原因。之后生成的审计总结每一项都会写明得分原因。', 'This summary predates per-item reasons; newer summaries explain every score.')}</p>`}
    <div style="display: flex; flex-direction: column;">${body}</div>
  </div>`
}

function conversationAuditTable() {
  const settings = state.auditSettings?.settings
  const model = state.auditSettings?.model
  const role = settings?.modelRole === 'utility' ? 'utility' : 'daily'
  const enabled = settings?.enabled === true
  const filterOptions = state.auditFilterOptions || { accounts: [], bots: [] }
  const optionsOf = (rows, selected, allLabel) => {
    const items = Array.isArray(rows) ? rows.slice() : []
    if (selected && !items.some((row) => row.id === selected)) items.push({ id: selected, name: selected })
    return [`<option value="">${t(allLabel)}</option>`]
      .concat(items.map((row) => `<option value="${esc(row.id)}" ${selected === row.id ? 'selected' : ''}>${esc(row.name || row.id)}</option>`))
      .join('')
  }
  const accountOptions = optionsOf(filterOptions.accounts, state.auditAccountId, '全部员工')
  const botOptions = optionsOf(filterOptions.bots, state.auditBotId, '全部 Bot')
  const coverage = state.auditCoverage || []
  const pending = coverage.filter((x) => !['succeeded', 'empty'].includes(x.status))
  const failed = pending.filter((x) => x.status === 'dead' || x.lastError)
  const grid = 'grid-template-columns: minmax(180px, 2fr) minmax(105px, 1fr) minmax(90px, .8fr) minmax(130px, 1.1fr) 64px;'
  const rows = (state.auditItems || []).map((row) => `<div class="satu-usagerow" style="${grid}">
      <span style="font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis;">${esc(row.taskSummary || t('未命名任务'))}</span>
      <span style="font-size: 12px; color: var(--muted-foreground);">${esc(row.accountName || row.accountId || '—')} · ${esc(row.botName || row.botId || '—')}</span>
      <span style="font-size: 12px; color: var(--muted-foreground);">${esc(auditOutcomeLabel(row.outcome))}${row.modelScore == null ? '' : ` · ${esc(String(row.modelScore))}`}</span>
      <span style="font-size: 12px; color: var(--muted-foreground);">${esc(fmtTime(row.endedAt || row.startedAt))}</span>
      <button type="button" class="satu-linkbtn" data-act="go" data-href="/audit/summary/${esc(row.id)}">${t('打开')}</button>
    </div>`).join('')
  return `
    <details class="mg-disclosure">
      <summary><span>${t('自动审计设置')}</span><span class="tag ${enabled ? 'mg-status-ok' : 'tag-neutral'}">${enabled ? t('已开启') : t('已关闭')}</span></summary>
      <div class="satu-panel" style="margin: 0;">
      <div class="satu-kv" style="align-items: center;"><span>${t('自动审计')}</span><span style="display: flex; align-items: center; gap: var(--space-2);">
        <span style="font-size: 12px;">${enabled ? t('已开启') : t('已关闭，不审计任何对话')}</span>
        <button type="button" class="satu-switch" aria-pressed="${String(enabled)}" aria-label="${esc(t('自动审计'))}" data-act="audit-enabled" ${state.busy || !settings ? 'disabled' : ''}><span></span></button>
      </span></div>
      <div class="satu-kv"><span>${t('审计时段')}</span><span>${t('每天连续 3 × 8 小时：09:00–17:00、17:00–01:00、01:00–09:00')} · ${esc(settings?.timezone || 'UTC')}</span></div>
      <div class="satu-kv"><span>${t('审计模型')}</span><span style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
        <button type="button" class="satu-assignee" aria-pressed="${String(role === 'daily')}" data-act="audit-model-role" data-role="daily">${t('任务模型（默认）')}</button>
        <button type="button" class="satu-assignee" aria-pressed="${String(role === 'utility')}" data-act="audit-model-role" data-role="utility">UTILITY</button>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(model?.provider && model?.model ? `${model.provider} / ${model.model}` : t('尚未配置'))}</span>
      </span></div>
      <div class="satu-kv"><span>${t('覆盖状态')}</span><span>${!enabled ? t('已暂停') : `${pending.length ? esc(t(`${pending.length} 个批次处理中`, `${pending.length} batch(es) in progress`)) : t('已覆盖到最新完成时段')}${failed.length ? ` · ${esc(t(`${failed.length} 个需要重试`, `${failed.length} need retry`))}` : ''}`}</span></div>
    </div>
    </details>
    ${enabled && failed.length ? `<div class="gw-flash gw-flash-err">${esc(t('部分审计暂未完成；系统会自动重试，删除 Bot 时也会等待终审完成。'))}</div>` : ''}
    <div class="mg-sectionhead"><h2>${t('审计记录', 'Audit records')}</h2><span class="mg-help">${t(`本页 ${(state.auditItems || []).length} 条`, `${(state.auditItems || []).length} on this page`)}</span></div>
    <form id="audit-filter-form" class="mg-filterbar">
      <div class="field" style="margin: 0;">
        <label for="audit-account">${t('员工')}</label>
        <select class="input" id="audit-account" name="accountId" style="width: 190px;">${accountOptions}</select>
      </div>
      <div class="field" style="margin: 0;">
        <label for="audit-bot">Bot</label>
        <select class="input" id="audit-bot" name="botId" style="width: 190px;">${botOptions}</select>
      </div>
      <div class="field" style="margin: 0;">
        <label for="audit-from">${t('开始日期')}</label>
        <input class="input" id="audit-from" name="from" type="date" value="${esc(state.auditFrom || '')}">
      </div>
      <div class="field" style="margin: 0;">
        <label for="audit-to">${t('结束日期')}</label>
        <input class="input" id="audit-to" name="to" type="date" value="${esc(state.auditTo || '')}">
      </div>
      <button type="submit" class="btn btn-secondary" style="flex: none;">${t('筛选')}</button>
      <button type="button" class="satu-linkbtn" data-act="audit-filter-clear">${t('清除')}</button>
    </form>
    <div class="mg-table">
      <div class="satu-usagehead" style="${grid}"><span>${t('任务总结')}</span><span>${t('员工 / Bot')}</span><span>${t('结果 / 评分')}</span><span>${t('结束时间')}</span><span>${t('打开')}</span></div>
      ${rows || emptyBox(state.auditLoading ? t('加载中…') : (state.auditCursors || []).length > 1 ? t('这一页没有内容了。', 'Nothing on this page.') : enabled ? t('还没有审计总结。完成首个 8 小时时段后会自动生成。') : t('还没有审计总结。打开上方的自动审计后，完成首个 8 小时时段会自动生成。'))}
    </div>
    ${auditPager()}`
}

/**
 * 翻页。只有真有第二页时才画——同计费明细那张表，不然就是两颗永远点不动的按钮。
 * 页码靠游标栈的深度算，接口不给总数：审计条目一直在涨，「共 N 页」翻着翻着就不对了。
 */
function auditPager() {
  const page = (state.auditCursors || [null]).length
  const more = Boolean(state.auditNextCursor)
  if (!more && page <= 1) return ''
  const busy = state.auditLoading
  return `<div style="display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2);">
      <span style="font-size: 12px; color: var(--muted-foreground);">${t(`第 ${page} 页`, `Page ${page}`)}</span>
      <button type="button" class="btn btn-ghost" data-act="audit-prev" ${page > 1 && !busy ? '' : 'disabled'}>${t('上一页')}</button>
      <button type="button" class="btn btn-ghost" data-act="audit-next" ${more && !busy ? '' : 'disabled'}>${t('下一页')}</button>
    </div>`
}

function auditPage() {
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        ${pageHead(t('审计'), t('查看自动生成的任务审计总结；可按日期、员工和 Bot 筛选。'))}
        ${flashes()}
        ${conversationAuditTable()}
      </div>
    </div>`
}

function conversationAuditDetailPage() {
  const detail = state.auditItemDetail
  const item = detail?.item
  const batch = detail?.batch
  if (!item) return `<div class="gw-page"><div class="gw-page-inner">${flashes()}<p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('找不到这条审计总结。')}</p></div></div>`
  const timeline = (item.timeline || []).map((x) => `<div style="display: grid; grid-template-columns: 150px 1fr; gap: var(--space-3); font-size: 13px;"><span style="color: var(--muted-foreground);">${esc(fmtTime(x.at))}</span><span>${esc(x.action)}</span></div>`).join('')
  const textBlock = (title, value) => `<div class="satu-panel" style="margin: 0;"><span class="satu-panel-title">${t(title)}</span><div style="white-space: pre-wrap; font-size: 13px; line-height: 1.65;">${esc(value || '—')}</div></div>`
  return `<div class="gw-page"><div class="gw-page-inner">
    ${pageHead(esc(item.taskSummary || t('审计总结')), `${esc(item.accountNameSnapshot || item.accountId)} · ${esc(item.botNameSnapshot || item.botId)} · ${esc(fmtTime(item.endedAt || item.startedAt))}`)}
    ${flashes()}
    <div class="satu-panel" style="margin: 0;"><span class="satu-panel-title">${t('结果与评分')}</span><div class="satu-kv"><span>${t('最终状态')}</span><span>${esc(auditOutcomeLabel(item.outcome))}</span></div><div class="satu-kv"><span>${t('评分')}</span><span>${item.modelScore == null ? '—' : esc(String(item.modelScore))}${item.scoreConfidence == null ? '' : ` · ${esc(t('置信度'))} ${esc(String(item.scoreConfidence))}`}</span></div><div class="satu-kv"><span>${t('审计模型')}</span><span>${esc(batch ? `${batch.modelRole} · ${batch.provider}/${batch.model}` : '—')}</span></div></div>
    ${auditScoreTable(item)}
    ${textBlock('用户问题', item.userQuestion)}
    ${textBlock('模型回答', item.modelAnswer)}
    ${textBlock('最终结果', item.finalResult)}
    <div class="satu-panel" style="margin: 0;"><span class="satu-panel-title">${t('任务时间线')}</span><div style="display: flex; flex-direction: column; gap: var(--space-2);">${timeline || `<span style="font-size: 13px; color: var(--muted-foreground);">${t('没有时间线')}</span>`}</div></div>
    ${(item.riskFlags || []).length ? `<div class="gw-flash gw-flash-err">${esc(t('风险标记'))}: ${esc(item.riskFlags.join('、'))}</div>` : ''}
  </div></div>`
}

function roleTag(role) {
  if (role === 'owner') return `<span class="tag tag-accent">${t('系统管理员')}</span>`
  if (role === 'admin') return `<span class="tag tag-accent">${t('管理员')}</span>`
  return `<span class="tag tag-neutral">${t('成员')}</span>`
}

function companyStatusTag(status) {
  return status === 'disabled'
    ? `<span class="tag tag-neutral">${t('已停用')}</span>`
    : `<span class="tag tag-accent-2">${t('生效中')}</span>`
}

/** 套餐名：界面语言是英文且这条套餐存了英文名就用英文名——套餐名是数据，译表翻不了。 */
function planLabel(plan) {
  if (!plan) return ''
  return (localeMode === 'en' && plan.skuNameEn ? plan.skuNameEn : plan.skuName) || ''
}

/**
 * 常用国家区号。国家名是**数据**不是文案，中英各写一份，别丢进译表。
 * 不求全：列里没有的号码照样存得下（见 phoneParts），只是要手填。
 */
const PHONE_CODES = [
  { code: '+86', zh: '中国', en: 'China' },
  { code: '+852', zh: '香港', en: 'Hong Kong' },
  { code: '+853', zh: '澳门', en: 'Macau' },
  { code: '+886', zh: '台湾', en: 'Taiwan' },
  { code: '+65', zh: '新加坡', en: 'Singapore' },
  { code: '+60', zh: '马来西亚', en: 'Malaysia' },
  { code: '+62', zh: '印尼', en: 'Indonesia' },
  { code: '+66', zh: '泰国', en: 'Thailand' },
  { code: '+84', zh: '越南', en: 'Vietnam' },
  { code: '+63', zh: '菲律宾', en: 'Philippines' },
  { code: '+81', zh: '日本', en: 'Japan' },
  { code: '+82', zh: '韩国', en: 'South Korea' },
  { code: '+91', zh: '印度', en: 'India' },
  { code: '+61', zh: '澳大利亚', en: 'Australia' },
  { code: '+1', zh: '美国 / 加拿大', en: 'US / Canada' },
  { code: '+44', zh: '英国', en: 'United Kingdom' },
  { code: '+49', zh: '德国', en: 'Germany' },
  { code: '+33', zh: '法国', en: 'France' },
  { code: '+971', zh: '阿联酋', en: 'UAE' },
]
const PHONE_CODE_DEFAULT = '+86'

/** 库里存的是一整串 `+86 13800000000`，编辑时拆成区号和号码两格。 */
function phoneParts(raw) {
  const s = String(raw || '').trim()
  const m = s.match(/^(\+\d{1,4})[\s-]*(.*)$/)
  if (!m) return { code: PHONE_CODE_DEFAULT, number: s }
  return { code: m[1], number: m[2].trim() }
}

/**
 * 区号 + 号码两格。区号是下拉，但库里那条不在列表里时把它补进去——
 * 否则一打开表单就被默默改成了别的国家。
 */
function phoneField(idPrefix, value, required = true) {
  const { code, number } = phoneParts(value)
  const codes = PHONE_CODES.some((c) => c.code === code) ? PHONE_CODES : [{ code, zh: code, en: code }, ...PHONE_CODES]
  return `<div style="display: flex; gap: var(--space-2);">
    <select class="input" id="${idPrefix}-code" name="contactPhoneCode" style="width: 132px; flex: none;" aria-label="${esc(t('国家区号'))}">
      ${codes
        .map((c) => `<option value="${esc(c.code)}" ${c.code === code ? 'selected' : ''}>${esc(c.code)} ${esc(localeMode === 'en' ? c.en : c.zh)}</option>`)
        .join('')}
    </select>
    <input class="input" id="${idPrefix}" name="contactPhone" type="tel" value="${esc(number)}" ${required ? 'required' : ''} placeholder="13800000000">
  </div>`
}

/** 提交时再拼回一整串。号码里的空格保留，人怎么填就怎么存。 */
function phoneValue(fd) {
  const code = String(fd.get('contactPhoneCode') || PHONE_CODE_DEFAULT).trim()
  const number = String(fd.get('contactPhone') || '').trim()
  if (!number) return ''
  return number.startsWith('+') ? number : `${code} ${number}`
}

function orgCreateModal() {
  if (!state.orgCreateOpen) return ''
  return modalBox({
    close: 'org-create-close',
    tag: 'form',
    attrs: 'id="create-org-form" class="gw-modal" style="max-width: 500px; max-height: 88vh; overflow-y: auto;" data-stop',
    title: t('新建公司'),
    sub: t('创建公司并指定一名管理员。'),
    body: `${state.orgCreateError ? `<div class="gw-flash gw-flash-err">${esc(state.orgCreateError)}</div>` : ''}
      <div class="field">
        <label for="org-name">${t('名称')}</label>
        <input class="input" id="org-name" name="name" required>
      </div>
      <div class="field">
        <label for="org-slug">slug</label>
        <input class="input" id="org-slug" name="slug" required>
        <span style="font-size: 12px; color: var(--muted-foreground);">${t('访问地址里的短名，小写字母开头，只能用字母数字和连字符')}</span>
      </div>
      <div class="field">
        <label for="org-contact-name">${t('联系人')}</label>
        <input class="input" id="org-contact-name" name="contactName" required>
      </div>
      <div class="field">
        <label for="org-contact-phone">${t('电话')}</label>
        ${phoneField('org-contact-phone', '')}
      </div>
      <div class="field">
        <label for="org-contact-email">${t('联系邮箱')}</label>
        <input class="input" id="org-contact-email" name="contactEmail" type="email" required>
      </div>
      <div class="field">
        <label for="org-address">${t('公司地址')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
        <input class="input" id="org-address" name="address">
      </div>
      <div class="field">
        <label for="org-website">${t('网站')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
        <input class="input" id="org-website" name="website" placeholder="https://acme.com">
      </div>
      <div class="field">
        <label for="org-admin-email">${t('管理员邮箱')}</label>
        <input class="input" id="org-admin-email" name="adminEmail" type="email" required>
      </div>
      <div class="field">
        <label for="org-admin-password">${t('管理员口令')}</label>
        <input class="input" id="org-admin-password" name="adminPassword" type="password" minlength="10" required>
      </div>
      <div class="field">
        <label for="org-admin-password2">${t('确认管理员口令')}</label>
        <input class="input" id="org-admin-password2" name="adminPassword2" type="password" minlength="10" required>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="org-create-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('创建中…') : t('创建')}</button>
      </div>`,
  })
}

function companiesPage() {
  // 席位那一列拿掉了：席位在公司详情的订阅里管，列表看的是「这家是谁、订了什么、什么时候到期」。
  const cols = 'minmax(160px, 1.8fr) 84px minmax(90px, 1fr) minmax(120px, 1fr) minmax(150px, 1.4fr) minmax(110px, 1fr) 104px'
  const cell = (text) =>
    `<span style="font-size: 13px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(text || '—')}</span>`
  const view = pageSlice('companies', state.orgs)
  const rows = view.rows
    .map((c) => {
      const plan = c.plan || {}
      return `<div class="satu-memberrow" style="cursor: pointer; grid-template-columns: ${cols};" data-act="go" data-href="/companies/${esc(c.id)}">
        <div style="min-width: 0;">
          <div style="font-size: 14px; font-weight: 600;">${esc(c.name)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(c.slug)}</div>
        </div>
        ${companyStatusTag(c.status)}
        ${cell(c.contactName)}
        ${cell(c.contactPhone)}
        ${cell(c.contactEmail)}
        ${cell(planLabel(plan))}
        ${cell(plan.expiresAt ? dayISO(plan.expiresAt) : t('不限期'))}
      </div>`
    })
    .join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        ${pageHead(t('公司'), t('所有注册公司。点进去改资料、定套餐、分席位。'), `<button type="button" class="btn btn-primary" style="flex: none;" data-act="org-create-open">${t('新建公司')}</button>`)}
        ${flashes()}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-memberhead" style="grid-template-columns: ${cols};">
            <span>${t('公司')}</span><span>${t('状态')}</span><span>${t('联系人')}</span><span>${t('电话')}</span><span>${t('联系邮箱')}</span><span>${t('订阅套餐')}</span><span>${t('到期时间')}</span>
          </div>
          ${rows || emptyBox(t('还没有公司'))}
          ${listPager('companies', view, '家')}
        </div>
      </div>
      ${orgCreateModal()}
    </div>`
}
