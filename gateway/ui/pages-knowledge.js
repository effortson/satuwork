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
  const data = await api('GET', kbBase(`/${encodeURIComponent(id)}`))
  state.kbDetail = { id, knowledge: data.knowledge, files: Array.isArray(data.files) ? data.files : [], canEdit: !!data.canEdit, enabled: data.enabled !== false }
  // 共享范围的编辑态和试搜结果都跟着库走：别拿上一个库的草稿、上一个库的命中画这一个。
  if (!state.kbShareDraft || state.kbShareDraft.id !== id) {
    state.kbShareDraft = { id, share: data.knowledge.share, botIds: [...(data.knowledge.botIds || [])] }
    state.kbSearch = null
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
  const uploading = (state.kbUploads || []).some((u) => !u.done)
  if (!busy && !uploading) return
  state.kbPollTimer = setTimeout(async () => {
    if (state.path !== `/knowledge/${encodeURIComponent(d.id)}`) return
    try {
      await loadKnowledgeDetail(d.id)
      render()
    } catch {}
  }, 5000)
}

const KB_STATUS = {
  uploading: ['上传中', 'Uploading', 'tag-accent'],
  queued: ['排队中', 'Queued', 'tag-accent'],
  processing: ['入库中', 'Indexing', 'tag-accent'],
  ready: ['可用', 'Ready', 'tag-accent-2'],
  failed: ['失败', 'Failed', 'tag-warn'],
}

function kbShareLabel(k) {
  if (k.share === 'all') return t('全部 Bot', 'All bots')
  if (k.share === 'bots') return t(`${(k.botIds || []).length} 颗 Bot`, `${(k.botIds || []).length} bots`)
  return t('未共享', 'Not shared')
}

function kbMeter(k) {
  const max = state.kbConfig?.limits?.bytesMax || 200 * 1024 * 1024
  const pct = Math.min(100, Math.round(((k.bytesUsed || 0) / max) * 100))
  return `<div style="display: flex; flex-direction: column; gap: 4px;">
    <div class="satu-meter"><div class="satu-meterfill" data-alt="${String(pct >= 90)}" style="width: ${pct}%;"></div></div>
    <span style="font-size: 12px; color: var(--muted-foreground);">${esc(fmtBytes(k.bytesUsed || 0))} / ${esc(fmtBytes(max))}</span>
  </div>`
}

function kbCard(k) {
  return `<button type="button" class="satu-panel" style="gap: var(--space-3); text-align: left; cursor: pointer;" data-act="go" data-href="/knowledge/${encodeURIComponent(k.id)}">
    <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
      <b style="font-size: 15px;">${esc(k.name)}</b>
      <span class="tag ${k.share === 'none' ? 'tag-neutral' : 'tag-accent-2'}">${kbShareLabel(k)}</span>
    </div>
    <p style="margin: 0; font-size: 13px; color: var(--muted-foreground); min-height: 18px;">${esc(k.desc || t('还没有说明。说明会告诉 Bot 这个库里是什么。', 'No description yet. It tells the bot what is inside.'))}</p>
    ${kbMeter(k)}
    <div style="font-size: 12px; color: var(--muted-foreground);">${t(`${k.fileCount || 0} 个文件 · ${k.chunkCount || 0} 段`, `${k.fileCount || 0} files · ${k.chunkCount || 0} chunks`)}</div>
  </button>`
}

function kbCreateModal() {
  const m = state.kbCreate
  if (!m) return ''
  const v = m.draft || { name: '', desc: '', share: 'all' }
  return `<div class="gw-modal-backdrop" data-act="kb-create-close">
    <form id="kb-create-form" class="gw-modal" style="max-width: 480px;" data-stop>
      <div>
        <h2 style="font-size: 20px; margin: 0 0 4px;">${t('新建知识库', 'New knowledge base')}</h2>
        <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('建好之后往里传文件。单个知识库最多 200 MB。', 'Create it, then upload files. Each knowledge base holds up to 200 MB.')}</p>
      </div>
      ${m.error ? `<div class="gw-flash gw-flash-err">${esc(m.error)}</div>` : ''}
      <div class="field">
        <label for="kb-name">${t('名称')}</label>
        <input class="input" id="kb-name" name="name" value="${esc(v.name)}" maxlength="60" required>
      </div>
      <div class="field">
        <label for="kb-desc">${t('说明')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
        <input class="input" id="kb-desc" name="desc" value="${esc(v.desc)}" maxlength="200" placeholder="${esc(t('一句话告诉 Bot 这个库里是什么，例如「员工手册与考勤制度」', 'One line telling the bot what is inside, e.g. "Employee handbook and attendance rules"'))}">
      </div>
      ${kbShareField(v.share, 'kb-create-share')}
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="kb-create-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : t('创建', 'Create')}</button>
      </div>
    </form>
  </div>`
}

/** 共享范围三选一。名单那张勾选表只在详情页画（新建时先选范围，名单建完再勾）。 */
function kbShareField(share, name) {
  const opts = [
    ['all', t('全部 Bot', 'All bots'), t('公司里每颗 Bot 都查得到，包括将来新建的。', 'Every bot in the company, including ones created later.')],
    ['bots', t('指定 Bot', 'Selected bots'), t('只有名单里的几颗。', 'Only the bots on the list.')],
    ['none', t('不共享', 'Not shared'), t('谁也查不到。还在准备、或只给管理员自己试搜时用。', 'No bot can search it. For drafts, or for admin-only testing.')],
  ]
  return `<div class="field">
    <label>${t('共享给', 'Share with')}</label>
    <div style="display: flex; flex-direction: column; gap: 6px;">
      ${opts.map(([k, label, note]) => `<label style="display: flex; gap: var(--space-2); align-items: flex-start; font-weight: 400; cursor: pointer;">
        <input type="radio" name="${esc(name)}" value="${k}" ${share === k ? 'checked' : ''} data-act="kb-share-pick" style="margin-top: 3px;">
        <span><b style="font-size: 13.5px;">${label}</b><br><span style="font-size: 12px; color: var(--muted-foreground);">${note}</span></span>
      </label>`).join('')}
    </div>
  </div>`
}

function knowledgePage() {
  const k = state.knowledge || { enabled: true, list: [], quota: 0, used: 0 }
  const admin = isAdmin() || isOwner()
  const full = k.used >= k.quota
  return `<div class="gw-page">
    <div class="gw-page-inner">
      <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('知识库')}${admin ? ` <span style="font-size: 14px; font-weight: 400; color: var(--muted-foreground);">${esc(k.used)} / ${esc(k.quota)}</span>` : ''}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${admin
            ? t('把公司资料交给 Bot：传文件进来，Bot 回答时会先在这里查。', 'Give your bots the company documents: upload files here and bots search them before answering.')
            : t('公司给你的 Bot 准备的资料。Bot 回答时会先在这里查。', 'Documents the company prepared for your bots. Bots search them before answering.')}</p>
        </div>
        ${admin ? `<button type="button" class="btn btn-primary" data-act="kb-create-open" ${full || !k.enabled ? 'disabled' : ''} title="${esc(full ? (k.quota ? t('已达套餐上限', 'Plan limit reached') : t('当前套餐不含知识库', 'Your plan has no knowledge bases')) : '')}">${t('新建知识库', 'New knowledge base')}</button>` : ''}
      </div>
      ${flashes()}
      ${!k.enabled ? `<div class="gw-flash">${t('平台还没开通知识库', 'Knowledge bases are not enabled on this platform yet')}${k.reason ? `：${esc(k.reason)}` : t('（没有配置向量库）。', ' (no vector store configured).')}</div>` : ''}
      ${admin && k.enabled && !k.quota ? `<div class="gw-flash">${t('当前套餐不含知识库。要用的话请联系平台升级套餐。', 'Your current plan has no knowledge bases. Contact the platform to upgrade.')}</div>` : ''}
      ${k.list.length
        ? `<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--space-4);">${k.list.map(kbCard).join('')}</div>`
        : `<p style="color: var(--muted-foreground);">${admin ? t('还没有知识库。', 'No knowledge bases yet.') : t('还没有共享给你的知识库。', 'No knowledge base has been shared with your bots yet.')}</p>`}
    </div>
    ${kbCreateModal()}
  </div>`
}

function kbFileRow(f, canEdit) {
  const [zh, en, cls] = KB_STATUS[f.status] || KB_STATUS.failed
  const pct = f.status === 'processing' && f.chunkCount ? Math.round((f.chunkDone / f.chunkCount) * 100) : null
  return `<div class="satu-memberrow" style="grid-template-columns: minmax(160px, 2fr) 90px 120px 120px 150px;">
    <div style="min-width: 0;">
      <div style="font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${esc(f.name)}">${esc(f.name)}</div>
      ${f.status === 'failed' && f.error ? `<div style="font-size: 12px; color: var(--color-warn, #b45309);">${esc(f.error)}</div>` : ''}
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

function kbUploadRows() {
  const list = (state.kbUploads || []).filter((u) => !u.done || u.error)
  if (!list.length) return ''
  return list.map((u) => `<div class="satu-memberrow" style="grid-template-columns: minmax(160px, 2fr) 90px 1fr;">
    <div style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(u.name)}</div>
    <span style="font-size: 13px; color: var(--muted-foreground);">${esc(fmtBytes(u.bytes))}</span>
    ${u.error
      ? `<span style="font-size: 12px; color: var(--color-warn, #b45309);">${esc(u.error)}</span>`
      : `<div class="satu-meter" style="align-self: center;"><div class="satu-meterfill" data-upload="1" style="width: ${u.pct}%;"></div></div>`}
  </div>`).join('')
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
  return `<form id="kb-share-form" class="satu-panel" style="gap: var(--space-3);">
    <span class="satu-panel-title">${t('共享范围', 'Sharing')}</span>
    ${kbShareField(d.share, 'kb-share')}
    ${d.share === 'bots' ? `<div style="border: 1px solid var(--border); border-radius: 12px; padding: var(--space-3); max-height: 320px; overflow: auto; display: flex; flex-direction: column; gap: var(--space-2);">
      ${bots.length ? [...groups.entries()].map(([owner, list]) => `<div>
        <div style="font-size: 12px; color: var(--muted-foreground); margin-bottom: 4px;">${esc(owner)}</div>
        ${list.map((b) => `<label style="display: flex; gap: var(--space-2); align-items: center; font-weight: 400; font-size: 13.5px; cursor: pointer; padding: 2px 0;">
          <input type="checkbox" name="botIds" value="${esc(b.id)}" ${chosen.has(b.id) ? 'checked' : ''} data-act="kb-share-bot">
          <span>${esc(b.name)}</span>
        </label>`).join('')}
      </div>`).join('') : `<span style="font-size: 13px; color: var(--muted-foreground);">${t('公司里还没有 Bot。', 'No bots in the company yet.')}</span>`}
      ${[...chosen].filter((id) => !known.has(id)).length ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t('名单里有已经删掉的 Bot，保存时会一并清掉。', 'Some bots on the list were deleted; saving will drop them.')}</span>` : ''}
    </div>` : ''}
    <div style="display: flex; justify-content: flex-end;">
      <button type="submit" class="btn btn-primary" ${state.busy || !dirty ? 'disabled' : ''}>${state.busy ? t('保存中…') : t('保存共享范围', 'Save sharing')}</button>
    </div>
  </form>`
}

function kbSearchPanel(k) {
  const s = state.kbSearch || {}
  const hits = Array.isArray(s.hits) ? s.hits : null
  return `<form id="kb-search-form" class="satu-panel" style="gap: var(--space-3);">
    <span class="satu-panel-title">${t('试搜', 'Try a search')}</span>
    <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('像 Bot 那样在这个库里按语义搜一次，看看传进来的资料查不查得到。', 'Search this knowledge base the way a bot would, to confirm the uploaded material is findable.')}</p>
    <div style="display: flex; gap: var(--space-2);">
      <input class="input" name="query" value="${esc(s.query || '')}" placeholder="${esc(t('例如：年假怎么算', 'e.g. how is annual leave calculated'))}" style="flex: 1;">
      <button type="submit" class="btn btn-secondary" ${s.busy ? 'disabled' : ''}>${s.busy ? t('搜索中…', 'Searching…') : t('搜索', 'Search')}</button>
    </div>
    ${hits ? (hits.length ? `<div style="display: flex; flex-direction: column; gap: var(--space-2);">
      <span style="font-size: 12px; color: var(--muted-foreground);">${t(`${hits.length} 段，用时 ${((s.elapsedMs || 0) / 1000).toFixed(1)}s`, `${hits.length} chunks in ${((s.elapsedMs || 0) / 1000).toFixed(1)}s`)}</span>
      ${hits.map((h) => `<div style="border: 1px solid var(--border); border-radius: 12px; padding: var(--space-3); font-size: 13px;">
        <div style="display: flex; justify-content: space-between; gap: var(--space-2); color: var(--muted-foreground); font-size: 12px; margin-bottom: 4px;">
          <span>${esc(h.fileName)}${h.page != null ? ` · ${t(`第 ${h.page} 页`, `p.${h.page}`)}` : ''}</span><span>${esc(String(h.score))}</span>
        </div>
        <div style="white-space: pre-wrap; word-break: break-word;">${esc(h.text)}</div>
      </div>`).join('')}
    </div>` : `<span style="font-size: 13px; color: var(--muted-foreground);">${t('没有和它相关的内容。', 'Nothing related was found.')}</span>`) : ''}
  </form>`
}

function knowledgeDetailPage() {
  const d = state.kbDetail && state.kbDetail.id === kbIdOfPath(state.path) ? state.kbDetail : null
  if (!d) {
    return `<div class="gw-page"><div class="gw-page-inner">${flashes()}<p style="color: var(--muted-foreground);">${t('载入中…')}</p></div></div>`
  }
  const k = d.knowledge
  const canEdit = d.canEdit
  const cfg = state.kbConfig || {}
  const types = (cfg.types || ['pdf', 'docx', 'pptx', 'xlsx', 'csv', 'md', 'txt']).map((x) => '.' + x)
  const edit = state.kbEdit && state.kbEdit.id === k.id ? state.kbEdit : null
  return `<div class="gw-page">
    <div class="gw-page-inner">
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
        <div style="min-width: 0; flex: 1;">
          ${edit ? `<form id="kb-edit-form" style="display: flex; flex-direction: column; gap: var(--space-2); max-width: 520px;">
            <input class="input" name="name" value="${esc(edit.name)}" maxlength="60" required>
            <input class="input" name="desc" value="${esc(edit.desc)}" maxlength="200" placeholder="${esc(t('这句话会告诉 Bot 这个库里是什么', 'This line tells the bot what is inside'))}">
            <div style="display: flex; gap: var(--space-2);">
              <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
              <button type="button" class="btn btn-secondary" data-act="kb-edit-cancel">${t('取消')}</button>
            </div>
          </form>` : `<h1 style="font-size: 24px; margin: 0 0 4px;">${esc(k.name)} <span class="tag ${k.share === 'none' ? 'tag-neutral' : 'tag-accent-2'}" style="vertical-align: middle;">${kbShareLabel(k)}</span></h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${esc(k.desc || t('还没有说明。', 'No description yet.'))}${canEdit ? ` <button type="button" class="satu-linkbtn" data-act="kb-edit-open">${t('编辑', 'Edit')}</button>` : ''}</p>`}
        </div>
        ${canEdit ? `<button type="button" class="btn btn-ghost" data-act="kb-delete" data-id="${esc(k.id)}" data-name="${esc(k.name)}">${t('删除知识库', 'Delete knowledge base')}</button>` : ''}
      </div>
      ${flashes()}
      <div class="satu-panel" style="gap: var(--space-3);">
        <div style="display: flex; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; align-items: center;">
          <span class="satu-panel-title" style="margin: 0;">${t('容量', 'Storage')}</span>
          <span style="font-size: 12px; color: var(--muted-foreground);">${t(`${k.fileCount || 0} 个文件 · ${k.chunkCount || 0} 段`, `${k.fileCount || 0} files · ${k.chunkCount || 0} chunks`)}</span>
        </div>
        ${kbMeter(k)}
      </div>
      ${canEdit ? `<div class="satu-panel" style="gap: var(--space-3);" id="kb-dropzone" data-act="kb-dropzone">
        <span class="satu-panel-title">${t('上传文件', 'Upload files')}</span>
        <div style="border: 1px dashed var(--border); border-radius: 12px; padding: var(--space-5); text-align: center; color: var(--muted-foreground); font-size: 13px;">
          ${t('把文件拖到这里，或', 'Drop files here, or')} <label class="satu-linkbtn" style="cursor: pointer;">${t('选择文件', 'choose files')}<input type="file" multiple accept="${esc(types.join(','))}" data-act="kb-files" style="display: none;"></label>
          <div style="margin-top: 6px; font-size: 12px;">${t(`支持 ${types.join(' / ')}；单个文件最多 ${fmtBytes(cfg.limits?.fileMax || 50 * 1024 * 1024)}。扫描件暂不支持。`, `Supports ${types.join(' / ')}; up to ${fmtBytes(cfg.limits?.fileMax || 50 * 1024 * 1024)} per file. Scanned PDFs are not supported yet.`)}</div>
        </div>
        ${!d.enabled ? `<div class="gw-flash">${t('平台还没开通知识库，暂时传不了。', 'Knowledge bases are not enabled on this platform yet.')}</div>` : ''}
      </div>` : ''}
      <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
        <div class="satu-memberhead" style="grid-template-columns: minmax(160px, 2fr) 90px 120px 120px 150px;">
          <span>${t('文件', 'File')}</span><span>${t('大小', 'Size')}</span><span>${t('状态')}</span><span>${t('上传时间', 'Uploaded')}</span><span></span>
        </div>
        ${kbUploadRows()}
        ${d.files.length ? d.files.map((f) => kbFileRow(f, canEdit)).join('') : `<p style="margin: 0; padding: var(--space-4); color: var(--muted-foreground); font-size: 13px;">${t('还没有文件。', 'No files yet.')}</p>`}
      </div>
      ${canEdit ? kbSharePanel(k) : ''}
      ${d.enabled ? kbSearchPanel(k) : ''}
    </div>
  </div>`
}

// ── 动作 ────────────────────────────────────────────────────────────────

async function knowledgeAct(act, btn) {
  if (!act || !act.startsWith('kb-')) return false
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
  state.busy = true
  render()
  try {
    await api('PATCH', kbBase(`/${encodeURIComponent(d.id)}`), { name: String(fd.get('name') || '').trim(), desc: String(fd.get('desc') || '').trim() })
    state.kbEdit = null
    await loadKnowledgeDetail(d.id)
    flash('ok', '已保存')
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function submitKnowledgeShare(e) {
  e.preventDefault()
  const d = state.kbDetail
  const fd = new FormData(e.target)
  const share = String(fd.get('kb-share') || 'all')
  const botIds = fd.getAll('botIds').map(String)
  state.busy = true
  render()
  try {
    await api('PUT', kbBase(`/${encodeURIComponent(d.id)}/share`), { share, botIds })
    state.kbShareDraft = null
    await loadKnowledgeDetail(d.id)
    flash('ok', t('共享范围已保存', 'Sharing saved'))
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function submitKnowledgeSearch(e) {
  e.preventDefault()
  const d = state.kbDetail
  const query = String(new FormData(e.target).get('query') || '').trim()
  if (!query) return
  state.kbSearch = { query, busy: true, hits: null }
  render()
  try {
    const data = await api('POST', kbBase('/search'), { query, kbIds: [d.id], count: 8 })
    state.kbSearch = { query, busy: false, hits: data.hits || [], elapsedMs: data.elapsedMs }
  } catch (err) {
    state.kbSearch = { query, busy: false, hits: null }
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
  const url = URL.createObjectURL(await r.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = name || 'file'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
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
  if (!d || !files || !files.length) return
  const cfg = state.kbConfig || {}
  const types = new Set(cfg.types || [])
  const fileMax = cfg.limits?.fileMax || 50 * 1024 * 1024
  const bytesMax = cfg.limits?.bytesMax || 200 * 1024 * 1024
  let used = d.knowledge.bytesUsed || 0
  state.kbUploads = state.kbUploads || []
  const jobs = []
  for (const file of files) {
    const ext = (file.name.split('.').pop() || '').toLowerCase()
    const job = { name: file.name, bytes: file.size, pct: 0, done: false, error: '' }
    state.kbUploads.push(job)
    // 在浏览器就拦：格式、单文件、容量。拦不住的（并发、别人也在传）由服务端那把锁兜。
    if (types.size && !types.has(ext)) { job.error = t('不支持的格式', 'Unsupported format'); job.done = true; continue }
    if (file.size > fileMax) { job.error = t(`超过单文件上限 ${fmtBytes(fileMax)}`, `Over the ${fmtBytes(fileMax)} per-file limit`); job.done = true; continue }
    if (used + file.size > bytesMax) { job.error = t('知识库放不下了', 'Knowledge base is full'); job.done = true; continue }
    used += file.size
    jobs.push([file, job])
  }
  render()
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
    render()
  }
  // 成功的那些从列表里拿掉（文件表里已经有它们了）；失败的留着给人看原因。
  state.kbUploads = state.kbUploads.filter((u) => u.error)
  render()
}

/** 进度条只改 DOM，不整页重绘——重绘会把试搜框里敲到一半的字冲掉。 */
function paintKnowledgeUploads() {
  const list = (state.kbUploads || []).filter((u) => !u.done || u.error)
  const rows = document.querySelectorAll('#app .satu-meterfill[data-upload]')
  if (rows.length !== list.length) { render(); return }
  rows.forEach((el, i) => { el.style.width = `${list[i].pct}%` })
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
