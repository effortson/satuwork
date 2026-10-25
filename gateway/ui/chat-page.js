/** 对话页本身：日志弹窗、机器失联的横幅、抬头、chatPage()。原先在 chat.js 里，拆出来只是搬家（顺序见 index.html）。 */
function logsModal() {
  if (!state.logsOpen) return ''
  const { title, sources = [], active } = state.logsOpen
  const picker =
    sources.length > 1
      ? `<select class="input" data-act="logs-source" style="max-width: 260px;">${sources
          .map((x) => `<option value="${esc(x.key)}" ${x.key === active ? 'selected' : ''}>${esc(x.label)}</option>`)
          .join('')}</select>`
      : ''
  return `<div class="gw-modal-backdrop" data-act="logs-close">
    <div class="gw-modal" style="max-width: 900px;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div style="min-width: 0;">
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t('运行日志')}</h2>
          <p style="margin: 0 0 var(--space-2); font-size: 13px; color: var(--muted-foreground);">${esc(title || '')}</p>
          ${picker}
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="logs-close">${svg(CLOSE_ICON, 16)}</button>
      </div>
      <pre id="log-body" style="margin: var(--space-4) 0 0; max-height: 60vh; overflow: auto; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; background: var(--muted); border-radius: var(--radius); padding: var(--space-3);"></pre>
      <p style="margin: var(--space-2) 0 0; font-size: 11.5px; color: var(--muted-foreground);">${t('凭据已在机器那侧盖掉。日志里会有对话正文和执行过的命令。')}</p>
    </div>
  </div>`
}

/** 非「未上线」的错误仍然贴在名册上方——那是整页级别的问题，不属于某一个 Bot。 */
function runtimeDownBanner() {
  const err = state.runtimeError
  if (!err || String(err).includes('实例还没上线')) return ''
  // 这一栏里的话是我们自己写进 state 的中文常量（见 startChatStream / retryChatSession），
  // 过一遍译表才能跟着界面语言走；查不到的原样回来，不会变成空白。
  //
  // 「连接断开」那一句要**能点**：它是退避认输留下的，而认输之后没有任何东西会再去
  // 重连。原话让人去刷新整页——那会连草稿和还没发出去的附件一起丢掉，而真正要做的
  // 只是重开一条流。
  const retry =
    err === '连接断开'
      ? ` <button type="button" class="btn btn-ghost" style="margin-left: var(--space-2); height: 24px; padding: 0 8px; font-size: 12px;" data-act="chat-reconnect">${t('重新连接')}</button>`
      : ''
  return `<div class="gw-flash gw-flash-err">${esc(t(err))}${retry}</div>`
}

/**
 * 会话身份行，**直接长在页面顶栏里**。
 *
 * 它原本是消息流上面单独一条 header，于是顶栏写着「对话」、下面一行写着这条对话是
 * 谁——两条横杠叠在一起，上面那条还是一句永远不变的废话。合成一条之后，顶栏在对话页
 * 上说的就是「你正在跟谁说话、它现在什么状态」，这才是这一页需要一直挂在眼前的东西。
 *
 * 返回的是 .gw-head 的内容片段（身份 + 操作），外壳和内边距由 .gw-head 给。
 */
function chatHeadInline() {
  const bot = chatBotOf()
  const name = (bot && bot.name) || t('未选择')
  const menu =
    state.menu === 'chat'
      ? `<div class="satu-menu" data-flip="${String(Boolean(state.menuFlip))}">
          ${/* 自己建的那种才给设置入口：别人的、全局的，这一页上没有可改的东西。 */ ''}
          ${isMyBot(bot) ? `<button type="button" class="satu-menuitem" data-act="go" data-href="/bots/${esc(bot.id)}">${t('Bot 设置')}</button>` : ''}
          ${bot ? mainBotMenuItem(bot) : ''}
          ${bot ? folderMenuItems(bot) : ''}
          <button type="button" class="satu-menuitem" data-act="chat-copy-all">${t('复制全文')}</button>
          <button type="button" class="satu-menuitem" data-act="chat-export">${t('导出 Markdown')}</button>
        </div>`
      : ''
  return `<div class="sw-convo-avatar" data-bot="${bot ? '1' : '0'}" aria-hidden="true">${bot ? botAvatarOf(bot, 34) : ICON_BOT}</div>
    <div class="sw-convo-id">
      <div class="sw-convo-title">
        <span class="sw-convo-name">${esc(name)}</span>
        ${bot && bot.runtimeKind === 'local' ? `<span class="satu-localtag">${t('本地 Bot', 'Local bot')}</span>` : ''}
        <span class="sw-convo-live" id="chat-live" data-live="0"><i aria-hidden="true"></i><span>${t('离线')}</span></span>
      </div>
      <p class="sw-convo-meta" id="chat-meta"></p>
    </div>
    <div class="sw-convo-actions">
      ${/* 对话内查找（chat-find.js）。摆在「更多」左边：它是这一屏里最常要按的那颗，
            不该收进菜单里。 */ ''}
      ${findToggleHtml()}
      <button type="button" class="btn btn-ghost btn-icon" data-menu-toggle data-act="chat-menu"
        aria-label="${esc(t('更多操作'))}">${svg(KEBAB_ICON, 16)}</button>
      ${menu}
    </div>`
}

function chatPage() {
  const bots = state.runtimeBots || []
  const selected = chatBotIdOf(state.path) || state.chatBotId
  /**
   * **flashes() 这一页以前没有。**
   *
   * flash() 写的是 state.error / state.notice，而这一页从头到尾只画 runtimeDownBanner
   * ——于是 chat.js 里那一串 flash 全是哑的：附件没传上去、这条消息没发出去、几个 `@`
   * 已经失效、「已中止，正在跑的那个工具要等它自己收尾」，一句都到不了屏幕上。人看到
   * 的就是「点了没反应」，而代码里明明写着话。别的页早就都拼了这一句（见各 pages-*.js）。
   * 导航时 go() 会清掉这两格，不会把上一页的红字带过来。
   */
  /**
   * 机器失联那一条**顶掉** runtimeDownBanner，不并排摆两条红字。
   *
   * 后者能说的只有「连接断开」外加一颗「重新连接」——而机器都不在了，那颗按钮点下去
   * 是白敲一次接口。真正的原因由前者说，而且它说得出「多久没心跳了」。
   */
  const machineDown = machineDownBanner()
  const banner = flashes() + (machineDown || runtimeDownBanner())
  if (!selected) {
    return `<div class="gw-chat"><section class="gw-chat-main">${banner}
      <div class="gw-chat-empty-main"><p>${bots.length ? t('从左边选一个 Bot 开始对话。') : t('还没有 Bot。点左下角「新建 Bot」建一个，它会用公司的 Bot 模版当底座。', 'No bots yet. Use “New bot” at the bottom left — it will run on your company template.')}</p></div>
    </section></div>`
  }
  // 席位没上线：正文换成一块「去部署」，连输入框一起不渲染（见 chatDeployPrompt）。
  const nodeploy = chatDeployPrompt(selected)
  if (nodeploy) {
    return `<div class="gw-chat"><section class="gw-chat-main">${banner}${nodeploy}</section></div>`
  }
  /* 正文一律留空：消息、在线灯、提示行全部由 paintChat 增量填。在这里先渲染一遍
     再让 paintChat 覆盖，等于每次换页把同一份内容画两遍，还会把已经渲染好的图冲掉。 */
  return `
    <div class="gw-chat">
      <section class="gw-chat-main">
        ${banner}
        <div class="sw-threadwrap">
          ${/* 查找条浮在消息流右上角（chat-find.js）。内容由 paintChatFind 就地填。 */ ''}
          ${chatFindHtml()}
          <div class="sw-thread" id="chat-thread"></div>
          <button type="button" class="sw-jump" id="chat-jump" data-act="chat-jump" hidden>${ICON_DOWN}${t('回到底部')}</button>
        </div>
        <div class="sw-composer">
          ${/* 待办 dock（见 docs/todo-tool.md）。摆在输入框**外面的顶上**，和排队那一行
                同一个位置逻辑：它说的是「这件事现在做到哪儿了」，是发下一句之前顺带
                知道的东西，不是消息流里的一条内容。默认折叠成一行——展开的清单会把
                输入框顶掉半屏，而人多半只想知道「还剩几条」。 */ ''}
          <div class="sw-todock" id="chat-todock" hidden></div>
          <div class="sw-queue" id="chat-queue" hidden></div>
          <form id="chat-form" class="sw-composer-box">
            <div class="sw-pickbox" id="chat-cmdpick" hidden></div>
            <div class="sw-pickbox" id="chat-mentionpick" hidden></div>
            ${/* 引用条：这一条还没发出去的消息指着谁（一条回复、一个文件）。摆在 @ 那排上面，
                  内容由 paintChatRefs 就地填（见 docs/chat-references.md §7.1）。 */ ''}
            <div class="sw-files sw-refs" id="chat-refs" hidden></div>
            <div class="sw-files" id="chat-mentions" hidden></div>
            <div class="sw-files" id="chat-files" hidden></div>
            <textarea id="chat-input" class="satu-prompt satu-grow" rows="1"
              placeholder="${esc(t('输入消息'))}">${esc(state.chatDraft || '')}</textarea>
            <div class="sw-composer-row">
              ${/* 席位的消息接口目前只收 text，没有二进制通道。所以附件走「随消息一起
                    贴成正文」这条路：选中的文本文件在发送时以围栏代码块拼进去，模型看到
                    的就是文件内容本身。二进制在选择那一刻当场挡掉并说明白，不做成一个
                    看起来能传、传完没反应的按钮。 */ ''}
              <button type="button" class="sw-iconbtn" data-act="chat-attach"
                aria-label="${esc(t('添加附件'))}" title="${esc(t('添加附件'))}">${ICON_CLIP}</button>
              <input type="file" id="chat-file" multiple hidden>
              ${/* 日常模型选择器。平台只配了一个日常模型、或者席位太旧不认这条路时整块
                    隐藏；内容由 paintChatModel 就地填，和上下文占比那颗药丸一个做法。 */ ''}
              <span class="sw-model" id="chat-model" hidden>
                <button type="button" class="sw-model-chip" id="chat-model-chip" data-act="chat-model"
                  aria-haspopup="listbox" aria-expanded="false"></button>
                <div class="sw-modelpop" id="chat-model-pop" role="listbox" hidden></div>
              </span>
              <span class="sw-spacer"></span>
              ${/* 发送和停止是同一个按钮的两副面孔——它们指的是同一件事（这一轮对话的
                    开与关），而且永远只有一个有意义。摆两个按钮的话，其中一个总是灰的，
                    还得让人先分辨哪个能点。切换由 paintChatChrome 就地改，不重绘整页。 */ ''}
              <button type="submit" class="sw-send" id="chat-send" data-state="send"
                aria-label="${esc(t('发送'))}" title="${esc(t('发送'))}">${ICON_SEND}</button>
            </div>
          </form>
          <div class="sw-composer-tip">
            <span id="chat-tip"></span>
            <span class="sw-spacer"></span>
            ${/* 占比摆在这一行的最右边：它跟左边那句一样是「发之前顺带知道一下」的东西，
                  不值得单占一行，也不该跑到消息流里去抢正文的位置。内容由 paintChatCtx
                  就地填，没有真实用量时整块隐藏。 */ ''}
            <span class="sw-ctx" id="chat-ctx" hidden>
              <button type="button" class="sw-ctx-chip" id="chat-ctx-chip" data-act="chat-ctx"
                aria-expanded="false"></button>
              <div class="sw-ctxpop" id="chat-ctx-pop" hidden></div>
            </span>
          </div>
        </div>
      </section>
    </div>`
}
