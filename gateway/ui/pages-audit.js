/** 加入邀请页、审计总结，以及平台侧的公司、机器、发布包。 */
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
            ${state.busy ? '' : svg(['M5 12h14', 'm12 5 7 7-7 7'], 14)}
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

function auditTabs(tab) {
  const items = [
    { key: 'summaries', label: '审计总结' },
    { key: 'chats', label: '对话' },
    { key: 'events', label: '操作记录' },
  ]
  return items
    .map(
      (item) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(tab === item.key)}" data-act="audit-tab" data-tab="${item.key}">${t(item.label)}</button>`,
    )
    .join('')
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
    <div class="satu-panel" style="margin: 0;">
      <span class="satu-panel-title">${t('自动审计设置')}</span>
      <div class="satu-kv"><span>${t('审计时段')}</span><span>${t('每天连续 3 × 8 小时：09:00–17:00、17:00–01:00、01:00–09:00')} · ${esc(settings?.timezone || 'UTC')}</span></div>
      <div class="satu-kv"><span>${t('审计模型')}</span><span style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
        <button type="button" class="satu-assignee" aria-pressed="${String(role === 'daily')}" data-act="audit-model-role" data-role="daily">${t('任务模型（默认）')}</button>
        <button type="button" class="satu-assignee" aria-pressed="${String(role === 'utility')}" data-act="audit-model-role" data-role="utility">UTILITY</button>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(model?.provider && model?.model ? `${model.provider} / ${model.model}` : t('尚未配置'))}</span>
      </span></div>
      <div class="satu-kv"><span>${t('覆盖状态')}</span><span>${pending.length ? esc(t(`${pending.length} 个批次处理中`, `${pending.length} batch(es) in progress`)) : t('已覆盖到最新完成时段')}${failed.length ? ` · ${esc(t(`${failed.length} 个需要重试`, `${failed.length} need retry`))}` : ''}</span></div>
    </div>
    ${failed.length ? `<div class="gw-flash gw-flash-err">${esc(t('部分审计暂未完成；系统会自动重试，删除 Bot 时也会等待终审完成。'))}</div>` : ''}
    <form id="audit-filter-form" style="display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: flex-end;">
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
    <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
      <div class="satu-usagehead" style="${grid}"><span>${t('任务总结')}</span><span>${t('员工 / Bot')}</span><span>${t('结果 / 评分')}</span><span>${t('结束时间')}</span><span>${t('打开')}</span></div>
      ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${state.auditLoading ? t('加载中…') : (state.auditCursors || []).length > 1 ? t('这一页没有内容了。', 'Nothing on this page.') : t('还没有审计总结。完成首个 8 小时时段后会自动生成。')}</div>`}
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

function auditEventsTable() {
  const rows = (state.events || [])
    .map((e) => {
      const detail = e.detail && typeof e.detail === 'object' ? JSON.stringify(e.detail) : String(e.detail ?? '')
      return `<div class="satu-usagerow">
        <span style="font-size: 13.5px; font-weight: 600;">${esc(e.action)}</span>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(fmtTime(e.createdAt))}</span>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(e.accountId || '—')}</span>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(detail)}</span>
        <div></div>
      </div>`
    })
    .join('')
  return `<div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-usagehead">
            <span>${t('事件')}</span><span>${t('时间')}</span><span>${t('账号')}</span><span>${t('详情')}</span><span></span>
          </div>
          ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有审计事件')}</div>`}
        </div>`
}

function auditPage() {
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('审计')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('查看自动生成的任务审计总结；可按日期、员工和 Bot 筛选。')}</p>
        </div>
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
    <div><h1 style="font-size: 24px; margin: 0 0 4px;">${esc(item.taskSummary || t('审计总结'))}</h1><p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${esc(item.accountNameSnapshot || item.accountId)} · ${esc(item.botNameSnapshot || item.botId)} · ${esc(fmtTime(item.endedAt || item.startedAt))}</p></div>
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
  return `<div class="gw-modal-backdrop" data-act="org-create-close">
    <form id="create-org-form" class="gw-modal" style="max-width: 500px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t('新建公司')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('创建公司并指定一名管理员。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="org-create-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      ${state.orgCreateError ? `<div class="gw-flash gw-flash-err">${esc(state.orgCreateError)}</div>` : ''}
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
      </div>
    </form>
  </div>`
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
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('公司')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('所有注册公司。点进去改资料、定套餐、分席位。')}</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" data-act="org-create-open">${t('新建公司')}</button>
        </div>
        ${flashes()}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-memberhead" style="grid-template-columns: ${cols};">
            <span>${t('公司')}</span><span>${t('状态')}</span><span>${t('联系人')}</span><span>${t('电话')}</span><span>${t('联系邮箱')}</span><span>${t('订阅套餐')}</span><span>${t('到期时间')}</span>
          </div>
          ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有公司')}</div>`}
          ${listPager('companies', view, '家')}
        </div>
      </div>
      ${orgCreateModal()}
    </div>`
}

function fmtSize(n) {
  const x = Number(n)
  if (!Number.isFinite(x) || x < 0) return '—'
  if (x < 1024) return x + ' B'
  if (x < 1024 * 1024) return (x / 1024).toFixed(1) + ' KB'
  return (x / (1024 * 1024)).toFixed(1) + ' MB'
}

function shaShort(h) {
  const s = String(h || '')
  return s ? s.slice(0, 12) : '—'
}

/**
 * 上传示例。**先在 Linux 上打包**那一步不能省：包里带 esbuild 的原生二进制，在
 * Mac 上打的解到席位机器上 tsx 加载不了它，bot 起不来。pack.mjs 会拦，但示例里
 * 直接给对的做法，比让人先撞一次再看报错强。
 */
const UPLOAD_SNIPPET = `# 打包（Linux，架构要和席位机器一致）
node bot/pack.mjs --upload "$GATEWAY_URL"
# 或者手动传已有的包
curl -sf -X PUT "$GATEWAY_URL/platform/bot-releases/$VERSION" \\
  -H "Authorization: Bearer $GATEWAY_PLATFORM_TOKEN" \\
  -H "X-Bot-Sha256: $(shasum -a 256 bot.tgz | cut -d' ' -f1)" \\
  --data-binary @bot.tgz`

/**
 * 桌面端本地 Bot 的六个目标：Gateway 按版本号末尾的 `-<平台>-<架构>` 给每台桌面端挑包
 * （gateway/src 的 localBotReleaseTarget），一个目标一条独立的版本线。
 */
const LOCAL_BOT_TARGETS = [
  { key: 'darwin-arm64', label: 'macOS · Apple Silicon' },
  { key: 'darwin-x64', label: 'macOS · Intel' },
  { key: 'windows-x64', label: 'Windows · x64' },
  { key: 'windows-arm64', label: 'Windows · ARM64' },
  { key: 'linux-x64', label: 'Linux · x64' },
  { key: 'linux-arm64', label: 'Linux · ARM64' },
]

/**
 * 各平台现在生效的是哪一版。桌面端没有「期望版本」可钉：它跟的就是自己那个平台最新
 * 登记的一版，下次启动第一颗本地 Bot 时静默切过去。所以这张表回答的是最常问的那一句——
 * 「我这台 Windows 下次会用哪个包」，缺了哪个平台也一眼看得出来。
 */
function localBotTargetsPanel(latestByTarget) {
  const rows = LOCAL_BOT_TARGETS.map((x) => {
    const v = latestByTarget?.[x.key]
    return `<div class="satu-kv"><span>${esc(x.label)}</span><span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; ${v ? '' : 'color: var(--muted-foreground);'}">${esc(v || t('还没有这个平台的包', 'No package for this platform'))}</span></div>`
  }).join('')
  return `<div style="display: flex; flex-direction: column;">${rows}</div>`
}

/**
 * 机器配置。三个 tab：机器管家、Bot 运行时、桌面端本地 Bot。
 *
 * 三边是同一套东西——按版本发布的包、一张列表、一个新增表单——只是 kind 不同，
 * 所以渲染共用 `releaseSection`，避免几份会各自漂移的相似代码。
 */
function releasesPage() {
  const tab = state.machineTab === 'bot' || state.machineTab === 'local-bot' ? state.machineTab : 'manager'
  const tabBtn = (id, label) =>
    `<button type="button" class="btn ${tab === id ? 'btn-primary' : ''}" data-act="machine-tab" data-tab="${id}">${label}</button>`
  const body =
    tab === 'manager'
      ? releaseSection({
          kind: 'manager',
          title: t('机器管家'),
          hint: t('机器心跳时拿到期望版本，自己换版并在失败时回滚。留空表示跟最新发布走。'),
          data: state.managerReleases,
          desired: true,
        })
      : tab === 'bot'
        ? releaseSection({
            kind: 'bot',
            title: t('Bot 运行时'),
            hint: t('部署席位时用最新版本；也可以在部署时指定某一版。'),
            data: { releases: state.releases || [], latest: state.latestRelease, desired: '' },
            desired: false,
          })
        : releaseSection({
            kind: 'local-bot',
            title: t('桌面端本地 Bot', 'Desktop local bot'),
            hint: t(
              '桌面端按自己的操作系统和架构，取那个平台最新登记的一版，下次启动第一颗本地 Bot 时静默切换；正在跑的不会被打断。包必须在对应平台上打（或推 local-bot-v* tag 走 CI），版本号以 -<平台>-<架构> 结尾。',
              'Each Desktop app takes the newest package registered for its own OS and architecture and switches to it the next time it starts its first local bot; running bots are not interrupted. Packages must be built on the target platform (or via a local-bot-v* tag in CI) and the version must end in -<platform>-<arch>.',
            ),
            data: { releases: state.localBotReleases?.releases || [], latest: new Set(Object.values(state.localBotReleases?.latestByTarget || {})), desired: '' },
            desired: false,
            extra: localBotTargetsPanel(state.localBotReleases?.latestByTarget),
          })
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('机器配置')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${tab === 'local-bot'
            ? t('Gateway 只登记和分发发布包，自己不构建。', 'The Gateway only registers and serves packages; it never builds them.')
            : t('Gateway 只登记和分发发布包，自己不构建。包必须在 Linux 上打，架构要和席位机器一致。')}</p>
          <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted-foreground);">${t('下载地址就是那台 Debian 拉包用的 URL。登记在 GitHub Release 上的包机器直接去取、不带凭据，按 sha256 核对；Gateway 转发地址要机器令牌（curl -H "Authorization: Bearer smt_…"），管家自己会带上。')}</p>
        </div>
        ${flashes()}
        <div style="display: flex; gap: var(--space-2);">
          ${tabBtn('manager', t('机器管家'))}${tabBtn('bot', t('Bot 运行时'))}${tabBtn('local-bot', t('桌面端本地 Bot', 'Desktop local bot'))}
        </div>
        ${body}
      </div>
    </div>`
}

function releaseRow(r, latest) {
  // 下载地址永远给出来，**包括字节就在 Gateway 磁盘上的时候**：那台 Debian 上没有
  // 别的地方能看到它，这一栏写「本机存储」等于没给。字节在哪儿降级成一行小字。
  //
  // 能直连的（GitHub Release 那种，见 gateway/src/releases.ts 的 directReleaseUrl）主行
  // 就是那个外部地址——机器真去的是那儿；Gateway 转发地址降成小字，只剩老管家拉 bot 包用。
  const dl = r.directUrl || r.downloadUrl || r.url || ''
  const from = r.directUrl
    ? `${t('老管家经 Gateway 转发')} ${esc(r.downloadUrl || '')}`
    : r.url ? `${t('外部来源')} ${esc(r.url)}` : t('本机存储')
  const where = `<span style="display: flex; flex-direction: column; gap: 2px; min-width: 0;">
      <span style="font-family: var(--font-mono, ui-monospace, monospace); word-break: break-all;">${esc(dl)}</span>
      <span style="color: var(--muted-foreground); word-break: break-all;">${from}${dl ? ` · <button type="button" class="satu-linkbtn" data-act="copy-release-url" data-url="${esc(dl)}">${t('复制')}</button>` : ''}</span>
    </span>`
  return `<div class="satu-memberrow" style="grid-template-columns: 200px 90px 120px 1fr 150px;">
    <span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; word-break: break-all;">${esc(r.version)}${(latest instanceof Set ? latest.has(r.version) : r.version === latest) ? ` <span class="tag tag-accent">${t('最新')}</span>` : ''}</span>
    <span style="font-size: 13px;">${esc(fmtSize(r.size))}</span>
    <span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted-foreground);">${esc(shaShort(r.sha256))}</span>
    <span style="font-size: 12px;">${where}</span>
    <span style="font-size: 13px; color: var(--muted-foreground);">${esc(fmtTime(r.createdAt))}</span>
  </div>`
}

/**
 * `latest` 是一个版本号，或者一组（桌面端本地 Bot 每个平台各有一个「最新」）。
 * `extra` 摆在说明和列表之间，给某一类独有的东西用。
 */
function releaseSection({ kind, title, hint, data, desired, extra = '' }) {
  const d = data || { releases: [], latest: null, desired: '' }
  const rows = d.releases || []
  // 两个 tab 各翻各的：管家和 Bot 是两条独立的版本线，在管家那边翻到第 3 页，
  // 切过去看 Bot 时没有理由也停在第 3 页。
  const view = pageSlice(`releases:${kind}`, rows)
  const table = rows.length
    ? `<div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover); overflow: hidden;">
        <div class="satu-memberhead" style="grid-template-columns: 200px 90px 120px 1fr 150px;">
          <span>${t('版本')}</span><span>${t('大小')}</span><span>sha256</span><span>${t('下载地址')}</span><span>${t('时间')}</span>
        </div>
        ${view.rows.map((r) => releaseRow(r, d.latest)).join('')}
        ${listPager(`releases:${kind}`, view, '版')}
      </div>`
    : `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground); border: 1px solid var(--border); border-radius: var(--radius-lg);">${t('还没有发布版本')}</div>`
  // 期望版本只有管家有：bot 是部署时挑版本，管家是机器自己去追一个目标版本。
  const desiredForm = desired
    ? `<form data-form="manager-version" style="display: flex; gap: var(--space-2); align-items: flex-end;">
        <div class="field" style="margin: 0; flex: 1;">
          <label for="mgr-ver">${t('期望版本')}</label>
          <input class="input" id="mgr-ver" name="managerVersion" value="${esc(d.desired || '')}" placeholder="${esc(t('留空 = 跟最新'))}" autocomplete="off">
        </div>
        <button type="submit" class="btn" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
      </form>`
    : ''
  return `<div class="satu-panel" style="display: flex; flex-direction: column; gap: var(--space-3);">
    <span class="satu-panel-title">${esc(title)}</span>
    <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${esc(hint)}</p>
    ${desiredForm}
    ${extra}
    ${table}
    ${addReleaseForm(kind)}
  </div>`
}

/**
 * 新增版本。
 *
 * 四个字段都必填：**大小和 sha256 是拿来核对的，不是拿来记录的**。保存时 Gateway
 * 会把包整个拉一遍,比对这两项、确认入口文件在,对不上就不入库——一条指向坏包的
 * 记录会一路传染到席位机器上,而那时已经没人能上去看了。
 */
function addReleaseForm(kind) {
  const busy = state.busy
  return `<details ${state.addRelease === kind ? 'open' : ''}>
    <summary style="cursor: pointer; font-size: 13px; color: var(--muted-foreground);">${t('新增版本')}</summary>
    <form data-form="add-release" data-kind="${kind}" style="display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-3);">
      <div style="display: flex; gap: var(--space-3); flex-wrap: wrap;">
        <div class="field" style="margin: 0; flex: 1; min-width: 200px;">
          <label for="ar-ver-${kind}">${t('版本号')}</label>
          <input class="input" id="ar-ver-${kind}" name="version" required placeholder="${kind === 'local-bot' ? '0.1.0+abc1234-windows-x64' : '0.1.0+abc1234-arm64'}" autocomplete="off">
        </div>
        <div class="field" style="margin: 0; width: 160px;">
          <label for="ar-size-${kind}">${t('大小')}（${t('字节')}）</label>
          <input class="input" id="ar-size-${kind}" name="size" required inputmode="numeric" placeholder="9376749" autocomplete="off">
        </div>
      </div>
      <div class="field" style="margin: 0;">
        <label for="ar-sha-${kind}">sha256</label>
        <input class="input" id="ar-sha-${kind}" name="sha256" required placeholder="${esc(t('64 位十六进制'))}" autocomplete="off">
      </div>
      <div class="field" style="margin: 0;">
        <label for="ar-url-${kind}">${t('下载地址')}</label>
        <input class="input" id="ar-url-${kind}" name="url" required placeholder="https://…/${kind}-0.1.0.tgz" autocomplete="off">
      </div>
      <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('保存前会把包整个拉一遍，核对大小与 sha256、确认入口文件在。验不过不入库。')}</p>
      <div><button type="submit" class="btn btn-primary" ${busy ? 'disabled' : ''}>${busy ? t('验证中…') : t('验证并保存')}</button></div>
    </form>
  </details>`
}

function companyDetailPage() {
  const c = state.org
  if (!c) {
    return `<div class="gw-page"><div class="gw-page-inner">${flashes()}<p style="color: var(--muted-foreground);">${t('载入中…')}</p></div></div>`
  }
  const plan = state.plan || { seats: 0, used: 0 }
  const seats = state.seats || { total: plan.seats || 0, used: plan.used || 0 }
  const members = state.accounts || []
  const billing = state.billing || { plan: {}, invoices: [] }
  const bplan = billing.plan || {}
  const invoices = Array.isArray(billing.invoices) ? billing.invoices : []
  const used = plan.used ?? seats.used ?? 0
  const total = plan.seats ?? seats.total ?? 0
  const envCols = 'minmax(170px, 2fr) 88px 72px minmax(90px, 1fr) minmax(120px, 1.3fr) 72px'
  const memberRows = members
    .map((m) => {
      const st = MEMBER_STATUS[m.status] || MEMBER_STATUS.active
      const runtimes = Array.isArray(m.runtimes) ? m.runtimes : []
      // 这一列本来只说「装的是哪个包」。模版版本跟在后面：一眼扫下去，落在旧版上的那
      // 几行就自己跳出来了，不用挨个点开。
      const env = runtimes.length
        ? runtimes
            .map((rt) => {
              const base = esc(rt.botVersion || rt.botId || rt.status || '—')
              return rt.tplVersion ? `${base} · ${t('模版', 'tpl')} v${esc(String(rt.tplVersion))}` : base
            })
            .join(' · ')
        : t('未部署')
      return `<div class="satu-memberrow" style="grid-template-columns: ${envCols};">
      <button type="button" class="satu-linkbtn" data-act="seat-open" data-id="${esc(m.id)}" style="min-width: 0; display: flex; align-items: center; gap: var(--space-3); text-align: left; padding: 0; border: 0; background: transparent;">
        <span class="satu-avatar" style="background: var(--color-neutral-300); color: var(--color-neutral-800);">${esc((m.name || m.email || '·').slice(0, 1).toUpperCase())}</span>
        <div style="min-width: 0;">
          <div style="font-size: 13.5px; font-weight: 600;">${esc(m.name || m.email)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(m.email)}</div>
        </div>
      </button>
      ${roleTag(m.role)}
      <span class="tag ${st.tag}">${t(st.label)}</span>
      <span style="font-size: 13px; color: var(--muted-foreground);">${esc(ago(m.lastSeenAt))}</span>
      <span style="font-size: 13px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${env}</span>
      <button type="button" class="satu-linkbtn" data-act="seat-open" data-id="${esc(m.id)}">${t('查看')}</button>
    </div>`
    })
    .join('')
  const invoiceRows = invoices.map((b) => invoiceRow(b)).join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${esc(c.name || t('公司详情'))}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${esc(c.slug || '')}</p>
        </div>
        ${flashes()}
        <form class="satu-panel" data-form="org-profile" data-id="${esc(c.id)}" style="gap: var(--space-4);">
          <span class="satu-panel-title">${t('公司信息')}</span>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-3);">
            <div class="field" style="margin: 0;">
              <label for="cd-name">${t('名称')}</label>
              <input class="input" id="cd-name" name="name" value="${esc(c.name || '')}" required>
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-slug">slug</label>
              <input class="input" id="cd-slug" name="slug" value="${esc(c.slug || '')}" required>
            </div>
            <div class="field" style="margin: 0;">
              <label>${t('状态')}</label>
              <div style="display: flex; align-items: center; gap: var(--space-3);">
                ${companyStatusTag(c.status)}
                <button type="button" class="btn btn-secondary" data-act="org-status" data-id="${esc(c.id)}" data-next="${c.status === 'disabled' ? 'active' : 'disabled'}">
                  ${c.status === 'disabled' ? t('启用') : t('停用')}
                </button>
              </div>
              <span style="font-size: 12px; color: var(--muted-foreground);">${t('状态单独生效，不用保存这张表单。停用后这家公司的人一律登不进来')}</span>
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-contact-name">${t('联系人')}</label>
              <input class="input" id="cd-contact-name" name="contactName" value="${esc(c.contactName || '')}" required>
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-contact-phone">${t('电话')}</label>
              ${phoneField('cd-contact-phone', c.contactPhone)}
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-contact-email">${t('联系邮箱')}</label>
              <input class="input" id="cd-contact-email" name="contactEmail" type="email" value="${esc(c.contactEmail || '')}" required>
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-address">${t('公司地址')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
              <input class="input" id="cd-address" name="address" value="${esc(c.address || '')}">
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-website">${t('网站')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
              <input class="input" id="cd-website" name="website" value="${esc(c.website || '')}" placeholder="https://acme.com">
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-url">${t('访问地址')}</label>
              <input class="input" id="cd-url" name="accessUrl" value="${esc(c.accessUrl || '')}" placeholder="https://acme.satuwork.com">
            </div>
          </div>
          <div class="satu-kv"><span>id</span><span>${esc(c.id || '—')}</span></div>
          <div class="satu-kv"><span>${t('创建时间')}</span><span>${esc(fmtTime(c.createdAt))}</span></div>
          <div class="satu-kv"><span>machineId</span><span>${esc(c.machineId || '—')}</span></div>
          <div style="display: flex; justify-content: flex-end;">
            <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
          </div>
        </form>
        ${machinePanel(c.id)}
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
            <h2 style="font-size: 18px; margin: 0;">${t('成员')}</h2>
            <div style="display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;">
              <span style="font-size: 12px; color: var(--muted-foreground);">${t(`平台最新 ${esc(state.latestRelease || t('还没有发布版本'))}`, `Latest ${esc(state.latestRelease || t('还没有发布版本'))}`)} · ${t(`${members.length} 人`, `${members.length} people`)} · ${t('已用')} ${t(`${esc(used)} / ${esc(total)} 席位`, `${esc(used)} / ${esc(total)} seats`)}</span>
            </div>
          </div>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-memberhead" style="grid-template-columns: ${envCols};">
              <span>${t('成员')}</span><span>${t('角色')}</span><span>${t('状态')}</span><span>${t('最近活跃')}</span><span>${t('环境')}</span><span></span>
            </div>
            ${memberRows || emptyBox(t('还没有成员'))}
          </div>
        </div>
        <div class="satu-panel">
          <span class="satu-panel-title">${t('订阅')}</span>
          <div style="display: flex; align-items: baseline; gap: var(--space-2);">
            <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(planLabel(plan) || t('无套餐'))}</span>
            ${plan.expiresAt && plan.expiresAt < Date.now() ? `<span class="tag tag-neutral">${t('已到期')}</span>` : ''}
          </div>
          <div class="satu-kv"><span>${t('席位')}</span><span>${esc(used)} / ${esc(total)}</span></div>
          <div class="satu-kv"><span>${t('账期')}</span><span>${esc(bplan.period || '—')}</span></div>
          <div class="satu-kv"><span>${t('到期时间')}</span><span>${esc(plan.expiresAt ? dayISO(plan.expiresAt) : t('不限期'))}</span></div>
          <div class="satu-kv"><span>${t('周期费用')}</span><span>${esc(bplan.amount || '—')}</span></div>
          <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('订阅按订单走：套餐、席位、到期时间都跟着订单，改这些请到订单页下单。')}</p>
        </div>
        ${balancePanel()}
        ${topupRecordsPanel()}
        ${billTable(t('订阅账单'), [t('账期'), t('金额'), t('状态'), t('付款时间'), ''], invoiceRows, t('还没有订阅账单。支付接上之后，账期会列在这里。'))}
        ${chargeTable('org', state.org?.id || '')}
        ${seatEnvModal()}
      </div>
    </div>`
}

function machinePanel(orgId) {
  const list = state.machines || []
  const cap = state.machineCapacity || { accounts: 0, max: 0 }
  const code = state.pairingCode
  // 配对码只在生成的那一刻拿得到，刷新页面就没了——所以要显眼，还要能一键复制。
  const codeBox = code
    ? `<div class="satu-panel" style="margin: 0; background: var(--muted);">
        <div class="satu-kv"><span>${t('配对码')}</span><span style="font-family: var(--font-mono); font-size: 16px; letter-spacing: 1px;">${esc(code.code)}</span></div>
        <div class="satu-kv"><span>${t('有效期至')}</span><span>${esc(new Date(code.expiresAt).toLocaleString())}</span></div>
        <p style="margin: var(--space-2) 0 6px; font-size: 12px; color: var(--muted-foreground);">${t('在那台 Debian 上用 root 跑这一条，装完即配对：')}</p>
        <pre style="margin: 0; padding: 10px; overflow-x: auto; background: var(--background); border-radius: var(--radius); font-size: 12px;"><code>${esc(code.installCommand)}</code></pre>
        <p style="margin: var(--space-2) 0 0; font-size: 12px; color: var(--muted-foreground);">${t('同一个地址重跑 = 重新配对那一台；换一台机器跑 = 新增一台。')}</p>
        <div style="margin-top: var(--space-2);"><button type="button" class="satu-linkbtn" data-act="copy-install">${t('复制命令')}</button></div>
      </div>`
    : ''
  const cards = list.length
    ? list.map((m) => machineCard(orgId, m)).join('')
    : `<p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('还没有配对任何机器')}</p>`
  return `<div class="satu-panel">
    <span class="satu-panel-title">${t('运行机器')}</span>
    <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('装上机器管家并配对之后，建账号、装包、起桌面全归它——Gateway 不保存任何登录这台机器的凭据。')}</p>
    <div class="satu-kv"><span>${t('账号位')}</span><span>${cap.accounts} / ${cap.max}${cap.max && cap.accounts >= cap.max ? ' · ' + t('已满，新员工无法部署') : ''}</span></div>
    ${cards}
    ${list.length ? timezoneOptions() : ''}
    ${codeBox}
    <div><button type="button" class="btn btn-primary" data-act="pairing-code" data-id="${esc(orgId)}" ${state.busy ? 'disabled' : ''}>${list.length ? t('新增 / 重配机器') : t('生成配对码')}</button></div>
  </div>`
}

/**
 * 通联状态 → 一盏灯 + 一句话。
 *
 * **判据是心跳的新旧，不是 `lastError`。** 能报错说明线是通的；把两件事塞进同一盏灯，
 * 「机器失联」和「机器在线但升级失败」就长成一个样子，而这两种的处置完全不同。错误
 * 另有一行 lastError 管。
 *
 * 中间那档 `stale` 不是凑数：换版重启本身就会断几十秒，一超时就报红会让每次自升级都
 * 闪一次红灯，几次之后没人再信这盏灯。
 */
const LINK_TEXT = {
  online: () => t('在线'),
  stale: () => t('心跳迟了'),
  offline: () => t('失联'),
  unpaired: () => t('还没有配对'),
  unknown: () => t('状态未知'),
}

/** 「多久之前」。秒级起步——心跳 30 秒一轮，只报到分钟就看不出刚刚断没断。 */
function sinceMs(ms) {
  if (ms == null) return ''
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return t(`${sec} 秒前`, `${sec}s ago`)
  const min = Math.floor(sec / 60)
  if (min < 60) return t(`${min} 分钟前`, `${min} min ago`)
  const hr = Math.floor(min / 60)
  if (hr < 24) return t(`${hr} 小时前`, `${hr} h ago`)
  return t(`${Math.floor(hr / 24)} 天前`, `${Math.floor(hr / 24)} d ago`)
}

/**
 * 卡片的头一行：灯、编号、短码、状态，右端一颗刷新。
 *
 * **编号和短码是两样东西。** 「1 号机」是给人照着念的，中间删掉一台后面就会往前挪；
 * 要唯一地指一台得用 id，所以短码那颗按钮复制的是**完整 id**，显示的只是前 8 位——
 * 完整 UUID 摆在卡片头上，占一行，还没人读得下来。
 */
function machineHead(orgId, card, m) {
  // **「后端没给这个字段」不等于「机器没配对」。** 这两件事差得最远，而合成一个兜底
  // 值的代价是：一台心跳正常、版本刚升完的机器，界面上写着「还没有配对」。开发时
  // 前端比后端新一步就会撞上（浏览器读的是磁盘上的 app.js，Gateway 要重启才换代码）。
  //
  // `paired` 是老响应里就有的，可信；`link` 缺了就老实说不知道，不替它猜一个。
  const link = m.link || (m.paired === false ? 'unpaired' : 'unknown')
  const label = (LINK_TEXT[link] || LINK_TEXT.unknown)()
  // 「还没有配对」本身就说完了，再缀一个「从未」是废话；配对过却没心跳过才要点出来。
  // 状态未知时也不缀——那个数字同样来自缺席的那批字段。
  const when =
    link === 'unpaired' || link === 'unknown'
      ? ''
      : m.heartbeatAge == null
        ? ' · ' + t('从未心跳')
        : ' · ' + sinceMs(m.heartbeatAge)
  const short = String(m.id || '').slice(0, 8)
  return `<div class="satu-machinehead">
    <span class="satu-linkdot" data-link="${esc(link)}" title="${esc(label)}"></span>
    ${/* 编号缺席时整个略过，不画「机器 ?」——一个问号既指代不了机器，也说不清是哪儿出了问题。 */ ''}
    ${card.no ? `<span class="satu-machineno">${t('机器')} ${esc(card.no)}</span>` : ''}
    ${short ? `<button type="button" class="satu-linkbtn satu-machineid" data-act="copy-machine-id" data-machine="${esc(m.id)}" title="${t('复制完整编号')}">${esc(short)}</button>` : ''}
    <span style="font-size: 13px; color: var(--muted-foreground);">${esc(label)}${esc(when)}</span>
    ${/* 卡片上的心跳、版本都是机器自报的，下完指令要等下一轮心跳才变——所以要有一颗
         「我现在就想知道」的按钮。它只重拉 Gateway 手上这一份，不去戳机器。

         没有 data-machine：机器那个接口一次回整张列表，重拉就是全都新的，没有
         「只刷这一台」这回事。挂一个用不上的 id 会让人以为有。 */ ''}
    <button type="button" class="satu-linkbtn satu-machinerefresh" data-act="machine-refresh" data-id="${esc(orgId)}" ${state.busy ? 'disabled' : ''} title="${t('重新拉一遍这台机器的信息')}">${t('刷新')}</button>
  </div>`
}

/**
 * 一台机器一张卡：地址、容量、两行版本、各自的升级按钮。
 *
 * 「已用」是**激活账号数**，不是席位数——一个员工的多个 bot 落在同一台机器上，只占
 * 一个账号位。席位数另外标出来，运维时想知道机器上到底有多少个进程。
 */
function machineCard(orgId, card) {
  const m = card.machine || {}
  const full = card.full
  return `<div class="satu-panel" style="margin: 0; background: var(--muted);">
    ${machineHead(orgId, card, m)}
    <div class="satu-kv"><span>${t('地址')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; word-break: break-all;">
      ${esc(m.host || '—')}
      ${/* 有席位也给点：席位的登记会跟着一起没，点下去先弹确认（见 removeMachine）。
           以前有席位就整个不画这颗按钮，结果是人只会以为功能没做。 */ ''}
      <button type="button" class="satu-linkbtn" data-act="machine-remove" data-id="${esc(orgId)}" data-machine="${esc(m.id)}" ${state.busy ? 'disabled' : ''}>${t('移除')}</button>
    </span></div>
    <div class="satu-kv"><span>${t('账号位')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
      ${m.paired ? `${card.accounts} / ${card.maxAccounts}` : `<span style="color: var(--muted-foreground);">${t('未配对，不提供账号位')}</span>`}${full ? ` <span class="tag">${t('已满')}</span>` : ''} · ${t('席位')} ${card.seats}
      <form data-form="machine-capacity" data-id="${esc(orgId)}" data-machine="${esc(m.id)}" style="display: inline-flex; gap: 6px; align-items: center;">
        <input class="input" name="maxAccounts" type="number" min="1" max="1000" value="${esc(card.maxAccounts)}" style="width: 84px;">
        <button type="submit" class="satu-linkbtn" ${state.busy ? 'disabled' : ''}>${t('改容量')}</button>
      </form>
    </span></div>
    <div class="satu-kv"><span>${t('最近心跳')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
      ${m.lastHeartbeatAt ? esc(new Date(m.lastHeartbeatAt).toLocaleString()) : t('还没有')}
      ${/* 没有 SSH 的时候，「这台机器怎么了」只能靠日志。管家自己那条和各席位的 bot
           那条答的不是同一个问题，所以两个都要能选。 */ ''}
      ${m.paired ? `<button type="button" class="satu-linkbtn" data-act="machine-logs" data-id="${esc(orgId)}" data-machine="${esc(m.id)}">${t('查看日志')}</button>` : ''}
    </span></div>
    ${machineLoadRow(m)}
    ${timezoneRow(orgId, m, card)}
    ${managerVersionRow(orgId, m, card)}
    ${botVersionRow(orgId, card)}
    ${botTemplateRow(card)}
    ${m.lastError ? `<div class="satu-kv"><span>lastError</span><span>${esc(m.lastError)}</span></div>` : ''}
    <form data-form="machine" data-id="${esc(orgId)}" data-machine="${esc(m.id)}" style="display: flex; gap: var(--space-2); align-items: flex-end;">
      <div class="field" style="margin: 0; flex: 1;">
        <label>${t('管家地址')}</label>
        <input class="input" name="host" value="${esc(m.host || '')}" placeholder="http://10.0.0.12:8443" autocomplete="off">
      </div>
      <button type="submit" class="btn" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
    </form>
    <form data-form="machine-direct" data-id="${esc(orgId)}" data-machine="${esc(m.id)}" style="display: flex; gap: var(--space-2); align-items: flex-end;">
      <div class="field" style="margin: 0; flex: 1;">
        <label>${t('桌面直连地址')}</label>
        <input class="input" name="directUrl" value="${esc(m.directUrl || '')}" placeholder="https://m001.example.com" autocomplete="off">
      </div>
      <button type="submit" class="btn" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
    </form>
    <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('填上之后桌面画面由浏览器直连这台机器，不再经过 Gateway。必须公网可达且是 https。留空 = 照旧从 Gateway 反代。')}${m.directPending ? `<br><b>${t('地址填了，但这台机器的管家版本还不够新，桌面仍在走 Gateway 反代——等它自升级上来会自动切过去。')}</b>` : ''}</p>
  </div>`
}

/**
 * 负载与日志占用，**只读一行**。
 *
 * 这张卡答的是「这家公司手上有几台、够不够用」，不是运维台——所以这里只把最吃紧的
 * 那一项和 journal 的大小摆出来，改上限、手动清理这些动作都在平台的机器详情页
 * （那一页才是为「这台机器怎么了」准备的）。两处共用同一批渲染函数（见
 * pages-machines.js），免得同一台机器在两个页面上说两种话。
 *
 * 机器没报过就整行不画：一行「—」占着地方却什么也没说。
 */
function machineLoadRow(m) {
  const load = (m.telemetry && m.telemetry.metrics) || null
  const logs = (m.telemetry && m.telemetry.logs) || null
  if (!load && !logs) return ''
  const age = m.telemetryAge == null ? '' : sinceMs(m.telemetryAge)
  return `<div class="satu-kv"><span>${t('负载')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
    ${load ? machineLoadCell(m) : ''}
    ${logs ? `<span style="font-size: 13px; color: var(--muted-foreground);">${t('日志')} ${esc(fmtBytes(logs.journalBytes))}</span>` : ''}
    ${age ? `<span style="font-size: 12px; color: var(--muted-foreground);">· ${esc(age)}</span>` : ''}
  </span></div>`
}

/**
 * 机器时区行。
 *
 * 和「升级」是同一条路：Gateway 没有登录这台机器的凭据，填进去只是**把期望时区钉在
 * 这台机器上**，真正 `timedatectl set-timezone` 的是机器上的管家，下一轮心跳才知道
 * 成没成。所以这里显示的是**机器自报的实际时区**，指令还没落地时另标一句，不写成
 * 「已生效」。
 *
 * 留空 = 不再管这台机器的时区（不会把机器改回去）。
 */
function timezoneRow(orgId, m, card) {
  const cur = m.currentTimezone || (m.paired ? t('机器没报') : '—')
  const note = card.timezonePending
    ? ` · ${t('已下指令，等机器改')} → ${esc(m.timezone || '')}`
    : m.timezone
      ? ` · ${t('已生效')}`
      : ` · ${t('没有指定，跟机器现状')}`
  return `<div class="satu-kv"><span>${t('时区')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
    ${esc(cur)}${note}
    <form data-form="machine-timezone" data-id="${esc(orgId)}" data-machine="${esc(m.id)}" style="display: inline-flex; gap: 6px; align-items: center;">
      <input class="input" name="timezone" list="satu-timezones" value="${esc(m.timezone || '')}" placeholder="Asia/Shanghai" autocomplete="off" spellcheck="false" style="width: 200px;">
      <button type="submit" class="satu-linkbtn" ${state.busy ? 'disabled' : ''}>${t('改时区')}</button>
    </form>
  </span></div>`
}

/**
 * 时区候选。浏览器自己就有全套 IANA 表（`Intl.supportedValuesOf`），不必在前端塞一份
 * 会过期的清单。取不到就退回几个常用的——datalist 只是补全，手打任何合法名字都收，
 * 真正认不认由 Gateway 判。
 *
 * **整个面板只出一份**（不是每台机器一份）：id 要唯一，而且这张表有四百多项，
 * 多机公司逐台复制一遍纯属白搭 DOM。
 */
let timezoneList = null
function timezoneOptions() {
  if (!timezoneList) {
    try {
      timezoneList = Intl.supportedValuesOf('timeZone')
    } catch {
      timezoneList = ['Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Kolkata', 'Europe/London', 'UTC']
    }
  }
  return `<datalist id="satu-timezones">${timezoneList.map((z) => `<option value="${esc(z)}"></option>`).join('')}</datalist>`
}

/**
 * 管家版本行。
 *
 * 「升级」只是**把期望版本钉到这台机器上**——真正换版由机器在下一轮心跳里自己做：
 * 它要挑不忙的时候、要跑自检、失败要回滚，这些只有机器上做得了。所以按下之后显示
 * 的是「等机器换版」，不是「已升级」。
 */
function managerVersionRow(orgId, m, card) {
  const cur = m.managerVersion || '—'
  const latest = state.managerLatest
  const canUp = card.managerOutdated
  const note = card.managerPending
    ? ` · ${t('已下指令，等机器换版')} → ${esc(card.managerDesired || '')}`
    : m.protocolTooOld
      ? ' · ' + t('版本过旧，等它自升级')
      : canUp
        ? ` · ${t('最新')} ${esc(latest)}`
        : ''
  const btn = canUp
    ? `<button type="button" class="btn" data-act="upgrade-manager" data-id="${esc(orgId)}" data-machine="${esc(m.id)}" ${state.busy ? 'disabled' : ''}>${t('升级')}</button>`
    : ''
  return `<div class="satu-kv"><span>${t('管家版本')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">${esc(cur)}${note}${btn}</span></div>`
}

/**
 * Bot 运行时版本行。
 *
 * 一台机器上可以同时躺着几个版本——有的席位部署得早、有的重新部署过。混版本本身
 * 不是错误，但得看得见，不然「升级完了吗」永远说不清。所以列的是清单加席位数。
 */
function botVersionRow(orgId, card) {
  const list = card.botVersions || []
  const text = list.length
    ? list.map((v) => `${esc(v.version || t('未部署'))} × ${v.seats}`).join('、')
    : t('还没有部署席位')
  const canUp = card.botOutdated
  const note = canUp ? ` · ${t('最新')} ${esc(state.botLatest || '')}` : ''
  const btn = canUp
    ? `<button type="button" class="btn" data-act="upgrade-bot" data-id="${esc(orgId)}" ${state.updatingRuntime ? 'disabled' : ''}>${state.updatingRuntime ? t('更新中…') : t('全部升级')}</button>`
    : ''
  return `<div class="satu-kv"><span>${t('Bot 运行时')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">${text}${note}${btn}</span></div>`
}

/**
 * 这台机器上的席位在跑哪一版**公司模版**。
 *
 * 和上面那行「Bot 运行时」是两件事：那行说的是装了哪个发布包，这行说的是跑着哪一版
 * 模版。两者会各自落后——包升到最新了、模版还停在三版之前，只看上面那行看不出来。
 *
 * 数字是**席位自己报上来的**（探针捎回，见迁移 0013）。没报到过的单独说，不混进某个
 * 版本号里：那多半意味着那台上的 bot 进程不在了，而它和「跑着旧版本」要查的是两件事。
 */
function botTemplateRow(card) {
  const list = card.tplVersions || []
  if (!list.length) return ''
  const known = list.filter((v) => v.version)
  const unknown = list.find((v) => !v.version)
  const text = [
    ...known.map((v) => `v${esc(String(v.version))} × ${v.seats}`),
    ...(unknown ? [t(`还没报到 × ${unknown.seats}`, `never reported × ${unknown.seats}`)] : []),
  ].join('、')
  return `<div class="satu-kv"><span>${t('Bot 模版')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">${text}</span></div>`
}

function botNameOfId(id) {
  const b = (state.bots || []).find((x) => x.id === id)
  return (b && b.name) || id || '—'
}

function seatEnvModal() {
  if (!state.seatMember) return ''
  const m = state.seatMember
  const runtimes = Array.isArray(state.seatRuntimes) ? state.seatRuntimes : []
  const body = runtimes.length
    ? runtimes
        .map((rt) => {
          const pw = rt && rt.vncPassword ? (state.seatReveal ? rt.vncPassword : '••••••••') : '—'
          return `<div class="satu-panel" style="margin: 0;">
        <span class="satu-panel-title">${esc(botNameOfId(rt.botId))}</span>
        <div class="satu-kv"><span>botId</span><span>${esc(rt.botId || '—')}</span></div>
        <div class="satu-kv"><span>linuxUser</span><span>${esc(rt.linuxUser || '—')}</span></div>
        <div class="satu-kv"><span>seatId</span><span style="word-break: break-all;">${esc(rt.seatId || '—')}</span></div>
        <div class="satu-kv"><span>${t('共享目录')}</span><span style="word-break: break-all;">${esc(rt.sharedDir || '—')}</span></div>
        <div class="satu-kv"><span>DISPLAY</span><span>${esc(rt.display != null ? ':' + rt.display : '—')}</span></div>
        <div class="satu-kv"><span>noVNC</span><span style="word-break: break-all;">${esc(rt.novncUrl || '—')}</span></div>
        <div class="satu-kv"><span>${t('VNC 密码')}</span><span>${esc(pw)} <button type="button" class="satu-linkbtn" data-act="seat-reveal">${state.seatReveal ? t('隐藏') : t('显示')}</button></span></div>
        <div class="satu-kv"><span>${t('状态')}</span><span>${esc(rt.status || '—')}</span></div>
        <div class="satu-kv"><span>${t('Bot 版本')}</span><span>${esc(rt.botVersion || t('未部署'))}</span></div>
        <!-- 两个「版本」问的是两件事：装的是哪个发布包、跑的是哪一版公司模版。后者由席位
             自己报上来，所以还带着「什么时候报的」——版本号对得上、汇报停在两小时前，
             说明那个进程已经不在了。 -->
        <div class="satu-kv"><span>${t('模版版本')}</span><span>${
          rt.tplVersion
            ? esc(`v${rt.tplVersion} · ${ago(rt.tplSyncedAt)}`)
            : t('还没报到过', 'never reported')
        }</span></div>
        ${rt.lastError ? `<div class="satu-kv"><span>lastError</span><span>${esc(rt.lastError)}</span></div>` : ''}
      </div>`
        })
        .join('') +
      `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('x11vnc 只听 localhost；noVNC 走内网 HTTP。不要当成公网安全。')}</p>`
    : `<p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${state.seatError || t('还没有部署。员工自己建一颗 Bot，它就会自己装上。')}</p>`
  return `<div class="gw-modal-backdrop" data-act="seat-close">
    <div class="gw-modal" style="max-width: 520px;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t('员工环境')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${esc(m.name || m.email)} · ${esc(m.email)}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="seat-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      ${body}
    </div>
  </div>`
}
