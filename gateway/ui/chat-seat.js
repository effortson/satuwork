/** 席位这一侧：部署按钮、通联的灯和横幅、装到哪一步、本机目录、机器面板，以及席位通联和安装进度的轮询。原先在 chat.js 里，拆出来只是搬家（顺序见 index.html）。 */
function deployBotButton(botId, label) {
  if (!botId) return ''
  const cls = label ? 'btn' : 'btn btn-primary'
  return `<button type="button" class="${cls}" data-act="runtime-deploy" data-bot="${esc(botId)}" ${state.deploying ? 'disabled' : ''}>${state.deploying ? t('部署中…') : label || t('部署这个 Bot')}</button>`
}

/**
 * 这个 Bot 的席位落在哪台机器上、那台机器现在通不通：
 * `''`（没这个字段）/ `online` / `stale` / `offline` / `unpaired`。
 *
 * **席位的 `status` 答不了这件事。** 它是「上一次部署走到哪一步了」，落库之后就不动
 * 了：机器断电、网线拔了、管家挂了，那一行照样写着 `ready`。于是平台那一页的灯已经
 * 打成「失联」，员工这边的 Bot 还挂着「在线」，点发送没有任何反应——发送失败那一路
 * 只会把 `实例还没上线` 写进 runtimeError，而它被 runtimeDownBanner 挡在界面外（那句
 * 话是重新部署时的常态，不该弹红字）。两头一凑，就是「什么都没说」。
 *
 * 判据直接用平台那一份（gateway 的 machineLink：心跳有多久没来了），一个字都不另算
 * ——同一台机器在两个页面上说两种话，比少一个字段糟得多。
 *
 * **后端没给这个字段 ≠ 机器失联。** 前端比后端新一步（浏览器读的是磁盘上的 app.js，
 * Gateway 要重启才换代码）就会拿到 undefined。那时老实回 ''、让灯照旧按部署状态走，
 * 不替它猜一个「失联」——猜错的方向恰恰是最吓人的那个。
 */
function seatLinkOf(bot) {
  const rt = bot && bot.runtime
  return (rt && rt.machineLink) || ''
}

/** 运行头像与名单使用同一份实时状态；失联、安装中和待人工时保持静止。 */
function botIsWorking(bot, busy) {
  if (!bot || installingOf(bot)) return false
  const link = seatLinkOf(bot)
  if (linkDown(link) || link === 'unpaired') return false
  if (bot.runtimeKind === 'local' && (bot.runtime?.status !== 'ready' || link !== 'online')) return false
  if (bot.runtime?.status && bot.runtime.status !== 'ready') return false
  const sum = (botStreams.get(bot.id) || {}).sum
  if (sum?.state === 'review') return false
  return busy == null ? sum?.state === 'busy' : Boolean(busy)
}

function seatLink() {
  return seatLinkOf(chatBotOf())
}

/** 这盏灯该说「它现在够不着」的两档。`unpaired` 不算——那是「还没装」，另有话说。 */
function linkDown(link) {
  return link === 'offline' || link === 'stale'
}

/**
 * 「这个 Bot 的机器失联了」摆在对话最上面。
 *
 * **只有 `offline` 才出横幅，`stale` 不出。** 中间那一档（3 到 20 轮心跳）本来就是
 * 换版重启会落进去的窗口，出一条红字等于每次自升级都喊一次狼来了。抬头那盏灯会先
 * 变成「心跳迟了」——想看的人看得见，不想看的人不被打断。
 *
 * 话要说到「所以现在会怎样」：人看见「失联」两个字之后真正要知道的是，这期间发出去
 * 的消息不会到、它的回复也回不来，以及这事不用他去点什么按钮。
 */
function machineDownBanner() {
  const bot = chatBotOf()
  if (!bot || bot.runtimeKind === 'local' || seatLinkOf(bot) !== 'offline') return ''
  const age = bot.runtime.machineHeartbeatAge
  const when = age == null ? t('从未心跳') : t('最后一次心跳 %s').replace('%s', sinceMs(age))
  const name = bot.name || t('这个 Bot')
  // 两个占位符用不同的记号：都写 %s 的话，名字里恰好有一个 %s 就会把第二次替换吃掉。
  return `<div class="gw-flash gw-flash-err">${esc(
    t('%s 所在的机器失联了（%t）。这期间消息发不出去，它的回复也送不回来；机器回来之后这一页会自己接上。一直不好就找管理员看看那台机器。')
      .replace('%t', when)
      .replace('%s', name),
  )}</div>`
}

/**
 * 对话页右侧的「这个 Bot 的机器」栏。
 *
 * 部署按钮和环境信息原来挤在左边名册的上方，两者都不好用。挪到右栏之后：名册只管
 * 选人，中间只管对话，机器的事集中在一处。
 *
 * **桌面地址做成按钮,不打印 URL。** 那条 URL 里带着一整段 JWT 票（五分钟有效），
 * 渲染成文本会占掉半屏，而且没人会去手抄它——它唯一的用法就是点开。
 */
/**
 * 这一刻这一屏对着的那个 Bot 的安装进度。**别的 Bot 的那一份不作数**——轮询是异步的，
 * 人在两次回执之间换了 Bot，认领上一份就等于把别人的进度画在这一页上。
 */
function deployProgressNow() {
  const p = state.deployProgress
  return p && p.botId === chatBotIdNow() ? p : null
}

/**
 * 这个 Bot 的席位走到哪一步了：`unbound` / `none` / `deploying` / `error` / `ready`。
 *
 * 抽出来是因为有两处要看它——对话正文中间那块「去部署」，和右栏。两处各判一次的话，
 * 迟早出现「中间说没部署、右栏说在线」这种自相矛盾的画面。
 *
 * **进度那一份优先于 desktopRuntime。** 它每两秒刷一次，而 desktopRuntime 只在进页面
 * 和部署收尾时取；刚建完的那颗 Bot 尤其——那一刻 `/runtime/desktop` 完全可能还是 404
 * （席位行刚落库、或者后台那次登记还差几百毫秒），照着它画就是一句「还没有部署」外加
 * 一颗按钮，而机器上已经开工了。
 */
function seatStage() {
  const bot = chatBotOf()
  if (bot && bot.runtimeKind === 'local') return bot.runtime && bot.runtime.status === 'ready' ? 'ready' : 'none'
  if (!(state.runtimeMachine && state.runtimeMachine.paired)) return 'unbound'
  const p = deployProgressNow()
  /**
   * **`stalled` 和 `deploying` 必须分开。**
   *
   * 库里那一行两种情况长得一模一样，可人要做的事完全相反：一个是接着等（什么都不用
   * 按），一个是这次装到一半没人接着装了（非按一下不可）。混成一档的代价是后者——
   * 一屏永远走不完的读秒，外加一颗都没有的按钮。判据由服务端给（见
   * `/runtime/deploy/progress` 的 stale：库里的在装心跳断了、管家那边也没在装）。
   */
  if (p && p.status === 'deploying') return p.stale ? 'stalled' : 'deploying'
  const mine = state.desktopRuntime
  if (!mine || mine.status === 'none') return p && p.status === 'error' ? 'error' : 'none'
  if (mine.status === 'error' || mine.status === 'deploying') return mine.status
  return mine.status === 'ready' ? 'ready' : 'none'
}

/** 上一次部署失败的理由。两份里哪份有话说算哪份（见 seatStage 里那段）。 */
function seatErrorText() {
  const p = deployProgressNow()
  return (state.desktopRuntime && state.desktopRuntime.lastError) || (p && p.lastError) || t('部署失败')
}

/**
 * 安装进度那一屏的正文。
 *
 * 三档，**说得出多少就说多少，不摊成一根匀速的百分比条**：机器上那几步的时长差着一个
 * 数量级（apt 装桌面栈占大半，写 systemd 单元一秒都不到），摊平的进度条只会在最长的那
 * 一步上停住不动——比不画还糟，因为它明确地在骗人。
 *
 *   · 管家报得出第几步（协议 3 起）→ 「第 3 步 / 共 7 步 · 安装浏览器」，带一根按步数
 *     走的条；
 *   · 只知道已经下发了 → 「机器上正在安装」；
 *   · 刚登记完还没发出去 → 「正在下发到机器」。
 *
 * 读秒那一格套的是现成的 `.sw-time[data-running]`（见 tickClocks）：每秒自己往前走，
 * 不用为这一屏再挂一个定时器。**它是这屏上最要紧的一句话**——人真正想知道的是「这是
 * 正常的等，还是卡住了」，而唯一能回答的就是「已经装了多久」。
 */
function installProgressBody() {
  const p = deployProgressNow()
  const step = p && p.step
  const rows = []
  if (step && step.total > 0) {
    const pct = Math.max(4, Math.min(100, Math.round((step.step / step.total) * 100)))
    rows.push(`<div class="sw-install-bar"><span style="width:${pct}%"></span></div>`)
    rows.push(
      `<p class="sw-install-step">${esc(
        t('第 %a 步 / 共 %b 步', 'Step %a of %b').replace('%a', String(step.step)).replace('%b', String(step.total)),
      )} · ${esc(step.label || '')}</p>`,
    )
  } else {
    rows.push(
      `<p class="sw-install-step">${esc(
        p && p.phase === 'queued'
          ? t('正在下发到机器…', 'Sending it to the machine…')
          : t('机器上正在安装…', 'Installing on the machine…'),
      )}</p>`,
    )
  }
  // **本地锚点，不是服务端时刻**（见 pollDeployProgress 里那段）：读秒往后每一下都由
  // 这台电脑自己的时钟走，两台钟差多少都不进这个数。
  const since = (p && p.since) || 0
  if (since) {
    rows.push(
      `<p class="sw-install-since">${t('已经装了', 'Running for')} <span class="sw-time" data-running data-since="${since}">${esc(
        elapsedText(Date.now() - since),
      )}</span></p>`,
    )
  }
  return rows.join('')
}

/**
 * 席位没上线时，**把话说在正文中间**，而不是只摆在右栏里。
 *
 * 原先这套提示只有右栏一份：而右栏可以收起（默认也常常是收起的），于是人看到的是一
 * 片空白的对话，外加一个能打字、发出去却没有任何反应的输入框——最需要指路的那一刻，
 * 屏幕正中什么也没说。
 *
 * 输入框在这个状态下整个不渲染。留着它就是留一个「看着能用、按了没用」的东西，比没有
 * 更糟。
 */
function chatDeployPrompt(botId) {
  const stage = seatStage()
  if (stage === 'ready') return ''
  const bot = chatBotOf() || {}
  const name = bot.name || t('这个 Bot')
  let title = ''
  let body = ''
  let action = ''
  let extra = ''
  if (bot.runtimeKind === 'local') {
    title = t('%s 正在等待 Desktop', '%s is waiting for Desktop').replace('%s', name)
    body = window.__SATUWORK_DESKTOP__
      ? t('本地运行时正在启动；它会使用这台电脑上独立的默认工作目录。', 'The local runtime is starting with its own workspace on this computer.')
      : t('请用 Satuwork Desktop 打开这个页面。本地 Bot 不会在普通浏览器里启动。', 'Open this page in Satuwork Desktop; local bots do not start in a regular browser.')
    action = window.__SATUWORK_DESKTOP__
      ? `<button type="button" class="btn btn-primary" data-act="local-bot-start" data-bot="${esc(botId)}">${t('重新启动', 'Start again')}</button>`
      : ''
  } else if (stage === 'unbound') {
    title = t('公司的运行机器还没配好')
    body = t('公司的运行机器还没有配对机器管家，请系统管理员在公司详情里生成配对码。')
  } else if (stage === 'deploying') {
    /**
     * 建完 Bot 之后人就坐在这一屏上等。所以这里说的不能只是「部署中…」——那句话在第
     * 一秒和第十分钟长得一模一样，人唯一能做的判断变成「是不是卡死了」，而正确答案
     * 通常是「没有，第一次装就是这么久」。
     *
     * 三句话，一句都不能少：**在装什么**（第几步）、**装了多久**（读秒）、**要不要
     * 守着**（不用，装好自己会变成对话）。
     */
    title = t('正在安装「%s」…', 'Setting up “%s”…').replace('%s', name)
    body = t(
      '第一次装要在机器上铺一整套桌面，通常几分钟。装好之后这一页会自己变成对话，不用守着——也可以先去做别的。',
      'The first install lays down a whole desktop on the machine and usually takes a few minutes. This page turns into the conversation on its own once it is done.',
    )
    extra = installProgressBody()
  } else if (stage === 'stalled') {
    // 说清楚**发生了什么**、**现在是什么状态**、**该按哪一下**。只写一句「部署失败」
    // 的话，人会去查一个根本不存在的故障——机器好好的，只是这次装没人接着做完。
    title = t('上一次安装没做完', 'The last install did not finish')
    body = t(
      '装到一半中断了（多半是 Gateway 重启过），机器上没有人接着装。点「重新部署」再来一次，已经装好的部分会复用。',
      'It stopped halfway — most likely the Gateway restarted — and nothing is installing it now. Hit “Redeploy” to run it again; whatever was already installed is reused.',
    )
    action = deployBotButton(botId, t('重新部署'))
  } else if (stage === 'error') {
    title = t('上一次部署没成功')
    body = seatErrorText()
    action = deployBotButton(botId, t('重新部署'))
  } else {
    title = t('%s 还没有部署').replace('%s', name)
    body = t('部署之后它才有自己的机器和桌面，也才收得到消息。这一步要几分钟。')
    action = deployBotButton(botId)
  }
  const hint = state.deployHint ? `<p class="sw-nodeploy-hint">${esc(state.deployHint)}</p>` : ''
  return `<div class="gw-chat-empty-main"><div class="sw-nodeploy">
    <span class="sw-nodeploy-icon">${svg(MONITOR, 26)}</span>
    <h2>${esc(title)}</h2>
    <p>${esc(body)}</p>
    ${extra}${action}${hint}
  </div></div>`
}

/**
 * 本地 Bot 批准过的文件夹：壳子那边的清单（local_directories），逐条带「撤销」。
 *
 * 数据只有壳子有（批准记录在这台电脑的应用数据目录里，Gateway 不知道），所以第一次画到
 * 这一格时去要一次，要回来再重画；批准、撤销、Bot 自己申请下来之后各重要一次。老版本的壳
 * 没有 `directories` 这条桥，整格不画——不能画一张永远是空的「没有批准任何文件夹」骗人。
 */
const localDirsLoading = new Set()

async function loadLocalDirs(botId) {
  const bridge = window.__SATUWORK_LOCAL_BOT__
  if (!botId || !bridge || typeof bridge.directories !== 'function') return
  state.localDirs = state.localDirs || {}
  localDirsLoading.add(botId)
  try {
    const list = await bridge.directories(botId)
    state.localDirs[botId] = { list: Array.isArray(list) ? list : [] }
  } catch (err) {
    state.localDirs[botId] = { list: [], error: err instanceof Error ? err.message : String(err || '') }
  } finally {
    localDirsLoading.delete(botId)
  }
}

function localDirsHtml(botId) {
  const bridge = window.__SATUWORK_LOCAL_BOT__
  if (!bridge || typeof bridge.directories !== 'function') return ''
  const got = (state.localDirs || {})[botId]
  if (!got) {
    if (!localDirsLoading.has(botId)) void loadLocalDirs(botId).then(() => render())
    return ''
  }
  if (got.error) return `<div class="gw-flash gw-flash-err" style="margin: 0;">${esc(got.error)}</div>`
  if (!got.list.length) return ''
  /**
   * **默认收起**，标题带条数。摊开的话批得越多、下面的「日常任务」被挤得越远——而日常任务
   * 是这一栏里天天要看的东西，批过哪些文件夹是偶尔才查一次的。
   *
   * 开合记在 state 里而不是用 <details> 自己的 open：右栏每次 render 都整块重画，<details>
   * 的开合会被一起抹掉，人刚点开，下一帧（名单流一来）就又收回去了。
   */
  const open = Boolean((state.localDirsOpen || {})[botId])
  const head =
    `<button type="button" class="sw-localdirs-head" data-act="local-dirs-toggle" data-bot="${esc(botId)}" aria-expanded="${String(open)}" ` +
    `style="display: flex; align-items: center; gap: 6px; width: 100%; padding: 0; border: 0; background: none; cursor: pointer; font: inherit; font-size: 12px; color: var(--muted-foreground); text-align: left;">` +
    `<span style="flex: 1;">${esc(t('已批准访问的文件夹', 'Approved folders'))} · ${got.list.length}</span>` +
    `<span aria-hidden="true" style="display: inline-block; transition: transform 0.15s ease; transform: rotate(${open ? 90 : 0}deg);">›</span>` +
    `</button>`
  if (!open) return `<div class="sw-localdirs">${head}</div>`
  const rows = got.list.map((d) => {
    const name = String(d.mount || '').replace(/^External\//, '') || d.path
    return (
      `<div class="sw-localdir" style="display: flex; align-items: center; gap: 8px; min-width: 0;">` +
      `<div style="flex: 1; min-width: 0;">` +
      `<div style="font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(name)}</div>` +
      `<div style="font-size: 11.5px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${esc(d.path)}">${esc(d.path)}</div>` +
      `</div>` +
      `<button type="button" class="btn btn-ghost btn-sm" data-act="local-dir-revoke" data-bot="${esc(botId)}" data-path="${esc(d.path)}">${esc(t('撤销', 'Revoke'))}</button>` +
      `</div>`
    )
  })
  return (
    `<div class="sw-localdirs" style="display: flex; flex-direction: column; gap: 8px;">` +
    head +
    // 批得多了也不把整栏撑长：最多露出五六行，其余在框里滚。
    `<div style="display: flex; flex-direction: column; gap: 8px; max-height: 240px; overflow-y: auto;">${rows.join('')}</div>` +
    `</div>`
  )
}

function chatMachinePanel() {
  const selected = chatBotIdOf(state.path) || state.chatBotId
  if (!selected) return ''
  const mine = state.desktopRuntime
  const stage = seatStage()
  const rows = []
  const local = (chatBotOf() || {}).runtimeKind === 'local'

  // 没上线时右栏只报状态，**不再摆第二颗部署按钮**——那句话和那颗按钮现在在正文
  // 中间，同一块屏幕上放两个一模一样的主操作，只会让人先分辨该点哪一个。
  if (local) {
    rows.push(`<p style="margin:0;font-size:12px;color:var(--muted-foreground);line-height:1.6;">${esc(
      stage === 'ready'
        ? t('运行在这台电脑；默认只访问自己的工作目录。', 'Running on this computer with access limited to its own workspace.')
        : t('本地运行时尚未连接。', 'The local runtime is not connected yet.'),
    )}</p>`)
    if (window.__SATUWORK_DESKTOP__) {
      rows.push(`<button type="button" class="btn btn-secondary" data-act="local-dir-approve" data-bot="${esc(selected)}">${t('批准访问其他文件夹', 'Approve another folder')}</button>`)
      rows.push(localDirsHtml(selected))
    }
  } else if (stage === 'unbound') {
    rows.push(
      `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground); line-height: 1.6;">${t('公司的运行机器还没有配对机器管家，请系统管理员在公司详情里生成配对码。')}</p>`,
    )
  } else if (stage === 'none') {
    rows.push(`<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('实例还没上线')}</p>`)
  } else if (stage === 'error') {
    // **不能读 mine.lastError**：这一档现在也可能只有进度那一份说得出话（席位行还没
    // 落到这个浏览器手上），那时 mine 是 null，读它就是一个白屏。
    rows.push(`<div class="gw-flash gw-flash-err" style="margin: 0;">${esc(seatErrorText())}</div>`)
  } else if (stage === 'stalled') {
    rows.push(`<div class="gw-flash gw-flash-err" style="margin: 0;">${esc(t('上一次安装没做完', 'The last install did not finish'))}</div>`)
  } else if (stage === 'deploying') {
    const p = deployProgressNow()
    const step = p && p.step
    const line = step ? `${t('正在安装', 'Installing')} · ${step.label || ''}` : t('正在安装…', 'Installing…')
    rows.push(`<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${esc(line)}</p>`)
  }

  /**
   * 机器通不通，**这一栏也要说一句**。
   *
   * 席位铺好之后这一栏里就只剩那块桌面了，而机器失联时它是一块静止的死屏——不写这
   * 一行的话，人会以为是桌面这一路坏了，去点「重新连接」。灯和横幅在正文那边，右栏
   * 收起时同样看不见（它默认常常是收着的）。
   *
   * 两档都说，用的还是机器页那套词和那盏灯：`stale` 只是一句灰字（换版重启就长这样），
   * `offline` 才用错误色。
   */
  if (stage === 'ready' && linkDown(seatLink())) {
    const link = seatLink()
    const age = (chatBotOf() || {}).runtime?.machineHeartbeatAge
    const when = age == null ? t('从未心跳') : sinceMs(age)
    const label = (LINK_TEXT[link] || LINK_TEXT.unknown)()
    rows.push(
      link === 'offline'
        ? `<div class="gw-flash gw-flash-err" style="margin: 0;">${esc(t('机器') + ' ' + label + ' · ' + when)}</div>`
        : `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${esc(t('机器') + ' ' + label + ' · ' + when)}</p>`,
    )
  }

  if (mine && mine.status === 'ready') {
    if (!mine.novncUrl) {
      // 桌面地址只剩直连一种（Gateway 不再反代 `/desktop/…`）：机器没配 directUrl 或管家
      // 太旧时它是 null。不说这一句的话这一栏就是空的，人会以为桌面这一路坏了。
      rows.push(
        `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground); line-height: 1.6;">${esc(t('这台机器没有配直连地址，桌面打不开'))}</p>`,
      )
    } else if (deskEmbeddable(mine.novncUrl)) {
      // 只放一个空槽。真正的 iframe 挂在 #app 外面的常驻层里（见 syncDesktop），
      // 整页重绘换不掉它——换掉一次就是断一次 VNC。
      rows.push(
        `<div class="sw-desk">
          <div class="sw-desk-slot" id="sw-desk-slot"><span>${t('正在连桌面…')}</span></div>
          <p class="sw-desk-cap">${esc(deskCaption())}</p>
        </div>`,
      )
    } else if (mine.novncUrl) {
      // 嵌不了的时候退回原来那颗按钮——新标签页是顶层导航，没有 iframe 那些限制。
      rows.push(
        `<a class="btn btn-primary" href="${esc(mine.novncUrl)}" target="_blank" rel="noopener noreferrer" style="text-align: center;">${t('打开桌面')}</a>`,
      )
    }
    /**
     * **右栏到这儿就结束了。**
     *
     * 这里原先还挂着一个「席位详情」折叠面板：共享目录、linuxUser、Bot 版本，以及
     * 「运行日志」「重新部署」两个入口。它们都是「出事那天」才用一次的东西，而这一
     * 栏每天要看的只有上面那块屏——多一个可展开的标题，就多一次「这里面是什么」的
     * 分神。
     *
     * **日志和重铺跟着一起下线了，这是有代价的**：员工手上暂时没有自助重铺的入口，
     * 席位坏了要找管理员。要把它们放回来的话，位置应该是桌面全屏时那条标题栏——出问
     * 题的是那块屏，人当时也正看着它。
     */
  }

  return rows.join('')
}

/**
 * 席位通联的轮询：这些 Bot 的机器还在不在。
 *
 * **非有不可。** 这一份数据只在进页面时拉过一次（loadPage → loadRuntimeBots），而机器
 * 失联恰恰是「人已经坐在这一页上」的时候发生的：不再拉一次，那盏灯就会一直停在他进
 * 来时的样子——正是「平台说失联、员工这边还写着在线」的后半截。事件流救不了这件事，
 * 机器没了它同样收不到任何东西。
 *
 * 30 秒一轮，和管家的心跳同频（MANAGER_HEARTBEAT_MS）：再密也没有新数据，Gateway 那
 * 一份也是等心跳来才变的。规矩照抄待办那条——只在页面可见时转，切回前台立刻补一次。
 *
 * **只有真的变了才重绘**：横幅和名册由 chatPage() / chatRosterNav() 拼，改不动就得整页
 * 重画，而那一下会把正在打字的输入框换掉（见 paintChatCtx 上的注释）。半分钟一次的
 * 无条件重绘，等于让人没法在这一页上安心打字。
 */
const SEAT_WATCH_MS = 30_000
let seatWatchTimer = null

function startSeatWatch() {
  if (seatWatchTimer) return
  seatWatchTimer = setInterval(() => {
    if (document.hidden) return
    void pollSeatLinks()
  }, SEAT_WATCH_MS)
  // Node 环境（e2e 垫片）下别拽着进程不退出；浏览器里 setInterval 是数字，没有 unref。
  if (seatWatchTimer && typeof seatWatchTimer.unref === 'function') seatWatchTimer.unref()
  document.addEventListener('visibilitychange', seatWatchOnVisible)
}

function seatWatchOnVisible() {
  if (!document.hidden) void pollSeatLinks()
}

/** 同 stopHandoffPoll：退出登录 / 票过期时停，登进来之后 loadPage 按角色重新起。 */
function stopSeatWatch() {
  clearInterval(seatWatchTimer)
  seatWatchTimer = null
  if (typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', seatWatchOnVisible)
}

async function pollSeatLinks() {
  if (isOwner()) return
  // 名册里每个 Bot 的通联状态都在这一份里，一次请求就够——一个 Bot 一次的话，
  // 名册长一点就是每半分钟一串请求，而它们全在问同一件事。
  // 键里带上部署状态：名单上那一行「正在安装…」要在装完的时候自己消失，而通联状态
  // 从头到尾都是 online——只比它的话，那句话会一直挂到人点了点什么才换掉。
  const rosterKey = () => (state.runtimeBots || []).map((b) => b.id + ':' + seatLinkOf(b) + ':' + ((b.runtime && b.runtime.status) || '')).join(',')
  const before = rosterKey()
  try {
    await loadRuntimeBots()
  } catch {
    // 拉不动就算了：这一份只用来点亮那盏灯，不该因为一次网络抖动把界面上的话改掉。
    return
  }
  if (rosterKey() === before) return
  // 别的页上没有这盏灯，也没有那条横幅——重绘只会把人正在填的表单换掉。回到对话页时
  // loadPage 自己会重画。
  if (isChatPath(state.path)) render()
}

async function updateOrgRuntime() {
  const org = state.org && state.org.id
  if (!org || state.updatingRuntime) return
  state.updatingRuntime = true
  render()
  try {
    // **不带版本**：升到哪一版由服务端定（平台钉的那一版，没钉就是最新），和心跳里的自动
    // 跟版同一个目标。这里自己带最新版的话，钉版本时一按就铺上最新，十分钟后又被跟版拉回去。
    // 还没有发布版本时服务端回 409，落进下面的 catch。
    const data = await api('POST', `/platform/orgs/${encodeURIComponent(org)}/runtime/update`, {})
    const results = Array.isArray(data.results) ? data.results : []
    const ok = results.filter((r) => r.status === 'ready' && !r.error).length
    /**
     * 「有会话在跑，这次没换」**单独数**，不进「失败」。
     *
     * 那是管家等到超时也没等到席位空下来（见 manager/src/seats.ts 的排空）：机器上
     * 一个字节都没动，席位还是原来的版本、还在好好地跑，晚点再来一次就是了。混进
     * 失败里的话，一次「中午大家都在用」会被报成一片红，人会去查根本不存在的故障。
     */
    const held = results.filter((r) => r.busy).length
    // 还没轮到的（202 + queued）：服务端在后台一台机器一个地往下推，不算成功也不算失败。
    const waiting = results.filter((r) => r.queued).length
    const bad = results.filter((r) => !r.busy && !r.queued && (r.error || r.status === 'error')).length
    const tail =
      (held ? t(`，${held} 个有会话在跑没换`, `, ${held} skipped (busy)`) : '') +
      (waiting ? t(`，${waiting} 个在后台排队`, `, ${waiting} queued in the background`) : '')
    if (!results.length) flash('ok', t('没有需要更新的席位', 'No seats needed updating'))
    else
      flash(
        bad && !ok && !waiting ? 'err' : 'ok',
        t(`更新 ${data.version}：成功 ${ok}，失败 ${bad}`, `Updated ${data.version}: ${ok} ok, ${bad} failed`) + tail,
      )
    await loadCompanyDetail(org)
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.updatingRuntime = false
    render()
  }
}

/* ── 安装进度的轮询 ──────────────────────────────────────────────────
   建完 Bot 之后自动开装（见 routes/runtime.ts 的 POST /runtime/bots），装完这一页要
   **自己**变成对话——让人为了知道「好了没有」去刷新页面，等于把刚省掉的那一次点击
   又还回去。 */

/** 两秒一轮。管家那份进度也就这个粒度（一步一变），再密只是白问。 */
const DEPLOY_WATCH_MS = 2000
let deployWatchTimer = null
let deployWatchBound = false

/**
 * 该不该转：这一页对着的那颗 Bot 正在装（或者刚建完、席位行还没落库）。
 *
 * 装完就停——**这不是一个长明的定时器**。一台已经好了的机器上每两秒问一次「装到哪儿
 * 了」，问的是一件没有答案的事，而它还要一路敲到那台机器上去。
 */
function ensureDeployWatch() {
  const want = !isOwner() && isChatPath(state.path) && Boolean(chatBotIdNow()) && seatStage() === 'deploying'
  if (want && !deployWatchTimer) {
    deployWatchTimer = setInterval(() => {
      if (document.hidden) return
      void pollDeployProgress()
    }, DEPLOY_WATCH_MS)
    // Node 环境（e2e 垫片）下别拽着进程不退出；浏览器里 setInterval 是数字，没有 unref。
    if (deployWatchTimer && typeof deployWatchTimer.unref === 'function') deployWatchTimer.unref()
    // 第一轮**当场就问**，不等这两秒：进这一页的那一瞬间，屏幕上那份进度可能是几分钟
    // 前留下的（换页回来、刷新过），而人正是为了看它才进来的。
    void pollDeployProgress()
    // 切回前台补一次，理由同待办和席位那两条轮询：后台标签页里不转，回来时立刻补上
    // 那一眼。**只挂一次**——这个函数每次 render 都会跑到。
    if (!deployWatchBound) {
      deployWatchBound = true
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && deployWatchTimer) void pollDeployProgress()
      })
    }
  } else if (!want && deployWatchTimer) {
    clearInterval(deployWatchTimer)
    deployWatchTimer = null
  }
}

/**
 * 上一轮还没跑完。**这道闸非有不可。**
 *
 * 收尾那一段（拉席位、拉名册、接会话）比两秒长是常事——尤其席位刚 ready、bot 进程还
 * 没上线的时候，正是这一段最慢的时刻。没有闸的话下一次 tick 会叠进来再跑一遍收尾，而
 * `ensureChatSession` 的第一句是 `cancelSessionRetry()`：它会把上一轮排好的退避重试取
 * 消掉，紧接着自己再发一次——退避于是被换成每两秒一记的硬打，而这条路是要经管家转到
 * 席位机器上去的。
 */
let deployPolling = false

/**
 * 问一次「装到哪一步了」，装好了就把这一页接上。
 *
 * **进度拉不动不清空 state.deployProgress**：一次网络抖动会让这一屏从「第 3 步 · 安装
 * 浏览器」跳回「还没有部署」外加一颗按钮——而机器上什么都没变。宁可让那个读秒继续走。
 */
async function pollDeployProgress() {
  const id = chatBotIdNow()
  if (!id || isOwner() || deployPolling) return
  deployPolling = true
  try {
    await runDeployPoll(id)
  } finally {
    deployPolling = false
  }
}

async function runDeployPoll(id) {
  let data
  try {
    data = await api('GET', '/runtime/deploy/progress?botId=' + encodeURIComponent(id))
  } catch {
    return
  }
  // 这一份是给 `id` 拉的。人在等待期间换了 Bot 的话，认领它就是把别人的进度画在这一页上。
  if (chatBotIdNow() !== id) return
  const before = deployProgressNow()
  /**
   * **年龄在收到的这一刻锚成本地时刻**，此后读秒走的是本机时钟。
   *
   * 服务端给的是「已经装了多久」而不是「什么时候开始的」（见 `/runtime/deploy/progress`）：
   * 员工的电脑和 Gateway 差几分钟是常事，拿绝对时刻自己减本地时钟，一台快十分钟的电脑
   * 会在刚按下「创建」的那一秒写出「已经装了 10:03」。
   *
   * 锚点**只在这里算一次**：每轮轮询都重锚的话，网络抖一下这个数就会往回跳，而人正盯着
   * 它判断「是不是卡住了」。同一次安装（状态还是 deploying、上一轮也是）就沿用上一次的
   * 锚点，只有换了一次安装才重新锚。
   */
  const keepAnchor = before && before.status === 'deploying' && data.status === 'deploying' && before.since
  const age = Number(data.elapsedMs)
  const since = keepAnchor || (Number.isFinite(age) ? Date.now() - Math.max(0, age) : 0)
  state.deployProgress = { botId: id, ...data, since }
  if (data.status === 'deploying') {
    // 装的过程中不整页重绘：那一屏上只有两处会动（第几步、读秒），而读秒自己每秒走
    // （tickClocks）。步骤没变就一个字都不用改。
    const same = before && before.status === 'deploying' && stepKeyOf(before) === stepKeyOf(state.deployProgress)
    if (!same) render()
    ensureClockTick()
    return
  }
  // 落地了（ready / error / none）：把席位那一份、名册那一份都换成新的，再整页重绘。
  await loadDesktopRuntime(id)
  await loadRuntimeBots().catch(() => {})
  if (data.status === 'ready') {
    state.runtimeError = ''
    state.deployHint = ''
    // 会话要现开一条：这颗 Bot 是刚装好的，之前每一次 ensureChatSession 都撞在 503 上。
    //
    // 吞掉它抛的那几种（这颗 Bot 不是你的、已经删了）：这是一条**定时器**里的调用，
    // 没有人接着这个 promise，抛出去只会变成一条 unhandled rejection；而这一页该说的
    // 话由下面的 render 按 state 画，不靠这次异常。
    await ensureChatSession(id).catch(() => {})
  }
  ensureDeployWatch()
  render()
}

/** 「这一屏此刻画的是什么」的身份。一个字都没变就没必要重绘。 */
function stepKeyOf(p) {
  const s = p && p.step
  // stale 也在里面：它一翻，这一屏就从「正在安装」换成「上一次安装没做完」，
  // 而 phase 和 step 那时通常一个都没动——漏掉它就是那句话永远换不过来。
  return (p && p.phase) + '/' + (p && p.stale ? 'stale' : 'live') + '/' + (s ? s.step + '/' + s.total + '/' + s.label : '-')
}

async function deployMyRuntime(botId, opts = {}) {
  const id = botId || chatBotIdOf(state.path) || state.chatBotId
  if (state.deploying || isOwner() || !id) return
  /**
   * **手上那份进度先扔掉。**
   *
   * 它可能正写着「上一次安装没做完」——而人按的正是那颗「重新部署」。留着它，seatStage
   * 会一直照它说话（进度那一份优先），于是这一次装完了，屏幕上还挂着上一次没做完的那
   * 句话，按钮也还是那颗。下一轮轮询会把新的那份填回来。
   */
  if (state.deployProgress && state.deployProgress.botId === id) state.deployProgress = null
  state.deploying = true
  state.deployHint = opts.update ? '正在重新部署…' : '正在部署…'
  render()
  try {
    // `update` 不能省：席位已经是 ready 且版本没变时，服务端会直接把现状还回来，
    // 什么都不做——那样「重新部署」这个按钮就成了摆设。
    const body = { botId: id }
    if (opts.update) body.update = true
    const started = await api('POST', '/runtime/deploy', body)
    /**
     * **服务端等不到装完就先回了（202 + installing）。** 首装要 apt 十几分钟，那条请求以前
     * 一直挂到装完，在 Vercel 上必然 504——界面说「部署失败」，机器上装得好好的。现在它
     * 只等一小会儿，剩下的交给进度轮询（和建完 Bot 那一屏同一套，见 ensureDeployWatch）。
     * 另一个人 / 另一个标签页已经在装（`already`）也走这里：这次什么都没发，接着看那一次。
     */
    if (started && started.installing) {
      if (chatBotIdNow() === id) {
        state.desktopRuntime = started
        state.desktopRuntimeAt = Date.now()
      }
      state.deployHint = ''
      flash('ok', started.already ? t('已经在装了，装完这一页会自己接上') : t('已开始安装，装完这一页会自己接上'))
      await loadRuntimeBots().catch(() => {})
      ensureDeployWatch()
      return
    }
    const startAt = Date.now()
    // 部署结果按这一份说话，不看 state.desktopRuntime——那一份可能已经是别的 Bot 的了。
    let last = null
    while (Date.now() - startAt < 15000) {
      try {
        const rt = await api('GET', '/runtime/desktop?botId=' + encodeURIComponent(id))
        last = rt
        // 人在这十几秒里换了 Bot 的话，这一份就不能往 state 上写：desktopRuntime 是
        // remountDesktop 拿去挂屏的那一份，写进去等于把这个 Bot 的桌面挂到另一个
        // Bot 的对话页上（loadDesktopRuntime 里那道同样的门就是为这个立的）。
        if (chatBotIdNow() === id) {
          state.desktopRuntime = rt
          state.desktopRuntimeAt = Date.now()
        }
        if (rt.status === 'ready' || rt.status === 'error') break
      } catch {}
      await new Promise((r) => setTimeout(r, 400))
    }
    await loadRuntimeBots()
    if (state.chatBotId === id || chatBotIdOf(state.path) === id) {
      state.runtimeError = ''
      await ensureChatSession(id)
    }
    if (last && last.status === 'error') {
      state.deployHint = last.lastError || '部署失败'
    } else if (!state.runtimeError) {
      state.deployHint = ''
      flash('ok', '已部署')
    } else {
      state.deployHint = '已登记，实例还在上线'
    }
  } catch (err) {
    state.deployHint = err.message
    flash('err', err.message)
  } finally {
    state.deploying = false
    render()
  }
}
