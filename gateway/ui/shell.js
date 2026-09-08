/** 外壳：登录页、初始化页、侧栏导航、Bot 名单。进得了门之前只有这些。 */
function mark(text, alt) {
  const style = alt
    ? 'background: var(--color-accent-2-100); color: var(--color-accent-2-800);'
    : 'background: var(--color-accent-100); color: var(--color-accent-800);'
  return `<span class="satu-providermark" style="${style}">${esc(String(text || '?').slice(0, 2).toUpperCase())}</span>`
}

/**
 * 登录、创建管理员、接受邀请这三屏共用的左半边。
 *
 * 只有中间那两句文案随屏变，其余（底纹、logo、题图、页脚）三屏一模一样——所以文案
 * 走参数，版式留在这一个地方。加入邀请页原先自己抄了一份，改一次 logo 要改两处。
 */
function authAside(
  title = t('Satuwork 控制面。按账号角色进入系统控制台或公司后台。'),
  sub = t('日常任务模型和 utility 模型由系统管理员配置。供应商密钥保存后不会回显，也不会下发到 Bot。'),
) {
  return `
    <div class="satu-authside">
      <div style="position: absolute; top: -60px; right: -60px; width: 220px; height: 220px; border-radius: 50%; background: var(--color-accent-2-200); opacity: 0.6;"></div>
      <div style="position: relative; display: flex; align-items: center; gap: var(--space-2);">
        <img src="/assets/satuwork-logo.png" alt="Satuwork" style="width: 34px; height: 34px; border-radius: 999px;">
        <span style="font-family: var(--font-heading); font-size: 20px;">Satuwork</span>
      </div>
      <div style="position: relative; display: flex; flex-direction: column; gap: var(--space-4); max-width: 440px;">
        <div style="width: 100%; aspect-ratio: 4/3; border-radius: var(--radius-lg); overflow: hidden; box-shadow: var(--shadow-lg);">
          <img src="/assets/login-hero.png" alt="" style="width: 100%; height: 100%; object-fit: cover;">
        </div>
        <p style="font-family: var(--font-heading); font-size: 26px; line-height: 1.2; margin: 0;">${title}</p>
        <p style="margin: 0; color: color-mix(in srgb, var(--color-text) 65%, transparent); font-size: 14px; line-height: 1.6;">${sub}</p>
      </div>
      <div style="position: relative; display: flex; gap: var(--space-4); font-size: 12px; color: color-mix(in srgb, var(--color-text) 55%, transparent);">
        <span>© 2026 Satuwork</span>
      </div>
    </div>`
}

/**
 * 系统里一个 owner 都没有时的第一屏。
 *
 * 不是登录页上的一个链接——没有管理员时登录页没有任何可用的入口，让人对着一个
 * 永远填不对的表单猜，不如直接把该做的事摆出来。建完当场就是登录态。
 */
function setupView() {
  return `
  <div class="gw-login">
    ${authAside()}
    <div style="position: relative; display: flex; align-items: center; justify-content: center; padding: var(--space-8);">
      <div style="width: 100%; max-width: 400px; display: flex; flex-direction: column; gap: var(--space-6);">
        <div>
          <h1 style="font-size: 30px; margin: 0 0 var(--space-2);">${t('创建系统管理员')}</h1>
          <p style="margin: 0; color: color-mix(in srgb, var(--color-text) 60%, transparent); font-size: 14px;">${t('这台 Gateway 还没有系统管理员。第一个账号由你在这里创建，之后这一屏不会再出现。')}</p>
        </div>
        ${state.setupError ? `<div class="gw-flash gw-flash-err">${esc(state.setupError)}</div>` : ''}
        <form id="setup-form" style="display: flex; flex-direction: column; gap: var(--space-4);">
          <div class="field">
            <label for="setup-email">${t('邮箱')}</label>
            <input class="input satu-input" id="setup-email" name="email" type="email" autocomplete="username" placeholder="you@company.com" value="${esc(state.setupEmail)}" required>
          </div>
          <div class="field">
            <label for="setup-name">${t('姓名')}<span style="color: var(--muted-foreground); font-weight: 400;">${t('（可留空）')}</span></label>
            <input class="input satu-input" id="setup-name" name="name" type="text" autocomplete="name" placeholder="${esc(t('张三'))}" value="${esc(state.setupName)}">
          </div>
          <div class="field">
            <label for="setup-pw">${t('口令')}</label>
            <input class="input satu-input" id="setup-pw" name="password" type="password" autocomplete="new-password" placeholder="${esc(t('至少 10 位'))}" required minlength="10">
          </div>
          <div class="field">
            <label for="setup-pw2">${t('再输一遍')}</label>
            <input class="input satu-input" id="setup-pw2" name="confirm" type="password" autocomplete="new-password" placeholder="${esc(t('再输一遍口令'))}" required minlength="10">
          </div>
          <button type="submit" class="btn btn-primary btn-block" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? t('创建中…') : t('创建并进入')}
            ${state.busy ? '' : svg(['M5 12h14', 'm12 5 7 7-7 7'], 14)}
          </button>
        </form>
        <p style="text-align: center; margin: 0; font-size: 14px; color: color-mix(in srgb, var(--color-text) 60%, transparent);">${t('系统管理员不属于任何公司，负责分配席位、配置模型和供应商密钥。')}</p>
      </div>
    </div>
  </div>`
}

function loginView() {
  return `
  <div class="gw-login">
    ${authAside()}
    <div style="position: relative; display: flex; align-items: center; justify-content: center; padding: var(--space-8);">
      <div style="width: 100%; max-width: 400px; display: flex; flex-direction: column; gap: var(--space-6);">
        <div>
          <h1 style="font-size: 30px; margin: 0 0 var(--space-2);">${t('登录 Satuwork')}</h1>
          <p style="margin: 0; color: color-mix(in srgb, var(--color-text) 60%, transparent); font-size: 14px;">${t('进入控制台，管理你的 AI 员工')}</p>
        </div>
        ${state.loginError ? `<div class="gw-flash gw-flash-err">${esc(state.loginError)}</div>` : ''}
        <form id="login-form" style="display: flex; flex-direction: column; gap: var(--space-4);">
          <div class="field">
            <label for="login-email">${t('邮箱')}</label>
            <input class="input satu-input" id="login-email" name="email" type="email" autocomplete="username" placeholder="you@company.com" value="${esc(state.loginEmail)}" required>
          </div>
          <div class="field">
            <div style="display: flex; justify-content: space-between; align-items: baseline;">
              <label for="login-pw" style="margin: 0;">${t('口令')}</label>
              <span style="font-size: 12px; color: var(--muted-foreground);">${t('忘记口令？联系管理员')}</span>
            </div>
            <input class="input satu-input" id="login-pw" name="password" type="password" autocomplete="current-password" placeholder="${esc(t('输入口令'))}" required>
          </div>
          <button type="submit" class="btn btn-primary btn-block" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? t('登录中…') : t('登录')}
            ${state.busy ? '' : svg(['M5 12h14', 'm12 5 7 7-7 7'], 14)}
          </button>
        </form>
        <p style="text-align: center; margin: 0; font-size: 14px; color: color-mix(in srgb, var(--color-text) 60%, transparent);">${t('还没有账号？联系管理员开通。')}</p>
      </div>
    </div>
  </div>`
}

/**
 * 二级页面算在哪一条菜单项底下。
 *
 * 一般就是地址前缀：`/machines/xxx` 属于「机器管理」。**只有自己那个 Bot 是例外**
 * ——`/bots` 在公司这一侧是「Bot 模版」，一份全公司共用的底座；从对话里点「Bot 设置」
 * 进来的却是我自己那个 Bot，两件事只是碰巧同一段前缀。让模版那一条亮起来，等于告诉人
 * 「你正在改全公司的底座」，而员工那边根本没有这条菜单，也就没人这么误会过。
 */
function navUnder(item) {
  if (item.href === '/' || !state.path.startsWith(item.href + '/')) return false
  if (item.href === '/bots' && ownBotPath(state.path)) return false
  return true
}

function navItem(item) {
  const current =
    state.path === item.href ||
    navUnder(item) ||
    (item.href === '/chat' && state.path.startsWith('/a/')) ||
    (item.href === '/' && memberChatHome() && state.path.startsWith('/a/'))
  return `<button type="button" class="satu-nav" data-act="go" data-href="${esc(item.href)}" aria-current="${current}">
    ${svg(ICONS[item.icon])}
    <span class="satu-label">${esc(t(item.label))}</span>
  </button>`
}

/**
 * 「对话」下面挂着的 Bot 名册。
 *
 * 挪到主导航里，是因为它本来就是**在一群人之间切换**——和左边那些页面入口是同一种
 * 动作，没理由在内容区里再占一栏。名册进来之后对话页只剩两栏：正文和运行环境。
 *
 * 只在对话相关的页面上展开：别的页面挂一串 Bot 是噪音。
 */
/**
 * 侧栏顶层的 Bot 名单。
 *
 * **不再挂在「对话」下面。** 这些 Bot 就是这个产品的主体——一个人管着几个 AI 员工，
 * 天天要看的是「谁在干活、谁刚回了话」。把它们藏在一个还要先点开的导航项里，等于
 * 把主角放进抽屉。所以提到顶层，做成聊天列表的样子：头像、名字、最近回复的时间、
 * 一行摘要，正在跑的转圈。
 *
 * 时间和摘要留空位不留内容：它们来自各自的事件流，每帧都在变（见 paintRoster），
 * 靠重绘整页去更新的话，一边打字一边就把侧栏刷没了。
 */
/** 这一颗此刻在装吗。名单和 paintRoster 两处都要问，判据只能有一份。 */
function installingOf(bot) {
  return Boolean(bot && bot.runtime && bot.runtime.status === 'deploying')
}

function chatRosterNav() {
  const bots = state.runtimeBots || []
  if (!bots.length) return ''
  /**
   * **只有真的在对话页上，名单里才有「选中的那一行」。**
   *
   * `state.chatBotId` 是「上一次聊的是谁」，切到 Bot 配置、账单这些页面之后它照样留
   * 着——光看它的话，名单上那一行会一直亮着，和当前页面的菜单项一起构成两处高亮，
   * 而左栏同一时刻只该有一个「你在这儿」。
   *
   * 用 onChatPage() 而不是自己再判一次路径：顶栏换不换成会话身份行、右栏开不开，用
   * 的都是它，三处共用一个判断才不会各自漂移。
   */
  const selected = onChatPage() ? chatBotIdOf(state.path) || state.chatBotId : ''
  return bots
    .map((b) => {
      const sum = (botStreams.get(b.id) || {}).sum || { state: 'idle', lastAt: 0, lastText: '' }
      return `<button type="button" class="satu-botrow" data-act="chat-open" data-id="${esc(b.id)}" data-bot-row="${esc(b.id)}" aria-current="${b.id === selected}">
        ${/* 头像占满两行：名字和摘要并排在它右边，整行才像一条会话，而不是一个
             带小图标的菜单项。34 是 botAvatar 的默认尺寸，也正好等于两行的高度。 */ ''}
        <span class="satu-botavatar">${botAvatar(b.icon, 34, b.origin)}</span>
        <span class="satu-botmain">
          <span class="satu-botline">
            ${/* 状态点在名字**前面**：一列对齐的点，扫一眼就知道哪几个在动，
                 不用把视线甩到行尾去找。 */ ''}
            <span class="satu-botdot" data-state="${sum.state}" title="${esc(botStateLabel(sum.state))}" aria-label="${esc(botStateLabel(sum.state))}"></span>
            <span class="satu-botname">${esc(b.name || b.id)}${b.runtimeKind === 'local' ? ` <span class="satu-localtag" data-compact>${t('本地', 'Local')}</span>` : ''}</span>
            ${/* 「有事等你」的图标。一颗 8px 的点在一列名字里太容易滑过去，而这一格说的
                 是「你不点它就一直停在那儿」——确认那一路是真的有一轮停在席位上等着。 */ ''}
            <span class="satu-botneed" data-need="${esc(sum.need || '')}" title="${esc(botNeedLabel(sum.need))}" aria-label="${esc(
              botNeedLabel(sum.need),
            )}"${sum.need ? '' : ' hidden'}>${botNeedIcon(sum.need)}</span>
            <time class="satu-bottime">${esc(sum.lastAt ? chatClock(sum.lastAt) : '')}</time>
          </span>
          ${/* 没有消息就不留这一行——空着一道灰边比少一行更碍眼。
               正在装的那一颗**借这一行说话**：建完 Bot 之后人完全可能先去点别的 Bot，
               回来时名单上得看得出它还在装，而不是和一颗没消息的旧 Bot 长得一模一样。 */ ''}
          <span class="satu-botsnip"${installingOf(b) || sum.lastText ? '' : ' hidden'}>${esc(installingOf(b) ? t('正在安装…', 'Installing…') : sum.lastText)}</span>
        </span>
      </button>`
    })
    .join('')
}

let rosterPaintQueued = false

/** 名单每帧都可能变（时间、摘要、转圈），跟正文一样合并到一帧里画。 */
function scheduleRosterPaint() {
  if (rosterPaintQueued) return
  rosterPaintQueued = true
  const run = () => {
    rosterPaintQueued = false
    paintRoster()
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else setTimeout(run, 16)
}

function botStateLabel(state) {
  if (state === 'busy') return t('正在执行')
  if (state === 'review') return t('待人工处理')
  return t('空闲')
}

/**
 * 名单上那个「有事等你」的图标，说给人听。
 *
 * **和那颗点分开说**：点答的是「这一颗现在什么状态」，这个图标答的是「你得去点一下」
 * ——而这两件事人要做的动作完全不同，混成一个琥珀点的话，人还得点进去才知道是要拍板
 * 还是要接手。
 */
function botNeedLabel(need) {
  if (need === 'approval') return t('在等你拍板', 'Waiting for your approval')
  if (need === 'handoff') return t('在等人接手', 'Waiting to be picked up')
  return ''
}

/** 拍板用盾牌（和确认卡上那张同一个），接手用那只举起来的手（和顶栏那颗同一个）。 */
function botNeedIcon(need) {
  if (need === 'approval') return ICON_SHIELD
  if (need === 'handoff') return svg(ICON_HANDOFF, 13)
  return ''
}

/** 就地更新名单的状态点/时间/摘要。不重绘整页——那会把正在打字的输入框一起换掉。 */
function paintRoster() {
  for (const row of document.querySelectorAll('[data-bot-row]')) {
    const id = row.getAttribute('data-bot-row')
    /**
     * 正在装的那一颗，这一行由名单自己写死（「正在安装…」），**这里不许覆盖**。
     *
     * 席位还没起来，它那条流开不起来，摘要永远是空的——照常走下去就是把那句话擦掉，
     * 于是名单上它和一颗没消息的旧 Bot 一模一样，而它此刻恰恰是最需要说明的那一个。
     */
    if (installingOf((state.runtimeBots || []).find((b) => b.id === id))) continue
    const sum = (botStreams.get(id) || {}).sum
    if (!sum) continue
    const dot = row.querySelector('.satu-botdot')
    if (dot && dot.getAttribute('data-state') !== sum.state) {
      dot.setAttribute('data-state', sum.state)
      dot.title = botStateLabel(sum.state)
      dot.setAttribute('aria-label', botStateLabel(sum.state))
    }
    const need = row.querySelector('.satu-botneed')
    if (need && need.getAttribute('data-need') !== (sum.need || '')) {
      const label = botNeedLabel(sum.need)
      need.setAttribute('data-need', sum.need || '')
      need.innerHTML = botNeedIcon(sum.need)
      need.hidden = !sum.need
      need.title = label
      need.setAttribute('aria-label', label)
    }
    const time = row.querySelector('.satu-bottime')
    if (time) time.textContent = sum.lastAt ? chatClock(sum.lastAt) : ''
    const snip = row.querySelector('.satu-botsnip')
    if (snip) {
      snip.textContent = sum.lastText
      snip.hidden = !sum.lastText
    }
  }
  /**
   * 顶栏那个数里有「等你拍板」这一项，而它随事件走（见 needCount）。名单本来就每帧
   * 都画，顺手把它对一遍——为它另开一条定时器的话，那个数会比名单上的图标慢几秒，
   * 而两者说的是同一件事。
   */
  paintHandoffBadge()
  repaintAskPanel()
}

/**
 * 一条提示条。红的、蓝的，还有对话页上「已压缩」「已开始新对话」那两句，走的都是
 * 这一个壳——它们是同一种东西（刚刚那一下的回执），就该长同一个样、同一处消失。
 *
 * `data-flash` 是给 dismissFlash 认的：撤的时候就地摘节点，不重绘整页。
 */
function flashRow(kind, text) {
  return `<div class="gw-flash gw-flash-${kind}" data-flash>
    <span class="gw-flash-text">${esc(text)}</span>
    <button type="button" class="gw-flash-x" data-act="flash-close" aria-label="${esc(t('关闭'))}">${svg(['M18 6 6 18', 'M6 6l12 12'], 14)}</button>
  </div>`
}

function flashes() {
  return `${state.error ? flashRow('err', state.error) : ''}
    ${state.notice ? flashRow('ok', state.notice) : ''}`
}

/**
 * 一页放多少条。
 *
 * 这几张表的行高在 56px 上下，20 条正好是一屏多一点——翻页的人一眼能看完一页，
 * 又不至于两条就要点一次「下一页」。
 */
const LIST_PAGE_SIZE = 20

/**
 * 把一份列表切成当前这一页。
 *
 * 切的是**前端已经拿到的整份数据**，不是接口分页：这几张表（公司、用户、机器、发布
 * 包）都是一次拉齐的，机器那条接口的汇总数字更是按全量算的（见 /platform/machines）。
 * 改成接口分页，汇总和筛选计数就得跟着一起改口径——而这几张表本来就是几十上百条的
 * 量级，问题从来不在「拉不动」，在「一屏塞不下、找不着」。
 *
 * 页码不写回 state：数据变少了（筛掉一批、删了几条）就地夹到最后一页，人看到的是
 * 有内容的一页，而不是一片空白加一个「第 7 页」。
 */
function pageSlice(key, rows) {
  const all = Array.isArray(rows) ? rows : []
  const pages = Math.max(1, Math.ceil(all.length / LIST_PAGE_SIZE))
  const page = Math.min(Math.max(1, Number(state.listPage?.[key]) || 1), pages)
  const from = (page - 1) * LIST_PAGE_SIZE
  return { rows: all.slice(from, from + LIST_PAGE_SIZE), page, pages, total: all.length, from }
}

/**
 * 列表底下那一条：一共多少条、这是第几页、往前往后。
 *
 * **总数一直在**，哪怕只有一页——「一共 7 家公司」本身就是这一屏要回答的问题之一，
 * 而翻页的两颗只在真有第二页时才出现，不然就是两颗永远点不动的按钮。
 *
 * 一条都没有时整条不画：那时页面上已经有一句「还没有公司」，再压一条「共 0 条」
 * 只是把空状态说了两遍。
 */
function listPager(key, view, unit) {
  if (!view.total) return ''
  const nav =
    view.pages > 1
      ? `<div style="display: flex; align-items: center; gap: var(--space-2);">
          <button type="button" class="btn btn-ghost" data-act="list-page" data-key="${esc(key)}" data-page="${view.page - 1}" ${view.page <= 1 ? 'disabled' : ''}>${t('上一页')}</button>
          <span>${t(`第 ${view.page} / ${view.pages} 页`, `Page ${view.page} of ${view.pages}`)}</span>
          <button type="button" class="btn btn-ghost" data-act="list-page" data-key="${esc(key)}" data-page="${view.page + 1}" ${view.page >= view.pages ? 'disabled' : ''}>${t('下一页')}</button>
        </div>`
      : ''
  const n = view.total
  const label = unit ? t(`共 ${n} ${unit}`, `${n} total`) : t(`共 ${n} 条`, `${n} total`)
  return `<div class="satu-pager">
    <span>${esc(label)}</span>
    ${nav}
  </div>`
}

function placeholderPage(title, body) {
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${esc(title)}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${esc(body)}</p>
        </div>
        ${flashes()}
      </div>
    </div>`
}
