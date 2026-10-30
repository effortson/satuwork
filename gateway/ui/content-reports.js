/* Explicit, in-app safety reports. Never send other messages or attachments automatically. */
let contentReportDraft = null
const CONTENT_REASONS = [
  ['sexual', '色情内容', 'Sexual content'], ['violence', '露骨暴力', 'Graphic violence'],
  ['child_safety', '儿童安全', 'Child safety'], ['hate', '仇恨或骚扰', 'Hate or harassment'],
  ['dangerous', '危险或违法内容', 'Dangerous or illegal content'], ['other', '其他问题', 'Other issue'],
]

function openContentReport(key, seq) {
  const row = document.querySelector('#chat-thread .sw-msg[data-key="' + CSS.escape(key) + '"]')
  if (!row || row.getAttribute('data-role') !== 'assistant' || !Number.isSafeInteger(Number(seq)) || Number(seq) <= 0) return
  closeMsgMenu()
  contentReportDraft = { accountId: state.me?.account?.id, botId: chatBotIdNow(), sessionId: state.chatSessionId, seq: Number(seq), reason: 'other',
    excerpt: (row.querySelector('.sw-md')?.innerText || '').trim().slice(0, 2000), note: '', consent: false, busy: false }
  render()
  document.getElementById('content-report-reason')?.focus()
}

function contentReportModal() {
  const d = contentReportDraft
  if (!d) return ''
  if (d.accountId !== state.me?.account?.id) { contentReportDraft = null; return '' }
  return modalBox({ close: 'content-report-close', tag: 'form',
    attrs: 'id="content-report-form" class="gw-modal" data-stop role="dialog" aria-modal="true" aria-labelledby="content-report-title" style="max-width:540px;max-height:90dvh;overflow:auto"',
    title: '<span id="content-report-title">' + esc(t('举报 AI 内容', 'Report AI content')) + '</span>',
    sub: esc(t('Satuwork 仅用于企业工作，禁止色情及露骨暴力。', 'Satuwork is for enterprise work. Pornography and graphic violence are prohibited.')),
    body: '<label for="content-report-reason">' + esc(t('问题类别', 'Issue')) + '</label>' +
      '<select class="input" name="reason" id="content-report-reason">' + CONTENT_REASONS.map(([v, zh, en]) => '<option value="' + v + '"' + (d.reason === v ? ' selected' : '') + '>' + esc(t(zh, en)) + '</option>').join('') + '</select>' +
      '<label for="content-report-excerpt">' + esc(t('要发送的片段（可编辑或清空）', 'Excerpt to send (edit or remove)')) + '</label>' +
      '<textarea class="input" rows="4" maxlength="2000" name="excerpt" id="content-report-excerpt">' + esc(d.excerpt) + '</textarea>' +
      '<label for="content-report-note">' + esc(t('补充说明（选填）', 'Additional details (optional)')) + '</label>' +
      '<textarea class="input" rows="2" maxlength="1000" name="note" id="content-report-note">' + esc(d.note) + '</textarea>' +
      '<label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" name="consent" required' + (d.consent ? ' checked' : '') + '><span>' + esc(t('将所选片段、说明、账号及会话标识发送给此服务器的服务运营方用于安全审核。请先删除机密信息；不会附带其他消息或文件。', 'Send this excerpt, details, account and conversation identifiers to this server’s service operator for safety review. Remove confidential information first. No other messages or files are attached.')) + '</span></label>' +
      (d.error ? '<p role="alert">' + esc(d.error) + '</p>' : '') +
      '<div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn btn-secondary" data-act="content-report-close"' + (d.busy ? ' disabled' : '') + '>' + esc(t('取消', 'Cancel')) + '</button>' +
      '<button type="submit" class="btn btn-primary"' + (d.busy ? ' disabled' : '') + '>' + esc(d.busy ? t('正在提交', 'Sending') : t('提交举报', 'Submit report')) + '</button></div>' })
}

document.addEventListener('input', (e) => {
  if (e.target.name === 'note' && e.target.closest?.('[data-content-review]')) {
    const id = e.target.closest('[data-content-review]').getAttribute('data-content-review')
    ;(state.contentReviewNotes ||= {})[id] = e.target.value
  }
  if (!contentReportDraft || !e.target.closest?.('#content-report-form')) return
  const el = e.target
  if (['reason', 'excerpt', 'note'].includes(el.name)) contentReportDraft[el.name] = el.value
  if (el.name === 'consent') contentReportDraft.consent = el.checked
})

async function submitContentReport(e) {
  e.preventDefault()
  const d = contentReportDraft
  if (!d || d.busy) return
  const form = new FormData(e.target)
  Object.assign(d, { reason: String(form.get('reason')), excerpt: String(form.get('excerpt') || ''), note: String(form.get('note') || ''), consent: form.has('consent') })
  if (!d.consent) return
  d.busy = true
  d.error = ''
  render()
  try {
    await api('POST', '/me/content-reports', { botId: d.botId, sessionId: d.sessionId, seq: d.seq, reason: d.reason, excerpt: d.excerpt, note: d.note, consent: true })
    if (contentReportDraft === d) contentReportDraft = null
    flash('ok', t('举报已提交给服务运营方进行安全审核。', 'Report submitted to the service operator for safety review.'))
  } catch (err) { d.error = err.message || t('提交失败，请重试。', 'Submission failed. Please retry.'); d.busy = false }
  render()
}

async function loadContentReports(more = false) {
  const rows = state.contentReports || [], last = more ? rows[rows.length - 1] : null
  const query = last ? '?before=' + Number(last.createdAt) + '&beforeId=' + encodeURIComponent(last.id) : ''
  const data = await api('GET', '/platform/content-reports' + query)
  state.contentReports = more ? [...rows, ...data.reports] : data.reports
  state.contentReportsMore = data.reports.length === 50
}

function contentReportsPage() {
  const rows = state.contentReports || []
  const reasonLabel = (reason) => { const found = CONTENT_REASONS.find(([v]) => v === reason); return found ? t(found[1], found[2]) : reason }
  const cards = rows.map((r) => '<section class="satu-panel" style="gap:12px"><div><strong>' + esc(reasonLabel(r.reason)) + '</strong> · ' + esc(new Date(Number(r.createdAt)).toLocaleString()) + ' · ' + esc(r.status === 'reviewed' ? t('已审核', 'Reviewed') : t('待审核', 'Open')) + '</div>' +
    '<div class="mg-help">' + esc(r.id) + '<br>' + esc(r.accountId) + ' / ' + esc(r.botId) + ' / ' + esc(r.sessionId) + ' #' + Number(r.seq) + '</div>' +
    '<pre style="white-space:pre-wrap;overflow-wrap:anywhere">' + esc(r.excerpt) + '</pre><p>' + esc(r.note) + '</p>' +
    (r.status === 'reviewed' ? '<p>' + esc(r.reviewNote) + '</p>' : '<form data-content-review="' + esc(r.id) + '"><label>' + esc(t('处置及过滤改进记录', 'Action taken and filtering improvements')) + '<textarea class="input" name="note" maxlength="1000" required>' + esc(state.contentReviewNotes?.[r.id] || '') + '</textarea></label><button class="btn btn-primary" type="submit">' + esc(t('完成审核', 'Mark reviewed')) + '</button></form>') + '</section>').join('')
  return '<div class="gw-page"><div class="gw-page-inner">' + pageHead(t('内容举报', 'Content reports'), t('检查举报、记录处置，并据此改进内容限制。仅平台管理员可见。', 'Review reports, record actions and improve safeguards. Visible only to platform administrators.')) + flashes() +
    '<button class="btn btn-secondary" data-act="content-reports-refresh">' + esc(t('刷新', 'Refresh')) + '</button>' + cards + (!rows.length ? '<p>' + esc(t('暂无举报', 'No reports')) + '</p>' : '') +
    (state.contentReportsMore ? '<button class="btn btn-secondary" data-act="content-reports-more">' + esc(t('加载更多', 'Load more')) + '</button>' : '') + '</div></div>'
}

async function submitContentReview(e) {
  e.preventDefault()
  const form = e.target, button = form.querySelector('button')
  if (button.disabled) return
  button.disabled = true
  try {
    await api('PATCH', '/platform/content-reports/' + encodeURIComponent(form.getAttribute('data-content-review')), { note: String(new FormData(form).get('note') || '') })
    if (state.contentReviewNotes) delete state.contentReviewNotes[form.getAttribute('data-content-review')]
    await loadContentReports()
    flash('ok', t('审核记录已保存', 'Review saved'))
  } catch (err) { flash('err', err.message) }
  render()
}
