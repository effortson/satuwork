/** Bot 与它的能力（技能、MCP），以及账单与用量两页。 */
function pickId(o) {
  return typeof o === 'string' ? o : o && typeof o === 'object' ? String(o.id ?? o.name ?? '') : String(o ?? '')
}
function pickLabel(o) {
  return typeof o === 'string' ? o : o && typeof o === 'object' ? String(o.name ?? o.id ?? '') : String(o ?? '')
}

/** `ro` = 只读：药丸连 disabled 一起给上，不然它看着还能按，按了改的是一份存不下去的草稿。 */
function botPicks(key, options, selected, hint, ro = false) {
  const sel = Array.isArray(selected) ? selected : []
  const buttons = (options || [])
    .map((o) => {
      const id = pickId(o)
      const on = sel.includes(id)
      const act = ro ? 'disabled' : `data-act="bot-pick" data-key="${esc(key)}" data-value="${esc(id)}"`
      return `<button type="button" class="satu-assignee" style="padding: 5px 12px;" aria-pressed="${String(on)}" ${act}>${esc(pickLabel(o))}</button>`
    })
    .join('')
  const empty = options && options.length ? '' : `<span style="font-size: 12px; color: var(--muted-foreground);">${esc(hint || t('没有可选项'))}</span>`
  return `<div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${buttons}${empty}</div>`
}

/** `act` 传空串 = 只读：开关连 disabled 一起给上，不然它看着还能按，按了没反应。 */
function botToggle(title, desc, on, act, extra = '') {
  return `<div class="satu-toggleRow">
    <div style="min-width: 0;">
      <div style="font-size: 13.5px; font-weight: 600;">${esc(title)}</div>
      <div style="font-size: 12px; color: var(--muted-foreground);">${esc(desc)}</div>
    </div>
    <button type="button" class="satu-switch" aria-pressed="${String(!!on)}" aria-label="${esc(title)}" ${act ? `data-act="${esc(act)}"` : 'disabled'} ${extra}><span></span></button>
  </div>`
}

/**
 * `/bots` 有两副面孔。
 *
 * owner 那边是**全局 Bot 名录**：他建的那几个所有公司都看得见，还是列表 + 详情。
 * 公司管理员那边是**一份 Bot 模版**——公司这一层不再有「一批共享的 Bot」，员工自己
 * 建的每个 Bot 都长在这份底座上（见 gateway/src/lib/catalog.ts 的 publicBot）。
 */
function botsPage() {
  return isOwner() ? globalBotsPage() : botTemplatePage()
}

function globalBotsPage() {
  const rows = (state.bots || [])
    .map((a) => {
      const on = a.enabled !== false
      const ro = readOnlyItem(a)
      return `<div class="satu-agentrow">
        <button type="button" class="satu-tasklink" data-act="go" data-href="/bots/${esc(a.id)}">
          <span style="display: flex; align-items: center; gap: var(--space-3); min-width: 0;">
            ${botAvatar(a.icon, 34, a.origin)}
            <span style="min-width: 0; display: flex; flex-direction: column; gap: 1px; text-align: left;">
              <span style="font-size: 14px; font-weight: 600;">${esc(a.name)}${ro ? ` <span class="tag tag-accent-2" style="font-size: 11px;">${t('全局')}</span>` : ''}</span>
              <span style="font-size: 12px; color: var(--muted-foreground);">${esc(a.description || '')}</span>
            </span>
          </span>
        </button>
        <span class="tag ${on ? 'tag-accent-2' : 'tag-neutral'}">${on ? t('已上线') : t('未上线')}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(a.skillCount ?? '—')}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(a.mcpCount ?? '—')}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(a.usage ?? '—')}</span>
        <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-2); justify-content: flex-end;">
          <button type="button" class="satu-switch" aria-pressed="${String(on)}" aria-label="${esc(t('上线'))}" data-act="bot-list-enabled" data-id="${esc(a.id)}" ${ro ? 'disabled title="' + esc(t('全局 Bot 由系统管理员维护')) + '"' : ''}><span></span></button>
          <button type="button" class="satu-linkbtn" data-act="go" data-href="/bots/${esc(a.id)}">${ro ? t('查看') : t('配置')}</button>
        </div>
      </div>`
    })
    .join('')
  const body = rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有 Bot')}</div>`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('全局 Bot')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('这里建的 Bot 所有公司都能用。公司自己的 Bot 由员工按本公司模版创建。', 'Bots created here are available to every company. Inside a company, members create their own from the company template.')}</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" data-act="bot-create">
            ${svg(['M12 5v14', 'M5 12h14'], 15)} ${t('新建 Bot', 'New bot')}
          </button>
        </div>
        ${flashes()}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-agenthead">
            <span>Bot</span><span>${t('状态')}</span><span>Skill</span><span>MCP</span><span>${t('本月执行')}</span><span></span>
          </div>
          ${body}
        </div>
      </div>
    </div>`
}

/**
 * 「改完到底铺下去没有」。
 *
 * 版本号是保存那一刻就跳的，席位换没换是另一回事——中间隔着一轮探针和一次拉取，以及
 * 所有会出错的地方。没有这一格的时候，「进程死了」「机器断网」「拉取一直失败」和「一切
 * 正常」在这一页上长得一模一样，管理员唯一的办法是改完等一会儿、然后去找个人问「你那边
 * 变了吗」。
 *
 * 数字按**席位自己报的版本**算，不是按 Gateway 发了什么算（见 0013 那条迁移）。
 *
 * **基准版本一律取 `sync.version`，不取这一页上那份 `state.template.version`。** 两者会
 * 分家：别人在你开着这一页的时候保存了新的一版，轮询拿回来的 `synced` 是服务端按新版本
 * 数的，而页面上那份还停在你打开时的旧版本。混着用的话，「落后的有谁」按旧版本筛、
 * 「几台跟上了」按新版本数——最难看的一种是筛出来空集，于是这一格画成绿色写着「每台都在
 * 跑这一版」，而同一行的标签是「0/4」。一个数字只能有一个基准。
 */
function templateSyncPanel() {
  const sync = state.templateSync
  if (!sync) return ''
  // 老响应里没有 version 时退回页面上那份，总比拿 undefined 去比对强。
  const version = sync.version ?? state.template?.version
  const seats = Array.isArray(sync.seats) ? sync.seats : []
  const behind = seats.filter((s) => s.version !== version)
  const done = seats.length > 0 && behind.length === 0
  const head = seats.length
    ? `<span class="tag ${done ? 'tag-accent-2' : 'tag-accent'}">${t(`${sync.synced}/${sync.total} 在 v${esc(String(version))}`, `${sync.synced}/${sync.total} on v${esc(String(version))}`)}</span>`
    : `<span class="tag tag-neutral">${t('没有已部署的席位')}</span>`
  // 落后的才列出来。跟上的那些列出来只是一张花名册，而这一格是拿来找那几台的。
  const rows = behind
    .map(
      (s) => `<div class="satu-kv">
        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(s.name || s.seatId)}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${
          s.version
            ? t(`v${esc(String(s.version))} · ${esc(ago(s.syncedAt))}`, `v${esc(String(s.version))} · ${esc(ago(s.syncedAt))}`)
            : t('还没报到过', 'never reported')
        }</span>
      </div>`,
    )
    .join('')
  return `
    <div class="satu-panel" data-tpl-sync>
      <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
        <span class="satu-panel-title">${t('席位同步')}</span>
        ${head}
      </div>
      ${rows}
      <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">
        ${
          done
            ? t('公司里每台已部署的席位都在跑这一版。', 'Every deployed seat in the company is running this version.')
            : t('席位每分钟探一次，换上新版本后立刻报回来。要是有一台一直落后、或者「还没报到过」停了很久，多半是它上面的 bot 进程不在了或者出不了网——去机器那一页看日志。', 'Seats check once a minute and report back as soon as they switch. A seat that stays behind — or has never reported for a long time — usually means its bot process is gone or offline; check the logs on the machines page.')
        }
        ${/* 自动刷新会在数字不动之后停下来（见 tplSyncWant）。停了之后**必须留一条手动
             的路**：一台永远跟不上的席位正是最需要反复确认的那种，而那时候页面已经不
             自己问了。这颗按钮同时把那个静默计数清零，等于「再盯一会儿」。 */ ''}
        ${done ? '' : ` <button type="button" class="satu-linkbtn" data-act="tpl-sync-refresh">${t('刷新')}</button>`}
      </p>
    </div>`
}

/**
 * 有席位没跟上的时候，隔一会儿自己再问一次。
 *
 * 保存完盯着这一页看的那半分钟，正是这一格唯一有人看的时候——而那时候它显示的一定是
 * 「0/4」。不自己刷新的话，人得手动重开这一页才看得到「4/4」，于是这一格答的其实是
 * 「刚才那一刻怎么样」，不是「现在怎么样」。
 *
 * ## 什么时候停
 *
 * 全跟上了就停——这是常态，几十秒的事。
 *
 * 但**「还有人落后」不是一个会自己了结的状态**：一台 bot 进程已经死掉的席位永远跟不上，
 * 而那恰恰是这一格最该报出来的那种故障。只按「还有人落后」接着问的话，一个开着不管的
 * 标签页会整夜每 15 秒打一次接口（八小时两千次，每次都要跑一遍席位表和账号表、并回整份
 * 模版正文），换不来任何新消息。
 *
 * 所以再加一条：**连着 TPL_SYNC_QUIET_MAX 轮数字一个都没变就停**（8 轮 = 2 分钟）。数字
 * 一变就清零、继续盯——真正在换版的那段时间里它每一轮都在变，停不下来。停了之后面板上
 * 留一颗「刷新」，按一下再盯两分钟。
 */
const TPL_SYNC_POLL_MS = 15000
const TPL_SYNC_QUIET_MAX = 8
let tplSyncTimer = 0
let tplSyncQuiet = 0
let tplSyncMark = ''

/** 这一份同步状态的指纹。只用来判断「和上一轮比动没动」，不给人看。 */
function tplSyncMarkOf(sync) {
  const seats = sync && Array.isArray(sync.seats) ? sync.seats : []
  return `${sync?.version ?? ''}|${sync?.synced ?? ''}|${seats.map((s) => `${s.seatId}:${s.version ?? ''}`).join(',')}`
}

function tplSyncWant() {
  // 人走开去别的页面了就别再问。
  if (state.path !== '/bots') return false
  if (tplSyncQuiet >= TPL_SYNC_QUIET_MAX) return false
  const sync = state.templateSync
  const seats = sync && Array.isArray(sync.seats) ? sync.seats : []
  // 基准要和面板那格用同一个（见 templateSyncCard 里那句「老响应里没有 version」）。
  // 各用各的话，响应缺 version 时这儿把每一台都算成落后、轮询一直转，而面板同时
  // 用回落基准显示「全都跟上了」——同一个数字两套判据，正是那格注释在防的事。
  const version = sync ? (sync.version ?? state.template?.version) : undefined
  return seats.some((s) => s.version !== version)
}

/** 重新开始盯：保存之后、以及人按了「刷新」之后。 */
function tplSyncWake() {
  tplSyncQuiet = 0
  tplSyncMark = tplSyncMarkOf(state.templateSync)
  syncTemplatePoll()
}

function syncTemplatePoll() {
  const want = tplSyncWant()
  if (want && !tplSyncTimer) {
    tplSyncTimer = setInterval(() => {
      if (!tplSyncWant()) {
        syncTemplatePoll()
        return
      }
      void refreshTemplateSync()
    }, TPL_SYNC_POLL_MS)
    return
  }
  if (!want && tplSyncTimer) {
    clearInterval(tplSyncTimer)
    tplSyncTimer = 0
  }
}

async function refreshTemplateSync() {
  const base = catalogBase()
  if (!base) return
  let data
  try {
    data = await api('GET', `${base}/bot-template`)
  } catch {
    // 一次网络抖动不该在这一页上冒一条红字：下一轮 15 秒后就到。
    return
  }
  state.templateSync = data.sync || null
  // 和上一轮比：动了就清零接着盯，没动就往静默计数上加一。
  const mark = tplSyncMarkOf(state.templateSync)
  if (mark === tplSyncMark) tplSyncQuiet++
  else {
    tplSyncQuiet = 0
    tplSyncMark = mark
  }
  /**
   * **只换这一格，不整页重绘。**
   *
   * 这一页正中间是一个大文本框，管理员多半正在里面写人设。整页重绘会把它按 state 重新
   * 画一遍——文字还在（草稿在 state 里），但光标位置、选区和滚动都没了。为了刷新一行
   * 状态而打断人打字，不值。
   */
  const node = document.querySelector('[data-tpl-sync]')
  if (node) node.outerHTML = templateSyncPanel()
  syncTemplatePoll()
}

/** 名字长长的一段：这一页改的是全公司的底座，得先把这件事说清楚再让人动手。 */
function botTemplatePage() {
  const tpl = state.template
  const a = state.templateDraft
  if (!tpl || !a) {
    return `<div class="gw-page"><div class="gw-page-inner" style="max-width: 820px;">${flashes()}<p style="color: var(--muted-foreground);">${t('载入中…')}</p></div></div>`
  }
  const opts = state.templateOptions || { skills: [], mcps: [] }
  const others = (state.bots || []).filter((b) => b.scope !== 'user')
  return `
    <div class="gw-page">
      <div class="gw-page-inner" style="max-width: 820px; gap: var(--space-4);">
        <div>
          <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
            <h1 style="font-size: 24px; margin: 0;">${t('Bot 模版')}</h1>
            <span class="tag tag-accent-2">v${esc(String(tpl.version))}</span>
          </div>
          <p style="margin: 4px 0 0; font-size: 14px; color: var(--muted-foreground);">
            ${t('公司里每个人自己建的 Bot 都长在这份底座上：人设、行为边界、记忆策略、能用哪些 Skill 和 MCP。保存即生效——版本号加一，各人的 Bot 一分钟内自己跟上，不用挨个改。', 'Every bot your members create sits on this base: persona, guardrails, memory policy, and which skills and MCP servers it may use. Saving takes effect immediately — the version bumps and each seat picks it up within a minute.')}
          </p>
        </div>
        ${flashes()}
        ${templateSyncPanel()}

        <div class="satu-panel">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
            <span class="satu-panel-title" style="text-transform: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; letter-spacing: 0;">soul.md</span>
            <span style="font-size: 12px; color: var(--muted-foreground);" data-bot-prompt-len>${t(`${esc(String(a.prompt.length))} 字 · 每轮随上下文注入`, `${esc(String(a.prompt.length))} chars · injected each turn`)}</span>
          </div>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('这份文件定义全公司 Bot 的身份、语气与工作原则。员工可以在自己的 Bot 上追加一段补充说明，接在这段后面，不会替掉它。', 'This defines the identity, tone and working principles shared by every bot in the company. Members can append their own note on their bot; it goes after this text and never replaces it.')}</p>
          <textarea class="input satu-code" rows="12" data-bot="prompt">${esc(a.prompt)}</textarea>
        </div>

        ${guardsPanel(a, false)}
        ${capabilityPanel(a, opts, false)}
        ${memoryPanel(a, false)}

        <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
          <button type="button" class="satu-linkbtn" style="text-align: left;" data-act="template-redeploy" ${state.busy ? 'disabled' : ''}>${t('立即下发到全部席位')}</button>
          <button type="button" class="btn btn-primary" data-act="template-save" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : t('保存模版')}</button>
        </div>
        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">
          ${t('「立即下发」会把公司已部署的席位挨个重铺一遍，正在进行的对话会断。平时不用按它：席位自己在盯着版本号。', 'Force-push reinstalls every deployed seat and drops ongoing conversations. You normally do not need it — seats watch the version themselves.')}
        </p>

        ${others.length ? `<div style="margin-top: var(--space-4);">
          <h2 style="font-size: 16px; margin: 0 0 4px;">${t('其它 Bot')}</h2>
          <p style="margin: 0 0 var(--space-2); font-size: 13px; color: var(--muted-foreground);">
            ${t('平台维护的全局 Bot，以及改版前建的公司 Bot（已停用，可以删掉）。员工自己建的不在这里——那些只有本人看得见。', 'Global bots maintained by the platform, plus company bots created before the template (now disabled; safe to delete). Bots your members created are not listed here — only they can see those.')}
          </p>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            ${others.map(legacyBotRow).join('')}
          </div>
        </div>` : ''}
      </div>
    </div>`
}

function legacyBotRow(b) {
  const tag = b.legacy
    ? `<span class="tag tag-neutral">${t('已停用')}</span>`
    : `<span class="tag tag-accent-2">${t('全局')}</span>`
  return `<div class="satu-agentrow" style="grid-template-columns: 1fr auto auto;">
    <button type="button" class="satu-tasklink" data-act="go" data-href="/bots/${esc(b.id)}">
      <span style="display: flex; align-items: center; gap: var(--space-3); min-width: 0;">
        ${botAvatar(b.icon, 30, b.origin)}
        <span style="min-width: 0; display: flex; flex-direction: column; gap: 1px; text-align: left;">
          <span style="font-size: 14px; font-weight: 600;">${esc(b.name)}</span>
          <span style="font-size: 12px; color: var(--muted-foreground);">${esc(b.description || '')}</span>
        </span>
      </span>
    </button>
    ${tag}
    <div style="display: flex; align-items: center; gap: var(--space-2); justify-content: flex-end;">
      ${b.legacy ? `<button type="button" class="satu-linkbtn" data-act="legacy-bot-delete" data-id="${esc(b.id)}" data-name="${esc(b.name)}">${t('删除')}</button>` : ''}
      <button type="button" class="satu-linkbtn" data-act="go" data-href="/bots/${esc(b.id)}">${t('查看')}</button>
    </div>
  </div>`
}

// ── 模版页和 Bot 详情页共用的那几块。──────────────────────────────────
//
// 行为边界、记忆、能力这三块在两页上长得一模一样，改的只是哪一份草稿（见 state.js
// 的 editingDraft）。抄成两份的话，下次给记忆加一个选项就会只加在其中一页上。

/**
 * 「转人工交给谁」的选项。
 *
 * 指名到人那一档从**员工名册**里出（`state.accounts`，管理员那一页本来就在拉它）。
 * 名册还没拉到时只出前两档——列一个空的选单，比少一档更让人以为是坏了。
 */
function escalateToOptions(cur) {
  const opts = [
    { v: 'owner', label: t('这颗 Bot 的主人', "The bot's owner") },
    { v: 'admin', label: t('公司管理员（谁先接算谁的）', 'Company admins (first to take it)') },
  ]
  for (const m of state.accounts || []) {
    if (m.role === 'owner' || m.status === 'disabled') continue
    opts.push({ v: 'member:' + m.id, label: t('指定：', 'Specific: ') + (m.name || m.email || m.id) })
  }
  /**
   * 当前值不在名单里（员工那一侧拉不到名册，或者那个人已经停用）：**补一个占位项**。
   *
   * 不补的话选单会显示第一项，而库里存的是另一个人——界面上写着「这颗 Bot 的主人」，
   * 实际指给的是张三，谁也看不出这里不对。
   */
  if (cur && !opts.some((o) => o.v === cur)) {
    opts.push({ v: cur, label: t('指定：某位同事', 'Specific: a colleague') })
  }
  return opts
    .map((o) => `<option value="${esc(o.v)}" ${o.v === cur ? 'selected' : ''}>${esc(o.label)}</option>`)
    .join('')
}

function guardsPanel(a, ro) {
  const guards = (a.guards || []).map((g) => botToggle(g.title, g.desc, g.on, ro ? '' : 'bot-guard', `data-id="${esc(g.id)}"`)).join('')
  return `<div class="satu-panel">
    <span class="satu-panel-title">${t('行为边界')}</span>
    ${guards}
    <div class="field">
      <label for="bot-escalate">${t('升级人工的条件')}</label>
      <input class="input" id="bot-escalate" type="text" data-bot="escalate" value="${esc(a.escalate || '')}" ${ro ? 'disabled' : ''}>
    </div>
    ${/* 「交给谁」和「什么时候交」摆在一起：写了条件却没人接，是这个功能最常见的坏法。 */ ''}
    <div class="field">
      <label for="bot-escalate-to">${t('转人工交给谁', 'Hand off to')}</label>
      <select class="input" id="bot-escalate-to" data-bot="escalateTo" ${ro ? 'disabled' : ''}>
        ${escalateToOptions(a.escalateTo || 'owner')}
      </select>
    </div>
    <span style="font-size: 12px; color: var(--muted-foreground);">${t('这几条落在席位上工具执行前的拦截里，不是提示词里的一句话：拦下来的调用没跑过。「升级人工的条件」原样进提示词，配一把 escalate_to_human 工具；它开出来的交接单在「转人工待办」里，人处理完交还，Bot 接着做。', 'These are enforced on the seat before a tool runs — a blocked call never executed. The escalation rule goes into the prompt verbatim, paired with an escalate_to_human tool; the tickets it opens show up under Handoffs, and the bot resumes once a person hands it back.')}</span>
  </div>`
}

function capabilityPanel(a, opts, ro) {
  if (ro) {
    const names = (ids, list) => (ids || []).map((id) => (list || []).find((o) => pickId(o) === id)).filter(Boolean).map(pickLabel)
    const chips = (labels) =>
      labels.length
        ? labels.map((n) => `<span class="tag tag-neutral">${esc(n)}</span>`).join(' ')
        : `<span style="font-size: 12px; color: var(--muted-foreground);">${t('没有')}</span>`
    return `<div class="satu-panel">
      <span class="satu-panel-title">${t('可用 Skill')}</span>
      <div style="display: flex; flex-wrap: wrap; gap: 6px;">${chips(names(a.skills, opts.skills))}</div>
      <span class="satu-panel-title" style="margin-top: var(--space-2);">${t('可用 MCP 服务器')}</span>
      <div style="display: flex; flex-wrap: wrap; gap: 6px;">${chips(names(a.mcps, opts.mcps))}</div>
      ${browserBlock(a, true)}
      ${selfSkillsBlock(a, true)}
    </div>`
  }
  return `<div class="satu-panel">
    <span class="satu-panel-title">${t('可用 Skill')}</span>
    ${botPicks('skills', opts.skills, a.skills, t('没有可选项'))}
    <span class="satu-panel-title" style="margin-top: var(--space-2);">${t('可用 MCP 服务器')}</span>
    ${botPicks('mcps', opts.mcps, a.mcps, t('没有可选项'))}
    <span style="font-size: 12px; color: var(--muted-foreground);">${t('未勾选的能力，Agent 在任务中不可调用。')}</span>
    ${browserBlock(a, false)}
    ${selfSkillsBlock(a, false)}
  </div>`
}


/**
 * 「让它自己记 Skill」。
 *
 * 摆在**能力**里，和浏览器同一格——它是「要不要放开」，不是「要不要收紧」。和浏览器
 * 不同的是它**默认开**：写下的东西绑在这一颗 Bot 上、进不了公司目录、每次写都落审计、
 * 这一屏一键能删，代价比「装完是哑的」小得多（见 docs/skills.md §7）。
 */
function selfSkillsBlock(a, ro) {
  const on = a.selfSkills !== false
  return botToggle(
    t('让它自己记 Skill', 'Let it write its own skills'),
    t(
      '跑完一件事，它可以把方法记下来，下次直接用。记下的只有这颗 Bot 用得上，在这一屏的「Bot 自己写的」里看得到、删得掉。',
      'After finishing a task it can note the method down and reuse it. Only this bot sees them; you can review or delete them under "Written by the bot".',
    ),
    on,
    ro ? '' : 'bot-self-skills',
  )
}

/**
 * 浏览器这一格摆在**能力**里，不摆在行为边界里。
 *
 * 那三条边界的语义是「要不要收紧」，默认全开等于最严；这一个是「要不要放开」，默认
 * 关才是最严。方向相反的东西并排放，管理员读到的会是「都打着勾＝都管着」。
 *
 * 站点列表只在开着的时候露出来：关着的时候它是一片没有任何作用的输入框，而一片看着
 * 能填的输入框比没有这一格更容易让人以为自己配好了。
 */
function browserBlock(a, ro) {
  const on = !!a.browserOn
  const desc = t(
    '让它操作席位桌面上那个浏览器，复用你已经登录的会话',
    'Let it drive the browser on the seat desktop, reusing sessions you already signed into',
  )
  const toggle = botToggle(t('允许操作浏览器', 'Allow browser control'), desc, on, ro ? '' : 'bot-browser')
  if (!on) return toggle
  const sites = String(a.browserSites || '')
  const list = ro
    ? `<div style="display: flex; flex-wrap: wrap; gap: 6px;">${
        sites.split('\n').map((x) => x.trim()).filter(Boolean).map((x) => `<span class="tag tag-neutral">${esc(x)}</span>`).join(' ') ||
        `<span style="font-size: 12px; color: var(--muted-foreground);">${t('没有')}</span>`
      }</div>`
    : /**
       * **多行的不能用 `.input` 那个药丸圆角。**
       *
       * `border-radius: 999px` 是给单行控件用的——高度一固定，999px 就是两头半圆，全站
       * 的输入框都长这样。textarea 一高上去，同一个值把边框摊成一个椭圆，域名从弧线里
       * 溢出来。仓库里已经栽过一次（发信卡的正文那格，`.sw-mail-text`）。
       *
       * 配法照同一页上那个 MCP 环境变量框（`#tl-env`）抄：等宽 + 12.5px。那一格和这一格
       * 是同一种东西——一行一个标识符，读的时候是在比对字符，不是在读句子。
       */
      `<textarea class="input" id="bot-browser-sites" rows="4" data-bot="browserSites" style="border-radius: var(--radius-md); resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.7;" placeholder="example.com&#10;*.erp.mycompany.cn">${esc(sites)}</textarea>`
  return `${toggle}
    <div class="field" style="margin-top: var(--space-2);">
      <label for="bot-browser-sites">${t('允许打开的站点', 'Sites it may open')}</label>
      ${list}
    </div>
    <span style="font-size: 12px; color: var(--muted-foreground);">${t(
      '一行一个。写 example.com 覆盖它和全部子域；* 顶一段标签里的字符、不跨点（erp-*.corp.com 配 erp-hz.corp.com）；example.* 放开后缀（.cn 和 .com 都算）；*.* 是全部放开。配上了就连子域一起算。没列出来的站点一律拦下——这把工具用的是你本人的登录态，一次误开就等于以你的名义做了一件事。填多宽由你定，但本机地址和内网地址是另一层管的，怎么填都不放行。',
      'One entry per line. A bare domain covers it and all subdomains (example.com covers app.example.com); * matches within one label and never crosses a dot (erp-*.corp.com matches erp-hz.corp.com); example.* opens the suffix (.cn and .com both count); *.* opens everything. Whatever matches, its subdomains match too. Anything not listed is blocked — this tool acts with your own signed-in session, so one wrong site means something done in your name. How wide you go is your call, but loopback and private addresses are handled by a separate layer and are never allowed, no matter what you type.',
    )}</span>`
}

/**
 * 「已存记忆」那一格。
 *
 * 这一格原来是**写死的空列表**——正文一行常量「没有已存记忆」，计数读一个恒定的空
 * 数组。开关全在，底下什么都没有（docs/memory.md 开头）。
 *
 * 三件事必须在这一屏上说清楚：
 *
 * - **哪些是它自己记的、哪些是管理员设的。** 上面两层（分组 / 全公司）在这儿只读——
 *   它们确实在影响这颗 Bot，藏起来的话「它怎么知道这件事的」就没有出处；
 * - **哪些已经过期。** 到期只是不再进上下文，条目还在，可以捞回来；
 * - **删掉之后要等一会儿。** 席位按目录探针同步，最多一分钟。不说的话，人删完立刻
 *   去对话里试、看见它还记得，得到的结论是「删除没用」（§12 ③）。
 */
function storedMemories(a, ro) {
  /**
   * **没拉过记忆就整格不画。**
   *
   * 这一格是 per-Bot 的东西，而 `memoryPanel` 还挂在公司 Bot 模版那一屏上（那儿没有
   * 「哪一颗 Bot」可言），owner 那条详情路径也不拉它。垫一个空数组画出来的话，人看到
   * 的是一句斩钉截铁的「还没有记下任何事实」加一句「改动一分钟后生效」——两句都是假的。
   */
  if (!Array.isArray(a.memories)) return ''
  const items = a.memories
  const now = Date.now()
  const dead = (m) => !m.pinned && m.expiresAt != null && m.expiresAt <= now
  const live = items.filter((m) => !dead(m))
  const gone = items.filter(dead)
  const used = a.memoryUsed ?? live.filter((m) => m.layer === 'bot' || m.layer === 'self').length
  const max = a.memoryMax || 0
  const count = max ? `${used} / ${max}` : `${used}`
  const row = (m, expired) => {
    const mine = m.layer === 'bot' || m.layer === 'self'
    const tags = [
      `<span class="tag tag-neutral" style="font-size: 11px;">${esc(t(m.kind))}</span>`,
      m.layer === 'self'
        ? `<span class="tag tag-neutral" style="font-size: 11px;">${esc(t('所有 Bot', 'all bots'))}</span>`
        : '',
      m.layer === 'group' || m.layer === 'company'
        ? `<span class="tag tag-neutral" style="font-size: 11px;">${esc(t(m.layer === 'group' ? '分组' : '全公司', m.layer === 'group' ? 'group' : 'company'))}</span>`
        : '',
      m.pinned ? `<span class="tag tag-neutral" style="font-size: 11px;">${esc(t('钉住', 'pinned'))}</span>` : '',
      // 席位扫出来的敏感类型。**标红给人看，不在这边重判**——判据那一份在席位上。
      (m.pii || []).length
        ? `<span class="tag tag-danger" style="font-size: 11px;">${esc((m.pii || []).join('、'))}</span>`
        : '',
    ]
      .filter(Boolean)
      .join(' ')
    /**
     * 「推给全公司」**只给管理员**，而且只给 `self` 那一层。
     *
     * 那一层的一条推上去之后会逐字进入本公司每个人的系统提示词——这不是一条设置，
     * 是一次对所有人的广播（docs/memory.md §12 ⑤）。所以它和私有档 Skill 的「晋升」
     * 一样是人的决定，而且是管理员的决定；模型自己碰不到那两层。
     */
    const canLift = !ro && mine && m.layer === 'self' && isAdmin()
    const acts = ro || !mine
      ? `<span style="font-size: 12px; color: var(--muted-foreground);">${esc(t('管理员设的，这里改不了', 'set by an admin — read-only here'))}</span>`
      : `${expired ? `<button type="button" class="sw-skillnote-act" data-act="bot-mem-renew" data-id="${esc(m.id)}">${esc(t('续期', 'renew'))}</button>` : `<button type="button" class="sw-skillnote-act" data-act="bot-mem-pin" data-id="${esc(m.id)}">${esc(m.pinned ? t('取消钉住', 'unpin') : t('钉住', 'pin'))}</button>`}
         ${canLift ? `<button type="button" class="sw-skillnote-act" data-act="bot-mem-lift" data-id="${esc(m.id)}">${esc(t('推给全公司', 'share company-wide'))}</button>` : ''}
         <button type="button" class="sw-skillnote-act" data-act="bot-mem-del" data-id="${esc(m.id)}">${esc(t('删掉', 'delete'))}</button>`
    return `<div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); padding: 8px 0; border-top: 1px solid var(--border);">
      <div style="min-width: 0;">
        <div style="font-size: 13px; ${expired ? 'color: var(--muted-foreground); text-decoration: line-through;' : ''}">${esc(m.text || '')}</div>
        <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;">${tags}</div>
      </div>
      <div style="display: flex; gap: 6px; flex: none;">${acts}</div>
    </div>`
  }
  const body = live.length
    ? live.map((m) => row(m, false)).join('')
    : `<div style="padding: 6px 0; border-top: 1px solid var(--border); font-size: 13px; color: var(--muted-foreground);">${t('还没有记下任何事实')}</div>`
  const expiredBlock = gone.length
    ? `<div style="margin-top: 4px; padding-top: 4px;">
        <div style="font-size: 12px; color: var(--muted-foreground);">${t(`已过期 ${gone.length} 条 · 不再进上下文，但没有删掉`, `${gone.length} expired · no longer injected, not deleted`)}</div>
        ${gone.map((m) => row(m, true)).join('')}
      </div>`
    : ''
  return `<div style="display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
    <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
      <span style="font-size: 13.5px; font-weight: 600;">${t('已存记忆')}</span>
      <span style="font-size: 12px; color: var(--muted-foreground);">${esc(count)}</span>
    </div>
    ${body}
    ${expiredBlock}
    <span style="font-size: 12px; color: var(--muted-foreground);">${t('改动最多一分钟后在对话里生效。', 'Changes take effect in conversations within a minute.')}</span>
  </div>`
}

function memoryPanel(a, ro) {
  const scopePills = MEMORY_SCOPES.map(
    (sc) =>
      `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(a.scope === sc)}" ${ro ? 'disabled' : `data-act="bot-scope" data-value="${esc(sc)}"`}>${esc(t(sc))}</button>`,
  ).join('')
  // value 用中文原串当键（存的就是它），只翻显示的那一份。
  const ttlOpts = MEMORY_TTLS.map((ttl) => `<option value="${esc(ttl)}" ${ttl === a.ttl ? 'selected' : ''}>${esc(t(ttl))}</option>`).join('')
  const body = a.memoryOn
    ? `<div style="display: flex; flex-direction: column; gap: var(--space-4);">
        <div class="field">
          <label>${t('记忆范围')}</label>
          <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${scopePills}</div>
        </div>
        <div class="field">
          <label>${t('记录哪些内容')}</label>
          ${/* id 保持中文原串（存的是它），只翻显示的 label；botPicks 也喂用户数据，不能整体翻。 */ ''}
          ${botPicks('kinds', MEMORY_KINDS.map((k) => ({ id: k, name: t(k) })), a.kinds, '', ro)}
          ${/**
             * 「流程」那一格和另外三个不是一回事：另外三个决定「这一类能不能存进记忆」,
             * 它决定「撞上一段流程时说哪一句话」——流程根本不进记忆，它进 Skill
             * （docs/memory.md §1、§6）。不写这一句，管理员会以为勾上它就能记流程。
             */ ''}
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('记忆放的是一句话说得完的事实。「流程」勾上时，它撞见一段有步骤的流程会改去记成 Skill，而不是塞进记忆。', 'Memories hold single-sentence facts. With "process" checked, a multi-step procedure is saved as a Skill instead of squeezed into a memory.')}</span>
        </div>
        <div class="satu-agentpair">
          <div class="field">
            <label for="bot-ttl">${t('保留时长')}</label>
            <select class="input" id="bot-ttl" data-act="bot-ttl" ${ro ? 'disabled' : ''}>${ttlOpts}</select>
          </div>
          <div class="field">
            <label for="bot-cap" data-bot-cap-label>${t(`注入上限 · ${esc(a.cap)} 条`, `Injection cap · ${esc(a.cap)}`)}</label>
            <input class="input" id="bot-cap" type="range" min="5" max="50" step="5" value="${esc(a.cap)}" data-bot="cap" ${ro ? 'disabled' : ''} style="padding: 0; border: 0; background: transparent; accent-color: var(--color-accent);">
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('每次对话最多注入的记忆条数')}</span>
          </div>
        </div>
        ${botToggle(t('写入前需用户确认'), t('Agent 提议记住某条信息时先征求同意'), a.confirmOn, ro ? '' : 'bot-confirm')}
        ${botToggle(t('不记录敏感信息'), t('手机号、证件号、银行卡等自动跳过'), a.piiOn, ro ? '' : 'bot-pii')}
        ${storedMemories(a, ro)}
      </div>`
    : ''
  return `<div class="satu-panel">
    <span class="satu-panel-title">${t('记忆')}</span>
    <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('决定这个 Agent 能记住什么、记多久，以及记忆如何参与后续对话。')}</p>
    ${/**
       * 副文案原来写的是「关闭后每次对话都从空白上下文开始」——**那是错的**：会话照旧
       * 只增不减，压缩照旧跑，关掉记忆只是不再有提示词末尾那一段。照着那句话理解，
       * 人会以为这是个「清空聊天」的开关（docs/memory.md §6）。
       */ ''}
    ${botToggle(t('启用长期记忆'), t('关闭后它不再记住跨对话的事实；已存的保留，随时可以再打开'), a.memoryOn, ro ? '' : 'bot-memory')}
    ${body}
  </div>`
}

function botDetailPage() {
  const bot = state.bot
  const a = state.botDraft
  if (!bot || !a) {
    return `<div class="gw-page"><div class="gw-page-inner" style="max-width: 820px;">${flashes()}<p style="color: var(--muted-foreground);">${t('载入中…')}</p></div></div>`
  }
  // 自己建的那种：能改的只有身份和一段补充说明，底座在公司模版里。
  if (isMyBot(bot)) return myBotPage(bot, a)
  return fullBotPage(bot, a)
}

/**
 * 「我的 Bot」。
 *
 * 这一页故意不给提示词、行为边界、Skill 勾选——它们来自公司模版，在这儿摆一份能改的
 * 副本，人改完却不生效（服务端不收），比不摆更糟。所以底座在下面**只读**地列出来，
 * 旁边写清楚它归谁管。
 */
/**
 * 「Bot 记下的事实」——**自己建的那一屏上的**。
 *
 * **摆在这儿，不是摆在公司模版那一屏上。** 记忆的那几个开关（记哪几类、留多久、注入
 * 上限）确实是模版的，但**条目本身是这一颗 Bot 攒下来的数据**，跟着人走。摆到模版页
 * 去，管理员看到的是一份跟他无关的清单，而这颗 Bot 的主人——唯一会想删掉某一条的人
 * ——在自己这一屏上根本找不到它。
 *
 * 第一版就是这么错的：`memoryPanel` 只挂在模版页和公司 Bot 详情页上，而这两处都不拉
 * 每颗 Bot 的记忆，于是「已存记忆」在**任何一屏上都看不到**。e2e 验了接口、探针验了
 * 挑选、ui-dom 验了文件能装载，没有一处会因为「这张列表压根没进任何一个页面」而变红。
 *
 * 和上面那几块只读的「继承自公司模版」不同：这一块**是能动的**（删、钉住、管理员还能
 * 推给全公司），所以传 `ro = false`。
 */
function myMemories(a) {
  // 没拉到就整块不画（同 storedMemories 的口径）：空列表和"还没拉过"不能长得一样。
  if (!Array.isArray(a.memories)) return ''
  const off = a.memoryOn
    ? ''
    : `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t(
        '公司模版里「长期记忆」当前是关着的，下面这些留着但不会进对话。',
        'Long-term memory is off in the company template — these are kept but do not enter conversations.',
      )}</p>`
  return `<div class="satu-panel">
    <span class="satu-panel-title">${t('它记下的事实')}</span>
    <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t(
      '跨对话有效的一句话事实。它自己在对话里记，你在这儿删得掉。记哪几类、留多久由公司模版定。',
      'Single-sentence facts that carry across conversations. It records them itself; you can delete them here. Which kinds and how long are set by the company template.',
    )}</p>
    ${off}
    ${storedMemories(a, false)}
  </div>`
}

function myBotPage(bot, a) {
  const tplVersion = bot.templateVersion || state.template?.version || 1
  const opts = state.botOptions || { skills: [], mcps: [] }
  const iconPick = avatarKeysFor('company').map((key) => {
    const on = a.icon === key
    const label = t(BOT_AVATARS[key]?.label || key)
    return `<button type="button" class="satu-iconpick" aria-pressed="${String(on)}" aria-label="${esc(label)}" title="${esc(label)}" data-act="bot-icon" data-icon="${esc(key)}">${botAvatar(key, 30, 'company')}</button>`
  }).join('')
  const base = { ...a, prompt: state.template?.prompt || '', skills: state.template?.skills || [], mcps: state.template?.mcps || [] }
  return `
    <div class="gw-page">
      <div class="gw-page-inner" style="max-width: 820px; gap: var(--space-4);">
        <div class="satu-panel">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
            <div style="display: flex; align-items: flex-start; gap: var(--space-3); min-width: 0; flex: 1;">
              ${botAvatar(a.icon, 42, 'company')}
              <div style="min-width: 0; flex: 1; display: flex; flex-direction: column; gap: var(--space-2);">
                <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
                  <input class="input" style="max-width: 280px; font-family: var(--font-heading); font-size: 16px; font-weight: 600;" data-bot="name" value="${esc(a.name)}" placeholder="${esc(t('助理名字'))}">
                  <span class="tag ${a.enabled ? 'tag-accent-2' : 'tag-neutral'}">${a.enabled ? t('已上线') : t('未上线')}</span>
                  <span class="tag tag-neutral">${bot.runtimeKind === 'local' ? t('本地 Bot', 'Local bot') : t('远程 Bot', 'Remote bot')}</span>
                </div>
                <input class="input" data-bot="description" value="${esc(a.description)}" placeholder="${esc(t('简介'))}">
                <div style="font-size: 12.5px; color: var(--muted-foreground);">${t(`模型 ${esc(a.model || '—')}（平台指定）`, `model ${esc(a.model || '—')} (set by the platform)`)}</div>
                <div style="display: flex; flex-wrap: wrap; gap: 6px;">${iconPick}</div>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: var(--space-2); flex: none;">
              <button type="button" class="satu-switch" aria-pressed="${String(!!a.enabled)}" aria-label="${esc(t('上线'))}" data-act="bot-enabled"><span></span></button>
            </div>
          </div>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('这个 Bot 的补充说明')}</span>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
            ${t('写它专门负责什么、有什么习惯。这段接在公司模版的人设<b>后面</b>，不会替掉它——公司改了模版，你这段还在。', 'Say what this one is for and how it should behave. It is appended <b>after</b> the company persona, never replaces it — when the template changes, your note stays.')}
          </p>
          <textarea class="input satu-code" rows="6" data-bot="extraPrompt" placeholder="${esc(t('例如：你专门跟进华东区的客户回访，回复里带上客户名和上次联系时间。'))}">${esc(a.extraPrompt || '')}</textarea>
          <div class="field">
            <label for="bot-greeting">${t('开场问候')}</label>
            <input class="input" id="bot-greeting" type="text" data-bot="greeting" value="${esc(a.greeting)}">
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-2);">
          <h2 style="font-size: 16px; margin: 0;">${t('继承自公司模版')}</h2>
          <span class="tag tag-accent-2">v${esc(String(tplVersion))}</span>
          <span style="font-size: 12.5px; color: var(--muted-foreground);">${t('由公司管理员统一维护，改了这里所有人的 Bot 一起变。', 'Maintained by your company admin; a change here moves everyone at once.')}</span>
        </div>
        <div class="satu-panel">
          <span class="satu-panel-title" style="text-transform: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; letter-spacing: 0;">soul.md</span>
          <textarea class="input satu-code" rows="8" disabled>${esc(base.prompt)}</textarea>
        </div>
        ${guardsPanel(base, true)}
        ${capabilityPanel(base, opts, true)}
        ${myMemories(a)}

        ${flashes()}
        <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);">
          <button type="button" class="satu-linkbtn" style="text-align: left;" data-act="bot-delete">${t('删除这个 Bot')}</button>
          <button type="button" class="btn btn-primary" data-act="bot-save" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : t('保存配置')}</button>
        </div>
        <p style="margin: 0 0 var(--space-4); font-size: 12px; color: var(--muted-foreground);">${bot.runtimeKind === 'local'
          ? t('删除会移除这颗 Bot 的配置与会话；Mac 上的工作目录保留，避免误删你的文件。', 'Deleting removes this bot and its conversations; its Mac workspace is kept to avoid deleting your files.')
          : t('删除会连它的席位一起拆掉，机器上那块屏和这个 Bot 的会话都不再保留。', 'Deleting also tears down its seat — that screen and this bot\'s conversations are gone.')}</p>
      </div>
    </div>`
}

/** 全局 Bot（owner 编辑 / 公司侧只读），以及改版前留下的公司 Bot。 */
function fullBotPage(bot, a) {
  const ro = readOnlyItem(bot)
  const opts = state.botOptions || { skills: [], mcps: [], groups: [], kbs: [] }
  const iconPick = avatarKeysFor(bot.origin).map((key) => {
    const on = a.icon === key
    const label = t(BOT_AVATARS[key]?.label || key)
    return `<button type="button" class="satu-iconpick" aria-pressed="${String(on)}" aria-label="${esc(label)}" title="${esc(label)}" data-act="bot-icon" data-icon="${esc(key)}" ${ro ? 'disabled' : ''}>${botAvatar(key, 30, bot.origin)}</button>`
  }).join('')
  const roNote = bot.legacy
    ? t('这个 Bot 建于 Bot 模版之前，已经停用。公司的底座现在在「Bot 模版」那一页。', 'This bot predates the company template and is disabled. The company base now lives on the Bot template page.')
    : t('全局 Bot 由系统管理员维护')
  return `
    <div class="gw-page">
      <div class="gw-page-inner" style="max-width: 820px; gap: var(--space-4);">
        ${/* 「已保存」画在最下面那排按钮旁边——保存键在页尾，结论也该在那儿。 */ ''}
        <div class="satu-panel">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
            <div style="display: flex; align-items: flex-start; gap: var(--space-3); min-width: 0; flex: 1;">
              ${botAvatar(a.icon, 42, bot.origin)}
              <div style="min-width: 0; flex: 1; display: flex; flex-direction: column; gap: var(--space-2);">
                <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
                  <input class="input" style="max-width: 280px; font-family: var(--font-heading); font-size: 16px; font-weight: 600;" data-bot="name" value="${esc(a.name)}" placeholder="${esc(t('助理名字'))}" ${ro ? 'disabled' : ''}>
                  <span class="tag ${a.enabled ? 'tag-accent-2' : 'tag-neutral'}">${a.enabled ? t('已上线') : t('未上线')}</span>
                  ${bot.legacy ? `<span class="tag tag-neutral">${t('已停用')}</span>` : ''}
                </div>
                <input class="input" data-bot="description" value="${esc(a.description)}" placeholder="${esc(t('简介'))}" ${ro ? 'disabled' : ''}>
                ${/* 模型不给挑：平台在「模型配置」里定的那一个，所有 Bot 都用它。 */ ''}
                <div style="font-size: 12.5px; color: var(--muted-foreground);">${t(`本月执行 ${esc(bot.usage || '—')}`, `${esc(bot.usage || '—')} this month`)} · ${t(`模型 ${esc(a.model || '—')}（平台指定）`, `model ${esc(a.model || '—')} (set by the platform)`)}</div>
                <div style="display: flex; flex-wrap: wrap; gap: 6px;">${iconPick}</div>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: var(--space-2); flex: none;">
              <button type="button" class="satu-switch" aria-pressed="${String(!!a.enabled)}" aria-label="${esc(t('上线'))}" data-act="bot-enabled" ${ro ? 'disabled' : ''}><span></span></button>
            </div>
          </div>
        </div>

        <div class="satu-panel">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
            <span class="satu-panel-title" style="text-transform: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; letter-spacing: 0;">soul.md</span>
            <span style="font-size: 12px; color: var(--muted-foreground);" data-bot-prompt-len>${t(`${esc(String(a.prompt.length))} 字 · 每轮随上下文注入`, `${esc(String(a.prompt.length))} chars · injected each turn`)}</span>
          </div>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('这份文件定义 Agent 的身份、语气与工作原则，每次对话都会随上下文一起注入。')}</p>
          <textarea class="input satu-code" rows="12" data-bot="prompt" ${ro ? 'disabled' : ''}>${esc(a.prompt)}</textarea>
          <div class="field">
            <label for="bot-greeting">${t('开场问候')}</label>
            <input class="input" id="bot-greeting" type="text" data-bot="greeting" value="${esc(a.greeting)}" ${ro ? 'disabled' : ''}>
          </div>
        </div>

        ${guardsPanel(a, ro)}
        ${capabilityPanel(a, opts, ro)}
        ${memoryPanel(a, ro)}

        ${ro ? '' : `<div class="satu-panel">
          <span class="satu-panel-title">${t('可访问范围')}</span>
          <div class="field">
            <label>${t('可使用该 Agent 的分组')}</label>
            ${botPicks('groups', opts.groups, a.groups, t('没有可选项'))}
          </div>
          <div class="field">
            <label>${t('知识库')}</label>
            ${botPicks('kbs', opts.kbs, a.kbs, t('没有可选项'))}
          </div>
        </div>`}

        ${flashes()}
        <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);">
          ${ro && !bot.legacy ? '' : `<button type="button" class="satu-linkbtn" style="text-align: left;" data-act="${bot.legacy ? 'legacy-bot-delete' : 'bot-delete'}" data-id="${esc(bot.id)}" data-name="${esc(bot.name)}">${t('删除这个 Bot')}</button>`}
          <div style="display: flex; gap: var(--space-2);">
            <button type="button" class="btn btn-primary" data-act="bot-save" ${state.busy || ro ? 'disabled' : ''} ${ro ? 'title="' + esc(roNote) + '"' : ''}>${state.busy ? t('保存中…') : ro ? t('只读') : t('保存配置')}</button>
          </div>
        </div>
        <p style="margin: 0 0 var(--space-4); font-size: 12px; color: var(--muted-foreground);">${ro ? esc(roNote) : t('这一页的设置都会写回目录。行为边界保存即生效（席位一分钟内跟上，拦截发生在工具执行前）。记忆现在还只是存下来：注入还没接到 Bot 上。分组与知识库也还没有落点。', 'Everything here is persisted to the catalog. Guardrails take effect on save — seats pick them up within a minute and enforcement happens before a tool runs. Memory is still stored only: injection is not wired into the bot yet. Groups and knowledge bases have no home yet either.')}</p>
      </div>
    </div>`
}

/**
 * 「新建 Bot」弹窗。员工自己建，**按下「创建」就开始装**——跳进去的那一页是安装进度，
 * 装好之后它自己变成对话（见 chat.js 的 chatDeployPrompt）。
 *
 * 只问身份：名字、头像、简介、一段补充说明。其余的来自公司模版，这里不问也不给改。
 */
function newBotModal() {
  const f = state.newBot
  if (!f) return ''
  const icons = avatarKeysFor('company').map((key) => {
    const label = t(BOT_AVATARS[key]?.label || key)
    return `<button type="button" class="satu-iconpick" aria-pressed="${String(f.icon === key)}" aria-label="${esc(label)}" title="${esc(label)}" data-act="new-bot-icon" data-icon="${esc(key)}">${botAvatar(key, 30, 'company')}</button>`
  }).join('')
  const version = state.template?.version
  return `<div class="gw-modal-backdrop" data-act="new-bot-close">
    <div class="gw-modal" data-stop style="max-width: 520px;">
      <div>
        <h2 style="font-size: 20px; margin: 0 0 4px;">${t('新建 Bot')}</h2>
        <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
          ${t(`它会用公司的 Bot 模版${version ? ` v${version}` : ''} 当底座——人设、能用的 Skill 和 MCP 都在那儿。这里只填它是谁。`, `It runs on your company's bot template${version ? ` v${version}` : ''} — persona, skills and MCP servers all come from there. Here you just say who it is.`)}
        </p>
      </div>
      <div class="field">
        <label for="nb-name">${t('名字')}</label>
        <input class="input" id="nb-name" data-newbot="name" value="${esc(f.name)}" placeholder="${esc(t('例如：回访助手'))}" autofocus>
      </div>
      <div class="field">
        <label>${t('运行位置', 'Runs on')}</label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <label class="satu-card" style="padding:12px;cursor:pointer;border-color:${f.runtimeKind === 'remote' ? 'var(--primary)' : 'var(--border)'};">
            <input type="radio" name="nb-runtime" data-newbot="runtimeKind" value="remote" ${f.runtimeKind === 'remote' ? 'checked' : ''}>
            <strong>${t('远程 Bot', 'Remote bot')}</strong>
            <small style="display:block;margin-top:4px;color:var(--muted-foreground);">${t('运行在公司配置的机器上', 'Runs on the company machine')}</small>
          </label>
          <label class="satu-card" style="padding:12px;cursor:${window.__SATUWORK_DESKTOP__ ? 'pointer' : 'not-allowed'};opacity:${window.__SATUWORK_DESKTOP__ ? '1' : '.55'};border-color:${f.runtimeKind === 'local' ? 'var(--primary)' : 'var(--border)'};">
            <input type="radio" name="nb-runtime" data-newbot="runtimeKind" value="local" ${f.runtimeKind === 'local' ? 'checked' : ''} ${window.__SATUWORK_DESKTOP__ ? '' : 'disabled'}>
            <strong>${t('本地 Bot', 'Local bot')}</strong>
            <small style="display:block;margin-top:4px;color:var(--muted-foreground);">${t('运行在这台 Mac，使用独立工作目录', 'Runs on this Mac with its own workspace')}</small>
          </label>
        </div>
        ${window.__SATUWORK_DESKTOP__ ? '' : `<small style="color:var(--muted-foreground);">${t('本地 Bot 只能在 Satuwork Desktop 中创建。', 'Local bots can only be created in Satuwork Desktop.')}</small>`}
      </div>
      <div class="field">
        <label for="nb-desc">${t('简介')}</label>
        <input class="input" id="nb-desc" data-newbot="description" value="${esc(f.description)}" placeholder="${esc(t('一句话说清它管什么'))}">
      </div>
      <div class="field">
        <label>${t('头像')}</label>
        <div style="display: flex; flex-wrap: wrap; gap: 6px;">${icons}</div>
      </div>
      <div class="field">
        <label for="nb-extra">${t('补充说明')}</label>
        <textarea class="input satu-code" id="nb-extra" rows="4" data-newbot="extraPrompt" placeholder="${esc(t('可留空。写了就接在公司人设后面。'))}">${esc(f.extraPrompt)}</textarea>
      </div>
      ${state.newBotError ? `<p style="margin: 0; font-size: 13px; color: var(--color-danger, #d33);">${esc(state.newBotError)}</p>` : ''}
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="new-bot-close">${t('取消')}</button>
        ${/* 「创建并安装」不是啰嗦：按下去之后机器上真的开始装东西（一台干净机器上要
              几分钟），这颗按钮得先把这件事说出来，人才不会在进度屏上愣一下。 */ ''}
        <button type="button" class="btn btn-primary" data-act="new-bot-save" ${state.busy ? 'disabled' : ''}>${state.busy ? t('创建中…') : f.runtimeKind === 'local' ? t('创建并启动', 'Create and start') : t('创建并安装', 'Create and install')}</button>
      </div>
    </div>
  </div>`
}

function dayISO(ts) {
  if (!ts) return '—'
  return new Date(ts).toISOString().slice(0, 10)
}

function kbOf(n) {
  const x = Number(n) || 0
  return x < 1024 ? `${x} B` : x < 1024 * 1024 ? `${(x / 1024).toFixed(1)} KB` : `${(x / 1024 / 1024).toFixed(1)} MB`
}

function stepsOfBody(body) {
  return String(body || '')
    .split('\n')
    .filter((l) => /^\s*(?:\d+[.)]|[-*+])\s+/.test(l)).length
}

const SKILL_ICON = ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z']
const EDIT_ICON = ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z']
const FILE_ICON = ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6']
const UPLOAD_ICON = ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 9 5-5 5 5', 'M12 4v12']
const CHECK_ICON = ['m5 13 4 4L19 7']
const PLUS_ICON = ['M12 5v14', 'M5 12h14']
const CLOSE_ICON = ['M18 6 6 18', 'M6 6l12 12']
const SKILL_SOURCES = [
  { key: '手动编写', label: '手动编写' },
  { key: '单文件 Skill', label: '单文件 Skill' },
  { key: 'ZIP 包', label: 'ZIP 包' },
]
const MCP_KINDS = ['stdio', 'SSE', 'HTTP']
const MCP_PERMS = [
  { key: '只读', label: '只读', tag: 'tag-neutral' },
  { key: '可写', label: '可写', tag: 'tag-accent' },
  { key: '需审批', label: '需审批', tag: 'tag-accent-2' },
]
function permTag(perm) {
  return MCP_PERMS.find((p) => p.key === perm)?.tag || 'tag-neutral'
}

function emptySkillForm(item) {
  return {
    name: item?.name || '',
    body: item?.body || '',
    tags: Array.isArray(item?.tags) ? [...item.tags] : [],
    source: item?.source || '手动编写',
    enabled: item ? item.enabled !== false : true,
    fileName: item?.fileName || '',
    /**
     * 常驻还是按需。**新建默认按需，打开一条老的显示它自己那一档**——存量都是常驻，
     * 那是它们建起来时唯一的行为，改默认值等于趁人不注意改行为。
     */
    mode: item?.mode === '常驻' ? '常驻' : item ? item.mode || '常驻' : '按需',
  }
}

function emptyServerForm(item) {
  const env = item?.env && typeof item.env === 'object' && Object.keys(item.env).length ? JSON.stringify(item.env, null, 2) : ''
  return {
    name: item?.name || '',
    kind: item?.kind || 'SSE',
    endpoint: item?.endpoint || '',
    token: '',
    env,
    perm: item?.perm || '只读',
    enabled: item ? item.enabled !== false : true,
    hasToken: !!item?.hasToken,
  }
}

function syncSkillForm() {
  const f = state.skillForm
  if (!f) return
  const name = document.getElementById('sk-name')
  const body = document.getElementById('sk-body')
  const endpoint = document.getElementById('tl-endpoint')
  const token = document.getElementById('tl-token')
  const env = document.getElementById('tl-env')
  if (name) f.name = name.value
  if (body) f.body = body.value
  if (endpoint) f.endpoint = endpoint.value
  if (token) f.token = token.value
  if (env) f.env = env.value
}

function closeSkillDialog() {
  state.skillDialog = null
  state.skillForm = null
  state.skillError = ''
  state.skillFile = null
  state.skillEntries = null
  state.skillTagManage = false
  state.skillTagAdding = false
}

function pickRow(label, options, value, act, hint) {
  const buttons = options
    .map((o) => {
      const key = o.key || o
      const lab = o.label || o
      return `<button type="button" class="satu-assignee" style="padding: 5px 12px;" aria-pressed="${String(value === key)}" data-act="${esc(act)}" data-value="${esc(key)}">${esc(lab)}</button>`
    })
    .join('')
  return `<div class="field">
    <label>${esc(label)}</label>
    <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${buttons}</div>
    ${hint ? `<span style="font-size: 12px; color: var(--muted-foreground);">${esc(hint)}</span>` : ''}
  </div>`
}

function skillEnableRow(enabled) {
  return `<div class="satu-toggleRow" style="border-top: 0; padding: 0;">
    <div>
      <div style="font-size: 13.5px; font-weight: 600;">${t('保存后立即启用')}</div>
      <div style="font-size: 12px; color: var(--muted-foreground);">${t('关闭则仅保存，不对 Agent 开放')}</div>
    </div>
    <button type="button" class="satu-switch" aria-pressed="${String(!!enabled)}" aria-label="${esc(t('立即启用'))}" data-act="skill-enabled"><span></span></button>
  </div>`
}

function skillTagPicker(known, picked) {
  const manage = state.skillTagManage
  const chips = (known || [])
    .map((tag) =>
      manage
        ? `<button type="button" class="satu-assignee" style="padding: 5px 10px 5px 12px; gap: 6px; color: var(--color-accent-800);" aria-label="${t(`删除标签 ${esc(tag)}`, `Delete tag ${esc(tag)}`)}" data-act="skill-tag-delete" data-tag="${esc(tag)}">${esc(tag)} ${svg(CLOSE_ICON, 12)}</button>`
        : `<button type="button" class="satu-assignee" style="padding: 5px 12px;" aria-pressed="${String(picked.includes(tag))}" data-act="skill-tag-pick" data-tag="${esc(tag)}">${esc(tag)}</button>`,
    )
    .join('')
  const add = manage
    ? ''
    : state.skillTagAdding
      ? `<input class="input" id="sk-tag-draft" style="width: 120px; padding: 4px 10px; font-size: 13px;" autofocus data-skill-tag-draft placeholder="${esc(t('新标签'))}">`
      : `<button type="button" class="satu-assignee" style="padding: 5px 12px;" data-act="skill-tag-add">${svg(PLUS_ICON, 12)} ${t('新建标签', 'New tag')}</button>`
  const hint = manage
    ? t('点一个标签把它删掉——用到它的 Skill 上那一个也会一起去掉。')
    : t('可多选，用于筛选与归类')
  return `<div class="field">
    <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
      <label style="margin: 0;">${t('标签')}</label>
      <button type="button" class="satu-linkbtn" style="font-size: 12px;" data-act="skill-tag-manage">${manage ? t('完成') : t('管理')}</button>
    </div>
    <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${chips}${add}</div>
    <span style="font-size: 12px; color: var(--muted-foreground);">${esc(hint)}</span>
  </div>`
}

function skillEmpty(title, note) {
  return `<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: var(--space-8) var(--space-4); border: 1px dashed var(--input-border); border-radius: var(--radius-lg); background: var(--card);">
    <div style="font-size: 14px; font-weight: 600;">${esc(title)}</div>
    <div style="font-size: 12.5px; color: var(--muted-foreground);">${esc(note)}</div>
  </div>`
}

function skillCard(skill) {
  // 全局项在公司侧只能看。owner 自己那份页面里不算只读。
  const ro = readOnlyItem(skill)
  const tags = (skill.tags || []).map((tag) => `<span class="tag tag-neutral" style="font-size: 11px; padding: 2px 8px;">${esc(tag)}</span>`).join('')
  const steps = skill.steps ? `<span>${t(`${esc(String(skill.steps))} 个步骤`, `${esc(String(skill.steps))} steps`)}</span>` : ''
  /**
   * 常驻 / 按需要在卡片上一眼看得见：这两档的行为差别很大（一个每轮都在，一个要模型
   * 自己去展开），而它在弹窗里，不点开根本不知道。
   */
  const onDemand = skill.mode !== '常驻'
  const modeTag = `<span class="tag ${onDemand ? 'tag-neutral' : 'tag-accent-2'}" style="font-size: 11px;">${onDemand ? t('按需') : t('常驻')}</span>`
  /**
   * **按需档没写说明就是废的**：提示词里只有这一句，模型据此决定要不要展开正文。
   * 常驻档没有这个问题（正文本来就在），所以只对按需档提示。
   */
  const noDesc = onDemand && !skill.description
  const fileTag = skill.fileCount ? `<span>${t(`${esc(String(skill.fileCount))} 个文件`, `${esc(String(skill.fileCount))} files`)}</span>` : ''
  return `<div class="satu-card">
    <div style="display: flex; align-items: flex-start; gap: var(--space-3);">
      <span class="satu-providermark" style="background: var(--color-accent-100); color: var(--color-accent-800);">${svg(SKILL_ICON, 16)}</span>
      <div style="flex: 1; min-width: 0;">
        <div class="satu-name">${esc(skill.displayName || skill.name)}${ro ? ` <span class="tag tag-accent-2" style="font-size: 11px;">${t('全局')}</span>` : ''} ${modeTag}</div>
        <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px;">${tags}</div>
      </div>
      <button type="button" class="satu-switch" aria-pressed="${String(skill.enabled !== false)}" aria-label="${esc(t('启用'))}" data-act="skill-toggle" data-id="${esc(skill.id)}" ${ro ? 'disabled title="' + esc(t('全局 Skill 由系统管理员维护')) + '"' : ''}><span></span></button>
    </div>
    <p class="satu-desc">${esc(skill.description || skill.summary || t('（还没写正文）'))}</p>
    ${noDesc ? `<div style="font-size: 12px; color: var(--color-accent-800);">${t('这条是按需的，但没有一句说明——模型看不出它是干什么的，多半不会展开它。在正文开头写一句，或用 frontmatter 的 description。')}</div>` : ''}
    <div style="height: 1px; background: var(--color-divider);"></div>
    <div class="satu-meta">
      ${steps}
      ${fileTag}
      <span>${esc(skill.source || t('手动编写'))}</span>
      <span>${t(`更新于 ${esc(dayISO(skill.updatedAt))}`, `Updated ${esc(dayISO(skill.updatedAt))}`)}</span>
    </div>
    <div style="display: flex; gap: var(--space-2); margin-top: auto;">
      <button type="button" class="btn btn-secondary" style="flex: 1; justify-content: center;" data-act="skill-edit" data-id="${esc(skill.id)}" ${ro ? 'disabled title="' + esc(t('全局 Skill 由系统管理员维护')) + '"' : ''}>${ro ? t('查看') : t('编辑')}</button>
      <button type="button" class="btn btn-secondary" style="flex: none;" disabled title="${esc(t('试运行要等 Skill 接进 Agent 循环'))}">${t('试运行')}</button>
    </div>
  </div>`
}

function skillDialogView() {
  const d = state.skillDialog
  if (!d || d.type !== 'skill') return ''
  const f = state.skillForm || emptySkillForm(d.item)
  const skill = d.item
  const zip = f.source === 'ZIP 包'
  const upload = f.source !== '手动编写' && !skill
  const steps = stepsOfBody(f.body)
  const known = state.skillTags || []
  const file = state.skillFile
  const entries = state.skillEntries
  let uploadBlock = ''
  if (upload) {
    const accept = zip ? '.zip' : '.md,.markdown,.yaml,.yml,.json,.txt'
    const title = zip ? t('选择 .zip 技能包') : t('选择 SKILL.md / .yaml / .json')
    const hint = zip
      ? t('就在这台浏览器里解开，看清楚了再保存。')
      : t('文件内容就是这个 Skill 的定义，导入后可以直接在下面改。')
    const reqs = zip
      ? `<div style="display: flex; flex-direction: column; gap: 6px; padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
          <span class="satu-panel-title">${t('ZIP 包结构要求')}</span>
          ${[t('根目录含 SKILL.md（名称、说明、步骤）'), t('可选 scripts/、templates/、assets/ 子目录'), t('单包不超过 5 MB、200 个文件')]
            .map((line) => `<div class="satu-step" style="color: var(--muted-foreground);">${svg(CHECK_ICON, 13)} ${esc(line)}</div>`)
            .join('')}
        </div>`
      : ''
    const fileRow = file
      ? `<div class="satu-uploadrow">
          <span class="satu-dropicon" style="width: 32px; height: 32px;">${svg(FILE_ICON, 16)}</span>
          <div style="min-width: 0; flex: 1;">
            <div style="font-size: 13.5px; font-weight: 600;">${esc(file.name)}</div>
            <div style="font-size: 12px; color: var(--muted-foreground);">${esc(kbOf(file.size))}${entries ? t(` · 解出 ${entries.length} 个文件`, ` · ${entries.length} files extracted`) : ''} · 读到 ${steps} 个步骤</div>
          </div>
          <span class="tag tag-accent-2">${zip ? t('已解开') : t('已读取')}</span>
        </div>`
      : ''
    const tree = zip && entries
      ? `<div class="satu-filetree" style="max-height: 168px;">
          ${entries
            .map(
              (entry) => `<div class="satu-fileitem" style="cursor: default;">
                <span class="satu-fileicon">${svg(FILE_ICON, 13)}</span>
                <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(entry.path)}</span>
                <span style="margin-left: auto; font-size: 11.5px; color: var(--muted-foreground);">${esc(kbOf(entry.bytes ? entry.bytes.length : 0))}</span>
              </div>`,
            )
            .join('')}
        </div>`
      : ''
    uploadBlock = `<div style="display: flex; flex-direction: column; gap: var(--space-3);">
      <label class="satu-drop">
        <input type="file" accept="${esc(accept)}" style="position: absolute; inset: 0; opacity: 0; cursor: pointer;" data-skill-file="1">
        <span class="satu-dropicon">${svg(UPLOAD_ICON, 20)}</span>
        <span style="font-size: 14px; font-weight: 600;">${esc(title)}</span>
        <span style="font-size: 12px; color: var(--muted-foreground); text-align: center;">${esc(hint)}</span>
      </label>
      ${reqs}
      ${fileRow}
      ${tree}
    </div>`
  }
  const showBody = !upload || file
  const bodyField = showBody
    ? `<div class="field">
        <label for="sk-body">${esc(skill?.fileName || t('Skill 说明'))}</label>
        <textarea class="input${skill || file ? ' satu-code' : ''}" id="sk-body" rows="${skill || file ? 14 : 6}" style="border-radius: var(--radius-md); resize: vertical;" placeholder="${esc(t('描述这个 Skill 解决什么问题、按什么步骤执行'))}">${esc(f.body)}</textarea>
        <span style="font-size: 12px; color: var(--muted-foreground);">${t(`按步骤写：每一条列表项算一个步骤，现在是 ${steps} 个。`, `Write it as steps: each list item counts as one. Currently ${steps}.`)}</span>
      </div>`
    : ''
  const sourceRow = skill ? '' : pickRow(t('创建方式'), SKILL_SOURCES, f.source, 'skill-source')
  /**
   * 常驻 / 按需。
   *
   * 说明写成人话：常驻的每一轮都占着上下文，所以「要短」；按需的靠那一句说明被选中，
   * 所以「说清什么时候用它」。这两句是这一屏上最要紧的两行文案——选错档的代价，一边
   * 是每轮多付钱，一边是这条 Skill 根本没被用上。
   */
  const modeRow = pickRow(
    t('什么时候生效'),
    [
      { key: '常驻', label: t('每一轮都带着') },
      { key: '按需', label: t('用到才展开') },
    ],
    f.mode === '常驻' ? '常驻' : '按需',
    'skill-mode',
    f.mode === '常驻'
      ? t('正文每一轮都进系统提示词。适合口径、语气这类每次都要成立的规矩——要写短。')
      : t('提示词里只留名字和第一句说明，模型判断要用时自己展开正文。适合流程、清单、带文件的包。第一句话要说清什么时候用它。'),
  )
  /**
   * 已存下来的 ZIP 包里有什么。
   *
   * 以前这一屏只显示「12 个文件」——而现在这些文件真的会下发到席位、被模型读到，
   * 管理员得能核对包里到底是什么。清单来自单条详情（`files`），列表那一屏不带它。
   */
  const saved = Array.isArray(skill?.files) ? skill.files : []
  const fileList = saved.length
    ? `<div class="field">
        <label>${t(`包里的文件（${saved.length} 个）`, `Files in the package (${saved.length})`)}</label>
        <div class="satu-filetree" style="max-height: 168px;">
          ${saved
            .map(
              (f2) => `<div class="satu-fileitem" style="cursor: default;">
                <span class="satu-fileicon">${svg(FILE_ICON, 13)}</span>
                <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(f2.path)}</span>
                <span style="margin-left: auto; font-size: 11.5px; color: var(--muted-foreground);">${esc(kbOf(f2.bytes || 0))}</span>
              </div>`,
            )
            .join('')}
        </div>
        <span style="font-size: 12px; color: var(--muted-foreground);">${t('Bot 用 skill_view 按名字读它们，不会一次全塞进上下文。')}</span>
      </div>`
    : ''
  const err = state.skillError
    ? `<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-sm); padding: 10px var(--space-3);">${esc(state.skillError)}</div>`
    : ''
  const del = skill
    ? `<button type="button" class="satu-linkbtn" style="margin-right: auto; color: var(--color-accent-800);" data-act="skill-delete">${t('删除这个 Skill')}</button>`
    : ''
  return `<div class="gw-modal-backdrop" data-act="skill-close">
    <form id="skill-form" class="gw-modal" style="max-width: 560px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${skill ? t('编辑 Skill') : t('新建 Skill')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('Skill 把一组步骤和 MCP 工具打包成可复用的工作方法。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="skill-close">${svg(CLOSE_ICON, 16)}</button>
      </div>
      <div class="field">
        <label for="sk-name">${t('名称')}</label>
        <input class="input" id="sk-name" type="text" required value="${esc(f.name)}" placeholder="${esc(t('例如：工单归类与摘要'))}">
      </div>
      ${sourceRow}
      ${uploadBlock}
      ${bodyField}
      ${modeRow}
      ${fileList}
      ${skillTagPicker(known, f.tags || [])}
      ${skillEnableRow(f.enabled)}
      ${err}
      <div style="display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2);">
        ${del}
        <button type="button" class="btn btn-secondary" data-act="skill-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : skill ? t('保存修改') : t('保存')}</button>
      </div>
    </form>
  </div>`
}

function serverDialogView() {
  const d = state.skillDialog
  if (!d || d.type !== 'server') return ''
  const f = state.skillForm || emptyServerForm(d.item)
  const server = d.item
  const stdio = f.kind === 'stdio'
  const err = state.skillError
    ? `<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-sm); padding: 10px var(--space-3);">${esc(state.skillError)}</div>`
    : ''
  const del = server
    ? `<button type="button" class="satu-linkbtn" style="margin-right: auto; color: var(--color-accent-800);" data-act="mcp-delete">${t('移除这台服务器')}</button>`
    : ''
  const tokenHint = f.hasToken
    ? t('已存了一把。留空表示不动它，填了就换成新的。')
    : t('存在本机库里，不会再从服务端发回浏览器。')
  return `<div class="gw-modal-backdrop" data-act="skill-close">
    <form id="server-form" class="gw-modal" style="max-width: 520px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${server ? t('编辑 MCP 服务器') : t('接入 MCP 服务器')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('接入之后，它提供的工具即可被 Agent 调用。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="skill-close">${svg(CLOSE_ICON, 16)}</button>
      </div>
      <div class="field">
        <label for="tl-name">${t('名称')}</label>
        <input class="input" id="tl-name" name="name" type="text" required value="${esc(f.name)}" placeholder="${esc(t('例如：zendesk-mcp'))}">
      </div>
      ${pickRow(t('传输方式'), MCP_KINDS.map((k) => ({ key: k, label: k })), f.kind, 'mcp-kind')}
      <div class="field">
        <label for="tl-endpoint">${stdio ? t('启动命令') : t('服务器地址')}</label>
        <input class="input" id="tl-endpoint" type="text" required value="${esc(f.endpoint)}" placeholder="${stdio ? 'npx -y @acme/mcp-server' : 'https://mcp.example.com/sse'}" ${stdio ? 'style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;"' : ''}>
        ${stdio ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t('本机启动的进程，按 stdio 通信')}</span>` : ''}
      </div>
      <div class="field">
        <label for="tl-token">${t('鉴权 Token（可选）')}</label>
        <input class="input" id="tl-token" type="password" value="${esc(f.token)}" placeholder="${f.hasToken ? '••••••••' : 'Bearer …'}">
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(tokenHint)}</span>
      </div>
      <div class="field">
        <label for="tl-env">${t('环境变量（JSON，可选）')}</label>
        <textarea class="input" id="tl-env" rows="3" style="border-radius: var(--radius-md); resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;" placeholder='{"WORKSPACE_ID":"acme"}'>${esc(f.env)}</textarea>
      </div>
      ${pickRow(t('权限'), MCP_PERMS, f.perm, 'mcp-perm', t('这一档现在只是登记，真正的拦截要等工具管线接上 MCP。'))}
      ${skillEnableRow(f.enabled)}
      ${err}
      <div style="display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2);">
        ${del}
        <button type="button" class="btn btn-secondary" data-act="skill-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : server ? t('保存修改') : t('保存')}</button>
      </div>
    </form>
  </div>`
}


/**
 * 「Bot 自己写的」那一档。
 *
 * 单独一栏而不是混进上面的网格：它们不是管理员写的东西，能做的事也不一样（转成公司
 * Skill、或者删掉，改不了正文）。默认折叠但**带条数角标**——平时不占地方，攒出东西
 * 来的时候一眼看得见。
 */
function seatSkillRow(skill, botName) {
  const pii = Array.isArray(skill.pii) && skill.pii.length
    ? `<span class="tag tag-accent-2" style="font-size: 11px;">${t(`可能含${esc(skill.pii.join('、'))}`, `may contain ${esc(skill.pii.join(', '))}`)}</span>`
    : ''
  return `<div class="satu-toolrow" style="grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) auto auto;">
    <div style="min-width: 0; display: flex; flex-direction: column; gap: 2px;">
      <span style="font-weight: 600; font-size: 14px;">${esc(skill.displayName || skill.name)} ${pii}</span>
      <span style="font-size: 12px; color: var(--muted-foreground);">${esc(botName || t('某颗 Bot'))} · ${esc(dayISO(skill.updatedAt))}</span>
    </div>
    <span style="font-size: 13px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(skill.description || skill.summary || t('（没写说明）'))}</span>
    <button type="button" class="btn btn-secondary" style="flex: none;" data-act="skill-promote" data-id="${esc(skill.id)}">${t('转成公司 Skill')}</button>
    <button type="button" class="satu-linkbtn" style="color: var(--color-accent-800);" data-act="skill-seat-delete" data-id="${esc(skill.id)}">${t('删掉')}</button>
  </div>`
}

function seatSkillsBlock(seat, bots) {
  if (!seat.length) return ''
  const open = state.seatSkillsOpen === true
  const nameOf = (id) => (bots || []).find((b) => b.id === id)?.name || ''
  return `<div style="display: flex; flex-direction: column; gap: var(--space-3);">
    <button type="button" class="satu-linkbtn" style="display: flex; align-items: center; gap: var(--space-2); font-size: 15px; font-weight: 600;" data-act="seat-skills-toggle">
      ${t('Bot 自己写的')} <span class="tag tag-neutral" style="font-size: 11px;">${seat.length}</span>
      <span style="font-size: 12px; color: var(--muted-foreground); font-weight: 400;">${open ? t('收起') : t('展开')}</span>
    </button>
    ${
      open
        ? `<div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">${seat.map((x) => seatSkillRow(x, nameOf(x.botId))).join('')}</div>
           <span style="font-size: 12px; color: var(--muted-foreground);">${t('这些是 Bot 在对话里自己记下的做法：只有记下它的那颗 Bot 用得上，进不了公司目录。要给全公司用，点「转成公司 Skill」。')}</span>`
        : ''
    }
  </div>`
}

function skillsPage() {
  /**
   * **tab 存的是键，不是译文。**
   *
   * 原先这里先 `t('MCP 与工具')` 翻成 'MCP & tools' 再拿去和下面那两个键比——英文界面
   * 下两边永远不相等，于是切到 MCP 那一屏时两颗药丸都不高亮（aria-pressed 全是
   * false）；药丸上的字也是 `esc(name)`，英文界面照样显示「MCP 与工具」。
   * 比较用键，显示用 t()。
   */
  const tab = state.skillsTab === 'MCP 与工具' ? 'MCP 与工具' : 'Skill'
  const isSkill = tab === 'Skill'
  const skills = state.skills || []
  const servers = state.mcpServers || []
  const tabs = ['Skill', 'MCP 与工具']
    .map(
      (name) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(tab === name)}" data-act="skills-tab" data-tab="${esc(name)}">${esc(name === 'Skill' ? name : t(name))}</button>`,
    )
    .join('')
  const failure = state.skillFailure
    ? `<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-md); padding: 10px var(--space-4); display: flex; justify-content: space-between; gap: var(--space-3);">
        <span>${esc(state.skillFailure)}</span>
        <button type="button" class="satu-linkbtn" data-act="skill-dismiss">${t('知道了')}</button>
      </div>`
    : ''
  let body
  if (isSkill) {
    // 「Bot 自己写的」不混进上面那片网格：它们不是同一种东西，能做的事也不一样。
    const owned = skills.filter((x) => x.origin !== 'seat')
    const seat = skills.filter((x) => x.origin === 'seat')
    const grid = owned.length
      ? `<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--space-4);">${owned.map(skillCard).join('')}</div>`
      : skillEmpty(t('还没有 Skill'), t('点右上角新建一个：手动写，或导入一份 SKILL.md。'))
    body = `<div style="display: flex; flex-direction: column; gap: var(--space-6);">${grid}${seatSkillsBlock(seat, state.bots)}</div>`
  } else {
    const rows = servers
      .map(
        (s) => `<div class="satu-toolrow">
          <div style="min-width: 0; display: flex; flex-direction: column; gap: 2px;">
            <span style="font-weight: 600; font-size: 14px;">${esc(s.name)}${readOnlyItem(s) ? ` <span class="tag tag-accent-2" style="font-size: 11px;">${t('全局')}</span>` : ''}</span>
            <span style="font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(s.endpoint)}</span>
          </div>
          <span style="font-size: 13px;">${esc(s.kind)}</span>
          <span style="font-size: 13px; color: var(--muted-foreground);" title="${esc(t('接上之后才知道'))}">—</span>
          <span class="tag ${permTag(s.perm)}">${esc(s.perm)}</span>
          <span style="font-size: 13px; color: var(--muted-foreground);">${esc(dayISO(s.updatedAt))}</span>
          <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-1); justify-content: flex-end;">
            <button type="button" class="satu-switch" aria-pressed="${String(s.enabled !== false)}" aria-label="${esc(t('启用'))}" data-act="mcp-toggle" data-id="${esc(s.id)}" ${readOnlyItem(s) ? 'disabled title="' + esc(t('全局 MCP 由系统管理员维护')) + '"' : ''}><span></span></button>
            <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('编辑 MCP 服务器'))}" data-act="mcp-edit" data-id="${esc(s.id)}" ${readOnlyItem(s) ? 'disabled title="' + esc(t('全局 MCP 由系统管理员维护')) + '"' : ''}>${svg(EDIT_ICON, 15)}</button>
          </div>
        </div>`,
      )
      .join('')
    const table = servers.length
      ? `<div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-toolhead">
            <span>${t('MCP 服务器')}</span><span>${t('传输')}</span><span>${t('工具数')}</span><span>${t('权限')}</span><span>${t('更新时间')}</span><span></span>
          </div>
          ${rows}
        </div>`
      : skillEmpty(t('还没接入 MCP 服务器'), t('点右上角接入一台：填地址与权限，先把配置登记下来。'))
    body = `<div style="display: flex; flex-direction: column; gap: var(--space-6);">
      <div style="display: flex; flex-direction: column; gap: var(--space-3);">
        <div style="display: flex; align-items: baseline; justify-content: space-between;">
          <h2 style="font-size: 18px; margin: 0;">${t('内置工具')}</h2>
        </div>
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover); padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('内置工具在 Bot 运行时上，Gateway 这一屏不列。')}</div>
      </div>
      <div style="display: flex; flex-direction: column; gap: var(--space-3);">
        <div style="display: flex; align-items: baseline; justify-content: space-between;">
          <h2 style="font-size: 18px; margin: 0;">${t('已接入 MCP 服务器')}</h2>
          <span style="font-size: 12px; color: var(--muted-foreground);">${t(`共 ${servers.length} 个`, `${servers.length} total`)}</span>
        </div>
        ${table}
        <span style="font-size: 12px; color: var(--muted-foreground);">${t('这里存的是连接配置。MCP 客户端还没接上，所以「工具数」要等真握上手才知道，先空着。')}</span>
      </div>
    </div>`
  }
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('Skill 与 MCP')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('Skill 是可复用的工作方法，MCP 服务器提供 AI 员工实际可调用的工具。')}</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" data-act="${isSkill ? 'skill-create' : 'mcp-create'}">
            ${svg(PLUS_ICON, 15)} ${isSkill ? t('新建 Skill') : t('接入 MCP')}
          </button>
        </div>
        ${flashes()}
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('分类')}</span>
          ${tabs}
        </div>
        ${failure}
        ${body}
      </div>
    </div>
    ${skillDialogView()}
    ${serverDialogView()}`
}


/**
 * 余额见底的横幅。
 *
 * **措辞跟着 enforce 走**：真会停下来和只是记账不拦截，是两件事。写死成「调用已暂停」
 * 而实际没停，公司会去查一个不存在的故障；反过来更糟。
 */
function creditWarning(balance) {
  const left = Number(balance.leftMicros)
  if (!Number.isFinite(left)) return ''
  const granted = Number(balance.grantedMicros) || 0
  if (left > 0) {
    // 见底之后才提醒等于没提醒——那时调用已经停了。一成是「还来得及去充」的量级。
    if (!granted || left > granted * 0.1) return ''
    return `<div class="gw-flash" style="margin: 0;">${esc(
      t(`额度还剩不到一成（${balance.left}），用完之后需要计费的调用会停下来。`,
        `Less than 10% of the credit is left (${balance.left}); billable calls stop when it runs out.`),
    )}</div>`
  }
  const msg = balance.enforce
    ? t('额度已用完，需要计费的调用（模型、连接器、网页搜索）已经停下来了。联系平台管理员充值后立刻恢复。',
        'Out of credit. Billable calls — model, connector and web search — are stopped. They resume as soon as the platform tops you up.')
    : t('额度已用完。平台目前没有开启熔断，调用还在继续，但这些钱是欠着的。',
        'Out of credit. The platform has not switched on enforcement, so calls still go through — but they are being booked against a negative balance.')
  return `<div class="gw-flash gw-flash-err" style="margin: 0;">${esc(msg)}</div>`
}

function billingPage() {
  const data = state.billing || {
    plan: { name: '席位套餐', status: '生效中', cycle: '—', seats: '—', period: '—', renew: '—', amount: '—', autoRenew: false },
    invoices: [],
    balance: { amount: '—', spentThisPeriod: '—', alertAt: '—' },
    topups: [],
  }
  const plan = data.plan || {}
  const tab = ['topup', 'usage'].includes(state.billingTab) ? state.billingTab : 'sub'
  const renewing = state.billingAutoRenew ?? !!plan.autoRenew
  const invoices = Array.isArray(data.invoices) ? data.invoices : []
  const topups = Array.isArray(data.topups) ? data.topups : []
  const balance = data.balance || { amount: '—', spentThisPeriod: '—', alertAt: '—' }
  const tabs = [
    { key: 'sub', label: '订阅' },
    { key: 'topup', label: '充值' },
    { key: 'usage', label: '用量明细' },
  ]
    .map(
      (item) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(tab === item.key)}" data-act="billing-tab" data-tab="${item.key}">${t(item.label)}</button>`,
    )
    .join('')
  const invoiceTail = `<div style="display: flex; align-items: center; gap: var(--space-3); justify-content: flex-end;">
      <button type="button" class="satu-linkbtn" disabled title="${esc(t('发票开具还没做'))}">${t('发票')}</button>
    </div>`
  const invoiceRows = invoices.map((b) => invoiceRow(b, invoiceTail)).join('')
  const topupRows = topups
    .map(
      (row) => `<div class="satu-billrow">
        <span style="font-size: 13.5px;">${esc(row.time)}</span>
        <span style="font-size: 13.5px;">${esc(row.amount)}</span>
        <span class="tag tag-accent-2">${t('已到账')}</span>
        <span style="font-size: 13px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(row.note || '—')}</span>
        <span></span>
      </div>`,
    )
    .join('')
  const subBody = `
        <div style="display: flex; flex-direction: column; gap: var(--space-6);">
          <div class="satu-panel">
            <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
              <div>
                <span class="satu-panel-title">${t('当前订阅')}</span>
                <div style="display: flex; align-items: baseline; gap: var(--space-2); margin-top: 6px;">
                  <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(plan.name || t('席位套餐'))}</span>
                  <span class="tag tag-accent-2">${esc(plan.status || t('生效中'))}</span>
                </div>
                <p style="margin: 6px 0 0; font-size: 13px; color: var(--muted-foreground);">${esc(plan.cycle || '—')} · ${esc(plan.seats || '—')}</p>
              </div>
              <button type="button" class="btn btn-secondary" style="flex: none;" disabled title="${esc(t('订阅体系还没做'))}">${t('管理订阅')}</button>
            </div>
            <div class="satu-kv"><span>${t('当前周期')}</span><span>${esc(plan.period || '—')}</span></div>
            <div class="satu-kv"><span>${t('下次续订')}</span><span>${esc(plan.renew || '—')}</span></div>
            <div class="satu-kv"><span>${t('周期费用')}</span><span>${esc(plan.amount || '—')}</span></div>
            <div class="satu-toggleRow">
              <div>
                <div style="font-size: 13.5px; font-weight: 600;">${t('自动续订')}</div>
                <div style="font-size: 12px; color: var(--muted-foreground);">${t('续订还没接，这个开关现在只是界面。')}</div>
              </div>
              <button type="button" class="satu-switch" aria-pressed="${String(renewing)}" aria-label="${esc(t('自动续订'))}" data-act="billing-autorenew"><span></span></button>
            </div>
          </div>
          ${billTable(t('订阅账单'), [t('账期'), t('金额'), t('状态'), t('付款时间'), ''], invoiceRows, t('还没有订阅账单。支付接上之后，账期会列在这里。'))}
        </div>`
  // 余额跟两个 tab 都有关（订阅送的 + 自己充的），所以提到 tab 上面，切 tab 也不换走。
  //
  // 两张卡并排：左边是会过期的那一笔，右边是账户合计。分开摆是因为这两笔的规矩不一样
  // ——赠送的跟着套餐到期清零，充的不过期。混在一张卡里只剩一个合计数，看不出该先花哪笔。
  const bonusExpiry = balance.planBonusExpires && balance.planBonusExpires !== '—'
    ? t(`${esc(balance.planBonusExpires)} 到期，没用完清零`, `expires ${esc(balance.planBonusExpires)}, unused amount is cleared`)
    : t('没有生效中的套餐')
  const balanceCard = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-4);">
          <div class="satu-panel">
            <span class="satu-panel-title">${t('套餐赠送余额')}</span>
            <div style="display: flex; align-items: baseline; gap: var(--space-3); margin-top: 6px;">
              <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(balance.planBonusLeft || balance.planBonus || '—')}</span>
              <span style="font-size: 13px; color: var(--muted-foreground);">${bonusExpiry}</span>
            </div>
            ${/* 发的和剩的是两个数。只报「发了多少」等于让人盯着一个永远不动的数猜自己还能用多久。 */ ''}
            <div class="satu-kv"><span>${t('本期发放')}</span><span>${esc(balance.planBonus || '—')}</span></div>
            <div class="satu-kv"><span>${t('来源')}</span><span>${esc(plan.name || t('席位套餐'))}</span></div>
            <div class="satu-kv"><span>${t('当前周期')}</span><span>${esc(plan.period || '—')}</span></div>
            <p style="margin: auto 0 0; font-size: 12px; color: var(--muted-foreground);">${t('跟着套餐走：续订会重新发一笔，到期不结转。')}</p>
          </div>
          <div class="satu-panel">
            <span class="satu-panel-title">${t('账户余额')}</span>
            <div style="display: flex; align-items: baseline; gap: var(--space-3); margin-top: 6px;">
              <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(balance.left || balance.amount || '—')}</span>
              <span style="font-size: 13px; color: var(--muted-foreground);">${t(`本期已扣 ${esc(balance.spentThisPeriod || '—')}`, `${esc(balance.spentThisPeriod || '—')} charged this period`)}</span>
            </div>
            ${/* 合计里含左边那一笔，所以这儿把两笔各自摊开，省得看着像两个不相干的数。 */ ''}
            <div class="satu-kv">
              <span>${t('充值余额')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('不过期')}</span></span>
              <span>${esc(balance.topupLeft || balance.topup || '—')}</span>
            </div>
            <div class="satu-kv">
              <span>${t('套餐赠送余额')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('会过期')}</span></span>
              <span>${esc(balance.planBonusLeft || balance.planBonus || '—')}</span>
            </div>
            <div class="satu-kv"><span>${t('扣费顺序')}</span><span>${t('先赠送，再充值', 'bonus first, then top-up')}</span></div>
            <p style="margin: auto 0 0; font-size: 12px; color: var(--muted-foreground);">${t('充值由平台代充：需要加额度请联系平台管理员。')}</p>
          </div>
        </div>
        ${creditWarning(balance)}`
  const topupBody = `
        <div style="display: flex; flex-direction: column; gap: var(--space-6);">
          ${billTable(t('充值记录'), [t('时间'), t('金额'), t('状态'), t('备注'), ''], topupRows, t('还没有充值记录。'))}
        </div>`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('账单')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('查看订阅状态、充值余额与历史账单。')}</p>
        </div>
        ${balanceCard}
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">${tabs}</div>
        ${flashes()}
        ${tab === 'sub' ? subBody : tab === 'topup' ? topupBody : chargeTable('org')}
        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('账单是公司产品层的事，不走 Bot 运行时。发票和在线支付还没接，那两处的数字空着，不编；余额和扣费是真的。')}</p>
      </div>
    </div>`
}

function usageMeter(name, value, pct, alt, mono) {
  const font = mono ? ' font-family: ui-monospace, SFMono-Regular, Menlo, monospace;' : ''
  return `<div style="display: flex; flex-direction: column; gap: 5px;">
      <div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3);">
        ${/* 面板窄，长名字（provider/model）必然被省略号切掉——把全名挂在 title 上，
              悬停能看全，不然「zaicodingplan/glm-…」两行长得一模一样。 */ ''}
        <span title="${esc(name)}" style="min-width: 0; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;${font}">${esc(name)}</span>
        <span style="flex: none; font-size: 12.5px; color: var(--muted-foreground);">${esc(value)}</span>
      </div>
      <div class="satu-meter"><div class="satu-meterfill" data-alt="${alt ? 'true' : 'false'}" style="width: ${Number(pct) || 0}%;"></div></div>
    </div>`
}

function usagePage() {
  const data = state.usage || {
    stats: [
      { label: '任务执行', value: '0', delta: '—' },
      { label: '输入 Tokens', value: '0', delta: '—' },
      { label: '输出 Tokens', value: '0', delta: '—' },
      { label: '费用', value: '—', delta: '—' },
    ],
    daily: [],
    byAgent: [],
    byKind: [],
    byModel: [],
    quota: [],
    seats: 0,
    byMember: [],
  }
  const ranges = ['近 7 天', '近 30 天', '本月']
  const range = state.usageRange || '近 30 天'
  const stats = Array.isArray(data.stats) ? data.stats : []
  const daily = Array.isArray(data.daily) ? data.daily : []
  const byAgent = Array.isArray(data.byAgent) ? data.byAgent : []
  const byModel = Array.isArray(data.byModel) ? data.byModel : []
  const byKind = Array.isArray(data.byKind) ? data.byKind : []
  const byMember = Array.isArray(data.byMember) ? data.byMember : []
  const seats = Number(data.seats) || 0
  const pills = ranges
    .map(
      (r) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(range === r)}" data-act="usage-range" data-range="${esc(r)}">${esc(r)}</button>`,
    )
    .join('')
  // 两张 token 卡片服务端给的是精确整数，几千万一长串没法一眼读，按 M 画、悬停看精确值。
  const tokenStats = new Set(['输入 Tokens', '输出 Tokens'])
  const statCards = stats
    .map(
      (s) => `<div class="satu-stat">
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(t(s.label))}</span>
        ${tokenStats.has(s.label)
          ? `<span title="${esc(exactTokens(s.value))}" style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(megaTokens(s.value))}</span>`
          : `<span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(s.value)}</span>`}
        <span style="font-size: 11.5px; color: var(--color-accent-2-800);">${esc(s.delta || '—')}</span>
      </div>`,
    )
    .join('')
  const dailyBody = daily.length
    ? (() => {
        const peak = Math.max(...daily.map((d) => Number(d.value) || 0), 0)
        const cols = daily
          .map((d) => {
            const v = Number(d.value) || 0
            const h = peak ? Math.round((v / peak) * 100) : 0
            return `<div class="satu-barcol" title="${esc(t(`${d.label} · ${v} 次`, `${d.label} · ${v} calls`))}">
                <div class="satu-barstack">
                  <div class="satu-barfill" style="height: ${h}%;"></div>
                </div>
                <span class="satu-barlabel">${esc(d.label)}</span>
              </div>`
          })
          .join('')
        return `<div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
            <span class="satu-panel-title">${t('每日任务执行量')}</span>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t(`峰值 ${peak} 次`, `peak ${peak} calls`)}</span>
          </div>
          <div class="satu-bars">${cols}</div>`
      })()
    : `<span class="satu-panel-title">${t('每日任务执行量')}</span>
          ${emptyBox(t('这个时间段里还没有调用。'))}`
  const agentBody = byAgent.length
    ? byAgent.map((a) => usageMeter(a.name, a.value, a.pct, false, false)).join('')
    // 「没有数」和「这一维盖不全」是两件事。模型调用还带不上 Bot 标识（Gateway 收到的
    // 是一个 OpenAI 兼容请求，里面没有会话这个概念），所以这一块空着多半不是没用过。
    : emptyBox(t('模型调用还没带上 Bot 标识，这里只数带得上的那些（连接器）。'))
  const modelBody = byModel.length
    ? byModel.map((m) => usageMeter(m.name, m.value, m.pct, true, true)).join('')
    : emptyBox(t('这个时间段里还没有模型调用。'))
  const kindBody = byKind.length
    ? byKind.map((k) => usageMeter(k.name, k.value, k.pct, false, false)).join('')
    : emptyBox(t('这个时间段里还没有计费记录。'))
  const memberRows = byMember
    .map((m) => {
      // 「已离职员工」是服务端兜出来的合计行，不是某个人——它的名字要翻译，真人的
      // 名字不能进译表。所以按标记分流，不是把所有 name 都塞进 t()。
      const label = m.departed
        ? `${t('已离职员工')}${m.count > 0 ? `（${m.count}）` : ''}`
        : m.name
      return `<div class="satu-usagerow"${m.departed ? ' style="opacity: 0.75;"' : ''}>
        <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
          <span class="satu-avatar" style="width: 26px; height: 26px; font-size: 11px; background: var(--color-neutral-300); color: var(--color-neutral-800);">${esc(m.initial || initialOf(m))}</span>
          <span style="min-width: 0; font-size: 13.5px;">${esc(label)}</span>
        </div>
        <span style="font-size: 13px;">${esc(m.tasks)}</span>
        <span title="${esc(exactTokens(m.tokens))}" style="font-size: 13px; color: var(--muted-foreground);">${esc(megaTokens(m.tokens))}</span>
        <span style="font-size: 13px;">${esc(m.amount || '—')}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(m.last)}</span>
      </div>`
    })
    .join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('用量统计')}</h1>
            ${/* label 是服务端原样发过来的中文（见 lib/guards.ts 那份 usagePayload），
                 拿 t() 翻过再比就永远配不上——英文界面下这句会一直说「还没有调用」，
                 而下面明明列着几千次。翻译只用在给人看的那半句上。 */ ''}
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${esc(range)} · ${esc((Number((stats.find((x) => x.label === '任务执行') || {}).value) || 0) > 0 ? t('已记录调用') : t('还没有调用'))}</p>
          </div>
          <div style="display: flex; align-items: center; gap: var(--space-2); flex: none;">
            ${pills}
            <button type="button" class="btn btn-secondary" disabled title="${esc(t('导出需要统计投影'))}">${t('导出 CSV')}</button>
          </div>
        </div>
        ${flashes()}
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--space-3);">
          ${statCards}
        </div>
        <div class="satu-panel">
          ${dailyBody}
        </div>
        <div class="satu-agentpair">
          ${/* 按类型排在最前：模型 / 连接器 / 网页三条路是**盖得全**的那一维，
                钱就是从这三处出去的。另外两块各自只覆盖一部分。 */ ''}
          <div class="satu-panel">
            <span class="satu-panel-title">${t('按类型')}</span>
            ${kindBody}
          </div>
          <div class="satu-panel">
            <span class="satu-panel-title">${t('按模型')}</span>
            ${modelBody}
          </div>
          <div class="satu-panel">
            <span class="satu-panel-title">${t('按 Bot')}</span>
            ${agentBody}
          </div>
        </div>
        <div class="satu-panel">
          <div>
            <span class="satu-panel-title">${t('套餐额度')}</span>
            <p style="margin: 6px 0 0; font-size: 13px; color: var(--muted-foreground);">${t(`当前套餐只约束席位（${seats} 个），还没有任务次数和 token 额度。`, `The current plan only caps seats (${seats}); there is no task or token quota yet.`)}</p>
          </div>
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <h2 style="font-size: 18px; margin: 0;">${t('成员用量')}</h2>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-usagehead">
              ${/* 「失败率」那一列永远是 —（从来没接过），换成真的能填上的东西。 */ ''}
              <span>${t('成员')}</span><span>${t('任务')}</span><span>Tokens</span><span>${t('金额')}</span><span>${t('最近使用')}</span>
            </div>
            ${memberRows || emptyBox(t('还没有成员。'))}
          </div>
        </div>
        ${chargeTable((isAdmin() || isOwner()) && orgId() ? 'org' : 'me')}
      </div>
    </div>`
}
