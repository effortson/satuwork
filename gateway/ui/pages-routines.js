/**
 * 日常任务：右栏那一列「这个 Bot 按时自己去做的事」，以及点进去的那一屏。
 *
 * 两个形态共用同一个右栏：**列表**挂在那块屏下面，**详情**把整栏换掉（见 render.js
 * 的 pageAside）。换掉的时候那块屏并没有卸载，只是被藏起来——桌面是一条 VNC 连接，
 * 卸一次就断一次（见 chat.js 的 syncDesktop）。
 *
 * 数据全在 Gateway：/runtime/bots/:id/routines 那一组。到点真正去跑的是 Gateway 的
 * 调度器，不是这个页面——浏览器关着的时候它照样得跑，这也是整个功能的意义所在。
 */

/** 详情里那几条运行记录多久刷一次。只在「有一条正在跑」的时候才转。 */
const ROUTINE_POLL_MS = 4000
let routinePollTimer = 0

/** 浏览器自己的时区。新触发器默认落在这儿——人写「九点」写的是眼前的九点。 */
function rtBrowserTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function rtFind(id) {
  return (state.routines || []).find((r) => r.id === id) || null
}

/** 当前打开的那条。列表里那份是权威，详情只是多带了运行记录。 */
function routineOpenRow() {
  return state.routineOpen ? rtFind(state.routineOpen) : null
}

const RT_CLOCK = ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2']
const RT_TRASH = ['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13h10l1-13']
const RT_CHECK = ['m5 13 4 4L19 7']
const RT_BANG = ['M12 8v5', 'M12 16h.01', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z']

const RT_WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const RT_WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * 触发器 → 一行人话。
 *
 * 时区**只有和浏览器不一样时才写出来**。一样的时候写出来是纯噪音，而不一样的时候
 * 不写出来，人会照着自己的表等一个永远不来的九点。
 */
function rtScheduleText(trigger) {
  if (!trigger || trigger.kind !== 'schedule') return ''
  const en = localeMode === 'en'
  const at = trigger.at || '09:00'
  const mm = at.slice(3)
  let body
  if (trigger.every === 'hour') body = en ? `Every hour at :${mm}` : `每小时的第 ${Number(mm)} 分`
  else if (trigger.every === 'day') body = en ? `Every day at ${at}` : `每天 ${at}`
  else if (trigger.every === 'week') {
    body = en ? `Every ${RT_WEEKDAYS_EN[trigger.weekday] || 'Monday'} at ${at}` : `每${RT_WEEKDAYS[trigger.weekday] || '周一'} ${at}`
  } else body = en ? `Day ${trigger.day} of each month at ${at}` : `每月 ${trigger.day} 号 ${at}`
  const tz = trigger.tz || ''
  return tz && tz !== rtBrowserTz() ? `${body}（${tz}）` : body
}

/** 一条任务在列表里那行小字：几个触发器就串几段，一个都没有就说清楚它不会自己跑。 */
function rtWhenText(routine) {
  const list = routine.triggers || []
  if (!list.length) return t('还没有设定时间')
  return list.map(rtScheduleText).filter(Boolean).join('，')
}

/** 运行记录那一行的时间。按触发器的时区显示，和上面那行「每天 21:00」对得上。 */
function rtRunTime(ms, tz) {
  if (!ms) return '—'
  const zone = tz || rtBrowserTz()
  const loc = localeMode === 'en' ? 'en-US' : 'zh-CN'
  const clock = new Intl.DateTimeFormat(loc, { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
  const dayOf = (x) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(x))
  const today = dayOf(Date.now())
  const day = dayOf(ms)
  if (day === today) return `${t('今天')} ${clock}`
  if (day === dayOf(Date.now() - 86400000)) return `${t('昨天')} ${clock}`
  return `${day.slice(5)} ${clock}`
}

/** 这条任务的时区：按第一个触发器算。没有触发器时就是浏览器自己的。 */
function rtTzOf(routine) {
  const first = (routine && routine.triggers && routine.triggers[0]) || null
  return (first && first.tz) || rtBrowserTz()
}

// ── 右栏里的那一列 ────────────────────────────────────────────────────

function routineListPanel() {
  const rows = state.routines || []
  /**
   * 出错的话就画在这一列自己头上。
   *
   * **不能用 flash()**：那条提示条是各页 `.gw-page` 自己调 `flashes()` 画出来的，而
   * 对话页整页都没有它——在这儿 flash 一句，等于什么都没说。
   */
  const head = `<div class="sw-rt-head">
    <h3>${t('日常任务')}</h3>
    <button type="button" class="btn btn-ghost btn-icon" data-act="routine-new"
      aria-label="${esc(t('新建日常任务'))}" title="${esc(t('新建日常任务'))}">${svg(PLUS_ICON, 16)}</button>
  </div>${state.routineError ? `<div class="gw-flash gw-flash-err" style="margin: 0;">${esc(state.routineError)}</div>` : ''}`
  if (!rows.length) {
    return `<div class="sw-rt">${head}
      <div class="sw-rt-empty">
        <p>${t('日常任务是这个 Bot 按时自己去做的事。')}</p>
        <button type="button" class="btn btn-secondary" data-act="routine-new">${t('新建日常任务')}</button>
      </div>
    </div>`
  }
  return `<div class="sw-rt">${head}
    <ul class="sw-rt-list">${rows.map(routineRow).join('')}</ul>
  </div>`
}

/**
 * 列表里的一行。**左边那个圈说的是「上一次跑得怎么样」**，不是「现在是什么状态」——
 * 定时任务真正会出事的是「昨晚静静地失败了」，而那件事只有这里说得出来。
 */
function routineRow(routine) {
  const last = routine.lastRun
  const running = last && last.status === 'running'
  const bad = last && last.status === 'error'
  const state_ = !routine.active ? 'off' : running ? 'run' : bad ? 'err' : 'ok'
  const name = routine.name || t('未命名任务')
  return `<li><button type="button" class="sw-rt-row" data-act="routine-open" data-id="${esc(routine.id)}">
    <span class="sw-rt-ico" data-state="${state_}">${svg(bad ? RT_BANG : RT_CLOCK, 16)}</span>
    <span class="sw-rt-text">
      <b>${esc(name)}</b>
      <em>${esc(routine.active ? rtWhenText(routine) : t('已停用'))}</em>
    </span>
  </button></li>`
}

// ── 点进去那一屏 ──────────────────────────────────────────────────────

function routineDetailPanel() {
  const routine = routineOpenRow()
  if (!routine) return ''
  const runs = state.routineRuns || []
  const running = runs.some((r) => r.status === 'running')
  const canRun = Boolean((routine.instruction || '').trim()) && !running
  return `<div class="sw-rt-detail">
    <div class="sw-rt-bar">
      <button type="button" class="btn btn-ghost btn-icon" data-act="routine-back"
        aria-label="${esc(t('返回'))}" title="${esc(t('返回'))}">${svg(BACK_ARROW, 16)}</button>
      <span>${t('日常任务')}</span>
    </div>
    ${state.routineError ? `<div class="gw-flash gw-flash-err">${esc(state.routineError)}</div>` : ''}
    <div class="sw-rt-acts">
      <button type="button" class="sw-switch" data-act="routine-toggle" aria-pressed="${routine.active}">
        <i aria-hidden="true"></i><span>${routine.active ? t('已启用') : t('已停用')}</span>
      </button>
      <span class="sw-spacer"></span>
      <button type="button" class="btn btn-secondary" data-act="routine-delete">${t('删除')}</button>
      ${/* 试跑在「指令还空着」和「上一次还在跑」时是灰的。灰着而不是藏起来——人要
            知道这颗按钮存在，也要知道现在为什么按不动（title 里写着）。 */ ''}
      <button type="button" class="btn btn-primary" data-act="routine-test" ${canRun ? '' : 'disabled'}
        title="${esc(running ? t('上一次还在跑') : canRun ? t('立刻跑一次') : t('先写清楚它每次要做什么'))}">
        ${running ? t('跑着…') : t('试跑')}
      </button>
    </div>
    <div class="field">
      <label for="routine-name">${t('名字')}</label>
      <input class="input satu-input" id="routine-name" data-routine-field="name" autocomplete="off"
        placeholder="${esc(t('给这条任务起个名字'))}" value="${esc(routine.name || '')}">
    </div>
    <div class="field">
      <label for="routine-instruction">${t('指令')}</label>
      <textarea class="input sw-rt-area" id="routine-instruction" data-routine-field="instruction" rows="4"
        placeholder="${esc(t('每次跑的时候，它要做什么？'))}">${esc(routine.instruction || '')}</textarea>
    </div>
    <div class="field">
      <label>${t('什么时候跑')}</label>
      <div class="sw-rt-triggers">
        ${(routine.triggers || []).map(routineTriggerRow).join('')}
        <button type="button" class="sw-rt-add" data-act="routine-trigger-add">${svg(PLUS_ICON, 14)}${t('添加时间')}</button>
      </div>
      ${routine.active && routine.nextRunAt ? `<p class="sw-rt-next">${t('下一次')} ${esc(rtRunTime(routine.nextRunAt, rtTzOf(routine)))}</p>` : ''}
      ${routineRetryLine(routine)}
    </div>
    ${routineModelField(routine)}
    <div class="field">
      <label>${t('运行记录')}</label>
      ${runs.length ? `<ul class="sw-rt-runs">${runs.map((r) => routineRunRow(r, routine)).join('')}</ul>` : `<p class="sw-rt-none">${t('还没跑过')}</p>`}
    </div>
  </div>`
}

/**
 * 用哪个模型跑。**默认是日常模型**，和人自己问它时同一个——人交代一件到点去做的事，
 * 期待的是和当面问一样的水平；定时任务跑出来的东西又比聊天更少有人当场复核。
 *
 * 这一档写的是「和聊天一样」而不是模型名：它的意思正是**不覆盖**——人在对话框里给这颗
 * Bot 换过日常模型的话，定时任务跟着换过之后的那个（见 Gateway 的 RoutineModelRole）。
 * utility 那一档要把「省 token」写明：每天都跑的简单活，拨过去能省下一大笔。
 */
function routineModelField(routine) {
  const role = routine.modelRole === 'utility' ? 'utility' : 'daily'
  const opt = (v, label) => `<option value="${v}" ${role === v ? 'selected' : ''}>${esc(label)}</option>`
  return `<div class="field">
    <label for="routine-model">${t('用哪个模型')}</label>
    <select class="input" id="routine-model" data-routine-field="modelRole">
      ${opt('daily', t('日常模型（和聊天时一样）'))}${opt('utility', t('Utility 模型（省 token）'))}
    </select>
    <p class="sw-rt-none">${
      role === 'utility'
        ? t('它自己跑的时候没人在等，用便宜的那一档。要它做难一点的活，换成日常模型。')
        : t('和你自己问它时用的是同一个模型。每天都跑的简单活，换成 utility 能省不少。')
    }</p>
  </div>`
}

/**
 * 一个触发器一行，就地可改。
 *
 * 没有「编辑」这一步：这一行本身就是编辑器。定时时间是**改的次数远多于建的次数**的
 * 东西，多一次点击进编辑态，就等于每次调时间都要多点一下。
 */
function routineTriggerRow(trigger, i) {
  const every = trigger.every || 'day'
  const opt = (v, label) => `<option value="${v}" ${every === v ? 'selected' : ''}>${esc(label)}</option>`
  const weekOpts = RT_WEEKDAYS.map(
    (zh, n) => `<option value="${n}" ${Number(trigger.weekday) === n ? 'selected' : ''}>${esc(localeMode === 'en' ? RT_WEEKDAYS_EN[n] : zh)}</option>`,
  ).join('')
  const dayOpts = Array.from({ length: 31 }, (_, n) => n + 1)
    .map((d) => `<option value="${d}" ${Number(trigger.day) === d ? 'selected' : ''}>${d}</option>`)
    .join('')
  return `<div class="sw-rt-trigger" data-i="${i}">
    <span class="sw-rt-ico" data-state="ok">${svg(RT_CLOCK, 15)}</span>
    <select class="sw-rt-sel" data-routine-trigger="every" data-i="${i}" aria-label="${esc(t('多久一次'))}">
      ${opt('hour', t('每小时'))}${opt('day', t('每天'))}${opt('week', t('每周'))}${opt('month', t('每月'))}
    </select>
    ${every === 'week' ? `<select class="sw-rt-sel" data-routine-trigger="weekday" data-i="${i}" aria-label="${esc(t('周几'))}">${weekOpts}</select>` : ''}
    ${every === 'month' ? `<select class="sw-rt-sel" data-routine-trigger="day" data-i="${i}" aria-label="${esc(t('几号'))}">${dayOpts}</select>` : ''}
    ${/* 每小时那一档只用得上分钟。给一个 time 框却只认后半截，比给一个分钟框更让人费解。 */ ''}
    ${
      every === 'hour'
        ? `<span class="sw-rt-minute">:<input class="sw-rt-num" type="number" min="0" max="59" data-routine-trigger="minute" data-i="${i}"
            value="${esc(String(Number((trigger.at || '09:00').slice(3))))}" aria-label="${esc(t('第几分'))}"></span>`
        : `<input class="sw-rt-time" type="time" data-routine-trigger="at" data-i="${i}" value="${esc(trigger.at || '09:00')}" aria-label="${esc(t('几点'))}">`
    }
    <button type="button" class="btn btn-ghost btn-icon sw-rt-del" data-act="routine-trigger-drop" data-i="${i}"
      aria-label="${esc(t('删掉这个时间'))}" title="${esc(t('删掉这个时间'))}">${svg(RT_TRASH, 15)}</button>
  </div>`
}

/**
 * 「上一次砸了，等会儿自己再试一次」。
 *
 * **要写出来。** 不写的话，屏上只有一条红的运行记录，人看到的是「今天这件事没做成」，
 * 于是他自己去点试跑——而十分钟后那次补跑照样会跑，同一件事做了两遍。写第几次也是
 * 同一个道理：他要判断的是「等它自己好」还是「现在就去看一眼」，而那取决于还剩几次。
 *
 * 补跑排着的那几分钟里这一栏**不轮询**（见 routinePollWant：只有真的有一轮在跑时才
 * 转）。等五分钟每四秒问一次，为的是把一行字提前几秒换掉，不值当；人回头刷新、或者
 * 补跑真的跑起来之后再看到，都不晚。
 */
function routineRetryLine(routine) {
  if (!routine.active || !routine.retryAt) return ''
  return `<p class="sw-rt-next">${esc(
    t('上一次没跑成，%s 再试一次（第 %n 次，共 %m 次）')
      .replace('%s', rtRunTime(routine.retryAt, rtTzOf(routine)))
      .replace('%n', String(routine.retryCount || 1))
      .replace('%m', String(routine.retryMax || 3)),
  )}</p>`
}

function routineRunRow(run, routine) {
  const tz = rtTzOf(routine)
  // 还在跑的分两种：登记了、机器还没来领（试跑刚点下去的那半分钟），和真的在跑。
  // 前者没有会话 id——工人领走、问到会话之后才有。
  const label = run.status === 'running' ? (run.sessionId ? t('正在跑…') : t('等机器来领…')) : rtRunTime(run.startedAt, tz)
  /**
   * 「试跑」和「重试」各挂各的牌子。
   *
   * 补跑不标出来的话，一条**每天都要补一次才成**的任务，在这一列上就是一串正常的
   * 绿勾——而它其实每天都在第一跳上摔一次。
   */
  const manual = run.trigger === 'manual' ? `<span class="sw-rt-tag">${t('试跑')}</span>` : ''
  const retried = run.trigger === 'retry' ? `<span class="sw-rt-tag">${t('重试')}</span>` : ''
  const mark =
    run.status === 'running'
      ? `<span class="sw-rt-spin" aria-hidden="true"></span>`
      : run.status === 'ok'
      ? `<span class="sw-rt-ok">${svg(RT_CHECK, 15)}</span>`
      : `<span class="sw-rt-bad" title="${esc(run.error || t('失败'))}">${svg(RT_BANG, 15)}</span>`
  return `<li class="sw-rt-run">
    <span class="sw-rt-runtime">${esc(label)}</span>${manual}${retried}
    <span class="sw-spacer"></span>${mark}
  </li>`
}

// ── 数据 ──────────────────────────────────────────────────────────────

/**
 * 拉这颗 Bot 的日常任务。**换 Bot 时先清空**：上一颗的那几条留在屏上，会让人对着
 * 别的 Bot 的任务点「试跑」。
 */
async function loadRoutines(botId) {
  if (!botId) {
    state.routines = []
    state.routinesBotId = ''
    state.routineOpen = ''
    state.routineRuns = []
    state.routineError = ''
    return
  }
  if (state.routinesBotId !== botId) {
    state.routines = []
    state.routineOpen = ''
    state.routineRuns = []
    state.routineError = ''
    state.routinesBotId = botId
  }
  try {
    const r = await api('GET', '/runtime/bots/' + encodeURIComponent(botId) + '/routines')
    // 拉的过程里人切走了：这一份已经不作数。
    if (state.routinesBotId !== botId) return
    state.routines = r.routines || []
  } catch {
    // 席位没上线、目录没这颗 Bot——右栏那一列不出现就是了，不该弹一条报错。
    state.routines = []
  }
  render()
  // 刚进页面时可能正好有一轮在跑（别的标签页点的，或者到点自己跑起来的）。
  syncRoutinePoll()
}

async function openRoutine(id) {
  state.routineOpen = id
  state.routineRuns = []
  state.routineError = ''
  render()
  await refreshRoutine(id)
}

/**
 * 屏上这一栏此刻长什么样。轮询回来的一份和它一模一样，就**一下都不用重画**。
 *
 * 这不是省几毫秒的优化。`render()` 是整页重绘（`#app` 的 innerHTML 换掉），而这一栏
 * 挂在**对话页**上：轮询每 4 秒一次、只在有一轮正在跑的时候转，于是「试跑的这几十秒」
 * 恰好是聊天正文每 4 秒被连根拔起重建一次的几十秒——正在流式输出的那段 Markdown 全部
 * 重渲染、图片重新加载、贴底状态（`data-touched` 在被换掉的那个节点上）跟着丢，气泡
 * 下面那行读秒也跟着被拆了重建。人看到的就是「一跑起来整块就开始抖」。
 *
 * 而这几十秒里这一栏其实什么都没变：那一行一直写着「正在跑…」。所以按内容比一下，
 * 没变就不画——**这是修那个抖动的正路**，比在重绘里补各种保位置的补丁都简单。
 */
function routineShot(id) {
  const row = rtFind(id)
  return JSON.stringify({
    e: state.routineError || '',
    r: row
      ? {
          n: row.name,
          i: row.instruction,
          a: row.active,
          m: row.modelRole,
          t: row.triggers || [],
          x: row.nextRunAt,
          // 补跑排上、或者排到了第几次，屏上那句话跟着变——不比这两格就画不出来。
          y: row.retryAt,
          z: row.retryCount,
        }
      : null,
    // 流水只比看得见的那几样。`runs` 整个 JSON 也行，但那一份里还有 sessionId 之类
    // 画不出来的字段，它们一变就白重绘一次。
    u: (state.routineRuns || []).map((x) => [x.id, x.status, x.trigger, x.startedAt, x.error || '']),
  })
}

/**
 * 拉一条的详情（主要是运行记录），顺带把列表里那一行也换成最新的。
 *
 * **`fromPoll` 只有那根 4 秒的定时器会给。** 「没变化就不画」是给轮询准备的（见
 * routineShot），不能对所有调用方生效：`sendRoutinePatch` 存不下去时，是**先写下
 * `state.routineError`、再把重画交给这里**——那时快照里已经带着那句错误，前后自然
 * 相等，于是一下都不画：屏上既没有那条红字，输入框里还留着他刚打的、其实没存下的
 * 内容。人只会以为存好了。
 */
async function refreshRoutine(id, fromPoll = false) {
  const before = routineShot(id)
  try {
    const r = await api('GET', '/runtime/routines/' + encodeURIComponent(id))
    if (state.routineOpen !== id) return
    state.routineRuns = r.runs || []
    replaceRoutine(r.routine)
  } catch (err) {
    if (state.routineOpen === id) state.routineError = err.message
    // 轮询途中被别处删掉了，和保存时撞上删除是同一件事：本地这一份也留不得。
    if (err.status === 404) dropRoutineLocally(id)
  }
  // 轮询：什么都没变就别重画（见 routineShot）。别的调用方一律照画（见函数头）。
  if (!fromPoll || routineShot(id) !== before) render()
  syncRoutinePoll()
}

/** 本地把这一条抹掉（服务端已经没有了）。详情正开着的话一并收回列表形态。 */
function dropRoutineLocally(id) {
  state.routines = (state.routines || []).filter((r) => r.id !== id)
  if (state.routineOpen === id) {
    state.routineOpen = ''
    state.routineRuns = []
  }
}

function replaceRoutine(next) {
  if (!next) return
  const rows = state.routines || []
  const i = rows.findIndex((r) => r.id === next.id)
  if (i >= 0) rows[i] = next
  else rows.push(next)
}

/** 返回列表。**错误也一起清掉**：那句话说的是刚才那一屏上的事，回到列表就过期了。 */
function closeRoutine() {
  state.routineOpen = ''
  state.routineRuns = []
  state.routineError = ''
  syncRoutinePoll()
  render()
}

/**
 * 列表那一份的快照。同 routineShot：轮询回来没变化就一下都不画。
 *
 * **触发器要比内容，不是条数。** 那一行小字画的是 `rtWhenText`，读的是每天几点、
 * 周几、哪个时区；只比条数的话，另一个标签页把「每天 09:00」改成「每天 21:00」，
 * 这边的快照一字未变，屏上就一直停在旧时间上。
 */
function routineListShot() {
  return JSON.stringify(
    (state.routines || []).map((r) => [r.id, r.name, r.active, r.triggers || [], r.nextRunAt, r.lastRun ? r.lastRun.status : '']),
  )
}

/** 静静地把列表拉一遍。列表里那个转着的圈也得有人来停。 */
async function refreshRoutineList() {
  const botId = state.routinesBotId
  if (!botId) return
  const before = routineListShot()
  try {
    const r = await api('GET', '/runtime/bots/' + encodeURIComponent(botId) + '/routines')
    if (state.routinesBotId !== botId) return
    state.routines = r.routines || []
  } catch {
    return
  }
  // 详情关着、只有列表里那颗圈在转的时候，这条路同样是每 4 秒一次的整页重绘。
  if (routineListShot() !== before) render()
  syncRoutinePoll()
}

/**
 * 有一轮在跑就转着刷，没有就停。
 *
 * 「跑完了没有」的真相在 Gateway（它挂着席位的事件流），浏览器这边只能问。定时器
 * **必须在没有 running 的时候停掉**——否则一个开着的标签页会永远每四秒一个请求。
 *
 * 详情关掉了也可能还有一轮在跑（点了试跑就返回）。那时候刷的是列表：不刷的话，那
 * 一行左边的圈会一直停在「正在跑」，直到人重开这一页。
 */
function routinePollWant() {
  // 人走开去别的页面了就别再问：这一列根本没画出来，而每一次问完都会 render()——
  // 那会把他正在填的那张表单按 state 重画一遍。
  if (!onChatPage()) return ''
  if (state.routineOpen) return (state.routineRuns || []).some((r) => r.status === 'running') ? 'detail' : ''
  return (state.routines || []).some((r) => r.lastRun && r.lastRun.status === 'running') ? 'list' : ''
}

function syncRoutinePoll() {
  const want = routinePollWant()
  if (want && !routinePollTimer) {
    routinePollTimer = setInterval(() => {
      const now = routinePollWant()
      if (!now) {
        syncRoutinePoll()
        return
      }
      if (now === 'detail') void refreshRoutine(state.routineOpen, true)
      else void refreshRoutineList()
    }, ROUTINE_POLL_MS)
    return
  }
  if (!want && routinePollTimer) {
    clearInterval(routinePollTimer)
    routinePollTimer = 0
  }
}

async function createRoutine() {
  const botId = state.routinesBotId || chatBotIdNow()
  if (!botId) return
  try {
    // 建出来就带一个「每天 09:00」的时间。空白的任务需要人填两处才开始有意义，
    // 而这一个默认值是最常见的那种，改它比从零填它快。
    const r = await api('POST', '/runtime/bots/' + encodeURIComponent(botId) + '/routines', {
      name: '',
      instruction: '',
      tz: rtBrowserTz(),
      triggers: [{ kind: 'schedule', every: 'day', at: '09:00', weekday: 1, day: 1, tz: rtBrowserTz() }],
    })
    state.routines = [...(state.routines || []), r.routine]
    await openRoutine(r.routine.id)
    // 建完焦点直接落在名字上：新建之后要做的第一件事一定是给它起个名字。
    const input = document.getElementById('routine-name')
    if (input) input.focus()
  } catch (err) {
    state.routineError = err.message
    render()
  }
}

/**
 * 保存排成一条队。
 *
 * 两处保存挨得很近是常事（把「每天」改成「每周」，紧接着调时间）。并发发出去有两个
 * 坏处：响应可能乱序回来，后到的那个旧快照会把新值盖回去；而触发器那一路是**整份
 * 数组一起发**的，第二次的载荷还会是从没改过的那份状态算出来的，第一次的改动直接
 * 丢掉。串起来发就都没有了——代价只是第二次要等第一次回来，而这本来就是人手速。
 */
let routineSave = Promise.resolve()

function patchRoutine(id, patch) {
  // 队尾那个 catch 不能省：链子一旦被一个 rejection 毒掉，后面每一次保存都不会再发出去。
  routineSave = routineSave.then(() => sendRoutinePatch(id, patch)).catch(() => {})
  return routineSave
}

async function sendRoutinePatch(id, patch) {
  try {
    const r = await api('PATCH', '/runtime/routines/' + encodeURIComponent(id), { ...patch, tz: rtBrowserTz() })
    replaceRoutine(r.routine)
    state.routineError = ''
    render()
  } catch (err) {
    state.routineError = err.message
    if (err.status === 404) {
      // 另一处已经把它删了。留着那一屏改不动的表单没有意义——收掉，错误画在列表头上。
      dropRoutineLocally(id)
      syncRoutinePoll()
      render()
      return
    }
    // 本地已经先把改动画上去了（见 editRoutineTrigger），存不进去就得**问一遍服务端
    // 现在到底是什么**，否则屏上留着一份根本没保存成功的时间表。
    if (state.routineOpen === id) await refreshRoutine(id)
    else render()
  }
}

async function deleteRoutineNow(id) {
  try {
    await api('DELETE', '/runtime/routines/' + encodeURIComponent(id))
    state.routines = (state.routines || []).filter((r) => r.id !== id)
    if (state.routineOpen === id) {
      state.routineOpen = ''
      state.routineRuns = []
    }
    state.routineError = ''
    syncRoutinePoll()
  } catch (err) {
    state.routineError = err.message
  }
  render()
}

async function testRunRoutine(id) {
  try {
    const r = await api('POST', '/runtime/routines/' + encodeURIComponent(id) + '/run', {})
    state.routineRuns = [r.run, ...(state.routineRuns || [])]
    // 列表里那一行也要当场知道「这条正在跑」：人点完试跑就返回是常事，而返回之后
    // 该不该继续轮询，看的正是这个字段。
    const row = rtFind(id)
    if (row) row.lastRun = r.run
    state.routineError = ''
    syncRoutinePoll()
    render()
  } catch (err) {
    state.routineError = err.message
    render()
  }
}

/**
 * 改一个触发器的某一项。整份 triggers 一起发——它在库里就是一个整体。
 *
 * **改完先落回本地 state，再发出去。** 不落的话，紧接着的第二次修改是从「改之前」那
 * 份数组算出来的，先改的那一处会被后发的整份数组盖掉（配合 patchRoutine 的串行队列）。
 */
function editRoutineTrigger(id, i, key, value) {
  const routine = rtFind(id)
  if (!routine) return
  const list = (routine.triggers || []).map((x) => ({ ...x }))
  const trigger = list[i]
  if (!trigger) return
  if (key === 'minute') {
    const m = Math.min(59, Math.max(0, Math.trunc(Number(value) || 0)))
    trigger.at = `${(trigger.at || '09:00').slice(0, 2)}:${String(m).padStart(2, '0')}`
  } else if (key === 'at') {
    trigger.at = /^\d{2}:\d{2}$/.test(String(value)) ? String(value) : trigger.at
  } else if (key === 'every') {
    trigger.every = value
  } else {
    trigger[key] = Math.trunc(Number(value) || 0)
  }
  // 时区跟着改它的人走：把「每天九点」从上海挪到伦敦的那个人，要的是他现在的九点。
  trigger.tz = rtBrowserTz()
  routine.triggers = list
  void patchRoutine(id, { triggers: list })
}

function addRoutineTrigger(id) {
  const routine = rtFind(id)
  if (!routine) return
  const list = [...(routine.triggers || []), { kind: 'schedule', every: 'day', at: '09:00', weekday: 1, day: 1, tz: rtBrowserTz() }]
  routine.triggers = list
  // 同 dropRoutineTrigger：新行立刻出来，下标也当场对齐。
  render()
  void patchRoutine(id, { triggers: list })
}

function dropRoutineTrigger(id, i) {
  const routine = rtFind(id)
  if (!routine) return
  const list = (routine.triggers || []).filter((_, n) => n !== i)
  routine.triggers = list
  /**
   * **就地重画，不等 PATCH 回来。**
   *
   * 行是按下标认的（`data-i`），而本地这个数组已经短了一截——重画排在 PATCH 之后的话，
   * 那一整个来回里屏幕上还是旧的几行、带着旧的下标：连点两下同一个垃圾桶，第二下按
   * `i` 删的是**另一条**；删掉第一条之后马上去改剩下某一行的时间，写进去的也是错的
   * 那一条（`editRoutineTrigger` 同样按 `list[data-i]` 取）。
   *
   * 顺带把「点了没反应」也治了：这一下之后行立刻消失，不用等一个来回。
   */
  render()
  void patchRoutine(id, { triggers: list })
}

/**
 * 右栏里的动作。和连接器那一屏一样单独收（见 pages-connectors.js 的 connectorAct）——
 * app.js 那条 if 链已经六百多行，再往上堆只会让下一个人更难找。
 *
 * 返回 true 表示这一下已经处理掉了。
 */
async function routineAct(act, btn) {
  if (act === 'routine-new') {
    await createRoutine()
    return true
  }
  if (act === 'routine-open') {
    await openRoutine(btn.getAttribute('data-id') || '')
    return true
  }
  if (act === 'routine-back') {
    closeRoutine()
    return true
  }
  if (act === 'routine-toggle') {
    const routine = routineOpenRow()
    if (routine) await patchRoutine(routine.id, { active: !routine.active })
    return true
  }
  if (act === 'routine-test') {
    if (state.routineOpen) await testRunRoutine(state.routineOpen)
    return true
  }
  if (act === 'routine-delete') {
    const routine = routineOpenRow()
    if (!routine) return true
    state.confirm = {
      title: '删掉这条日常任务？',
      body: t(
        `「${routine.name || t('未命名任务')}」不会再自己跑了，运行记录也一起没了。已经发出去的那几轮对话留在聊天里。`,
        `"${routine.name || 'Untitled'}" stops running on its own and its run history goes away. Conversations it already started stay in the chat.`,
      ),
      label: '删除',
      kind: 'routine-delete',
      id: routine.id,
    }
    render()
    return true
  }
  if (act === 'routine-trigger-add') {
    if (state.routineOpen) addRoutineTrigger(state.routineOpen)
    return true
  }
  if (act === 'routine-trigger-drop') {
    if (state.routineOpen) dropRoutineTrigger(state.routineOpen, Number(btn.getAttribute('data-i')))
    return true
  }
  return false
}
