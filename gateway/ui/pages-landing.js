/**
 * 首页：**没登录的人进来看到的第一屏**。
 *
 * 以前 `/` 对着一个没有票的人只有登录表单。可这台 Gateway 的地址会被发给还没开通的
 * 人（销售发过去、员工转给同事、管理员叫人来装桌面端），他们打开只看见两个输入框，
 * 一句「这是什么」都没有——而这个产品恰恰不是一眼就懂的那类。
 *
 * 所以 `/` 让给这一屏，登录挪到 `/login`。分工：
 *
 *   /        没票 → 这一屏；有票 → 照旧是概览 / 对话（见 render.js）
 *   /login   登录表单。桌面壳里 `/` 也直接给它——壳子是应用，不是网站，
 *            开机第一件事就是连回自己那台 Gateway，没有「先了解一下」这一步
 *
 * 文案就地给中英两版（`t('中文', 'English')`），不进 i18n.js 的译表：那份表是给
 * 「定义在模块级 const 里、加载时就求值」的标签用的（见 i18n.js 开头），而这一屏
 * 整个是渲染时才拼的字符串，就地写反而看得见上下文。
 */

/**
 * GitHub 那只猫。**不走 svg()**——那个助手画的是描边图标（fill:none + stroke），
 * 而这只猫是一整块实心路径，套进去只会得到一团糊住的线。
 */
const LP_ICON_GITHUB =
  '<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>'

/** 源码在哪儿。头上那颗 GitHub 指这里。 */
const LP_REPO = 'https://github.com/effortson/satuwork'

/**
 * 联系销售的 WhatsApp。**现在这一组是占位的示例，上线前必须换掉。**
 *
 * 号码用的是 `+1 555 555 0100`：555 区号在北美号码计划里根本不分配，所以扫出来通向
 * 一个不存在的账号，而不是某个倒霉的陌生人——占位的号码必须是**注定打不通**的那种，
 * 随手写一串数字有可能正好是真人的。
 *
 * 换成真号要动两处，两处都改才算换完：
 *
 *   1. 这三个常量（号码、显示用的写法、wa.me 地址跟着 LP_SALES_WA 走）
 *   2. `gateway/ui/assets/sales-whatsapp.svg` —— 二维码是**图**，不跟着常量变。重新生成：
 *      `cd gateway/ui/assets && npx qrcode -t svg -e M -o sales-whatsapp.svg "https://wa.me/<新号码>"`
 *
 * 只改常量不换图的结果最坏：页面上写着新号，扫出来还是旧的——而没人会去扫自己页面上
 * 的二维码。所以弹窗里那句「示例二维码」是**故意留着**的，它是这件事没做完的唯一提示；
 * 换完了连同 LP_SALES_PLACEHOLDER 一起去掉。
 */
const LP_SALES_WA = '15555550100'
const LP_SALES_SHOW = '+1 555 555 0100'
const LP_SALES_PLACEHOLDER = true

/** 首页的图标。和侧栏那套 ICONS 分开——那套是 17px 的菜单图标，这里是 20px 的题图。 */
const LP_ICONS = {
  roster: ['M4 5h9a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M7 9h3', 'M7 13h3', 'M18 8v8', 'M21 8v8'],
  machine: [
    'M4 4h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
    'M4 14h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z',
    'M7 7.5h.01',
    'M7 17.5h.01',
  ],
  skills: ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'],
  plug: ['M9 2v6', 'M15 2v6', 'M6 8h12v4a6 6 0 0 1-6 6 6 6 0 0 1-6-6z', 'M12 18v4'],
  channels: ['M4 12a8 8 0 0 1 16 0', 'M12 4v4', 'M8 12h8', 'M6 18h12'],
  handoff: ['M9 11V4.5a1.5 1.5 0 0 1 3 0V11', 'M12 11V3.5a1.5 1.5 0 0 1 3 0V11', 'M15 11V5.5a1.5 1.5 0 0 1 3 0V13a7 7 0 0 1-7 7h-1a7 7 0 0 1-7-7v-1.5a1.5 1.5 0 0 1 3 0V13'],
  routines: ['M12 3a9 9 0 1 0 9 9', 'M12 7v5l3 2', 'M21 3v5h-5'],
  ledger: ['M2 5h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M1 10h22'],
  // 联系销售那颗：一个带尾巴的气泡。和 chat 那个方形气泡分得开——那是「对话」，这是「找人」。
  sales: ['M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.9-.9L3 20.5l1.6-4.8A8.4 8.4 0 0 1 3.6 11a8.4 8.4 0 0 1 8.4-8.4 8.4 8.4 0 0 1 9 8.4z', 'M8.5 11h.01', 'M12 11h.01', 'M15.5 11h.01'],
}

/**
 * 一张能力卡：**上面是一块小样，下面一句话**。
 *
 * 原先是「图标 + 标题 + 两句说明」，八张排下去整页就是一片字，谁也不会读第三张。
 * 现在说明由那块小样自己承担——「他真的有一台机器」画一个带文件和终端的窗口，比
 * 写一句「一个席位一个 Linux 账号，自己的工作区、终端和浏览器」快得多。
 *
 * 小样是 `aria-hidden` 的装饰：标题和那一句已经把话说完，读屏的人不必再听一遍
 * 假的文件名。
 */
function lpCard(shot, title, line) {
  return `<div class="satu-lp-card">
    ${/* 角上那颗十字是图纸上的定位记号，纯装饰——四张卡因此看着是「同一张图上的
          四格」，而不是四个各自为政的方块。 */ ''}
    <span class="satu-lp-tick" aria-hidden="true"></span>
    <div class="satu-lp-cardshot" aria-hidden="true">${shot}</div>
    <h3>${esc(title)}</h3>
    <p>${esc(line)}</p>
  </div>`
}

/**
 * 底下那条能力带：一个图标一个词，**没有说明**。
 *
 * 这几样单开一张卡不值当（说一句就完），可整个不提又缺一块。排成一条被竖线切成四格
 * 的窄带，人扫过去知道「还有这些」就够了。
 *
 * 类名是 `satu-lp-specitem` 而**不是** `satu-lp-chip`：后者是气泡里那几颗工具痕迹
 * （lpDemoMsg）。两边原来同名，app.css 里后写的那条把气泡里那几颗一起撑成了描边
 * 药丸——气泡里于是浮着两个和「这条带」一模一样的东西。
 */
function lpChip(icon, label) {
  return `<div class="satu-lp-specitem">
    <span class="satu-lp-chipicon">${svg(LP_ICONS[icon], 17)}</span>
    <span>${esc(label)}</span>
  </div>`
}

/**
 * 「怎么开始」里的一步。序号是排版的一部分，所以留在这儿而不是交给 <ol>。
 *
 * 补成两位（01/02/03）：这一格里序号是最大的那个字，一位数的「1」在 38px 上瘦成
 * 一根竖线，三格排过去像三条杠；补一位之后它才是一个**数**。
 */
function lpStep(n, title) {
  return `<li class="satu-lp-step">
    <span class="satu-lp-tick" aria-hidden="true"></span>
    <span class="satu-lp-stepnum">${String(n).padStart(2, '0')}</span>
    <h3>${esc(title)}</h3>
  </li>`
}

/** 小样窗口的标题栏：三颗灯 + 一行标题。四块小样共用。 */
function lpWinBar(title) {
  return `<div class="satu-lp-winbar"><i></i><i></i><i></i><span>${esc(title)}</span></div>`
}

/** 工作区：文件留在机器上，命令在机器上跑。 */
function lpMockWork() {
  const files = [
    [t('refunds-2026-09.csv', 'refunds-2026-09.csv'), t('47 行', '47 rows')],
    [t('对账结果.md', 'reconciliation.md'), t('刚写完', 'just now')],
    [t('check-refunds.mjs', 'check-refunds.mjs'), '2.1 KB'],
  ]
  return `<div class="satu-lp-win">
    ${lpWinBar('~/work')}
    <div class="satu-lp-winbody">
      ${files
        .map(
          ([name, meta]) => `<div class="satu-lp-file">
        ${svg(['M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z', 'M14 3v4h4'], 13)}
        <span>${esc(name)}</span><em>${esc(meta)}</em>
      </div>`,
        )
        .join('')}
      <div class="satu-lp-term"><b>$</b> node check-refunds.mjs<i class="satu-lp-caret"></i></div>
    </div>
  </div>`
}

/** 拍板：该你点头的那一步，他停在那儿。 */
function lpMockApprove() {
  return `<div class="satu-lp-appr">
    <span class="satu-lp-apprtag">${ICON_SHIELD}${t('要你拍板', 'Needs your call')}</span>
    <p>${esc(t('把这 3 单退款提交给财务？', 'Submit these 3 refunds to finance?'))}</p>
    <div class="satu-lp-apprbtns">
      <span data-yes>${t('批准', 'Approve')}</span>
      <span>${t('先别', 'Hold')}</span>
    </div>
  </div>`
}

/** 日常任务：到点自己开工。 */
function lpMockCron() {
  const rows = [
    [t('每天 08:30', 'Daily 08:30'), t('对一遍昨天的账', 'Reconcile yesterday'), 'ok'],
    [t('每周一 09:00', 'Mon 09:00', ), t('出上周的周报', 'Weekly report'), 'ok'],
    [t('每 2 小时', 'Every 2h'), t('巡一遍收件箱', 'Sweep the inbox'), 'run'],
  ]
  return `<div class="satu-lp-win">
    ${lpWinBar(t('日常任务', 'Routines'))}
    <div class="satu-lp-winbody">
      ${rows
        .map(
          ([when, what, state]) => `<div class="satu-lp-cron">
        <span class="satu-lp-cronwhen">${esc(when)}</span>
        <span class="satu-lp-cronwhat">${esc(what)}</span>
        <span class="satu-lp-shotdot" data-state="${state === 'run' ? 'busy' : 'idle'}"></span>
      </div>`,
        )
        .join('')}
    </div>
  </div>`
}

/** 账本：钱花在哪儿了，一眼。 */
function lpMockLedger() {
  // 高度是排版数字，不是真数据——所以写死在这儿，别让人以为它连着什么。
  const bars = [38, 52, 30, 66, 44, 78, 58]
  return `<div class="satu-lp-win">
    ${lpWinBar(t('本月花费', 'This month'))}
    <div class="satu-lp-winbody satu-lp-ledger">
      <div class="satu-lp-bars">${bars.map((h) => `<i style="height: ${h}%"></i>`).join('')}</div>
      <div class="satu-lp-ledgerfoot">
        <b>$1,284</b>
        <span>${esc(t('模型 · 连接器 · 搜索', 'Models · connectors · search'))}</span>
      </div>
    </div>
  </div>`
}

/**
 * 首屏右边那块。**不是图，是一块能点的演示。**
 *
 * 原来这儿是一张画出来的小样（静态的产品截图替身）。可这个产品的形状恰恰是「左边
 * 一份名册，点谁就是谁那条长对话」——那件事光看一张定格的图看不出来，得手上点一下
 * 才知道。所以名册那三行是真的按钮：点一行，右边整条对话跟着换。
 *
 * 对话内容是**排好的演示稿**（lpDemos），不连后端、也不会有第四句冒出来。这一屏上
 * 还没有人登录，没有会话可连；写成假装在对话的样子反而是在骗人。名册上那三个名字
 * 和状态点用的是和真界面同一套词（空闲 / 正在执行 / 待人工处理）。
 *
 * 换人只重画右半边（paintLpDemo），不走 render()：整页 innerHTML 换掉的话，文档滚动
 * 位置会跟着抖一下，而人此刻的手正停在名册上。
 */

/**
 * 演示稿。t() 要在渲染时才求值，所以是函数不是常量——切语言之后这几句得跟着换。
 *
 * `turns` 里一条消息是 `{ me, text, at, chips }`：`me` 是「这句是人说的」，`at` 是气泡
 * 底下那行时间，`chips` 是**气泡里面**那几颗工具痕迹（真界面里它们就长在气泡里，见
 * chat.css 的 .sw-chips——浮在气泡外面是另一种东西）。
 */
function lpDemos() {
  return [
    {
      id: 'support',
      name: t('小满 · 客服', 'Mia · Support'),
      role: t('客服席位', 'Support seat'),
      snip: t('3 封工单回完了', '3 tickets answered'),
      state: 'busy',
      live: t('正在执行', 'Working'),
      turns: [
        { me: 1, at: '09:12', text: t('把这个月的退款单核一遍，有拿不准的先别动。', 'Go through this month’s refunds — hold anything you’re unsure about.') },
        {
          me: 0,
          at: '09:26',
          text: t('47 单核完了。3 单金额对不上，我停在那儿等你拍板。', 'All 47 checked. 3 don’t add up — I stopped and left them for you.'),
          chips: [t('读了 refunds-2026-09.csv', 'Read refunds-2026-09.csv'), t('跑了对账脚本', 'Ran the reconcile script')],
        },
        { me: 1, at: '09:27', text: t('那三单发我看看。', 'Send me those three.') },
      ],
    },
    {
      id: 'ops',
      name: t('阿橙 · 运营', 'Orin · Ops'),
      role: t('运营席位', 'Ops seat'),
      snip: t('昨夜的对账好了', 'Reconciliation done'),
      state: 'idle',
      live: t('空闲', 'Idle'),
      turns: [
        { me: 1, at: '18:40', text: t('周报还是老样子，明早上班前发我。', 'Same weekly report as always — on my desk before I’m in.') },
        {
          me: 0,
          at: '18:41',
          text: t('已经设成每周一 09:00 自己跑了。昨夜那版在工作区里，你要现在看也行。', 'Set to run Mondays at 09:00. Last night’s draft is in the workspace if you want it now.'),
          chips: [t('新建了日常任务', 'Created a routine'), t('写了 周报-w37.md', 'Wrote weekly-w37.md')],
        },
      ],
    },
    {
      id: 'research',
      name: t('小雨 · 研究', 'Yu · Research'),
      role: t('研究席位', 'Research seat'),
      snip: t('在等人接手', 'Needs a human'),
      state: 'review',
      live: t('待人工处理', 'Needs a human'),
      turns: [
        { me: 1, at: '11:03', text: t('找一下这三家同行最近半年的定价改动。', 'Find pricing changes at these three competitors over the last six months.') },
        {
          me: 0,
          at: '11:19',
          text: t('两家拿到了。第三家要登录才看得到价目表——这一步我交给人。', 'Got two. The third hides its price list behind a login — handing that step to a human.'),
          chips: [t('搜了 9 次', '9 searches'), t('读了 14 个网页', '14 pages read')],
        },
      ],
      handoff: t('已转人工：需要一次登录', 'Handed off: needs a sign-in'),
    },
  ]
}

/** 当前选中第几个。没点过就是第一个。 */
function lpDemoAt() {
  const n = Number(state.lpDemo) || 0
  const all = lpDemos()
  return all[Math.min(Math.max(0, n), all.length - 1)]
}

/**
 * 一条消息。**照着真界面那条来**（chat.css 的 .sw-msg）：头像在外，气泡和时间在一列
 * 里，人说的那一侧整行反过来。这三样任缺一样，它就从「一条对话」退回成「两个方块」。
 */
function lpDemoMsg(m, who) {
  return `<div class="satu-lp-msg" data-role="${m.me ? 'user' : 'assistant'}">
    <span class="satu-lp-face">${esc(m.me ? t('我', 'Me') : who)}</span>
    <div class="satu-lp-col">
      <div class="satu-lp-bubble" data-role="${m.me ? 'user' : 'assistant'}">
        <span>${esc(m.text)}</span>
        ${
          m.chips && m.chips.length
            ? `<span class="satu-lp-chips">${m.chips
                .map((c) => `<span class="satu-lp-chip">${svg(['M20 6 9 17l-5-5'], 12)}<span>${esc(c)}</span></span>`)
                .join('')}</span>`
            : ''
        }
      </div>
      <span class="satu-lp-time">${esc(m.at)}</span>
    </div>
  </div>`
}

/**
 * 右半边整块：会话抬头 + 那条对话。换人时就地换掉的就是这一段——抬头上的名字和
 * 那颗在线灯也跟着换，所以它和消息一起进这个函数，不能只换底下的消息。
 */
function lpDemoPane() {
  const d = lpDemoAt()
  const who = d.name.slice(0, 1)
  return `<div class="satu-lp-convohead">
      <span class="satu-lp-face" data-big>${esc(who)}</span>
      <span class="satu-lp-convoid">
        <b>${esc(d.name)}</b>
        <span>${esc(d.role)}</span>
      </span>
      <span class="satu-lp-live" data-state="${esc(d.state)}"><i></i>${esc(d.live)}</span>
    </div>
    <div class="satu-lp-thread">
      ${d.turns.map((m) => lpDemoMsg(m, who)).join('')}
      ${
        d.handoff
          ? `<div class="satu-lp-handoff">${svg(LP_ICONS.handoff, 14)}<span>${esc(d.handoff)}</span></div>`
          : ''
      }
    </div>
    ${lpComposer()}`
}

/**
 * 对话底下那个输入框。少了它，右半边看着像一张截了一半的图——真界面里这块屏的下沿
 * 永远是输入框。
 *
 * **它整个是一颗按钮，点下去去登录**，不是一个 `<textarea>`。摆一个真能打字的框在
 * 这儿只有两条路：打完没反应（那是个骗人的控件），或者接一句编好的回复（那是假装
 * 有人在答）。两条都不做。做成按钮之后它既补上了那道下沿，本身又是一条通往登录的
 * 路——人想「试试看」的那一下，正好就该落在这儿。
 *
 * 右边那句「登录后开始」是明说：手还没落下去就知道这不是一个能打字的框。
 */
function lpComposer() {
  return `<button type="button" class="satu-lp-composer" data-act="go" data-href="/login"
    aria-label="${esc(t('登录后开始对话', 'Sign in to start a conversation'))}">
    <span class="satu-lp-iconbtn">${ICON_CLIP}</span>
    <span class="satu-lp-composer-ph">${esc(t('交代点什么…', 'Give it something to do…'))}</span>
    <span class="satu-lp-composer-hint">${esc(t('登录后开始', 'Sign in to start'))}</span>
    <span class="satu-lp-send">${ICON_SEND}</span>
  </button>`
}

/** 换人：只换右半边和名册上的选中态，不重绘整页。 */
function paintLpDemo() {
  const main = document.getElementById('satu-lp-demo')
  if (main) main.innerHTML = lpDemoPane()
  const at = lpDemoAt()
  for (const row of document.querySelectorAll('[data-demo-row]')) {
    const on = row.getAttribute('data-demo-row') === at.id
    row.setAttribute('aria-pressed', String(on))
    row.setAttribute('data-on', String(on))
  }
}

function lpShot() {
  const at = lpDemoAt()
  return `<div class="satu-lp-shot">
    ${/* 这一组是真的按钮，所以它得有个名字——读屏的人听到的是「Satuwork 界面演示，
          三个按钮」，而不是一堆没头没尾的人名。 */ ''}
    <div class="satu-lp-shotside" role="group" aria-label="${esc(t('Satuwork 界面演示：换一个 AI 员工看看', 'Satuwork demo: switch between AI coworkers'))}">
      ${lpDemos()
        .map(
          (d, i) => `<button type="button" class="satu-lp-shotrow" data-act="landing-demo" data-i="${i}"
        data-demo-row="${esc(d.id)}" data-on="${d.id === at.id}" aria-pressed="${d.id === at.id}"
        ${/* 名字在窄屏上是 display:none 的（见 app.css 的 560 那段），光靠可见文字的话
              手机上这三颗就是三个没有名字的按钮。名字写在 aria-label 上，藏不藏都在。 */ ''}
        aria-label="${esc(d.name)}">
        <span class="satu-lp-shotface">${esc(d.name.slice(0, 1))}</span>
        <span class="satu-lp-shottext">
          <span class="satu-lp-shotname"><i class="satu-lp-shotdot" data-state="${d.state}"></i><b>${esc(d.name)}</b></span>
          <span class="satu-lp-shotsnip">${esc(d.snip)}</span>
        </span>
      </button>`,
        )
        .join('')}
      <span class="satu-lp-shothint">${esc(t('点一个试试', 'Pick one'))}</span>
    </div>
    <div class="satu-lp-shotmain" id="satu-lp-demo">${lpDemoPane()}</div>
  </div>`
}

/**
 * 「联系销售」弹窗：一张 WhatsApp 二维码，底下是号码和一条点得开的 wa.me 链接。
 *
 * **二维码和链接两样都给**，因为这一页两种人都会打开：坐在电脑前的人用手机扫，用
 * 手机打开这一页的人扫不了自己的屏幕——那条链接就是给他的，点一下直接进 WhatsApp。
 * 只放二维码的话，一半的访客对着它没办法。
 *
 * 二维码是一张**静态 SVG**（assets/sales-whatsapp.svg），不在浏览器里现算：现算要拉
 * 一个编码库进来（CSP 的 script-src 只放 self 和那个 CDN），而这张图一年也不会变一次。
 * SVG 不是 PNG：它在任何缩放下都是干净的方块，扫得稳。
 *
 * 底色写死白的、模块写死黑的，**暗色主题下也不跟着反**——反色的二维码有相当一部分
 * 扫码器读不出来。所以给它包一层白底的圆角框，让它在深色页面上看着是「一张卡片」，
 * 而不是一块没适配的白斑。
 */
function lpSalesModal() {
  if (!state.salesOpen) return ''
  const href = `https://wa.me/${LP_SALES_WA}`
  return `
    <div class="gw-modal-backdrop" data-act="landing-sales-close">
      <div class="gw-modal satu-lp-salesbox" data-act="landing-sales-dialog" role="dialog" aria-modal="true" aria-labelledby="lp-sales-title">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h2 id="lp-sales-title" style="font-size: 20px; margin: 0 0 4px;">${t('联系销售', 'Contact sales')}</h2>
            <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t(
              '用手机扫一扫，直接在 WhatsApp 上聊。开通公司、席位和套餐都问他。',
              'Scan with your phone to talk on WhatsApp — provisioning, seats and plans.',
            )}</p>
          </div>
          <button type="button" class="btn btn-ghost btn-icon" style="flex: none;" data-act="landing-sales-close" aria-label="${esc(t('关闭'))}">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
        </div>
        <div class="satu-lp-qr">
          <img src="/assets/sales-whatsapp.svg" alt="${esc(t(`WhatsApp 二维码：${LP_SALES_SHOW}`, `WhatsApp QR code: ${LP_SALES_SHOW}`))}" width="180" height="180">
        </div>
        <div class="satu-lp-salesnum">
          <span>${esc(LP_SALES_SHOW)}</span>
          ${/* 手机上扫不了自己的屏幕，这条链接就是给他的。target/rel 和顶栏那颗 GitHub 同一套规矩。 */ ''}
          <a class="btn btn-primary" href="${esc(href)}" target="_blank" rel="noopener noreferrer">
            ${svg(LP_ICONS.sales, 15)}${t('在 WhatsApp 上打开', 'Open in WhatsApp')}
          </a>
        </div>
        ${
          LP_SALES_PLACEHOLDER
            ? `<p class="satu-lp-salesnote">${t(
                '示例二维码：号码是占位的，上线前换成销售的真号（见 pages-landing.js 的 LP_SALES_WA）。',
                'Placeholder QR — this number is a stand-in. Swap it for the real one before launch (see LP_SALES_WA in pages-landing.js).',
              )}</p>`
            : ''
        }
      </div>
    </div>`
}


/**
 * 文件放在哪儿：GitHub 上一个**固定的** Release，tag 是 `desktop-latest`。
 *
 * 每发一版桌面端，发版 CI（.github/workflows/desktop-release.yml 的「同步到 desktop-latest」
 * 那一步）把三个包改成不带版本号的名字，覆盖上传到这个 Release。所以这里的地址**永远
 * 不用改**：发了新版，按钮当场就指到新包上；自托管的 Gateway 不升级也一样拿到新包。
 * 每一版自己的 Release（`desktop-v<版本>`）照旧留着，要旧版去那儿找（见 dlHistory）。
 *
 * **不走 `releases/latest/download/`**：这个仓库里 bot、管家、本地 Bot、桌面端几条发布线
 * 共用一个 Release 列表，GitHub 的「Latest」只有一个，指的是别条线上最新的那个——本地 Bot
 * 发一版，桌面端的下载地址就跟着指到它的包上去了，而页面上看不出任何毛病。
 *
 * 写成函数而不是模块级常量，和 dlBuilds 一样在渲染时才拼。
 */
function dlBase() {
  return `${LP_REPO}/releases/download/desktop-latest`
}

/** 历次桌面端版本。页面上不印版本号（它读不到 desktop-latest 里现在是哪一版），要旧版的走这条。 */
function dlHistory() {
  return `${LP_REPO}/releases?q=desktop-v&expanded=true`
}

/** Windows 那只窗。不走 svg()——那个助手画描边图标，这几块是实心的。 */
const DL_ICON_WINDOWS =
  '<svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M0 2.27 6.51 1.4v6.29H0zm7.3-.98L15.99 0v7.6H7.3zM0 8.48h6.51v6.29L0 13.9zm7.3 0h8.69V16L7.3 14.72z"/></svg>'

/** macOS 那只苹果。同样是实心路径。 */
const DL_ICON_APPLE =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.05 12.54c-.02-2.4 1.96-3.55 2.05-3.61-1.12-1.64-2.86-1.86-3.48-1.89-1.48-.15-2.89.87-3.64.87-.75 0-1.91-.85-3.14-.83-1.61.02-3.1.94-3.93 2.38-1.68 2.91-.43 7.22 1.2 9.58.8 1.16 1.75 2.46 3 2.41 1.2-.05 1.66-.78 3.11-.78 1.45 0 1.86.78 3.13.75 1.29-.02 2.11-1.18 2.9-2.34.91-1.34 1.29-2.64 1.31-2.71-.03-.01-2.5-.96-2.53-3.83M14.7 5.1c.66-.8 1.11-1.92.99-3.03-.95.04-2.11.63-2.8 1.43-.61.71-1.15 1.85-1.01 2.94 1.07.08 2.16-.54 2.82-1.34"/></svg>'

/** 下载那支箭：一条线朝下，落在一根托盘上。 */
const DL_ICON_DOWN = ['M12 4v11', 'm7 11 5 5 5-5', 'M5 20h14']

/**
 * 每一档包：**平台、架构、文件名，一条一行**。
 *
 * 文件名是 Tauri 出包时的默认命名（`<productName>_<version>_<arch>.<后缀>`）**去掉版本号**
 * 那一截——desktop-latest 里的资产就是这么改名传上去的。**这张表和发版 CI 是一对**：
 * CI 那边改了资产名，这里跟着改，不然页面上每颗按钮都是 404。
 *
 * macOS 两档分芯片：Apple 芯片的包在 Intel 机器上装不起来，反过来能跑但是走 Rosetta。
 * 浏览器里**认不出 Mac 的芯片**（navigator 在 M 系上照样报 `MacIntel`），所以两档都
 * 摆出来、Apple 芯片排在前面，让人自己认一下——这是这一段里唯一要人动脑子的地方，
 * 所以那一行写了「关于本机」在哪儿看。
 */
function dlBuilds() {
  return [
    {
      os: 'windows',
      variant: t('64 位', '64-bit'),
      hint: t('Windows 10 及以上', 'Windows 10 and later'),
      file: 'Satuwork_x64-setup.exe',
      kind: t('安装程序 · .exe', 'Installer · .exe'),
    },
    {
      os: 'mac',
      variant: t('Apple 芯片', 'Apple silicon'),
      hint: t('M1 及以后的机型', 'M1 and later'),
      file: 'Satuwork_aarch64.dmg',
      kind: '.dmg',
    },
    {
      os: 'mac',
      variant: t('Intel 芯片', 'Intel'),
      hint: t('2020 年前后的旧机型', 'Older Intel Macs'),
      file: 'Satuwork_x64.dmg',
      kind: '.dmg',
    },
  ]
}

const DL_OS = {
  windows: { label: 'Windows', icon: DL_ICON_WINDOWS },
  mac: { label: 'macOS', icon: DL_ICON_APPLE },
}

/**
 * 这台电脑是什么系统。认不出来回空串。
 *
 * **先认 Mac 再认 Windows**：`Darwin` 里带着 `win` 三个字母，反过来判的话 Mac 会被
 * 认成 Windows——而那正是「自动检测」最丢脸的错法。
 *
 * `userAgentData.platform` 是新浏览器上唯一没被冻结的那个（Chrome 里 `navigator.platform`
 * 早就不动了），所以排在最前面；三样拼成一条一起匹配，少一样也还认得出来。iPhone、
 * iPad 上没有桌面端可装，落回空串，页面会照实说一句。
 *
 * **手机和平板要排在认 Mac 之前挑出去**：iPhone、iPad 的 UA 里都写着「like Mac OS X」，
 * iPadOS 默认还用桌面版网页模式、自称 Macintosh——只看字样的话它们全被认成 Mac，页面还会
 * 说「看起来你正用的就是这个系统」，把一个装不上的 .dmg 摆到人面前。桌面版网页模式下
 * 连 UA 都和 Mac 一模一样，只有触点数露馅：Mac 没有触摸屏。
 */
function dlDetect() {
  const nav = typeof navigator === 'object' && navigator ? navigator : {}
  const hint = nav.userAgentData && typeof nav.userAgentData.platform === 'string' ? nav.userAgentData.platform : ''
  const raw = `${hint} ${nav.platform || ''} ${nav.userAgent || ''}`
  if (/iphone|ipad|ipod|android|windows phone/i.test(raw)) return ''
  if (/macintosh|macintel/i.test(raw) && Number(nav.maxTouchPoints) > 1) return ''
  if (/mac ?os|macintosh|darwin/i.test(raw)) return 'mac'
  if (/windows|win32|win64|wow64/i.test(raw)) return 'windows'
  return ''
}

/**
 * 这一帧摆哪个平台。人点过切换就听他的，没点过才去认。
 *
 * 认不出来（Linux、iPad、以及一切没见过的 UA）时摆 Windows——这一段里总得有个东西
 * 摆出来，空着一格比摆错更没用；卡片上另有一句话说明「没认出来」。
 */
function dlOs() {
  if (state.dlOs === 'windows' || state.dlOs === 'mac') return state.dlOs
  return dlDetect() || 'windows'
}

/**
 * 卡片顶上那排平台切换。**是按钮不是链接**：换的只是这一段里摆哪一档，地址不变。
 *
 * 自动认得对的时候它看着是多余的，而它恰恰是这一段的保险——在 Mac 上替同事下一个
 * Windows 包，靠的就是这排。
 */
function dlTabs(cur) {
  const one = (key) =>
    `<button type="button" data-act="download-os" data-os="${key}" aria-pressed="${cur === key}">
      ${DL_OS[key].icon}<span>${esc(DL_OS[key].label)}</span>
    </button>`
  return `<div class="satu-dl-tabs" role="group" aria-label="${esc(t('选择操作系统', 'Choose your operating system'))}">
    ${one('windows')}${one('mac')}
  </div>`
}

/**
 * 一档包那一行。**`<a download>` 真链接，不是 data-act 按钮**：右键「链接存储为」、
 * 中键、复制地址这几样是浏览器在链接上给的，而这一段恰恰有人要把地址复制给别人
 * （「你先把这个下下来」）。
 *
 * `primary` 是这一档里排第一的那个：按钮实心，其余的是描边。
 */
function dlRow(b, primary) {
  const href = `${dlBase()}/${b.file}`
  return `<a class="btn ${primary ? 'btn-primary' : 'btn-secondary'} satu-dl-get" href="${esc(href)}" download>
    ${svg(DL_ICON_DOWN, 16)}
    <span class="satu-dl-getin">
      <b>${esc(t(`下载 ${DL_OS[b.os].label} 版`, `Download for ${DL_OS[b.os].label}`))}${b.os === 'mac' ? esc(` · ${b.variant}`) : ''}</b>
      <em>${esc(`${b.kind} · ${b.hint}`)}</em>
    </span>
  </a>`
}

/**
 * 安装完第一步要填的那个地址：**就是这台 Gateway**。
 *
 * 桌面壳第一屏问「连哪台 Gateway」，而来下载的人多半答不上来——他手上只有一条被
 * 发过来的地址，而那条地址就在他的地址栏里。所以这里把它印出来。
 *
 * 取不到（不是 http/https 的源）就整块不画：印一条错地址比不印坏得多。
 */
function dlServerHint() {
  const base = gatewayBase() || (typeof location === 'object' && location && typeof location.origin === 'string' ? location.origin : '')
  if (!base || !/^https?:\/\//i.test(base)) return ''
  return `<p class="satu-dl-server">${t('第一次打开要填的服务器地址：', 'The server address it asks for on first launch:')}<code>${esc(base)}</code></p>`
}

/**
 * 右边那列说明里的一条。标题 + 一段话，`cmd` 给了的话底下再跟一行要照抄的命令
 * （等宽、点一下全选——那一行是要原样贴进终端的）。
 */
function dlNote(title, body, cmd) {
  return `<div class="satu-dl-note">
    <h3>${esc(title)}</h3>
    <p>${esc(body)}</p>
    ${cmd ? `<code class="satu-dl-cmd">${esc(cmd)}</code>` : ''}
  </div>`
}

/**
 * 下载桌面端那一段：**接在「怎么开始」那条深色带后面**，是首页正文的最后一段。
 *
 * 以前它是单独一页（`/download`）。现在并进首页：读完三步的人下一件事就是装客户端，
 * 放在同一页上往下一滚就到，不必再多开一页。老的 `/download` 地址还收着，进来会折到
 * 这一段上（见 app.js 的 boot 和 render.js 里 `state.lpJump` 那一句）。
 *
 * 版式：头上一段说明，底下左边一张大卡（当前平台的包），右边一列说明。
 */
function lpDownload() {
  const cur = dlOs()
  const builds = dlBuilds().filter((b) => b.os === cur)
  const guessed = dlDetect()
  return `<section class="satu-lp-wrap satu-lp-rail satu-lp-sec satu-lp-dl" id="download">
    <div class="satu-lp-sechead satu-lp-dlhead">
      <span class="satu-lp-kicker">${t('桌面端', 'Desktop app')}</span>
      <h2>${t('下载 Satuwork 桌面端', 'Download Satuwork for desktop')}</h2>
      <p>${t(
        '桌面端把界面装进本机，并且能在这台电脑上直接跑「本地」那种 AI 员工——他的工作区就是你电脑上的文件夹，对话不经过服务器。浏览器里用不到这一层，随时也可以直接登录网页版。',
        'The desktop app bundles the interface and runs “local” coworkers right on this machine — their workspace is a folder on your computer and those conversations never leave it. You can always use the web version instead.',
      )}</p>
      <p class="satu-lg-meta">${t('这里下到的总是最新版。', 'You always get the latest version here.')}${t('', ' ')}<a href="${esc(dlHistory())}" target="_blank" rel="noopener noreferrer">${t('历次版本', 'All versions')}</a></p>
    </div>

    <div class="satu-dl-grid">
      <div class="satu-dl-card">
        ${dlTabs(cur)}
        <div class="satu-dl-head">
          <span class="satu-dl-osicon" aria-hidden="true">${DL_OS[cur].icon}</span>
          <div>
            <h3>${esc(DL_OS[cur].label)}</h3>
            <p>${esc(
              guessed === cur
                ? t('看起来你正用的就是这个系统。', 'This looks like the system you are on.')
                : guessed
                  ? t('你正用的是另一个系统，这一档是给别的电脑准备的。', 'You are on the other system — this one is for a different machine.')
                  : t('没认出你的系统，上面那排可以自己切。', 'We could not detect your system — switch it above.'),
            )}</p>
          </div>
        </div>
        <div class="satu-dl-gets">
          ${builds.map((b, i) => dlRow(b, i === 0)).join('')}
        </div>
        ${
          cur === 'mac'
            ? `<p class="satu-dl-fine">${t(
                '不确定是哪种芯片？左上角苹果菜单 →「关于本机」，写着 Apple M 开头的选上面那个。',
                'Not sure which chip? Apple menu → “About This Mac”. Anything starting with Apple M takes the first one.',
              )}</p>`
            : ''
        }
        ${dlServerHint()}
        <p class="satu-dl-fine">${t('装不了也不耽误用：', 'Can’t install it? Nothing is lost: ')}<button type="button" class="satu-dl-weblink" data-act="go" data-href="/login">${t('直接用网页版登录', 'sign in to the web version')}</button>${t('，除了本地 AI 员工之外都一样。', ' — everything except local coworkers works the same.')}</p>
      </div>

      <div class="satu-dl-side">
        ${/* Mac 那条**不是「右键 → 打开」**：没签名的包下载下来带着隔离标记，系统报的是
              「已损坏」，右键打开绕不过去，只能在终端里把那个标记摘掉。和发版 CI 写进
              Release 说明里的是同一句（见 .github/workflows/desktop-release.yml）。 */ ''}
        ${dlNote(
          t('第一次打开会拦一下', 'The first launch gets blocked'),
          cur === 'mac'
            ? t(
                '这个包还没做苹果签名，打开时系统会说「已损坏，无法打开」——包本身没有坏。先把 Satuwork 拖进「应用程序」，再打开「终端」执行下面这一行，之后就能正常打开。只需要做一次。',
                'The build is not signed by Apple yet, so macOS says it is “damaged and can’t be opened” — it isn’t. Drag Satuwork into Applications, then run this line once in Terminal and it opens normally from then on.',
              )
            : t(
                '这个包还没做代码签名，SmartScreen 会挡一下。在那个蓝框里点「更多信息」→「仍要运行」——只有第一次要这么做。',
                'The build is not code-signed yet, so SmartScreen steps in. Click “More info” → “Run anyway” in that blue box. Only the first launch needs this.',
              ),
          cur === 'mac' ? 'xattr -dr com.apple.quarantine /Applications/Satuwork.app' : '',
        )}
        ${dlNote(
          t('账号还是原来那个', 'Same account as the web'),
          t(
            '桌面端不另开账号：填完服务器地址，用管理员给你开的那个邮箱和口令登录即可。没有账号就找公司管理员开通。',
            'The desktop app does not have its own accounts. After the server address, sign in with the email and password your admin gave you. No account yet? Ask your company admin.',
          ),
        )}
        ${dlNote(
          t('自己会升级的只有一半', 'Half of it updates itself'),
          t(
            '本地 AI 员工的运行时会自己在后台更新；外面这层应用还要手工换新版——所以升级的时候回首页这一段再下一次。',
            'The local coworker runtime updates itself in the background. The app shell around it still needs a new installer, so come back here to upgrade.',
          ),
        )}
        ${dlNote(
          t('Linux 暂时没有包', 'No Linux build yet'),
          t(
            'Linux 上的桌面端还没验过，暂时不发包。那边先用浏览器打开这台服务器，除了本地 AI 员工之外功能一样。',
            'The Linux desktop build is not verified yet, so we don’t ship one. Open this server in a browser there — everything except local coworkers is the same.',
          ),
        )}
      </div>
    </div>
  </section>`
}

/**
 * 切平台：只换这一段，不重绘整页（理由同 paintLpDemo——整页 innerHTML 一换，文档
 * 滚动跟着抖一下，而人正停在页面最底下）。换完把焦点还给刚按的那颗，键盘上的人不至于
 * 被扔回页首。这一段不在（不是首页）就退回整页重绘。
 */
function paintLpDownload(os) {
  const sec = document.getElementById('download')
  if (!sec) return render()
  sec.outerHTML = lpDownload()
  document.querySelector(`#download [data-act="download-os"][data-os="${os}"]`)?.focus()
}


/** 主 CTA 上那支箭。这一屏的按钮全是方的、字是大写的，箭头是它唯一的装饰。 */
const LP_ARROW = ['M5 12h14', 'm12 5 7 7-7 7']

/**
 * 首页本体。
 *
 * 版式是**一张图纸**（见 app.css 里 `.satu-lp` 那一段）：一条 1px 的栏线从顶栏画到
 * 页脚，每一块内容落在这条线圈出的格子里，格与格之间也只用一条线隔开。所以这里几乎
 * 每一段都带着 `satu-lp-rail`——那对左右边框接起来就是那两条竖线，少写一段，线就断
 * 在那儿。
 *
 * 唯一不带栏线的是 `.satu-lp-band` 那条深色带：它**通栏**，正因为它要打断那两条线，
 * 页面读到那儿才会停一下。
 *
 * 不套 `.gw-page`——那套是登录之后工作台里的内容区，外面有侧栏和顶栏兜着，滚动锁在
 * 它自己那一格里。这一屏没有外壳，滚的是文档本身（见 app.css 的 `.satu-lp`）。
 */
function landingView() {
  // 走 theme.css 那套药丸（.btn / .btn-primary），不另起一套方按钮：这颗点下去就是
  // /login，而那一屏上每一颗按钮都是圆头的。见 app.css 里 .satu-lp-ctas 那段。
  const cta = `<button type="button" class="btn btn-primary" data-act="go" data-href="/login">
    ${t('登录 Satuwork', 'Sign in to Satuwork')}${svg(LP_ARROW, 14)}
  </button>`
  return `
  <div class="satu-lp">
    <header class="satu-lp-top">
      ${/* 这一条**不收在栏线里**：横梁要横过整个屏幕，末端那格实心的「登录」才顶
            得到右沿（见 app.css 的 .satu-lp-topin）。 */ ''}
      <div class="satu-lp-wrap satu-lp-topin">
        <button type="button" class="satu-lp-brand" data-act="go" data-href="/">
          <img src="/assets/satuwork-logo.png" alt="Satuwork" width="28" height="28">
          <span>Satuwork</span>
        </button>
        <div class="satu-lp-topact">
          ${/* 源码。**一个真的 `<a>`，不是 data-act 按钮**——它要走出这个站，中键点开、
                右键复制地址这些都得照常能用，而那些是浏览器在链接上给的，不是我们
                在点击处理器里能补出来的。`rel` 那两个词是开新标签页的规矩：不给对面
                `window.opener`，也不把来路一起送过去。 */ ''}
          <a class="satu-lp-ghlink" href="${esc(LP_REPO)}" target="_blank" rel="noopener noreferrer"
            aria-label="${esc(t('在 GitHub 上看源码', 'Source on GitHub'))}" title="GitHub">${LP_ICON_GITHUB}</a>
          ${/* 语言只落本地（setLocale 写 localStorage），不打 /me——这一屏上还没有人。
                登录之后个人设置里那个开关会把它同步回账号。 */ ''}
          <div class="satu-lp-lang" role="group" aria-label="${esc(t('语言', 'Language'))}">
            <button type="button" data-act="landing-locale" data-locale="zh" aria-pressed="${localeMode !== 'en'}">中文</button>
            <button type="button" data-act="landing-locale" data-locale="en" aria-pressed="${localeMode === 'en'}">EN</button>
          </div>
          ${/* 联系销售。**不是链接是按钮**：它开的是一个弹窗（里面有二维码和号码），
                而不是跳去某处。手机上收成一颗只有图标的圆钮（见 app.css 的 560 那段）
                ——顶栏那一行在 375 宽上已经排着四样东西了。 */ ''}
          ${/* 名字写在 aria-label 上：窄屏上那四个字是 display:none 的，光靠可见文字的话
                手机上这就是一颗没有名字的按钮（名册那三行踩过同一个坑）。 */ ''}
          <button type="button" class="btn btn-secondary satu-lp-sales" data-act="landing-sales"
            aria-label="${esc(t('联系销售', 'Contact sales'))}" title="${esc(t('联系销售', 'Contact sales'))}">
            ${svg(LP_ICONS.sales, 15)}<span>${t('联系销售', 'Contact sales')}</span>
          </button>
          <button type="button" class="btn btn-primary satu-lp-topsign" data-act="go" data-href="/login">${t('登录', 'Sign in')}</button>
        </div>
      </div>
    </header>

    <section class="satu-lp-wrap satu-lp-rail satu-lp-hero">
      <div class="satu-lp-heroleft">
        <span class="satu-lp-kicker satu-lp-eyebrow">${t('给公司用的 AI 员工', 'AI coworkers for companies')}</span>
        <h1>${t('把活交出去，像交给一个同事。', 'Hand off the work the way you would to a colleague.')}</h1>
        ${/* 一句就够。首屏右边那块小样比三行字说得清楚，两个一起上只会互相抢。 */ ''}
        <p class="satu-lp-lead">${t(
          '给公司里的每个人配几个 AI 员工。他们有自己的机器，会用你们已经在用的系统，拿不准的那一步会停下来等你。',
          'A few AI coworkers for everyone in your company. Each has its own machine, works your existing systems, and stops for you when it isn’t sure.',
        )}</p>
        <div class="satu-lp-ctas">
          ${cta}
          <button type="button" class="btn btn-secondary" data-act="landing-more">${t('先看看它能做什么', 'See what it does')}</button>
        </div>
        ${/* 这一行以前只有前半句。下载那一段在页面最底下，首屏上一个字都不提的话，
              没人知道有这东西。所以补在这儿：一句话说清它多出来什么（本地那种 AI
              员工），外加一条路——点下去滚到页面底下那一段（lpDownload）。 */ ''}
        <p class="satu-lp-fine">${t('账号由公司管理员开通。', 'Accounts are created by your company admin.')}
          ${t('想让 AI 员工直接在自己电脑上干活，', 'Want a coworker running on your own machine? ')}<button type="button" class="satu-lp-finelink" data-act="landing-download">${t('下载桌面端', 'Get the desktop app')}</button>${t('。', '.')}</p>
      </div>
      <div class="satu-lp-heroright">${lpShot()}</div>
    </section>

    ${/* 能力带。四样单开一张卡不值当，排成一条被竖线切成四格的窄带就够了。它紧贴
          首屏底下，是那两条栏线上的第一道横隔——图纸从这儿开始有「行」。 */ ''}
    <section class="satu-lp-wrap satu-lp-rail satu-lp-spec" aria-label="${esc(t('还有这些', 'Also included'))}">
      ${lpChip('skills', t('Skill 与 MCP 分两层', 'Skills and MCP, two layers'))}
      ${lpChip('plug', t('连接器走 OAuth', 'Connectors over OAuth'))}
      ${lpChip('channels', t('Telegram 渠道直连', 'Telegram channels'))}
      ${lpChip('handoff', t('转人工待办', 'Human handoff queue'))}
    </section>

    <section class="satu-lp-wrap satu-lp-rail satu-lp-sec" id="satu-lp-features">
      <div class="satu-lp-sechead">
        <span class="satu-lp-kicker">${t('它能做什么', 'What it does')}</span>
        <h2>${t('它不是一个聊天框', 'It isn’t just a chat box')}</h2>
        <p>${t(
          '四件事分别是一台机器、一次拍板、一张排期表和一本账——都是交给同事之后你本来就会关心的那几件。',
          'A machine, a decision, a schedule and a ledger — the four things you’d ask about after handing work to anyone.',
        )}</p>
      </div>
      <div class="satu-lp-cards">
        ${lpCard(lpMockWork(), t('他真的有一台机器', 'It really has a machine'), t('自己的工作区、终端和浏览器', 'Its own workspace, terminal and browser'))}
        ${lpCard(lpMockApprove(), t('拿不准就停下来', 'Unsure? It stops'), t('该你点头的那一步，他等着', 'It waits on the step that needs you'))}
        ${lpCard(lpMockCron(), t('日常任务自己跑', 'Routines run themselves'), t('到点开工，半夜也在干活', 'On schedule, through the night'))}
        ${lpCard(lpMockLedger(), t('钱花在哪儿一眼看得见', 'See where the money went'), t('模型、连接器、搜索按次落账', 'Models, connectors, search — per call'))}
      </div>
    </section>

    ${/* 「怎么开始」那条深色带。**整页唯一一块深色，也是唯一一块通栏**：前面一路
          都是奶油底，读到这儿忽然暗一档，人自然会停一下——而要他停的正是这一段。
          所以它在 `.satu-lp-wrap` 外面，不带 satu-lp-rail。 */ ''}
    <section class="satu-lp-band">
      <div class="satu-lp-wrap satu-lp-bandin">
        <div class="satu-lp-sechead">
          <span class="satu-lp-kicker">${t('怎么开始', 'Getting started')}</span>
          <h2>${t('通常是一个下午的事。', 'Usually one afternoon.')}</h2>
        </div>
        <ol class="satu-lp-steps">
          ${lpStep(1, t('管理员开通公司和席位', 'An admin provisions company and seats'))}
          ${lpStep(2, t('在公司模版上建你的 Bot', 'You build your bot on the template'))}
          ${lpStep(3, t('像跟同事说话一样交代', 'You talk to it like a colleague'))}
        </ol>
        <div class="satu-lp-tail">
          ${cta}
          <span>${t('还没有账号？找管理员开通。', 'No account? Ask your admin.')}</span>
        </div>
      </div>
    </section>

    ${/* 下载桌面端。**紧接在三步后面**：读到这儿的人已经决定要用了，而「本地那种 AI
          员工」只有装了客户端才有——这是三步之后的第四件事。 */ ''}
    ${lpDownload()}

    ${lpSalesModal()}

    <footer class="satu-lp-foot">
      <div class="satu-lp-wrap satu-lp-footin">
        <span class="satu-lp-brand" data-static>
          <img src="/assets/satuwork-logo.png" alt="" width="20" height="20">
          <span>Satuwork</span>
        </span>
        ${/* 隐私政策和服务条款（pages-legal.js）。页脚是找它们的地方——法务、合规问卷
              和应用商店的上架表单都是先翻到页面最底下。两条都是站内跳转，所以和这一页
              别处一样走 data-act="go"，不是 `<a>`（那会整页重载）。 */ ''}
        <span class="satu-lg-links">
          ${/* 下载那一段（lpDownload）就在页脚正上方，这一条仍留着：页脚是人找「下载」
                「隐私」这类东西的地方，先翻到底的人一眼就看得见。 */ ''}
          <button type="button" data-act="landing-download">${t('下载桌面端', 'Desktop app')}</button>
          <button type="button" data-act="go" data-href="/privacy">${t('隐私政策', 'Privacy Policy')}</button>
          <button type="button" data-act="go" data-href="/terms">${t('服务条款', 'Terms of Service')}</button>
          <span>© 2026 Satuwork</span>
        </span>
      </div>
    </footer>
  </div>`
}
