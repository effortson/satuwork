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
 * 文案就地给中英两版（`t('中文', 'English')`），不进 core 的译表：那份表是给
 * 「定义在模块级 const 里、加载时就求值」的标签用的（见 core/src/i18n/dict.ts 开头），而这一屏
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

/** 首页前景演示 Bot 独立执行与多 Bot 协作，背景继续使用原来的动态点阵。
 * 分镜是本地演示数据；只有多 Bot 协作场景；动态背景保持运行。 */

/**
 * three.js 的路径和摘要。和 markdown.js 的 LIBS 同一套规矩（SRI 必须有，改版本要一起换
 * 摘要），CSP 那边的包列在 `gateway/src/ui-cdn.ts` 的 UI_CDN_PACKAGES 里。
 */
const LP_THREE = {
  path: '/three@0.170.0/build/three.module.min.js',
  sri: 'sha384-IDC7sAMAIMB/TZ6dgKKPPAKZ2bXXXP8+FBMBC8cU319eBhKITx+PaalhfDkDNH28',
}

/** 播放进度。放在模块里而不是 state：它只管这一段动画，render() 重画时照着它接着播。 */
const lpFilm = { step: 0, playing: true, visible: false, seen: false, timer: 0, io: null, ro: null, three: null }

/** 只演示多 Bot 派活；任务、记录与文件为本地固定数据。 */
function lpFilmScript() {
  return {
    steps: [2700, 1000, 2400, 2000, 3200, 3000, 3200, 1700, 2500, 4200],
    captions: [
      t('输入目标，把任务交给主 Bot', 'Give the main Bot a goal'),
      t('发送任务，主 Bot 开始处理', 'Send the task to the main Bot'),
      t('主 Bot 安排检索、分析与撰写', 'The main Bot plans research, analysis and writing'),
      t('派出去的任务出现在回复气泡里', 'Delegated tasks appear inside the reply'),
      t('检索与分析 Bot 各自推进，任务卡实时更新', 'Research and analysis progress in the task card'),
      t('分析 Bot 整理数据，回传关键发现', 'The analysis Bot sends back its findings'),
      t('撰写 Bot 汇总结果，生成简报文件', 'The writing Bot combines the results into a brief'),
      t('切到右侧工作区，查看生成的文件', 'Switch to the workspace to see generated files'),
      t('打开文件，直接在右侧预览', 'Open the file in the side preview'),
      t('主 Bot 汇总完成，结果留在对话与工作区', 'The result stays in the conversation and workspace'),
    ],
  }
}

function lpDemoBots() {
  return [
    ['lead','c-flow',t('主 Bot','Main Bot')],
    ['research','c-book',t('检索 Bot','Research Bot')],
    ['analysis','c-chart',t('分析 Bot','Analysis Bot')],
    ['writing','c-pen',t('撰写 Bot','Writing Bot')],
  ].map(([key,icon,name]) => ({id:'lp-demo-'+key, key, icon, name, origin:'company', runtimeKind:'remote', folderId:key==='lead'?'':key==='writing'?'lp-content':'lp-research'}))
}

function lpDemoTaskState(key, step) {
  const [start,end] = {lead:[1,9],research:[3,5],analysis:[4,6],writing:[6,8]}[key]
  return step < start ? 'waiting' : step < end ? 'running' : 'done'
}

/** 真实派活卡渲染器：状态、领活 Bot、工具进度均按产品格式展示。 */
function lpDemoTasks(step) {
  const goals = [t('收集本周产品动态的公开来源','Collect public sources for this week’s updates'),t('对比产品变化，提炼关键发现','Compare product changes and identify insights'),t('撰写简报，附上来源与建议','Write the brief with sources and recommendations')]
  const tools = ['web_search','terminal','write_file']
  return taskGroupHtml(lpDemoBots().slice(1).map((bot,i) => ({
    id:bot.id+'-task', state:lpDemoTaskState(bot.key,step), title:goals[i], body:'', reason:'',
    who:{name:bot.name,avatar:botAvatar(bot.icon,18,'company')}, steps:step > i+3 ? 3+i : 0,
    waitText:i === 2 ? t('等检索与分析完成','Waiting for research and analysis') : t('等待开始','Waiting to start'),
    progress:{tool:{name:tools[i],detail:i === 1 ? 'python compare.py' : i === 2 ? lpDemoFiles()[2].path : t('产品动态','product updates')}},
  })))
}

function lpDemoTools(step) {
  // 其他 Bot 的工具进度放在各自的任务行里，不混进主 Bot 的工具记录。
  return toolFoldHtml([{name:'assign_task',args:'{}',result:step>=8?'ok':null}],[])
}

function lpDemoFiles() {
  const reportName = t('本周市场简报.md','market-brief.md')
  return [{name:'sources.json',path:'sources.json',size:2400},{name:'market-data.csv',path:'market-data.csv',size:1600},{name:reportName,path:reportName,size:3200}]
}

function lpDemoReport() {
  return t('# 本周市场简报\n\n## 关键动态\n\n产品能力正在从单点工具走向多 Bot 协作。\n\n## 关键发现\n\n- 团队协作与多步骤执行是本周的主要变化。\n- 本地运行与工具连接能力持续完善。\n\n## 建议\n\n优先验证协作流程与交付质量。\n\n## 来源\n\n3 个公开资料，已整理在 sources.json。', '# Weekly market brief\n\n## Key updates\n\nProducts are moving from individual tools to multi-Bot collaboration.\n\n## Findings\n\n- Collaboration and multi-step execution are key changes.\n- Local execution and connected tools continue to improve.\n\n## Next steps\n\nValidate workflows and output quality.\n\n## Sources\n\n3 public references, collected in sources.json.')
}

/** 真实产品样式在独立文档中加载，避免首页白底变量及媒体查询污染工作台。 */
function lpDemoDocument() {
  const bots = lpDemoBots()
  const folders = [{id:'lp-research',name:t('研究分析','Research & analysis'),position:0},{id:'lp-content',name:t('内容交付','Content delivery'),position:1}]
  const files = lpDemoFiles()
  const file = files[2]
  const preview = {name:file.name,path:file.path,size:file.size,kind:'markdown',mode:'view',text:lpDemoReport()}
  const goal = t('整理本周市场动态，安排检索、分析和撰写 Bot 一起完成简报，附上来源和建议。','Coordinate the research, analysis and writing Bots to create this week’s market brief with sources and recommendations.')
  const panelIcon = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>'
  return `<!doctype html><html lang="${localeMode === 'en' ? 'en' : 'zh-CN'}" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/chat.css"><style>
    html,body{height:100%;overflow:hidden}body{margin:0}.lp-product-shell{height:100%;overflow:hidden;display:grid;grid-template-columns:248px minmax(0,1fr);gap:var(--space-4);padding:var(--space-4);background:var(--color-bg);font-family:var(--font-body);color:var(--color-text);box-sizing:border-box}
    .lp-product-side{height:100%;min-height:0;overflow:hidden;box-sizing:border-box;display:flex;flex-direction:column;background:var(--color-surface);border-radius:var(--radius-md);padding:var(--space-4) var(--space-2) var(--space-2)}
    .lp-product-menu{display:none}.lp-product-side .satu-brand{display:flex;align-items:center;gap:var(--space-2);padding:0 var(--space-3) var(--space-4);border:0;background:transparent;color:inherit}.satu-brand img{width:32px;height:32px;border-radius:var(--radius-sm)}.satu-brandtext{font-family:var(--font-heading);font-size:19px}
    [data-at]:not([data-on]){display:none!important}.lp-product-thread{scrollbar-width:none}.lp-demo-goal{margin:0}.lp-demo-draft{resize:none;min-height:44px}.lp-product-aside .sw-desk-slot{height:190px;background:#243140;overflow:hidden;border-radius:var(--radius-sm);display:flex;flex-direction:column;align-items:stretch;text-align:left;color:#e6e2d8}
    .lp-mini-bar{font-size:10px;padding:7px 9px;background:#334252;color:#d3d8dd}.lp-mini-page{background:#fff;color:#625c50;flex:1;margin:12px;padding:12px;overflow:hidden;border-radius:5px}.lp-mini-page h4{font-size:13px;margin:0 0 10px}.lp-mini-page p{font-size:10px;border-bottom:1px solid #eee;padding:6px 0;margin:0}.lp-mini-terminal{font:11px/1.8 ui-monospace,monospace;white-space:pre-wrap;padding:12px;margin:0}
    .lp-product-env,.lp-product-files,.lp-product-preview{display:none}.lp-demo-root[data-screen="env"] .lp-product-env,.lp-demo-root[data-screen="files"] .lp-product-files,.lp-demo-root[data-screen="preview"] .lp-product-preview{display:flex;flex-direction:column;min-height:0}.lp-product-preview{flex:1}.lp-product-preview .sw-preview{max-width:none;height:100%;display:flex;flex-direction:column}.lp-product-preview .sw-preview-slot{display:flex;flex:1;min-height:0}.lp-product-preview .sw-preview-body{flex:1;min-height:0;height:auto;margin:0;overflow:auto}
    .lp-demo-root[data-step="0"] .lp-product-user{display:none}.lp-demo-root:not([data-step="0"]) .lp-product-welcome{display:none}.lp-product-welcome{display:grid;place-content:center;flex:1;text-align:center;gap:12px;color:var(--muted-foreground)}.lp-product-welcome p{margin:0;font-size:14px}.lp-product-welcome .satu-bot-art{margin:auto}.lp-demo-root[data-playing="false"] *{animation-play-state:paused!important}
    .lp-product-emptyfiles{font-size:12px;color:var(--muted-foreground)}.lp-product-demo-tag{font-size:11px;color:var(--muted-foreground)}.lp-product-foot{display:flex;gap:var(--space-2);align-items:center;padding:var(--space-3);border-top:1px solid var(--border);margin-top:var(--space-2);font-size:12px}.lp-product-foot>span{width:30px;height:30px;display:grid;place-items:center;background:var(--color-accent-200);border-radius:50%;color:var(--color-accent-800)}
    @media(max-width:760px){.lp-product-side{display:none}.lp-product-shell{grid-template-columns:minmax(0,1fr)!important;padding:0;gap:0}.lp-demo-root[data-screen="env"] .lp-product-aside{display:none}.lp-demo-root:not([data-screen="env"]) .gw-body{visibility:hidden}.lp-product-head-collapse{display:none}.lp-product-menu{display:inline-flex}.lp-product-main{border:0;border-radius:0}.lp-product-aside{grid-row:2;grid-column:1}.sw-convo-meta{display:none}}
  </style></head><body class="lp-demo-root" data-step="${lpFilm.step}" data-screen="env" data-playing="${lpFilm.playing}"><div class="gw-shell lp-product-shell" inert>
    <aside class="gw-side lp-product-side"><button class="satu-brand"><img src="/assets/satuwork-logo.png" alt=""><span class="satu-brandtext">Satuwork</span></button>
      <div class="satu-botlist">${chatRosterNav({bots,folders,selected:bots[0].id,mainBotId:bots[0].id,folderOpen:{}})}</div>
      <div class="satu-newbotrow"><button class="satu-newbot">${svg(PLUS_ICON,15)}<span>${t('新建 Bot','New bot')}</span></button><button class="satu-newbot satu-newbot-more">${svg(KEBAB_ICON,15)}</button></div>
      <div class="satu-userrow lp-product-foot"><span>Y</span><div><b style="font-size:13px;font-weight:600">${t('演示用户','Demo user')}</b><div style="font-size:11px;color:var(--muted-foreground)">demo@satuwork</div></div><button class="btn btn-ghost btn-icon" style="margin-left:auto">${svg(GEAR,16)}</button></div>
    </aside>
    <main class="gw-main lp-product-main" style="grid-template-columns:minmax(0,1fr) 280px">
      <div class="gw-head"><button class="btn btn-ghost btn-icon lp-product-menu">${svg(['M4 6h16','M4 12h16','M4 18h16'],18)}</button><button class="btn btn-ghost btn-icon lp-product-head-collapse">${panelIcon}</button><div style="width:1px;height:18px;background:var(--color-divider)"></div><div class="sw-convo-avatar" data-bot="1">${botAvatarOf(bots[0],34,false,bots[0].id)}</div><div class="sw-convo-id"><div class="sw-convo-title"><span class="sw-convo-name">${bots[0].name}</span><span class="sw-convo-live" data-live="1"><i></i><span data-demo-live>${t('在线','Online')}</span></span></div><p class="sw-convo-meta">${t('主会话','Main conversation')}</p></div><div class="sw-convo-actions"><button class="btn btn-ghost btn-icon">${svg(['M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13','m16 16 4 4'],16)}</button><button class="btn btn-ghost btn-icon">${svg(KEBAB_ICON,16)}</button></div><span style="display:inline-flex;gap:2px"><button class="btn btn-ghost btn-icon sw-asidetab lp-demo-files-tab" title="${t('工作区文件')}">${svg(FOLDER,16)}</button><button class="btn btn-ghost btn-icon sw-asidetab lp-demo-env-tab" title="${t('运行环境')}">${svg(MONITOR,16)}</button></span></div>
      <div class="gw-body"><div class="gw-chat"><section class="gw-chat-main"><div class="sw-threadwrap"><div class="sw-thread lp-product-thread">
        <div class="lp-product-welcome">${botAvatarOf(bots[0],42,false,bots[0].id)}<p>${t('输入消息','Type a message')}</p></div>
        <div class="sw-msg lp-product-user" data-role="user" data-at="1"><div class="sw-msg-avatar">Y</div><div class="sw-msg-col"><div class="sw-bubble" data-role="user"><p class="lp-demo-goal">${goal}</p></div><div class="sw-time">09:41</div></div></div>
        <div class="sw-msg lp-product-assistant" data-role="assistant" data-bot="1" data-at="2"><div class="sw-msg-avatar" data-bot="1">${botAvatarOf(bots[0],36,false,bots[0].id)}</div><div class="sw-msg-col"><div class="sw-bubble" data-role="assistant"><div class="sw-md"><p>${t('我会把资料收集、对比分析和简报撰写交给对应的 Bot，完成后统一汇总。','I’ll assign research, analysis and writing to the corresponding Bots, then combine the results.')}</p></div><div data-demo-tools data-at="3">${lpDemoTools(lpFilm.step)}</div><div data-demo-tasks data-at="3">${lpDemoTasks(lpFilm.step)}</div><div class="sw-chips" data-at="8">${fileChipHtml(file)}</div><div class="sw-md" data-at="9"><p>${t('简报已完成。来源、数据表和最终文档都已保存到工作区。','The brief is ready. Sources, data and the final document are saved in the workspace.')}</p></div></div><div class="sw-time" data-demo-time>${t('正在处理','Working')}</div></div></div>
      </div></div><div class="sw-composer"><div class="sw-composer-box"><textarea class="satu-prompt satu-grow lp-demo-draft" rows="1" placeholder="${t('输入消息')}" readonly data-goal="${esc(goal)}"></textarea><div class="sw-composer-row"><button class="sw-iconbtn">${ICON_CLIP}</button><span class="sw-spacer"></span><button class="sw-send" data-state="send">${ICON_SEND}</button></div></div><div class="sw-composer-tip"><span>${t('输入消息','Type a message')}</span><span class="sw-spacer"></span></div></div></section></div></div>
      <aside class="gw-aside lp-product-aside"><div class="gw-aside-body">
        <div class="gw-aside-stack lp-product-env"><h3>${t('运行环境')}</h3><div class="satu-kv"><span>${t('状态','Status')}</span><span>${t('在线','Online')}</span></div><div class="sw-desk"><div class="sw-desk-slot"><div class="lp-mini-bar">Ubuntu · ${t('远程桌面','Remote desktop')}</div><div class="lp-mini-page" data-demo-browser><h4>${t('本周产品动态','This week’s product updates')}</h4><p>product-a.example / updates</p><p>product-b.example / news</p><p>industry.example / weekly</p></div><pre class="lp-mini-terminal" data-demo-terminal>$ python compare.py\n3 sources loaded\n3 products compared\n✓ market-data.csv</pre></div><p class="sw-desk-cap">${t('桌面画面','Desktop view')}</p></div></div>
        <div class="sw-ws lp-product-files"><div class="sw-ws-head"><h3>${t('工作区文件')}</h3><button class="btn btn-ghost btn-icon">${svg(REFRESH,15)}</button></div><p class="lp-product-emptyfiles">${t('工作区还是空的。','The workspace is empty.')}</p><ul class="sw-ws-tree">${files.map((f,i)=>`<li data-at="${[5,6,7][i]}" data-demo-file="${i}">${workspaceFileRowHtml(f).replace(/^<li>/,'').replace(/<\/li>$/,'')}</li>`).join('')}</ul></div>
        <div class="lp-product-preview">${previewPanel(preview, `<div class="sw-preview-body">${previewBody(preview)}</div>`)}</div>
      </div></aside>
    </main>
  </div></body></html>`
}

function lpFilmStage() {
  return `<div class="satu-ui-demo" data-mode="team" data-step="${lpFilm.step}" data-playing="${lpFilm.playing}"><iframe class="lp-product-frame" title="${esc(t('多 Bot 协作：真实产品 UI 操作演示','Multi-Bot collaboration in the product UI'))}" sandbox="allow-same-origin" srcdoc="${esc(lpDemoDocument())}"></iframe><span class="lp-product-cursor" aria-hidden="true"><svg width="20" height="24" viewBox="0 0 20 24"><path d="M3 2l14 11-6 .8 2.5 6-3 1.3-2.5-6L3 19z" fill="#302d27" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg><i></i></span></div>`
}

function lpFilmView() {
  return `<section class="satu-lp-wrap satu-lp-film" id="satu-lp-film" aria-label="${esc(t('多 Bot 协作操作演示','Multi-Bot collaboration demo'))}">
    <canvas class="satu-lp-film-bg" aria-hidden="true"></canvas>
    <div class="satu-lp-sechead satu-lp-filmhead"><span class="satu-lp-kicker">${t('围绕 Bot，组织你的工作','BUILT AROUND BOTS')}</span><h1>${t('多个 Bot，一起把任务完成。','Multiple Bots. One completed task.')}</h1><p class="satu-bot-intro">${t('主 Bot 分派任务，协作过程和结果都在同一个工作台。','Your main Bot delegates the work. Progress and results stay in one workspace.')}</p></div>
    <div class="lp-demo-toolbar"><span>${t('多 Bot 协作 · 产品 UI 演示','Multi-Bot collaboration · Product UI demo')}</span><div><button type="button" class="satu-lp-filmplay" data-act="landing-film-play" aria-label="${lpFilm.playing ? t('暂停','Pause') : t('播放','Play')}" data-playing="${lpFilm.playing}">${svg(['M8 5v14','M16 5v14'],14)}${svg(['M7 4.5v15l12-7.5z'],14)}</button><button type="button" class="lp-demo-replay" data-act="landing-film-replay" aria-label="${t('重新播放','Replay')}" title="${t('重新播放','Replay')}">${svg(['M3 10a9 9 0 1 1 2 8','M3 3v7h7'],14)}</button></div></div>
    <div class="satu-lp-filmframe"><div class="satu-lp-filmview">${lpFilmStage()}</div></div>
    <div class="satu-bot-progress" aria-live="off"><span class="satu-bot-caption"></span><div class="satu-bot-phases" aria-label="${t('演示进度','Demo progress')}">${[[0,t('输入任务','Type')],[3,t('派发任务','Delegate')],[4,t('协同执行','Collaborate')],[7,t('工作区文件','Workspace')],[9,t('完成','Done')]].map(([step,label])=>`<button type="button" data-act="landing-film-step" data-step="${step}"><i></i>${label}</button>`).join('')}</div></div>
  </section>`
}

/** 在隔离文档内更新真实的名册行、工具记录、派活卡和文件预览。 */
function lpFilmApply(animate = true) {
  const sec = document.getElementById('satu-lp-film')
  if (!sec) return
  const script = lpFilmScript()
  const step = lpFilm.step
  const frame = sec.querySelector('.lp-product-frame')
  const doc = frame?.contentDocument
  const root = doc?.querySelector('.lp-demo-root')
  const moving = animate && lpFilm.playing && lpFilm.visible
  sec.querySelector('.satu-ui-demo')?.setAttribute('data-step',String(step))
  if (root) {
    root.setAttribute('data-step',String(step))
    root.setAttribute('data-playing',String(lpFilm.playing))
    root.setAttribute('data-screen',step < 7 ? 'env' : step === 7 ? 'files' : 'preview')
    root.querySelector('.lp-product-main').style.gridTemplateColumns = `minmax(0,1fr) ${step >= 8 ? ASIDE_PREVIEW_WIDTH : 280}px`
    root.querySelector('.lp-product-aside').toggleAttribute('data-preview',step >= 8)
    for (const el of root.querySelectorAll('[data-at]')) {
      const on = step >= Number(el.getAttribute('data-at'))
      el.toggleAttribute('data-on',on)
      el.setAttribute('aria-hidden',String(!on))
    }
    const tasks = root.querySelector('[data-demo-tasks]')
    if(tasks) tasks.innerHTML=lpDemoTasks(step)
    const tools = root.querySelector('[data-demo-tools]')
    if(tools) tools.innerHTML=lpDemoTools(step)
    for (const bot of lpDemoBots()) {
      const row = root.querySelector(`[data-bot-row="${bot.id}"]`)
      const state = lpDemoTaskState(bot.key,step)
      row?.querySelector('.satu-botdot')?.setAttribute('data-state',state === 'running' ? 'busy' : 'idle')
      const snip=row?.querySelector('.satu-botsnip')
      if(snip) { snip.hidden=step<3; snip.textContent=state==='done'?t('任务已完成','Task complete'):state==='running'?t('正在处理任务…','Working on the task…'):t('等待前置任务','Waiting for earlier tasks') }
      setBotAvatarRunning(row,state==='running')
    }
    const live=root.querySelector('.sw-convo-live')
    live?.setAttribute('data-live',step>0&&step<9?'busy':'1')
    const liveText=root.querySelector('[data-demo-live]')
    if(liveText)liveText.textContent=step>0&&step<9?t('正在处理','Working'):t('在线','Online')
    const message=root.querySelector('.lp-product-assistant')
    message?.setAttribute('data-live',step<9?'1':'0')
    setBotAvatarRunning(message?.querySelector('.sw-msg-avatar'),step<9)
    setBotAvatarRunning(root.querySelector('.sw-convo-avatar'),step>0&&step<9)
    const stamp=root.querySelector('[data-demo-time]')
    if(stamp)stamp.textContent=step===9?'09:42':t('正在处理','Working')
    const browser=root.querySelector('[data-demo-browser]')
    const terminal=root.querySelector('[data-demo-terminal]')
    if(browser)browser.style.display=step<5?'block':'none'
    if(terminal)terminal.style.display=step>=5?'block':'none'
    const empty=root.querySelector('.lp-product-emptyfiles')
    if(empty)empty.hidden=step>=5
    root.querySelector('.lp-demo-files-tab')?.setAttribute('aria-pressed',String(step===7))
    root.querySelector('.lp-demo-env-tab')?.setAttribute('aria-pressed',String(step<7))
    const send=root.querySelector('.sw-send')
    if(send){send.setAttribute('data-state',step>1&&step<9?'stop':'send');send.innerHTML=step>1&&step<9?'<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>':ICON_SEND}
    const draft=root.querySelector('.lp-demo-draft')
    if(step!==0){clearInterval(lpFilm.typeTimer);lpFilm.typeTimer=0;if(draft)draft.value=''}
    else if(draft){
      const text=draft.getAttribute('data-goal')||''
      if(!moving)draft.value=text
      else if(!lpFilm.typeTimer){
        draft.value=text.slice(0,lpFilm.typed||0)
        lpFilm.typeTimer=setInterval(()=>{
          if(!frame.isConnected){clearInterval(lpFilm.typeTimer);lpFilm.typeTimer=0;return}
          lpFilm.typed=Math.min(text.length,(lpFilm.typed||0)+1)
          draft.value=text.slice(0,lpFilm.typed)
          if(lpFilm.typed===text.length){clearInterval(lpFilm.typeTimer);lpFilm.typeTimer=0}
        },Math.max(22,2100/text.length))
      }
    }
    const thread=root.querySelector('.lp-product-thread')
    if(thread)thread.scrollTop=step>=3?thread.scrollHeight:0
    lpDemoPointer(sec,root,step,moving)
  }
  const caption=sec.querySelector('.satu-bot-caption')
  if(caption)caption.textContent=script.captions[step]
  const starts=[0,3,4,7,9]
  sec.querySelectorAll('.satu-bot-phases button').forEach((button,i)=>{
    const active=step>=starts[i]&&(i===4||step<starts[i+1])
    button.setAttribute('data-state',active?'active':step>starts[i]?'done':'waiting')
    button.setAttribute('aria-pressed',String(active))
  })
  const play=sec.querySelector('.satu-lp-filmplay')
  play?.setAttribute('data-playing',String(lpFilm.playing))
  play?.setAttribute('aria-label',lpFilm.playing?t('暂停','Pause'):t('播放','Play'))
}

function lpDemoPointer(sec,root,step,moving){
  const selectors=['.lp-demo-draft','.sw-send','.lp-product-assistant .sw-bubble','.sw-task-card','.sw-toolfold-head','.sw-task-row:nth-child(3) .sw-task-line','.sw-task-row:nth-child(4) .sw-task-line','.lp-demo-files-tab','[data-demo-file="2"] .sw-ws-file','.sw-preview-md h1']
  const target=root.querySelector(selectors[step])
  const cursor=sec.querySelector('.lp-product-cursor')
  const frame=sec.querySelector('.lp-product-frame')
  const view=sec.querySelector('.satu-lp-filmview')
  const box=target?.getBoundingClientRect()
  const scale=view&&frame?view.clientWidth/frame.clientWidth:1
  if(cursor&&box?.width){cursor.style.left=(box.left+Math.min(box.width/2,90))*scale+'px';cursor.style.top=(box.top+Math.min(box.height/2,25))*scale+'px';cursor.toggleAttribute('data-click',false);clearTimeout(lpFilm.clickTimer);if(moving&&[1,7,8].includes(step))lpFilm.clickTimer=setTimeout(()=>cursor.isConnected&&cursor.toggleAttribute('data-click',true),520)}
}

function lpFilmStop() {
  clearTimeout(lpFilm.timer)
  clearTimeout(lpFilm.clickTimer)
  clearInterval(lpFilm.typeTimer)
  lpFilm.typeTimer = 0
  lpFilm.timer = 0
}

/** 排下一步。只在「在播、看得见、这一段还在页面上」时排。 */
function lpFilmSchedule() {
  clearTimeout(lpFilm.timer)
  lpFilm.timer = 0
  if (!lpFilm.playing || !lpFilm.visible || !document.getElementById('satu-lp-film')) return
  const b = lpFilmScript()
  lpFilm.timer = setTimeout(() => {
    lpFilm.timer = 0
    if (!document.getElementById('satu-lp-film')) return
    if (lpFilm.step + 1 < b.steps.length) {
      lpFilm.step++
      lpFilmApply()
    } else {
      lpFilmGo()
      return
    }
    lpFilmSchedule()
  }, b.steps[lpFilm.step])
}

/** 只重播多 Bot 协作，不替换背景或重新加载真实 UI 的样式表。 */
function lpFilmGo(){
  lpFilmStop()
  lpFilm.step=0
  lpFilm.typed=0
  lpFilm.playing=true
  lpFilmApply()
  lpFilmSchedule()
}

/** 可直接跳到输入、规划、执行、保存或结果，停下来查看这一步。 */
function lpFilmSeek(step) {
  if (!Number.isInteger(step) || step < 0 || step >= lpFilmScript().steps.length) return
  lpFilmStop()
  lpFilm.playing = false
  lpFilm.step = step
  lpFilmApply(false)
}

function lpFilmToggle(){
  lpFilm.playing=!lpFilm.playing
  if(!lpFilm.playing)lpFilmStop()
  lpFilmApply(lpFilm.playing)
  if(lpFilm.playing)lpFilmSchedule()
}

/** 用真实桌面 / 手机视口渲染隔离文档，再等比缩放到首页可用空间。 */
function lpFilmFit(){
  const view=document.querySelector('#satu-lp-film .satu-lp-filmview')
  const frame=view?.querySelector('.lp-product-frame')
  if(!view||!frame)return
  const narrow=(view.parentElement?.clientWidth||view.clientWidth)<620
  view.toggleAttribute('data-narrow',narrow)
  const width=narrow?390:1440
  const height=narrow?580:720
  frame.style.width=width+'px'
  frame.style.height=height+'px'
  frame.style.transform=`scale(${view.clientWidth/width})`
  const root=frame.contentDocument?.querySelector('.lp-demo-root')
  if(root)lpDemoPointer(document.getElementById('satu-lp-film'),root,lpFilm.step,false)
}

/**
 * render() 之后调：把这一段接上计时、观察者和背景。
 *
 * 没有 IntersectionObserver 的环境（e2e 的 DOM 垫片）不播：停在第一位的最后一帧，
 * 也不排任何计时器——一串自我续命的 setTimeout 会让测试套件退不出去。
 */
function lpFilmMount() {
  const sec = document.getElementById('satu-lp-film')
  if (!sec) return
  lpFilm.io?.disconnect()
  lpFilm.ro?.disconnect()
  clearInterval(lpFilm.typeTimer)
  lpFilm.typeTimer=0
  const frame=sec.querySelector('.lp-product-frame')
  frame?.addEventListener('load',()=>{lpFilmFit();lpFilmApply(lpFilm.playing)},{once:true})
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  if (typeof IntersectionObserver !== 'function' || reduce) {
    // 不动的环境：头一回停在最后一帧（整件事都摆出来了）。减少动效的人想看可以点播放；
    // 垫片里 visible 一直是 false，点了也不会排计时器。
    if (!lpFilm.seen) {
      lpFilm.playing = false
      lpFilm.step = lpFilmScript().steps.length - 1
    }
    lpFilm.seen = true
    lpFilm.visible = reduce && typeof IntersectionObserver === 'function'
    lpFilmFit()
    lpFilmApply(false)
    return
  }
  lpFilm.seen = true
  lpFilm.io = new IntersectionObserver((ents) => {
    const vis = ents.some((e) => e.isIntersecting)
    if (vis === lpFilm.visible) return
    lpFilm.visible = vis
    if (vis) {
      lpFilmApply()
      lpFilmSchedule()
      lpFilmThree(sec)
    } else {
      lpFilmStop()
    }
  }, { threshold: 0.25 })
  lpFilm.io.observe(sec)
  if (typeof ResizeObserver === 'function') {
    lpFilm.ro = new ResizeObserver(() => lpFilmFit())
    lpFilm.ro.observe(sec)
  }
  lpFilmFit()
  lpFilmApply(false)
  if (lpFilm.visible) {
    lpFilmApply()
    lpFilmSchedule()
    lpFilmThree(sec)
  }
}

/** 按需拉 three.js。modulepreload 带着 SRI，随后的 import() 命中同一条已核过的记录（同 markdown.js 的 mermaidLib）。 */
let lpThreeLoad = null
function lpThree() {
  if (!lpThreeLoad) {
    const src = uiCdn() + LP_THREE.path
    const pre = document.createElement('link')
    pre.rel = 'modulepreload'
    pre.href = src
    pre.integrity = LP_THREE.sri
    pre.crossOrigin = 'anonymous'
    document.head.appendChild(pre)
    lpThreeLoad = import(src)
  }
  return lpThreeLoad
}

/**
 * 背景保留球面与波浪网格两种点阵，按时间缓慢变化，
 * 半路上带一点散开，像是被搅了一下。
 *
 * 画布整页重绘时会被换掉：每一帧先看它还在不在页面上，不在就把 GPU 那头的东西放掉。
 */
async function lpFilmThree(sec) {
  const canvas = sec.querySelector('.satu-lp-film-bg')
  if (!canvas || canvas.dataset.live) return
  canvas.dataset.live = '1'
  let THREE
  try {
    THREE = await lpThree()
  } catch {
    return
  }
  if (!canvas.isConnected) return
  let renderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' })
  } catch {
    return
  }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
  camera.position.set(0, 0.6, 10)
  camera.lookAt(0, 0, 0)

  const small = (canvas.clientWidth || 800) < 640
  const COLS = small ? 44 : 64
  const ROWS = small ? 26 : 34
  const N = COLS * ROWS
  // 形状 0：斐波那契球面，点分布得均匀，转起来不会有一块特别密。
  const sphere = new Float32Array(N * 3)
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2
    const r = Math.sqrt(1 - y * y)
    const a = golden * i
    sphere[i * 3] = Math.cos(a) * r * 3.3
    sphere[i * 3 + 1] = y * 3.3
    sphere[i * 3 + 2] = Math.sin(a) * r * 3.3
  }
  // 形状 1：一张往后仰的网格（u 横着，v 顺着斜面往远处），起伏在 tick 里按时间算。
  const grid = new Float32Array(N * 3)
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const k = (j * COLS + i) * 3
      grid[k] = (i / (COLS - 1) - 0.5) * 17
      grid[k + 1] = (j / (ROWS - 1) - 0.5) * 9
    }
  }
  const jitter = new Float32Array(N * 3)
  for (let i = 0; i < N * 3; i++) jitter[i] = Math.random() * 2 - 1

  const pos = new Float32Array(N * 3)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  // 圆点：一张小画布当贴图，不然 Points 画出来是方块。
  const dot = document.createElement('canvas')
  dot.width = dot.height = 64
  const g2 = dot.getContext('2d')
  const grad = g2.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.45, 'rgba(255,255,255,0.9)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g2.fillStyle = grad
  g2.fillRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(dot)
  const mat = new THREE.PointsMaterial({ size: small ? 0.085 : 0.075, map: tex, transparent: true, opacity: 0.75, depthWrite: false, sizeAttenuation: true })
  const pts = new THREE.Points(geo, mat)
  scene.add(pts)

  const accent = () => {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--color-accent-500').trim()
    try {
      mat.color.set(v || '#c2410c')
    } catch {
      mat.color.set('#c2410c')
    }
  }
  accent()

  const live = { shape: 1, raf: 0 }
  lpFilm.three = live
  let mix = 1 // 保留球面与波浪两种动态点阵。
  let mx = 0
  let my = 0
  const onMove = (e) => {
    const r = canvas.getBoundingClientRect()
    mx = ((e.clientX - r.left) / r.width - 0.5) * 2
    my = ((e.clientY - r.top) / r.height - 0.5) * 2
  }
  sec.addEventListener('pointermove', onMove)
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)
  let last = performance.now()
  let frame = 0

  const size = () => {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!w || !h) return
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
  }

  const tick = (now) => {
    if (!canvas.isConnected) {
      sec.removeEventListener('pointermove', onMove)
      geo.dispose()
      mat.dispose()
      tex.dispose()
      renderer.dispose()
      if (lpFilm.three === live) lpFilm.three = null
      return
    }
    live.raf = requestAnimationFrame(tick)
    if (!lpFilm.visible && frame > 0) return
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    frame++
    if (frame % 90 === 0) accent()
    size()
    // 形状之间走 1.6 秒。
    const want = (Math.sin(now / 16000) + 1) / 2
    mix += Math.sign(want - mix) * Math.min(Math.abs(want - mix), dt / 1.6)
    const m = ease(mix)
    const scatter = Math.sin(Math.PI * m) * 0.9
    const time = now / 1000
    const rot = time * 0.12
    const cr = Math.cos(rot)
    const sr = Math.sin(rot)
    const tilt = 0.35
    const ct = Math.cos(tilt)
    const st = Math.sin(tilt)
    for (let i = 0; i < N; i++) {
      const k = i * 3
      // 地球：绕 y 转，再往前倾一点，看得到北半球。
      let sx = sphere[k] * cr + sphere[k + 2] * sr
      let sz = -sphere[k] * sr + sphere[k + 2] * cr
      let sy = sphere[k + 1]
      const ty = sy * ct - sz * st
      sz = sy * st + sz * ct
      sy = ty + 0.9
      // 桌面：两道正弦叠出来的缓慢起伏。
      const gx = grid[k]
      const v = grid[k + 1]
      const wave = Math.sin(gx * 0.55 + time * 0.9) * 0.28 + Math.cos(v * 0.8 + time * 0.6) * 0.22
      const gy = 1 + v * 0.5 + wave * 0.8
      const gz = -v * 0.9 + wave * 0.5
      pos[k] = sx + (gx - sx) * m + jitter[k] * scatter
      pos[k + 1] = sy + (gy - sy) * m + jitter[k + 1] * scatter
      pos[k + 2] = sz + (gz - sz) * m + jitter[k + 2] * scatter
    }
    geo.attributes.position.needsUpdate = true
    // 指针带一点视差。
    camera.position.x += (mx * 0.8 - camera.position.x) * 0.04
    camera.position.y += (0.6 - my * 0.4 - camera.position.y) * 0.04
    camera.lookAt(0, 0, 0)
    renderer.render(scene, camera)
  }
  live.raf = requestAnimationFrame(tick)
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
          <button type="button" class="btn btn-ghost btn-icon" style="flex: none;" data-act="landing-sales-close" aria-label="${esc(t('关闭'))}">${svg(CLOSE_ICON, 16)}</button>
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
function dlMirror() {
  const raw = document.querySelector('meta[name="satu-desktop-download"]')?.getAttribute('content')
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? url.href.replace(/\/+$/, '') : ''
  } catch { return '' }
}

function dlBase() {
  if (dlMirror()) return dlMirror()
  return `${LP_REPO}/releases/download/desktop-latest`
}

/** 历次桌面端版本。页面上不印版本号（它读不到 desktop-latest 里现在是哪一版），要旧版的走这条。 */
function dlHistory() {
  if (dlMirror()) return dlMirror() + '/'
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

/** 那段介绍。`signedIn` 时去掉末尾那句「随时也可以直接登录网页版」——应用内那一页上的人正在网页版里。 */
function dlLead(signedIn) {
  return signedIn
    ? t(
        '桌面端把界面装进本机，并且能在这台电脑上直接跑本地 Bot——他的工作区就是你电脑上的文件夹，对话不经过服务器。',
        'The desktop app bundles the interface and runs local Bots right on this machine — their workspace is a folder on your computer and those conversations never leave it.',
      )
    : t(
        '桌面端把界面装进本机，并且能在这台电脑上直接跑本地 Bot——他的工作区就是你电脑上的文件夹，对话不经过服务器。浏览器里用不到这一层，随时也可以直接登录网页版。',
        'The desktop app bundles the interface and runs local Bots right on this machine — their workspace is a folder on your computer and those conversations never leave it. You can always use the web version instead.',
      )
}

/**
 * 「总是最新版 · 历次版本」那一行。借法律页 `.satu-lg-meta` 的打扮；**是 `<div>` 不是 `<p>`**：
 * 首页那一段里 `.satu-lp-sechead p` 的权重更高，是 `<p>` 的话字号、颜色、外边距全被它抹掉。
 */
function dlMeta() {
  return `<div class="satu-lg-meta satu-dl-meta">${t('这里下到的总是最新版。', 'You always get the latest version here.')}${t('', ' ')}<a href="${esc(dlHistory())}" target="_blank" rel="noopener noreferrer">${t('历次版本', 'All versions')}</a></div>`
}

/**
 * 左边一张卡（当前平台的包）、右边一列说明。公开下载页（downloadView）和应用内那一页
 * （downloadPage）画的是同一个东西；切平台时只换这一块（见 paintDownload），所以带着 id。
 */
function dlGrid(cur) {
  const builds = dlBuilds().filter((b) => b.os === cur)
  const guessed = dlDetect()
  return `<div class="satu-dl-grid" id="dl-grid">
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
      ${/* 只给没登录的人：已经登录在网页版里的人（应用内那一页），再叫他去登录网页版是说胡话。 */ ''}
      ${
        state.me
          ? ''
          : `<p class="satu-dl-fine">${t('装不了也不耽误用：', 'Can’t install it? Nothing is lost: ')}<button type="button" class="satu-dl-weblink" data-act="go" data-href="/login">${t('直接用网页版登录', 'sign in to the web version')}</button>${t('，除了本地 Bot之外都一样。', ' — everything except local Bots works the same.')}</p>`
      }
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
          '本地 Bot的运行时会自己在后台更新；外面这层应用还要手工换新版——所以升级的时候回这里再下一次。',
          'The local Bot runtime updates itself in the background. The app shell around it still needs a new installer, so come back here to upgrade.',
        ),
      )}
      ${dlNote(
        t('Linux 暂时没有包', 'No Linux build yet'),
        t(
          'Linux 上的桌面端还没验过，暂时不发包。那边先用浏览器打开这台服务器，除了本地 Bot之外功能一样。',
          'The Linux desktop build is not verified yet, so we don’t ship one. Open this server in a browser there — everything except local Bots is the same.',
        ),
      )}
    </div>
  </div>`
}

/** 公开下载页，与首页共用导航和页脚；无需登录即可直接打开 /download。 */
function downloadView() {
  return `<div class="satu-lp satu-lp-compact">
    ${lpHeader()}
    <main class="satu-lp-wrap satu-lp-sec satu-lp-dl" id="download">
      <div class="satu-lp-sechead satu-lp-dlhead">
        <span class="satu-lp-kicker">${t('桌面端', 'Desktop app')}</span>
        <h1>${t('下载 Satuwork 桌面端', 'Download Satuwork for desktop')}</h1>
        <p>${dlLead(false)}</p>
        ${dlMeta()}
      </div>
      ${dlGrid(dlOs())}
    </main>
    ${lpSalesModal()}
    ${lpFooter()}
  </div>`
}

/**
 * 应用内的「下载桌面端」（`/download`，登录之后）。首页只给没登录的人看，而已经在用
 * 网页版的人同样会想装个客户端——入口在个人设置里，以前发出去的 `/download` 链接登录
 * 之后也落到这儿。桌面壳里不给（见 app.js 的 foldDownload）。
 */
function downloadPage() {
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('下载 Satuwork 桌面端', 'Download Satuwork for desktop')}</h1>
          <p style="margin: 0; font-size: 14px; line-height: 1.7; color: var(--muted-foreground);">${dlLead(true)}</p>
          ${dlMeta()}
        </div>
        ${dlGrid(dlOs())}
      </div>
    </div>`
}

/**
 * 切平台：只换那张卡和那列说明，不重绘整页（整页 innerHTML 一换，
 * 文档滚动跟着抖一下，而人正停在页面最底下）。换完把焦点还给刚按的那颗，键盘上的人
 * 不至于被扔回页首。那一块不在就退回整页重绘。
 */
function paintDownload(os) {
  const grid = document.getElementById('dl-grid')
  if (!grid) return render()
  grid.outerHTML = dlGrid(os)
  document.querySelector(`#dl-grid [data-act="download-os"][data-os="${os}"]`)?.focus()
}


/** 首页与公开下载页共用的导航。 */
function lpHeader() {
  return `    <header class="satu-lp-top">

      <div class="satu-lp-wrap satu-lp-topin">
        <button type="button" class="satu-lp-brand" data-act="go" data-href="/">
          <img class="satu-lp-home-logo" src="/assets/satuwork-logo.png" alt="Satuwork" width="40" height="40">
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
          <button type="button" class="btn btn-secondary satu-lp-topdownload" data-act="go" data-href="/download">${t('下载桌面端', 'Desktop app')}</button>
          <button type="button" class="btn btn-primary satu-lp-topsign" data-act="go" data-href="/login">${t('登录', 'Sign in')}</button>
        </div>
      </div>
    </header>`
}

/** 公开页面的页脚。 */
function lpFooter() {
  return `    <footer class="satu-lp-foot">
      <div class="satu-lp-wrap satu-lp-footin">
        <span class="satu-lp-brand" data-static>
          <img src="/assets/satuwork-logo.png" alt="" width="20" height="20">
          <span>Satuwork</span>
        </span>
        ${/* 隐私政策和服务条款（pages-legal.js）。页脚是找它们的地方——法务、合规问卷
              和应用商店的上架表单都是先翻到页面最底下。两条都是站内跳转，所以和这一页
              别处一样走 data-act="go"，不是 `<a>`（那会整页重载）。 */ ''}
        <span class="satu-lg-links">

          <button type="button" data-act="go" data-href="/privacy">${t('隐私政策', 'Privacy Policy')}</button>
          <button type="button" data-act="go" data-href="/terms">${t('服务条款', 'Terms of Service')}</button>
          <span>© 2026 Satuwork</span>
        </span>
      </div>
    </footer>`
}

/** 首页用一屏展示 Bot 协作演示与导航。 */
function landingView() {
  return `<div class="satu-lp satu-lp-compact satu-lp-home">
    ${lpHeader()}
    <main>
      ${lpFilmView()}
    </main>
    ${lpSalesModal()}
    ${lpFooter()}
  </div>`
}
