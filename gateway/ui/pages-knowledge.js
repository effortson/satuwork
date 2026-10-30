/**
 * 公司知识库（docs/knowledge-base.md §11）。列表、详情、共享范围、上传、试搜。
 *
 * 入口在侧栏名单底下那颗「更多」里，渠道后面。管理员能建库、传文件、改共享；成员只看得见
 * 共享给自己任何一颗 Bot 的库，没有任何写动作。
 */

function kbIdOfPath(p) {
  if (!p || !p.startsWith('/knowledge/')) return ''
  return decodeURIComponent(p.slice('/knowledge/'.length).split('/')[0] || '')
}

function kbBase(extra) {
  return `/orgs/${encodeURIComponent(orgId())}/knowledge${extra || ''}`
}

async function loadKnowledgeConfig() {
  state.kbConfig = await api('GET', kbBase('/config'))
}

async function loadKnowledge() {
  const data = await api('GET', kbBase())
  state.knowledge = {
    enabled: data.enabled !== false,
    reason: data.reason || '',
    list: Array.isArray(data.knowledge) ? data.knowledge : [],
    quota: Number(data.quota) || 0,
    used: Number(data.used) || 0,
  }
}

async function loadKnowledgeDetail(id) {
  const path = state.path
  const previousId = state.kbDetail?.id
  const data = await api('GET', kbBase(`/${encodeURIComponent(id)}`))
  if (state.path !== path || (kbIdOfPath(state.path) && kbIdOfPath(state.path) !== id)) return
  state.kbDetail = { id, knowledge: data.knowledge, files: Array.isArray(data.files) ? data.files : [], canEdit: !!data.canEdit, enabled: data.enabled !== false }
  // 共享范围的编辑态和试搜结果都跟着库走：别拿上一个库的草稿、上一个库的命中画这一个。
  if (!state.kbShareDraft || state.kbShareDraft.id !== id) {
    state.kbShareDraft = { id, share: data.knowledge.share, botIds: [...(data.knowledge.botIds || [])] }
    if (previousId !== id) {
      state.kbSearch = null
      state.kbSearchQuery = null
      state.kbTab = 'files'
    }
  }
  scheduleKnowledgePoll()
}

async function loadKnowledgeBots() {
  const data = await api('GET', kbBase('/bots'))
  state.kbBots = Array.isArray(data.bots) ? data.bots : []
}

/** 入库中的文件每 5 秒拉一次；没有入库中的就不轮。离开这一页就停。 */
function scheduleKnowledgePoll() {
  clearTimeout(state.kbPollTimer)
  const d = state.kbDetail
  if (!d || state.path !== `/knowledge/${encodeURIComponent(d.id)}`) return
  const busy = d.files.some((f) => f.status === 'queued' || f.status === 'processing' || f.status === 'uploading')
  const uploading = (state.kbUploads || []).some((u) => (!u.kbId || u.kbId === d.id) && !u.done)
  if (!busy && !uploading) return
  state.kbPollTimer = setTimeout(async () => {
    if (state.path !== `/knowledge/${encodeURIComponent(d.id)}`) return
    try {
      await loadKnowledgeDetail(d.id)
      paintKnowledgeFiles()
    } catch {}
  }, 5000)
}

const KB_STATUS = {
  uploading: ['上传中', 'Uploading', 'tag-accent'],
  queued: ['排队中', 'Queued', 'tag-accent'],
  processing: ['入库中', 'Indexing', 'tag-accent'],
  ready: ['可检索', 'Searchable', 'mg-status-ok'],
  failed: ['失败', 'Failed', 'tag-warn'],
}

function kbShareLabel(k) {
  if (k.share === 'all') return t('全部 Bot', 'All bots')
  if (k.share === 'bots') return t(`${(k.botIds || []).length} 个 Bot`, `${(k.botIds || []).length} bots`)
  return t('未共享', 'Not shared')
}

function kbMeter(k) {
  const max = state.kbConfig?.limits?.bytesMax || 200 * 1024 * 1024
  const pct = Math.max(0, Math.min(100, Math.round(((k.bytesUsed || 0) / max) * 100)))
  return `<div class="rs-kb-meter"><div class="satu-meter" role="meter" aria-label="${t('知识库容量', 'Knowledge base storage')}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="satu-meterfill" data-alt="${pct >= 90}" style="width:${pct}%"></div></div><span>${esc(fmtBytes(k.bytesUsed || 0))} / ${esc(fmtBytes(max))}</span></div>`
}

function kbCard(k) {
  return `<button type="button" class="satu-panel rs-kb-card" data-act="go" data-href="/knowledge/${encodeURIComponent(k.id)}">
    <div class="rs-kb-card-top"><span class="rs-resource-icon">${svg(['M4 4h7a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4z','M20 4h-7a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h7z'], 22)}</span><span class="tag ${k.share === 'none' ? 'tag-neutral' : 'tag-accent-2'}">${kbShareLabel(k)}</span></div>
    <strong>${esc(k.name)}</strong><p>${esc(k.desc || t('暂无资料说明。', 'No description yet.'))}</p>
    <div class="rs-kb-card-meta"><span>${t(`${k.fileCount || 0} 个文件`, `${k.fileCount || 0} files`)}</span><span>${t(`${k.chunkCount || 0} 个内容片段`, `${k.chunkCount || 0} text chunks`)}</span></div>${kbMeter(k)}
  </button>`
}

function kbCreateModal() {
  const m = state.kbCreate
  if (!m) return ''
  const v = m.draft || { name: '', desc: '', share: 'all' }
  return modalBox({
    close: 'kb-create-close',
    tag: 'form',
    attrs: 'id="kb-create-form" class="gw-modal rs-kb-create" style="max-width: 520px;" data-stop role="dialog" aria-modal="true" aria-label="'+esc(t('新建知识库', 'New knowledge base'))+'"',
    x: false,
    title: t('新建知识库', 'New knowledge base'),
    sub: t(`按主题整理公司资料。创建后可上传文件，每个知识库最多 ${fmtBytes(state.kbConfig?.limits?.bytesMax || 200 * 1024 * 1024)}。`, `Organize company documents by topic. Upload files after creation; each knowledge base holds up to ${fmtBytes(state.kbConfig?.limits?.bytesMax || 200 * 1024 * 1024)}.`),
    body: `${m.error ? `<div class="gw-flash gw-flash-err">${esc(m.error)}</div>` : ''}
      <div class="field">
        <label for="kb-name">${t('名称')}</label>
        <input class="input" id="kb-name" name="name" data-act="kb-create-field" data-field="name" value="${esc(v.name)}" maxlength="60" required>
      </div>
      <div class="field">
        <label for="kb-desc">${t('说明')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
        <input class="input" id="kb-desc" name="desc" data-act="kb-create-field" data-field="desc" value="${esc(v.desc)}" maxlength="200" placeholder="${esc(t('一句话告诉 Bot 这个库里是什么，例如「员工手册与考勤制度」', 'One line telling the bot what is inside, e.g. "Employee handbook and attendance rules"'))}">
      </div>
      ${kbShareField(v.share, 'kb-create-share')}
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="kb-create-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : t('创建', 'Create')}</button>
      </div>`,
  })
}

/** 共享范围三选一。名单那张勾选表只在详情页画（新建时先选范围，名单建完再勾）。 */
function kbShareField(share, name) {
  const opts = [
    ['all', t('全部 Bot', 'All bots'), t('公司现有及之后新建的 Bot 均可检索。', 'All current and future bots in the company can search.')],
    ['bots', t('指定 Bot', 'Selected bots'), t('仅允许你选择的 Bot 检索。', 'Only the bots you select can search.')],
    ['none', t('不共享', 'Not shared'), t('Bot 暂不可检索，管理员仍可测试检索效果。', 'Bots cannot search; admins can still test retrieval.')],
  ]
  return `<fieldset class="rs-share-options"><legend>${t('共享给', 'Share with')}</legend>${opts.map(([key,label,note])=>`<label class="rs-share-option"><input type="radio" name="${esc(name)}" value="${key}" ${share === key ? 'checked' : ''} data-act="kb-share-pick"><span><strong>${label}</strong><small>${note}</small></span></label>`).join('')}${name === 'kb-create-share' ? `<p class="mg-help rs-create-bots-help">${t('创建后，请在“共享与设置”中选择具体 Bot。在选择前，没有 Bot 可以检索此知识库。', 'After creation, select bots under Sharing & settings. No bot can search this knowledge base until then.')}</p>` : ''}</fieldset>`
}

function knowledgePage() {
  const k = state.knowledge
  const admin = isAdmin() || isOwner()
  if (!k) return `<div class="gw-page"><div class="gw-page-inner">${flashes()}${resourceEmpty(t('正在加载知识库', 'Loading knowledge bases'), t('正在获取资料与共享范围。', 'Fetching documents and sharing information.'))}</div></div>`
  const full = k.used >= k.quota
  return `<div class="gw-page rs-page"><div class="gw-page-inner">
    ${pageHead(t('知识库', 'Knowledge bases'), admin ? t('按主题整理公司资料，上传文件并设置哪些 Bot 可以检索。', 'Organize company documents, upload files and choose which bots can search them.') : t('查看公司共享给你的 Bot 的资料与文件。', 'View the documents shared with your bots.'), admin ? `<button type="button" class="btn btn-primary" data-act="kb-create-open" ${full || !k.enabled ? 'disabled' : ''}>${t('新建知识库', 'New knowledge base')}</button>` : '')}
    ${flashes()}
    ${admin ? managementStats([{label:t('已创建知识库', 'Knowledge bases'),value:k.used,note:t(`套餐上限 ${k.quota} 个`, `Plan limit: ${k.quota}`)}, {label:t('资料文件', 'Document files'),value:k.list.reduce((n,x)=>n+(x.fileCount || 0),0),note:t('当前知识库中的文件总数', 'Files in the listed knowledge bases')}, {label:t('已用容量', 'Storage used'),value:fmtBytes(k.list.reduce((n,x)=>n+(x.bytesUsed || 0),0)),note:t('各知识库独立计算容量上限', 'Storage limits apply to each knowledge base')}]) : ''}
    ${!k.enabled ? `<p class="mg-notice" role="status">${t('知识库服务暂不可用，请联系管理员。', 'Knowledge base service is unavailable. Contact your administrator.')}${k.reason ? ` ${esc(k.reason)}` : ''}</p>` : admin && full ? `<p class="mg-notice">${k.quota ? t('已达到知识库数量上限。现有资料仍可管理，如需新增请调整套餐。', 'The knowledge base limit has been reached. You can still manage existing documents; adjust your plan to add more.') : t('当前套餐不含知识库，请联系平台调整套餐。', 'Your plan does not include knowledge bases. Contact the platform to adjust it.')}</p>` : ''}
    <section class="rs-section"><div class="mg-sectionhead"><h2>${admin ? t('公司资料', 'Company documents') : t('共享资料', 'Shared documents')} <span class="rs-count">${k.list.length}</span></h2><span class="mg-help">${t('打开知识库查看文件与检索效果', 'Open a knowledge base to view files and test search')}</span></div>
      ${k.list.length ? `<div class="rs-kb-grid">${k.list.map(kbCard).join('')}</div>` : resourceEmpty(admin ? t('还没有知识库', 'No knowledge bases yet') : t('暂无共享资料', 'No shared documents'), admin ? t('按主题创建知识库，再上传可供 Bot 检索的公司资料。', 'Create a knowledge base by topic, then upload documents for bots to search.') : t('管理员共享资料给你的 Bot 后，会显示在这里。', 'Documents will appear here when an administrator shares them with your bots.'))}
    </section>
  </div>${kbCreateModal()}</div>`
}

function kbFileRow(f, canEdit) {
  const [zh, en, cls] = KB_STATUS[f.status] || KB_STATUS.failed
  const pct = f.status === 'processing' && f.chunkCount ? Math.max(0, Math.min(100, Math.round(((f.chunkDone || 0) / f.chunkCount) * 100))) : null
  return `<div class="satu-memberrow rs-kb-filerow" style="grid-template-columns: minmax(160px, 2fr) 80px 100px 126px 160px;">
    <div style="min-width: 0;">
      <div style="font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${esc(f.name)}">${esc(f.name)}</div>
      ${f.status === 'failed' && f.error ? `<div style="font-size: 12px; color: var(--color-warn-800);">${esc(f.error)}</div>` : ''}
      ${f.status === 'ready' ? `<div style="font-size: 12px; color: var(--muted-foreground);">${t(`${f.chunkCount} 段`, `${f.chunkCount} chunks`)}</div>` : ''}
    </div>
    <span style="font-size: 13px; color: var(--muted-foreground);">${esc(fmtBytes(f.bytes))}</span>
    <span class="tag ${cls}">${t(zh, en)}${pct != null ? ` ${pct}%` : ''}</span>
    <span style="font-size: 12px; color: var(--muted-foreground);">${esc(fmtTime(f.createdAt))}</span>
    <div class="satu-rowactions" style="display: flex; gap: var(--space-2); justify-content: flex-end;">
      ${f.status !== 'uploading' ? `<button type="button" class="btn btn-ghost" data-act="kb-download" data-id="${esc(f.id)}" data-name="${esc(f.name)}">${t('下载', 'Download')}</button>` : ''}
      ${canEdit && f.status === 'failed' ? `<button type="button" class="btn btn-secondary" data-act="kb-file-retry" data-id="${esc(f.id)}">${t('重试', 'Retry')}</button>` : ''}
      ${canEdit ? `<button type="button" class="btn btn-ghost" data-act="kb-file-delete" data-id="${esc(f.id)}" data-name="${esc(f.name)}">${t('删除')}</button>` : ''}
    </div>
  </div>`
}

function kbVisibleUploads() {
  return (state.kbUploads || []).filter(u => (!u.kbId || u.kbId === state.kbDetail?.id) && (!u.done || u.error))
}

function kbUploadRows() {
  const list = kbVisibleUploads()
  return list.length ? `<div class="rs-uploads" aria-label="${t('文件上传进度', 'File uploads')}">${list.map((u,i)=>`<div class="rs-upload-row"><div><strong>${esc(u.name)}</strong><small>${esc(fmtBytes(u.bytes))}</small></div>${u.error ? `<span class="rs-upload-error" role="alert">${esc(u.error)}</span>` : `<div class="rs-upload-progress"><span data-upload-label="${i}">${t('上传中', 'Uploading')} ${u.pct}%</span><div class="satu-meter" role="progressbar" aria-label="${esc(u.name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${u.pct}"><div class="satu-meterfill" data-upload="${i}" style="width:${u.pct}%"></div></div></div>`}</div>`).join('')}</div>` : ''
}

function kbSharePanel(k) {
  const d = state.kbShareDraft || { share: k.share, botIds: k.botIds || [] }
  const bots = state.kbBots || []
  const groups = new Map()
  for (const b of bots) {
    const key = b.owner ? b.owner.name || b.owner.email : b.scope === 'global' ? t('平台', 'Platform') : t('公司', 'Company')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(b)
  }
  const known = new Set(bots.map((b) => b.id))
  const chosen = new Set(d.botIds)
  const dirty = d.share !== k.share || [...chosen].sort().join() !== [...(k.botIds || [])].sort().join()
  return `<form id="kb-share-form" class="satu-panel rs-sharing-panel" style="gap: var(--space-3);">
    <span class="satu-panel-title">${t('共享范围', 'Sharing')}</span>
    ${kbShareField(d.share, 'kb-share')}
    ${d.share === 'bots' ? `<p class="mg-help">${chosen.size ? t(`已选择 ${chosen.size} 个 Bot。`, `${chosen.size} bots selected.`) : t('尚未选择 Bot，保存后没有 Bot 可以检索此知识库。', 'No bots selected. Saving will leave this knowledge base unavailable to all bots.')}</p><div style="border: 1px solid var(--border); border-radius: 12px; padding: var(--space-3); max-height: 320px; overflow: auto; display: flex; flex-direction: column; gap: var(--space-2);">
      ${bots.length ? [...groups.entries()].map(([owner, list]) => `<div>
        <div style="font-size: 12px; color: var(--muted-foreground); margin-bottom: 4px;">${esc(owner)}</div>
        ${list.map((b) => `<label style="display: flex; gap: var(--space-2); align-items: center; font-weight: 400; font-size: 13.5px; cursor: pointer; padding: 2px 0;">
          <input type="checkbox" name="botIds" value="${esc(b.id)}" ${chosen.has(b.id) ? 'checked' : ''} data-act="kb-share-bot">
          <span>${esc(b.name)}</span>
        </label>`).join('')}
      </div>`).join('') : `<span style="font-size: 13px; color: var(--muted-foreground);">${t('公司里还没有 Bot。', 'No bots in the company yet.')}</span>`}
      ${[...chosen].filter((id) => !known.has(id)).length ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t('部分已选 Bot 已被删除，保存时会移除这些无效项。', 'Some bots on the list were deleted; saving will drop them.')}</span>` : ''}
    </div>` : ''}
    <div class="rs-sharing-save">
      <span class="mg-help">${dirty ? t('有未保存的更改', 'Unsaved changes') : t('当前共享范围已保存', 'Sharing settings are saved')}</span>
      <button type="submit" class="btn btn-primary" ${state.busy || !dirty ? 'disabled' : ''}>${state.busy ? t('保存中…') : t('保存共享范围', 'Save sharing')}</button>
    </div>
  </form>`
}

function kbSearchPanel(k) {
  const search = state.kbSearch || {}
  const hits = Array.isArray(search.hits) ? search.hits : null
  return `<form id="kb-search-form" class="satu-panel rs-kb-search"><div><h2>${t('检索测试', 'Test retrieval')}</h2><p class="mg-help">${t('输入一个实际问题，查看 Bot 能检索到的资料片段。仅已完成入库的文件可参与检索。', 'Ask a real question to see which document passages a bot can retrieve. Only indexed files are searchable.')}</p></div>
    <div class="field"><label for="kb-query">${t('测试问题', 'Test question')}</label><div class="rs-search-form"><input class="input" id="kb-query" type="search" name="query" data-act="kb-query" value="${esc(state.kbSearchQuery ?? search.query ?? '')}" placeholder="${esc(t('例如：年假如何申请？', 'e.g. How do I request annual leave?'))}" maxlength="2000" required><button type="submit" class="btn btn-primary" ${search.busy ? 'disabled' : ''}>${search.busy ? t('搜索中…', 'Searching…') : t('测试检索', 'Test search')}</button></div></div>
    ${search.busy ? `<p class="mg-help" role="status">${t('正在查找相关资料…', 'Finding relevant documents…')}</p>` : ''}
    ${search.error ? `<div class="rs-inline-error" role="alert"><strong>${t('检索未完成', 'Search did not complete')}</strong><p>${esc(search.error)}</p><span>${t('请检查服务状态后重试，输入的问题已保留。', 'Check the service and retry. Your question has been kept.')}</span></div>` : ''}
    ${hits ? `<p class="mg-help">${t('检索问题：', 'Search question: ')}${esc(search.query || '')}</p>` : ''}
    ${hits ? hits.length ? `<div class="rs-search-results"><div class="mg-sectionhead"><strong>${t(`找到 ${hits.length} 个相关片段`, `${hits.length} relevant passages`)}</strong><span class="mg-help">${t(`用时 ${((search.elapsedMs || 0)/1000).toFixed(1)} 秒`, `${((search.elapsedMs || 0)/1000).toFixed(1)} seconds`)}</span></div>${hits.map(h=>`<article class="rs-search-hit"><div><strong>${esc(h.fileName)}</strong>${h.page != null ? `<span>${t(`第 ${h.page} 页`, `Page ${h.page}`)}</span>` : ''}<span class="rs-hit-score">${t('相关度', 'Relevance')} ${esc(String(h.score))}</span></div><p>${esc(h.text)}</p></article>`).join('')}</div>` : resourceEmpty(t('未找到相关内容', 'No relevant passages found'), t('试试更具体的问题，并确认相关文件已完成入库。', 'Try a more specific question and check that the relevant files are indexed.')) : ''}
  </form>`
}

function kbDetailSummary(d) {
  const k = d.knowledge
  return `<div class="rs-kb-summary"><div><span>${t('资料文件', 'Files')}</span><strong>${k.fileCount || 0}</strong></div><div><span>${t('已完成入库', 'Indexed')}</span><strong>${d.files.filter(f=>f.status === 'ready').length}</strong></div><div class="rs-kb-summary-storage"><span>${t('已用容量', 'Storage used')}</span>${kbMeter(k)}</div></div>`
}

function kbFilesArea(d) {
  const cfg = state.kbConfig || {}
  const types = (cfg.types || ['pdf','docx','pptx','xlsx','csv','md','txt']).map(x=>'.'+x)
  return `${d.canEdit ? `<div class="rs-kb-upload" id="kb-dropzone" data-act="kb-dropzone"${!d.enabled ? ' data-disabled="1"' : ''}>
    <span class="rs-resource-icon">${svg(['M12 16V4','m7 9 5-5 5 5','M4 16v4h16v-4'],22)}</span><div><strong>${t('拖放文件到这里，或选择文件上传', 'Drop files here or select files to upload')}</strong><p>${t(`支持 ${types.join(' / ')}，单个文件最多 ${fmtBytes(cfg.limits?.fileMax || 50*1024*1024)}。扫描件暂不支持。`, `Supports ${types.join(' / ')}; up to ${fmtBytes(cfg.limits?.fileMax || 50*1024*1024)} per file. Scanned documents are not supported.`)}</p></div>
    <label class="btn btn-secondary rs-file-picker">${t('选择文件', 'Choose files')}<input type="file" multiple accept="${esc(types.join(','))}" aria-label="${t('选择文件', 'Choose files')}" data-act="kb-files" ${!d.enabled ? 'disabled' : ''}></label>
  </div>` : ''}${kbUploadRows()}
  <div class="mg-table rs-kb-filetable"><div class="satu-memberhead" style="grid-template-columns:minmax(160px,2fr) 80px 100px 126px 160px"><span>${t('文件', 'File')}</span><span>${t('大小', 'Size')}</span><span>${t('状态')}</span><span>${t('上传时间', 'Uploaded')}</span><span></span></div>${d.files.length ? d.files.map(f=>kbFileRow(f,d.canEdit)).join('') : resourceEmpty(t('还没有文件', 'No files yet'),d.canEdit ? t('上传文件后将自动入库，完成后即可检索。', 'Uploaded files are indexed automatically and become searchable when ready.') : t('管理员上传文件后，会显示在这里。', 'Files appear here once uploaded by an administrator.'))}</div>`
}

/** Polling and upload progress update only read-only file content; active forms keep focus. */
function paintKnowledgeFiles() {
  const d = state.kbDetail
  if (!d || kbIdOfPath(state.path) !== d.id) return
  const host = document.getElementById('kb-files-area')
  if (host) { host.innerHTML = kbFilesArea(d); cardifyTables(host) }
  const summary = document.getElementById('kb-summary')
  if (summary) summary.innerHTML = kbDetailSummary(d)
}

function knowledgeDetailPage() {
  const d = state.kbDetail && state.kbDetail.id === kbIdOfPath(state.path) ? state.kbDetail : null
  if (!d) return `<div class="gw-page"><div class="gw-page-inner">${flashes()}${resourceEmpty(t('正在加载知识库', 'Loading knowledge base'), t('正在获取文件与配置信息。', 'Fetching files and settings.'))}</div></div>`
  const k = d.knowledge
  const edit = state.kbEdit?.id === k.id ? state.kbEdit : null
  const tabs = [{ key:'files',label:t('文件', 'Files') }, ...(d.enabled ? [{key:'search',label:t('检索测试', 'Test retrieval')}] : []), ...(d.canEdit ? [{key:'sharing',label:t('共享与设置', 'Sharing & settings')}] : [])]
  const tab = tabs.some(x=>x.key === state.kbTab) ? state.kbTab : 'files'
  return `<div class="gw-page rs-page"><div class="gw-page-inner">
    ${edit ? `<form id="kb-edit-form" class="satu-panel rs-kb-edit"><h2>${t('编辑基本信息', 'Edit details')}</h2><div class="mg-form-grid"><label class="field"><span>${t('名称', 'Name')}</span><input class="input" name="name" data-act="kb-edit-field" data-field="name" value="${esc(edit.name)}" maxlength="60" required></label><label class="field"><span>${t('说明', 'Description')}</span><input class="input" name="desc" data-act="kb-edit-field" data-field="desc" value="${esc(edit.desc)}" maxlength="200"></label></div><div class="rs-modal-actions"><button type="button" class="btn btn-secondary" data-act="kb-edit-cancel">${t('取消')}</button><button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${t('保存')}</button></div></form>` : pageHead(`${esc(k.name)} <span class="tag ${k.share === 'none' ? 'tag-neutral' : 'tag-accent-2'}">${kbShareLabel(k)}</span>`,esc(k.desc || t('暂无资料说明。', 'No description yet.')),d.canEdit ? `<button type="button" class="btn btn-secondary" data-act="kb-edit-open">${t('编辑信息', 'Edit details')}</button>` : '')}
    ${flashes()}${!d.enabled ? `<p class="mg-notice" role="status">${t('知识库服务暂不可用，文件上传和检索已暂停。', 'Knowledge base service is unavailable. Uploads and search are paused.')}</p>` : ''}
    <div id="kb-summary">${kbDetailSummary(d)}</div>
    <div class="mg-tabs rs-kb-tabs" aria-label="${t('知识库内容', 'Knowledge base sections')}">${tabs.map(x=>`<button type="button" class="btn mg-tab" aria-pressed="${tab === x.key}" data-act="kb-tab" data-tab="${x.key}">${x.label}</button>`).join('')}</div>
    ${tab === 'files' ? `<div id="kb-files-area" class="rs-section">${kbFilesArea(d)}</div>` : tab === 'search' ? kbSearchPanel(k) : `<div class="rs-section">${kbSharePanel(k)}<section class="rs-danger-zone"><div><h2>${t('删除知识库', 'Delete knowledge base')}</h2><p>${t('将永久删除此知识库及其中全部文件，Bot 将无法再检索这些资料。', 'Permanently deletes this knowledge base and all its files. Bots will no longer be able to retrieve them.')}</p></div><button type="button" class="btn btn-secondary rs-danger-action" data-act="kb-delete" data-id="${esc(k.id)}" data-name="${esc(k.name)}">${t('删除知识库', 'Delete knowledge base')}</button></section></div>`}
  </div></div>`
}

// ── 动作 ────────────────────────────────────────────────────────────────

async function knowledgeAct(act, btn) {
  if (!act || !act.startsWith('kb-')) return false
  if (act === 'kb-tab') {
    const tab = btn.getAttribute('data-tab')
    if (['files','search','sharing'].includes(tab)) state.kbTab = tab
    render(); return true
  }
  if (act === 'kb-create-open') { state.kbCreate = { error: '', draft: null }; render(); return true }
  if (act === 'kb-create-close') { state.kbCreate = null; render(); return true }
  if (act === 'kb-edit-open') {
    const k = state.kbDetail?.knowledge
    if (k) state.kbEdit = { id: k.id, name: k.name, desc: k.desc || '' }
    render(); return true
  }
  if (act === 'kb-edit-cancel') { state.kbEdit = null; render(); return true }
  if (act === 'kb-share-pick' || act === 'kb-share-bot') {
    // 单选 / 勾选改的是草稿；保存那颗按钮按草稿和当前值的差异亮灭。新建弹窗里那组单选不在草稿里。
    const form = btn.closest('form')
    if (form && form.id === 'kb-create-form' && state.kbCreate) {
      const fd = new FormData(form)
      state.kbCreate.draft = { name: String(fd.get('name') || ''), desc: String(fd.get('desc') || ''), share: String(fd.get('kb-create-share') || 'all') }
    }
    if (form && form.id === 'kb-share-form' && state.kbShareDraft) {
      const fd = new FormData(form)
      state.kbShareDraft.share = String(fd.get('kb-share') || state.kbShareDraft.share)
      state.kbShareDraft.botIds = fd.getAll('botIds').map(String)
      render()
    }
    return true
  }
  if (act === 'kb-download') {
    // 登录态在请求头里，不在 cookie 里：一个裸的 <a href> 拿不到文件，得自己带票取回来再交给浏览器存。
    const d = state.kbDetail
    if (!d) return true
    try {
      await knowledgeDownload(d.id, btn.getAttribute('data-id'), btn.getAttribute('data-name'))
    } catch (err) {
      flash('err', err.message)
      render()
    }
    return true
  }
  if (act === 'kb-file-retry') {
    const d = state.kbDetail
    if (!d) return true
    try {
      await api('POST', kbBase(`/${encodeURIComponent(d.id)}/files/${encodeURIComponent(btn.getAttribute('data-id'))}/retry`), {})
      await loadKnowledgeDetail(d.id)
      flash('ok', t('已重新排队', 'Queued again'))
    } catch (err) {
      flash('err', err.message)
    }
    render(); return true
  }
  if (act === 'kb-file-delete') {
    state.confirm = {
      kind: 'kb-file-delete', id: btn.getAttribute('data-id'), title: t(`删除「${btn.getAttribute('data-name')}」？`, `Delete “${btn.getAttribute('data-name')}”?`),
      body: t('文件和它的分片会从知识库里拿掉，Bot 查不到它了。', 'The file and its chunks are removed; bots will no longer find it.'),
      label: t('删除'),
    }
    render(); return true
  }
  if (act === 'kb-delete') {
    state.confirm = {
      kind: 'kb-delete', id: btn.getAttribute('data-id'), title: t(`删除知识库「${btn.getAttribute('data-name')}」？`, `Delete knowledge base “${btn.getAttribute('data-name')}”?`),
      body: t('里面所有文件一起删，Bot 立刻查不到。这一步不能撤销。', 'Every file in it is deleted and bots stop seeing it immediately. This cannot be undone.'),
      label: t('删除'),
    }
    render(); return true
  }
  return false
}

async function knowledgeConfirm(c) {
  if (c.kind === 'kb-delete') {
    await api('DELETE', kbBase(`/${encodeURIComponent(c.id)}`))
    state.kbDetail = null
    flash('ok', t('知识库已删除', 'Knowledge base deleted'))
    go('/knowledge')
    return true
  }
  if (c.kind === 'kb-file-delete') {
    const d = state.kbDetail
    await api('DELETE', kbBase(`/${encodeURIComponent(d.id)}/files/${encodeURIComponent(c.id)}`))
    await loadKnowledgeDetail(d.id)
    flash('ok', t('文件已删除', 'File deleted'))
    render()
    return true
  }
  return false
}

async function submitKnowledgeCreate(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  const body = { name: String(fd.get('name') || '').trim(), desc: String(fd.get('desc') || '').trim(), share: String(fd.get('kb-create-share') || 'all'), botIds: [] }
  state.kbCreate.draft = body
  state.busy = true
  render()
  try {
    const data = await api('POST', kbBase(), body)
    state.kbCreate = null
    await loadKnowledge().catch(() => {})
    flash('ok', t('知识库已创建，接下来传文件', 'Created — now upload some files'))
    go(`/knowledge/${encodeURIComponent(data.knowledge.id)}`)
  } catch (err) {
    state.kbCreate = { error: err.message, draft: body }
  } finally {
    state.busy = false
    render()
  }
}

async function submitKnowledgeEdit(e) {
  e.preventDefault()
  const d = state.kbDetail
  const fd = new FormData(e.target)
  await withBusy(async () => {
    await api('PATCH', kbBase(`/${encodeURIComponent(d.id)}`), { name: String(fd.get('name') || '').trim(), desc: String(fd.get('desc') || '').trim() })
    state.kbEdit = null
    await loadKnowledgeDetail(d.id)
    flash('ok', '已保存')
  })
}

async function submitKnowledgeShare(e) {
  e.preventDefault()
  const d = state.kbDetail
  const fd = new FormData(e.target)
  const share = String(fd.get('kb-share') || 'all')
  const botIds = fd.getAll('botIds').map(String)
  await withBusy(async () => {
    await api('PUT', kbBase(`/${encodeURIComponent(d.id)}/share`), { share, botIds })
    state.kbShareDraft = null
    await loadKnowledgeDetail(d.id)
    flash('ok', t('共享范围已保存', 'Sharing saved'))
  })
}

async function submitKnowledgeSearch(e) {
  e.preventDefault()
  const d = state.kbDetail
  const query = String(new FormData(e.target).get('query') || '').trim()
  if (!query) return
  state.kbSearchQuery = query
  state.kbSearch = { query, busy: true, hits: null }
  render()
  try {
    const data = await api('POST', kbBase('/search'), { query, kbIds: [d.id], count: 8 })
    if (state.kbDetail?.id !== d.id) return
    state.kbSearch = { query, busy: false, hits: data.hits || [], elapsedMs: data.elapsedMs }
  } catch (err) {
    if (state.kbDetail?.id !== d.id) return
    state.kbSearch = { query, busy: false, hits: null, error: err.message }
    flash('err', err.message)
  }
  render()
}

async function knowledgeDownload(kbId, fileId, name) {
  const r = await swFetch(kbBase(`/${encodeURIComponent(kbId)}/files/${encodeURIComponent(fileId)}/download`), {
    headers: { authorization: 'Bearer ' + token() },
  })
  if (!r.ok) {
    let msg = `HTTP ${r.status}`
    try { msg = (await r.json()).error || msg } catch {}
    throw new Error(msg)
  }
  await saveBlob(await r.blob(), name || 'file', 60_000)
}

// ── 上传 ────────────────────────────────────────────────────────────────

/** Blob 的浏览器 SDK（ui/blob-client.js，由 scripts/build-blob-client.mjs 打出来）。只在要直传时才加载。 */
function loadBlobClient() {
  if (window.VercelBlobClient) return Promise.resolve(window.VercelBlobClient)
  if (!window.__kbBlobLoading) {
    window.__kbBlobLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = '/blob-client.js'
      s.onload = () => resolve(window.VercelBlobClient)
      s.onerror = () => reject(new Error(t('上传组件加载失败', 'Upload component failed to load')))
      document.head.appendChild(s)
    })
  }
  return window.__kbBlobLoading
}

function putWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('authorization', 'Bearer ' + token())
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) onProgress(Math.round((ev.loaded / ev.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else {
        let msg = `HTTP ${xhr.status}`
        try { msg = JSON.parse(xhr.responseText).error || msg } catch {}
        reject(new Error(msg))
      }
    }
    xhr.onerror = () => reject(new Error(t('网络错误', 'Network error')))
    xhr.send(file)
  })
}

async function knowledgeUpload(files) {
  const d = state.kbDetail
  if (!d || !d.canEdit || !d.enabled || !files || !files.length) return
  const cfg = state.kbConfig || {}
  const types = new Set(cfg.types || [])
  const fileMax = cfg.limits?.fileMax || 50 * 1024 * 1024
  const bytesMax = cfg.limits?.bytesMax || 200 * 1024 * 1024
  let used = d.knowledge.bytesUsed || 0
  state.kbUploads = state.kbUploads || []
  const jobs = []
  for (const file of files) {
    const ext = (file.name.split('.').pop() || '').toLowerCase()
    const job = { kbId: d.id, name: file.name, bytes: file.size, pct: 0, done: false, error: '' }
    state.kbUploads.push(job)
    // 在浏览器就拦：格式、单文件、容量。拦不住的（并发、别人也在传）由服务端那把锁兜。
    if (types.size && !types.has(ext)) { job.error = t('不支持的格式', 'Unsupported format'); job.done = true; continue }
    if (file.size > fileMax) { job.error = t(`超过单文件上限 ${fmtBytes(fileMax)}`, `Over the ${fmtBytes(fileMax)} per-file limit`); job.done = true; continue }
    if (used + file.size > bytesMax) { job.error = t('知识库放不下了', 'Knowledge base is full'); job.done = true; continue }
    used += file.size
    jobs.push([file, job])
  }
  paintKnowledgeFiles()
  for (const [file, job] of jobs) {
    try {
      const reg = await api('POST', kbBase(`/${encodeURIComponent(d.id)}/files`), { name: file.name, bytes: file.size, mime: file.type || '' })
      const up = reg.upload
      if (up.mode === 'blob-client') {
        const client = await loadBlobClient()
        const blob = await client.upload(up.pathname, file, {
          access: 'private',
          handleUploadUrl: up.tokenUrl,
          clientPayload: JSON.stringify({ fileId: reg.file.id }),
          headers: { authorization: 'Bearer ' + token() },
          contentType: reg.file.mime || file.type || 'application/octet-stream',
          onUploadProgress: (ev) => { job.pct = Math.round(ev.percentage || 0); paintKnowledgeUploads() },
        })
        await api('POST', up.doneUrl, { url: blob.url })
      } else {
        await putWithProgress(up.url, file, (pct) => { job.pct = pct; paintKnowledgeUploads() })
      }
      job.pct = 100
      job.done = true
    } catch (err) {
      job.error = err.message
      job.done = true
    }
    await loadKnowledgeDetail(d.id).catch(() => {})
    paintKnowledgeFiles()
  }
  // 成功的那些从列表里拿掉（文件表里已经有它们了）；失败的留着给人看原因。
  state.kbUploads = state.kbUploads.filter((u) => !u.done || u.error)
  paintKnowledgeFiles()
}

/** 进度条只改 DOM，不整页重绘——重绘会把试搜框里敲到一半的字冲掉。 */
function paintKnowledgeUploads() {
  const list = kbVisibleUploads()
  const host = document.getElementById('kb-files-area')
  if (!host) return
  const bars = host.querySelectorAll('.satu-meterfill[data-upload]')
  if (bars.length !== list.filter(u=>!u.error).length) { paintKnowledgeFiles(); return }
  for (const el of bars) {
    const index = Number(el.getAttribute('data-upload'))
    const item = list[index]
    if (!item) continue
    el.style.width = `${item.pct}%`
    el.parentElement.setAttribute('aria-valuenow', String(item.pct))
    const label = host.querySelector(`[data-upload-label="${index}"]`)
    if (label) label.textContent = t(`上传中 ${item.pct}%`, `Uploading ${item.pct}%`)
  }
}

document.addEventListener('dragover', (e) => {
  const zone = e.target instanceof Element && e.target.closest('#kb-dropzone')
  if (!zone) return
  e.preventDefault()
  zone.style.outline = '2px dashed var(--color-accent)'
})
document.addEventListener('dragleave', (e) => {
  const zone = e.target instanceof Element && e.target.closest('#kb-dropzone')
  if (zone) zone.style.outline = ''
})
document.addEventListener('drop', (e) => {
  const zone = e.target instanceof Element && e.target.closest('#kb-dropzone')
  if (!zone) return
  e.preventDefault()
  zone.style.outline = ''
  void knowledgeUpload(e.dataTransfer?.files)
})
