/**
 * 页面骨架与重绘：pageView / appView / render()。各种表单的保存与提交在 actions.js。
 *
 * render() 是整页 innerHTML 换掉，所以对话正文不走它——那边是 paintChat 增量填（见 chat-thread.js）。
 */
function pageView() {
  if (state.path.startsWith('/bots/')) return botDetailPage()
  if (state.path.startsWith('/plugins/')) return pluginDetailPage()
  if (state.path.startsWith('/knowledge/')) return knowledgeDetailPage()
  if (state.path.startsWith('/companies/') && state.path !== '/companies') return companyDetailPage()
  if (state.path.startsWith('/users/') && state.path !== '/users') return userDetailPage()
  if (state.path.startsWith('/machines/') && state.path !== '/machines') return machineDetailPage()
  if (state.path.startsWith('/audit/summary/')) return conversationAuditDetailPage()
  if (isChatPath(state.path)) return chatPage()
  switch (state.path) {
    case '/bots':
      return botsPage()
    case '/skills':
      return skillsPage()
    case '/models':
      return modelsPage()
    case '/providers':
      return providersPage()
    case '/tools':
      return toolsPage()
    case '/connectors':
      return connectorsPage()
    case '/company':
      return companyPage()
    case '/accounts':
      return accountsPage()
    case '/handoffs':
      return handoffsPage()
    case '/channels':
      return channelsPage()
    case '/plugins':
      return pluginsPage()
    case '/knowledge':
      return knowledgePage()
    case '/audit':
      return auditPage()
    case '/machines':
      return machinesPage()
    case '/releases':
      return releasesPage()
    case '/companies':
      return companiesPage()
    case '/users':
      return usersPage()
    case '/orders':
      return ordersPage()
    case '/plans':
      return plansPage()
    case '/stats':
      return statsPage()
    case '/billing':
    case '/costs':
      return billingPage()
    case '/usage':
      return usagePage()
    case '/catalog':
      return placeholderPage(t('公司目录'), t('公司 Bot / Skill / MCP'))
    case '/profile':
      return profilePage()
    case '/download':
      return downloadPage()
    default:
      return overviewPage()
  }
}

/**
 * 当前页面的右侧栏。目前只有对话页有。
 *
 * 折叠时不是 `display:none`，而是留一条 34px 的竖条 —— 收起来之后还得有地方点回去，
 * 而且列宽从 280 变 34 有过渡，不会突然跳一下。
 */
function pageAside() {
  if (!hasAside()) return ''
  /**
   * 文件预览也摆在这一栏里，不再是盖住整屏的弹层——人要一边看产出一边跟 Bot 说「这里
   * 改一下」，弹层一开对话就被挡住了。预览开着的时候哪怕栏是收着的也要摆出来：人刚点了
   * 一个文件，什么都没出现才是最糟的。关掉预览，栏回到原来那个样子（收着的就还是收着）。
   */
  const preview = shownPreview()
  // 折叠 = 整个不渲染。开关挪到了对话 header 上，这里不用再留一条竖条给人点回去。
  if (!asideOpen() && !preview) return ''
  const detail = !preview && Boolean(state.routineOpen && routineOpenRow())
  /**
   * 点开一条日常任务时，整栏换成那一屏——但**上面那块屏只是藏起来，不是拿掉**。
   *
   * 拿掉的代价是断一次 VNC（见 chat-desktop.js 的 syncDesktop：槽没了就卸载）。藏着的时候
   * 它的 getBoundingClientRect 全是 0，常驻层自己会判成不可见，连接照旧活着；人点
   * 返回，槽一恢复尺寸，画面就在那儿。预览盖上来时同理。
   */
  /**
   * 文件那一屏和运行环境是**两屏并存、只藏一屏**，理由和日常任务详情那条一样：
   * 拿掉运行环境等于断一次 VNC。切到文件去看一眼再切回来，屏还在那儿。
   *
   * 转人工待办不用这样：里面没有长连接，用不着藏着养着，摆着的时候才画。
   */
  const tab = asideTab()
  const cover = detail || Boolean(preview)
  return `<aside class="gw-aside"${preview ? ' data-preview="1"' : ''}>
    <div class="gw-aside-grip" data-act="aside-grip" title="${esc(t('拖动调整宽度'))}"></div>
    <div class="gw-aside-body">
      <div class="gw-aside-stack" ${cover || tab !== 'env' ? 'hidden' : ''}>
        <h3>${t('运行环境')}</h3>
        ${chatMachinePanel()}
        ${routineListPanel()}
      </div>
      <div class="gw-aside-stack" ${cover || tab !== 'files' ? 'hidden' : ''}>
        ${workspacePanel()}
      </div>
      ${!cover && tab === 'handoffs' ? `<div class="gw-aside-stack" id="aside-handoffs">${handoffsAside()}</div>` : ''}
      ${detail ? routineDetailPanel() : ''}
      ${preview ? previewPanel() : ''}
    </div>
  </aside>`
}

/**
 * 右栏眼下该摆哪一屏。转人工待办只有公司里的人看得到（见 canSeeHandoffs）：上次停在
 * 那一屏、这次换了个看不到的身份登进来，就退回运行环境，别摆一屏空的。
 */
function asideTab() {
  if (asidePref.tab === 'handoffs' && !canSeeHandoffs()) return 'env'
  return asidePref.tab
}

/** 右栏这一刻的宽度：预览和平时各记各的（见 prefs.js 的 asideWidthOf）。 */
function asideWidth() {
  return shownPreview() ? asidePref.previewWidth : asidePref.width
}

/**
 * 右栏那一列的 grid 写法。拖动时（app.js）也走这一句。
 *
 * **预览那一档给内容区留够 420px**：它能拖到 1600，窗口一窄，右栏照着记下来的宽度画，
 * 对话会被挤成一条缝——而预览挪进右栏的意义就是边看边说。
 *
 * **平时那一档不留**：它最宽也就 520，原来一直是写死的像素。也套上这一刀的话，中等宽度
 * 的窗口里 280 的栏会被压窄，再窄一点直接算成 0——切屏按钮点下去像是没反应。
 */
function asideColumns(width, preview) {
  return preview ? `minmax(0, 1fr) min(${width}px, calc(100% - 420px))` : `minmax(0, 1fr) ${width}px`
}

/**
 * 右栏开关。放在对话 header 上，所以折叠之后仍然点得到——右栏本身是整个不渲染的。
 *
 * **几颗切屏 + 一颗收起，收起排在最右。** 切屏那几颗永远画自己那一屏的图标（举手、文件
 * 夹、显示器），正看着的那一屏留个底色；收起是另一件事——它不属于任何一屏，所以自己占
 * 一颗，而且只有栏开着的时候才在。
 *
 * 一开始是让正看着那一屏的图标就地变成收起箭头的：省一颗按钮，但同一个位置上的图标
 * 一开一关是两个意思，而人是照位置去点的——要收起，得先想起来「现在开着的是哪一屏」。
 *
 * 转人工待办原来是顶栏一颗跳去 /handoffs 的按钮，点下去整页换掉、对话没了。在对话页上
 * 它也是这一栏里的一屏；别的页没有右栏，那颗按钮照旧跳整页（见 handoffBell）。
 */
function asideToggle() {
  if (!hasAside()) return ''
  const preview = Boolean(shownPreview())
  const open = asideOpen() || preview
  const tab = (name, icon, label, extra = '') => {
    const here = open && !preview && asideTab() === name
    return `<button type="button" class="btn btn-ghost btn-icon sw-asidetab" style="flex: none;"
      data-act="aside-tab" data-tab="${name}" aria-pressed="${here}"
      aria-label="${esc(label)}" title="${esc(label)}">${svg(icon, 16)}${extra}</button>`
  }
  const collapse = open
    ? `<button type="button" class="btn btn-ghost btn-icon" style="flex: none;"
        data-act="aside-toggle" aria-label="${esc(t('收起右栏'))}" title="${esc(t('收起右栏'))}"
        >${svg(CHEVRON_RIGHT, 16)}</button>`
    : ''
  const n = needCount()
  const handoffs = canSeeHandoffs()
    ? tab('handoffs', ICON_HANDOFF, t('转人工待办', 'Handoffs'), `<span class="satu-handoffcount" ${n ? '' : 'hidden'}>${n > 99 ? '99+' : n}</span>`)
    : ''
  return `<span style="margin-left: auto; flex: none; display: inline-flex; gap: 2px;"
    >${handoffs}${tab('files', FOLDER, t('工作区文件'))}${tab('env', MONITOR, t('运行环境'))}${collapse}</span>`
}

/** 在不在对话页。顶栏换不换成会话身份行、右栏开不开，都看它，免得两处判断漂移。 */
function onChatPage() {
  if (!state.me) return false
  // 判据收敛到 state.js 的 isChatPath（`/` 对公司侧的人也算），这里不再自己列一遍。
  return isChatPath(state.path) && Boolean(chatBotIdOf(state.path) || state.chatBotId)
}

/** 这一页有没有右栏可开。 */
function hasAside() {
  return onChatPage()
}

function appView() {
  // 窄屏上没有「收窄成导轨」这一档：侧栏是盖上来的抽屉，要么整个出来，要么整个不在。
  const narrow = narrowScreen()
  const rail = state.rail && !narrow
  const crumbs = crumbsOf(state.path)
  // 一般的上一级是「回某个地址」（go）；有些屏的上一级要走一个动作，带的是 id 不是
  // 地址——crumbsOf 用 act 区分这两种，这里拼成按钮属性。
  const crumbBack = crumbs
    ? crumbs.act
      ? `data-act="${esc(crumbs.act)}" data-id="${esc(crumbs.id || '')}"`
      : `data-act="go" data-href="${esc(crumbs.href)}"`
    : ''
  // 对话页不要面包屑也不要「对话」两个字——顶栏整条让给会话身份行。
  const head = onChatPage()
    ? chatHeadInline()
    : crumbs
    ? `<button type="button" class="btn btn-ghost btn-icon" style="flex: none;" ${crumbBack} aria-label="${esc(t('返回'))}" title="${esc(crumbs.parent)}">${svg(BACK_ARROW, 17)}</button>
        <nav class="satu-crumbs" aria-label="${esc(t('面包屑', 'Breadcrumb'))}">
          <button type="button" class="satu-crumblink" ${crumbBack}>${esc(crumbs.parent)}</button>
          <span class="satu-crumbsep" aria-hidden="true">/</span>
          <span class="satu-crumbcur" aria-current="page">${esc(crumbs.current)}</span>
        </nav>`
    : `<span style="font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(pageTitle(state.path))}</span>`
  const account = state.me?.account || {}
  const email = account.email || ''
  const displayName = account.name || email || '…'
  const roster = chatRosterNav()
  // 侧栏按组画。组标题原来只有一条（「平台」/「公司」），说的是「你在哪一侧」——可
  // 平台管理员只有平台这一侧，那句话每次都在重复一件不会变的事。现在它换成了组名，
  // 说的是「这几条在管什么」，那才是站在菜单前要问的。
  const navHtml = navGroupsForRole()
    .map(
      (group) => {
        const open = !group.collapsible || state.navGroupOpen[group.key] !== false
        const title = !group.label
          ? ''
          : group.collapsible
            ? `<button type="button" class="satu-group satu-group-toggle" data-act="nav-group-toggle"
                data-group="${esc(group.key)}" aria-expanded="${String(open)}">
                <span>${esc(t(group.label))}</span>
                <span class="satu-groupchev" aria-hidden="true">${svg(CHEVRON_SMALL_DOWN, 12)}</span>
              </button>`
            : `<p class="satu-group">${esc(t(group.label))}</p>`
        return `<div class="satu-navgroup"${group.collapsible ? ` data-collapsible="true" data-open="${String(open)}"` : ''}>${title}${
          open ? group.items.map(navItem).join('') : ''
        }</div>`
      },
    )
    .join('')
  // 右栏和 header 同高：把 main 做成两行两列的 grid，侧栏跨两行占右列。做成 header
  // 下面的兄弟节点就顶不上去了。
  const aside = pageAside()
  const asideCols = aside
    ? `grid-template-columns: ${asideColumns(asideWidth(), Boolean(shownPreview()))};`
    : 'grid-template-columns: minmax(0, 1fr);'
  return `
  <div class="gw-shell" data-drawer="${narrow && state.drawer ? 'open' : 'closed'}" style="height: 100vh; height: 100dvh; overflow: hidden; display: grid; grid-template-columns: ${rail ? '62px' : '248px'} 1fr; gap: var(--space-4); padding: var(--space-4); background: var(--color-bg); font-family: var(--font-body); color: var(--color-text); box-sizing: border-box;">
    <aside class="gw-side${rail ? ' satu-rail' : ''}" ${narrow && !state.drawer ? 'inert' : ''} style="height: 100%; min-height: 0; overflow: hidden; box-sizing: border-box; display: flex; flex-direction: column; background: var(--color-surface); border-radius: var(--radius-md); padding: var(--space-4) var(--space-2) var(--space-2);">
      <button type="button" class="satu-brand" data-act="go" data-href="/" style="display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-3) var(--space-4); border: 0; background: transparent; cursor: pointer; color: inherit;">
        <img src="/assets/satuwork-logo.png" alt="Satuwork" style="width: 32px; height: 32px; min-width: 32px; flex: none; object-fit: contain; border-radius: var(--radius-sm);">
        <span class="satu-brandtext" style="font-family: var(--font-heading); font-size: 19px;">Satuwork</span>
      </button>
      ${/* 名单吃掉剩下的全部高度并自己滚；下面那组导航沉到底，不跟着一起滚走。
            Bot 是这一屏的主体，页面入口是配角，位置上就该这么分。

            **占位的有无按「这一侧有没有名单」分，不按「此刻有没有 Bot」分。**

            平台管理员那一侧永远没有 Bot（他没有席位，/runtime/bots 对他 403），占位
            每次都撑满，把整组菜单压到屏幕底部、上面空一大片——沉底的理由是「给名单
            让位」，名单不在，理由也就不在了。

            但员工那一侧不一样：他**现在**没有 Bot（刚进来、或者刚把最后一颗删掉）不
            等于这里没有名单。跟着一起收掉的话，「新建 Bot」和「插件」会从名单下沿弹
            到品牌标底下，删完最后一颗 Bot 的那一瞬间整个侧栏跳一下位——而对话区那句
            空态写的正是「点**左下角**「新建 Bot」」。所以只要这一侧有名单，占位就一直
            在，哪怕它是空的。 */ ''}
      <div style="flex: 1; min-height: 0; display: flex; flex-direction: column;">
        ${isOwner() ? '' : `<div class="satu-botlist">${roster}</div>`}
        ${/* 「新建 Bot」跟着名单走：Bot 是自己建的，入口就该在自己那份名单底下，而不是
              藏在某个设置页里。owner 没有席位也没有名册，那一侧不出现。

              **「插件」和「渠道」收进了它右边那颗「更多」里。** 三条一样宽的虚线框叠在
              名单下面，占掉三行高，而名单才是这一屏的主体——那两条一天也点不了一次，
              却和每天都要点的「新建 Bot」长得一模一样，谁也不比谁显眼。收进菜单之后
              这里只剩一行，名单多出两行。

              插件跳 /plugins、渠道跳 /channels，都是内置页（插件以前是弹窗，为什么改成页面
              见 pages-plugins.js 开头那段）。 */ ''}
        ${
          isOwner()
            ? ''
            : `<div class="satu-newbotrow">
          <button type="button" class="satu-newbot" data-act="new-bot">${svg(PLUS_ICON, 15)} <span>${t('新建 Bot', 'New bot')}</span></button>
          ${/* 走全局那套菜单（app.js 的 menu-toggle / state.menu，和成员表、对话顶栏
                同一套）：点外面自动收、翻不下去时自动向上弹，都是现成的。 */ ''}
          <button type="button" class="satu-newbot satu-newbot-more" data-menu-toggle data-act="menu-toggle" data-id="botmore"
            aria-haspopup="true" aria-expanded="${String(state.menu === 'botmore')}"
            aria-label="${esc(t('更多', 'More'))}" title="${esc(t('更多', 'More'))}">${svg(KEBAB_ICON, 15)}</button>
          ${
            state.menu === 'botmore'
              ? `<div class="satu-menu" data-flip="${String(Boolean(state.menuFlip))}">
              <button type="button" class="satu-menuitem satu-menuitem-icon" data-act="go" data-href="/plugins" aria-current="${state.path === '/plugins' || state.path.startsWith('/plugins/')}">${svg(ICONS.plugins, 15)}<span>${t('插件', 'Plugins')}</span></button>
              <button type="button" class="satu-menuitem satu-menuitem-icon" data-act="go" data-href="/channels" aria-current="${state.path === '/channels'}">${svg(['M4 12a8 8 0 0 1 16 0', 'M12 4v4', 'M8 12h8', 'M6 18h12'], 15)}<span>${t('渠道', 'Channels')}</span></button>
              ${/* 知识库排在渠道后面（docs/knowledge-base.md §11.1）：书本。 */ ''}
              <button type="button" class="satu-menuitem satu-menuitem-icon" data-act="go" data-href="/knowledge" aria-current="${state.path === '/knowledge' || state.path.startsWith('/knowledge/')}">${svg(['M4 4h7a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4z', 'M20 4h-7a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h7z'], 15)}<span>${t('知识库')}</span></button>
              ${/* 名单的分类：建一个，然后把 Bot 拖进去。它管的是上面那份名单，所以和「新建 Bot」
                    收在同一颗菜单里，而不是另起一个设置页。 */ ''}
              <button type="button" class="satu-menuitem satu-menuitem-icon" data-act="bot-folder-new">${svg(FOLDER, 15)}<span>${t('新建分类', 'New folder')}</span></button>
            </div>`
              : ''
          }
          ${/* 收窄成导轨时**不走这颗菜单**：浮层最窄 168px，而那一档侧栏只有 62px 宽，
                aside 又是 overflow:hidden，弹出来会被整块裁掉。所以那一档照旧把两条
                摊成两行，只剩图标——反正那一档整条侧栏本来就只有图标。 */ ''}
          <button type="button" class="satu-newbot satu-newbot-rail" data-act="go" data-href="/plugins"
            aria-current="${state.path === '/plugins' || state.path.startsWith('/plugins/')}"
            aria-label="${esc(t('插件', 'Plugins'))}" title="${esc(t('插件', 'Plugins'))}">${svg(ICONS.plugins, 15)}</button>
          <button type="button" class="satu-newbot satu-newbot-rail" data-act="go" data-href="/channels"
            aria-current="${state.path === '/channels'}"
            aria-label="${esc(t('渠道', 'Channels'))}" title="${esc(t('渠道', 'Channels'))}">${svg(['M4 12a8 8 0 0 1 16 0', 'M12 4v4', 'M8 12h8', 'M6 18h12'], 15)}</button>
          <button type="button" class="satu-newbot satu-newbot-rail" data-act="go" data-href="/knowledge"
            aria-current="${state.path === '/knowledge' || state.path.startsWith('/knowledge/')}"
            aria-label="${esc(t('知识库'))}" title="${esc(t('知识库'))}">${svg(['M4 4h7a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4z', 'M20 4h-7a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h7z'], 15)}</button>
          ${/* 窄栏不摆「新建分类」：那一档分类标题本来就收掉了，建出来人也看不见它。 */ ''}
        </div>`
        }
        ${
          navHtml
            ? `<div class="satu-navfoot">
          <div class="satu-sep"></div>
          ${navHtml}
        </div>`
            : ''
        }
      </div>
      ${/* 桌面端有新版本时亮在这里：沉在底部、紧挨着自己的头像，是「这台电脑上的应用」的事，
            不是哪颗 Bot 的事。没有新版时槽是空的，不占高度。 */ ''}
      ${desktopUpdateSlot('side')}
      ${/* box-sizing 必须写死：侧栏是 border-box，这一行不写就按 content-box 算，
            宽度比容器多出左右内边距，齿轮会顶出侧栏外沿。 */ ''}
      <div class="satu-userrow" style="display: flex; align-items: center; gap: var(--space-2); box-sizing: border-box; width: 100%; padding: var(--space-3); margin-top: var(--space-2); border-top: 1px solid var(--color-divider);">
        ${accountAvatar(account, 30)}
        <div class="satu-userinfo" style="line-height: 1.25; min-width: 0; flex: 1;">
          <div style="font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(displayName)}</div>
          <div style="font-size: 11px; color: color-mix(in srgb, var(--color-text) 50%, transparent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(email)}</div>
        </div>
        <button type="button" class="btn btn-ghost btn-icon satu-usercog" style="flex: none;" data-act="go" data-href="/profile" aria-label="${esc(t('个人设置'))}" aria-pressed="${String(state.path === '/profile')}">${svg(GEAR, 16)}</button>
      </div>
    </aside>
    ${/* 抽屉开着时盖在内容上的那层。点它就是收起——和点汉堡那颗是同一个动作。 */ ''}
    <div class="gw-drawer-mask" data-act="rail" aria-hidden="true"></div>
    <main id="gw-main" class="gw-main${aside ? ' gw-main-aside' : ''}" style="${asideCols}">
      <div class="gw-head">
        ${
          narrow
            ? `<button type="button" class="btn btn-ghost btn-icon" style="flex: none;" data-act="rail" aria-label="${esc(t('打开菜单', 'Open menu'))}" aria-expanded="${String(Boolean(state.drawer))}">${svg(['M4 6h16', 'M4 12h16', 'M4 18h16'], 18)}</button>`
            : `<button type="button" class="btn btn-ghost btn-icon" data-act="rail" aria-label="${rail ? t('展开侧栏') : t('收起侧栏')}">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>
        </button>
        <div style="width: 1px; height: 18px; background: var(--color-divider);"></div>`
        }
        ${head}
        ${handoffBell()}
        ${asideToggle()}
      </div>
      <div class="gw-body${state.path === '/profile' || (!isOwner() && /^\/(company|accounts|audit|billing|costs|usage|bots|skills|connectors)(\/|$)/.test(state.path)) ? ' gw-company' : ''}">${pageView()}</div>
      ${aside}
    </main>
    ${confirmModal()}
    ${newBotModal()}
    ${botFolderModal()}
    ${logsModal()}
  </div>`
}

/**
 * 没登录的人这一帧看到什么：首页，还是登录表单。
 *
 * `/` 给首页（见 pages-landing.js）——这台 Gateway 的地址会被发给还没开通的人，
 * 他们打开只看见两个输入框的话，连「这是什么」都问不出口。登录在 `/login`。
 *
 * 两个例外都回到登录表单：
 *
 * - **桌面壳**。它是应用不是网站，开机第一件事就是连回自己那台 Gateway；中间插一屏
 *   讲产品是什么，等于让已经装了这个东西的人再被推销一次。
 * - **`/` 以外的任何地址**。直接输 `/machines`、或者票过期之后刷新，人是奔着某一页
 *   去的——那时该问的是「你是谁」，不是「要不要了解一下」。
 */
function anonView() {
  if (state.path === '/' && !appShell()) return landingView()
  return loginView()
}

/**
 * 窄屏上把表格排成卡片（样式见 app.css 末尾「表格」那段）。
 *
 * 各页的表都是同一个形状：一行 `.satu-xxxhead`，后面跟着一串 `.satu-xxxrow`，格子是行的
 * 直接子元素，列宽写死在 grid 上。手机上照原样排，七八列挤在 343 宽里，整页只能横着滚。
 *
 * **不去一张张改各页的 HTML**——二十几张表，改一张漏一张，以后加表还得记得再写一份窄屏
 * 版。这里照着表头把每一格的列名抄到行上：第一格当卡片标题，表头是空的那一格（操作
 * 按钮）放到右上角，其余每格套一层 `.gw-tt-cell`、带上 data-label，CSS 画成「列名 … 值」。
 *
 * 套那一层是因为好几格本身就是个药丸（.tag）：列名直接用 ::before 挂在它身上，会画进
 * 药丸的底色里。
 *
 * 宽屏上不跑。从窄屏拖回宽屏时 narrowMq 的监听会整页重画，套的那层跟着没了。
 */
const TT_HEAD = /^satu-([a-z]+)head$/

function cardifyTables(root) {
  if (!root || !narrowScreen()) return
  for (const head of root.querySelectorAll('[class*="head"]')) {
    const m = [...head.classList].map((c) => TT_HEAD.exec(c)).find(Boolean)
    if (!m) continue
    // 行的类名跟表头配对（memberhead ↔ memberrow）。配不上的不是表（比如机器卡片顶上那条 machinehead）。
    const rowClass = `satu-${m[1]}row`
    const labels = [...head.children].map((c) => c.textContent.replace(/\s+/g, ' ').trim())
    // 哪一格当卡片标题，默认第一格。第一格不适合当标题的表在表头上写 data-tt-title：
    // 机器表第一格是一颗状态灯（用主机名），计费明细第一格是时间（用计费对象）。
    const title = Number(head.getAttribute('data-tt-title')) || 0
    // 表头整条收掉，空表也一样：一排列名底下只有一句「还没有…」，在手机上没意义。
    head.classList.add('gw-tt-head')
    for (let sib = head.nextElementSibling; sib; sib = sib.nextElementSibling) {
      const rows = sib.classList.contains(rowClass) ? [sib] : sib.querySelectorAll(`:scope > .${rowClass}`)
      for (const row of rows) cardifyRow(row, labels, title)
    }
  }
}

function cardifyRow(row, labels, title) {
  if (row.hasAttribute('data-tt')) return
  row.setAttribute('data-tt', '')
  row.classList.add('gw-tt-row')
  ;[...row.children].forEach((cell, i) => {
    if (i === title) return cell.setAttribute('data-tt-cell', 'title')
    const label = labels[i] || ''
    if (!label) return cell.setAttribute('data-tt-cell', 'act')
    const wrap = document.createElement('div')
    wrap.className = 'gw-tt-cell'
    wrap.setAttribute('data-label', label)
    row.insertBefore(wrap, cell)
    wrap.appendChild(cell)
  })
}

/** 上一帧画的是哪个页面。换页要回到顶部，原地重绘不能动——见 render()。 */
let paintedPath = null

/**
 * 重绘。整页是 innerHTML 整块换掉的，滚动位置跟着一起没——在同一个页面上按一个
 * 开关（记忆范围、勾选项这些都会重绘一次）视线就被扔回页首，页面越长越难受。
 * 所以换之前记下内容区滚到哪儿，换完贴回去；只有真的换了页面才落回顶部。
 */
function render() {
  const root = document.getElementById('app')
  // 对话页没有 .gw-page（自己那套滚动容器由 paintChat 管），这里就是 null，跳过。
  const before = document.querySelector('.gw-page')
  const keep = before && paintedPath === state.path ? before.scrollTop : 0
  // 窄屏的侧栏抽屉：换了页就收起。人从抽屉里点了一颗 Bot 或一页，要看的是那一页，
  // 抽屉还盖在上面等于这一下没点着。
  if (paintedPath !== state.path) {
    state.drawer = false
    // 公开页面滚的是文档，首页页脚进入下载页时也应从标题开始。
    window.scrollTo?.(0, 0)
  }
  paintedPath = state.path
  if (state.path.startsWith('/join/')) {
    root.innerHTML = joinView()
    syncDesktop()
    return
  }
  /**
   * 隐私政策和服务条款（pages-legal.js）。**放在登录判断之前**：有票没票、桌面壳里
   * 还是浏览器里，打开都是同一份文本。法律文本背后不该有一道登录墙——真要看它的人，
   * 多半正是还没有账号的那个（注册页底下那句「继续即表示同意」指的就是这里）。
   *
   * 也在「还没有系统管理员」那一屏之前：一台刚装好、一个账号都没有的 Gateway，同样
   * 该给得出这两页。
   */
  if (state.path === '/privacy' || state.path === '/terms') {
    root.innerHTML = legalView(state.path === '/terms' ? 'terms' : 'privacy')
    syncDesktop()
    return
  }
  if (state.path === '/download' && !state.me && !appShell()) {
    root.innerHTML = downloadView()
    syncDesktop()
    return
  }
  if (!state.me && state.needsSetup) {
    root.innerHTML = setupView()
    syncDesktop()
    return
  }
  // 右栏待办 / 待办页里正写着的结论，换壳之前存一下（见 chat-decide.js 的 stashHandoffNotes）。
  stashHandoffNotes(root)
  root.innerHTML = state.me ? appView() : anonView()
  fillHandoffNotes(root)
  // 首页那段演示：计时器、观察者和 three.js 背景都挂在 DOM 上，整页重绘之后要重新接上。
  if (document.getElementById('satu-lp-film')) lpFilmMount()
  // 对话页的正文不在 appView 里——chatPage 只搭空壳，消息由 paintChat 增量填。
  // 整页重绘会把那个壳换掉，所以每次 render 之后要补一次。
  if (document.getElementById('chat-thread')) {
    paintChat()
    // 输入框上下那三块（排队 dock、已选的 @ 药丸、选单）同样是空壳 + 增量填。
    paintChatQueue()
    paintChatMentions()
    paintChatRefs()
    // 附件那一栏同理。漏了它，发送时那次 render 一换壳，「正在传」的附件就从眼前消失了。
    paintChatFiles()
    paintMentionPick()
    // 命令选单也在这三块里。漏掉它的话，重绘之后 state.cmdPick 还开着、DOM 里却空了——
    // 上下键选不动（一条候选都查不到），回车穿到发送那条路上去。
    paintCmdPick()
  }
  // 右栏里的预览：内容在常驻层上，这里只对位置、内容变了才换（见 chat-preview.js 的 syncPreview）。
  // 笔刷滑杆在右栏的按钮行里，跟着整页换掉了，要重新接上。
  syncPreview()
  bindPaintBrush()
  // 日志面板同理：壳在 render 里，内容由 paintLogs 增量填。
  if (document.getElementById('log-body')) paintLogs()
  // 右栏那棵工作区文件树：开着而这条会话还没取过的话，补一次（见 chat-workspace.js 的
  // ensureWorkspaceTree）。**挂在这儿而不是 paintChat 里**——paintChat 要先找得到
  // #chat-thread 才往下走，而那个节点在「还没部署」「一个 Bot 都没有」这两种形态下
  // 根本不画，右栏却照样开着，于是那一屏一次都不取，永远停在「载入中」。
  ensureWorkspaceTree()
  // 内嵌桌面那块屏活在 #app 外面（重绘换不掉它），但它的位置是照着右栏里的空槽算
  // 的——壳换过一次就得重新对齐。
  syncDesktop()
  // 正在装的那颗 Bot 要有人替它盯着（见 chat-seat.js 的 ensureDeployWatch）：装好之后这一
  // 页自己变成对话。挂在这儿是因为「要不要盯」由这一次画出来的那一屏决定——换页、
  // 换 Bot、装完，三件事都在 render 之后才成立。
  ensureDeployWatch()
  if (!keep) return
  const after = document.querySelector('.gw-page')
  if (after) after.scrollTop = keep
}
