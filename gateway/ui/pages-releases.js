/** 平台侧的发布包（机器配置那一页）：Bot、管家、桌面端本地 Bot 各一条版本线。原先在 pages-audit.js。 */
/** 发布包大小。负数（不该有）和认不出的一样画成 —。 */
function fmtSize(n) {
  return Number(n) < 0 ? '—' : SatuCore.fmtFileSize(n, '—')
}

function shaShort(h) {
  const s = String(h || '')
  return s ? s.slice(0, 12) : '—'
}

/**
 * 桌面端本地 Bot 的六个目标：Gateway 按版本号末尾的 `-<平台>-<架构>` 给每台桌面端挑包
 * （gateway/src 的 localBotReleaseTarget），一个目标一条独立的版本线。
 */
const LOCAL_BOT_TARGETS = [
  { key: 'darwin-arm64', label: 'macOS · Apple Silicon' },
  { key: 'darwin-x64', label: 'macOS · Intel' },
  { key: 'windows-x64', label: 'Windows · x64' },
  { key: 'windows-arm64', label: 'Windows · ARM64' },
  { key: 'linux-x64', label: 'Linux · x64' },
  { key: 'linux-arm64', label: 'Linux · ARM64' },
]

/**
 * 各平台现在生效的是哪一版。桌面端没有「期望版本」可钉：它跟的就是自己那个平台最新
 * 登记的一版，下次启动第一颗本地 Bot 时静默切过去。所以这张表回答的是最常问的那一句——
 * 「我这台 Windows 下次会用哪个包」，缺了哪个平台也一眼看得出来。
 *
 * 最新那版要求更高的 Desktop 时一并写出来：够不上的桌面端会停在它够得着的那一版上。
 */
function localBotTargetsPanel(latestByTarget, releases) {
  const rows = LOCAL_BOT_TARGETS.map((x) => {
    const v = latestByTarget?.[x.key]
    const min = v ? (releases || []).find((r) => r.version === v)?.minDesktopVersion : null
    const needs = min && min !== '0.1.0' ? ` · ${t('需要 Desktop', 'Needs Desktop')} ≥ ${esc(min)}` : ''
    return `<div class="satu-kv"><span>${esc(x.label)}</span><span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; ${v ? '' : 'color: var(--muted-foreground);'}">${esc(v || t('还没有这个平台的包', 'No package for this platform'))}${needs}</span></div>`
  }).join('')
  return `<div style="display: flex; flex-direction: column;">${rows}</div>`
}

/**
 * 机器配置。三个 tab：机器管家、Bot 运行时、桌面端本地 Bot。
 *
 * 三边是同一套东西——按版本发布的包、一张列表、一个新增表单——只是 kind 不同，
 * 所以渲染共用 `releaseSection`，避免几份会各自漂移的相似代码。
 */
function releasesPage() {
  const tab = state.machineTab === 'bot' || state.machineTab === 'local-bot' ? state.machineTab : 'manager'
  const tabBtn = (id, label) =>
    `<button type="button" class="btn ${tab === id ? 'btn-primary' : ''}" data-act="machine-tab" data-tab="${id}">${label}</button>`
  const body =
    tab === 'manager'
      ? releaseSection({
          kind: 'manager',
          title: t('机器管家'),
          hint: t('机器心跳时拿到期望版本，自己换版并在失败时回滚。留空表示跟最新发布走。'),
          data: state.managerReleases && { ...state.managerReleases, latest: latestPerArch(state.managerReleases.releases) },
          desired: true,
        })
      : tab === 'bot'
        ? releaseSection({
            kind: 'bot',
            title: t('Bot 运行时'),
            hint: t('机器心跳时，不在期望版本上的席位会被排进部署队列，等席位上的会话跑完再换。留空表示跟最新发布走；要回滚就填上一版。'),
            data: { releases: state.releases || [], latest: latestPerArch(state.releases), desired: state.botDesired || '' },
            desired: true,
          })
        : releaseSection({
            kind: 'local-bot',
            title: t('桌面端本地 Bot', 'Desktop local bot'),
            hint: t(
              '桌面端按自己的操作系统和架构，取那个平台最新登记、且自己的版本够得上「最低 Desktop 版本」的一版，下次启动第一颗本地 Bot 时静默切换；正在跑的不会被打断。包必须在对应平台上打（或推 local-bot-v* tag 走 CI），版本号以 -<平台>-<架构> 结尾。',
              'Each Desktop app takes the newest package registered for its own OS and architecture whose minimum Desktop version it meets, and switches to it the next time it starts its first local bot; running bots are not interrupted. Packages must be built on the target platform (or via a local-bot-v* tag in CI) and the version must end in -<platform>-<arch>.',
            ),
            data: { releases: state.localBotReleases?.releases || [], latest: new Set(Object.values(state.localBotReleases?.latestByTarget || {})), desired: '' },
            desired: false,
            extra: localBotTargetsPanel(state.localBotReleases?.latestByTarget, state.localBotReleases?.releases),
          })
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('机器配置')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${tab === 'local-bot'
            ? t('Gateway 只登记和分发发布包，自己不构建。', 'The Gateway only registers and serves packages; it never builds them.')
            : t('Gateway 只登记和分发发布包，自己不构建。包必须在 Linux 上打，架构要和席位机器一致。')}</p>
          <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted-foreground);">${t('下载地址就是那台 Debian 拉包用的 URL。登记在 GitHub Release 上的包机器直接去取、不带凭据，按 sha256 核对；Gateway 转发地址要机器令牌（curl -H "Authorization: Bearer smt_…"），管家自己会带上。')}</p>
        </div>
        ${flashes()}
        <div style="display: flex; gap: var(--space-2);">
          ${tabBtn('manager', t('机器管家'))}${tabBtn('bot', t('Bot 运行时'))}${tabBtn('local-bot', t('桌面端本地 Bot', 'Desktop local bot'))}
        </div>
        ${body}
      </div>
    </div>`
}

/**
 * 每个架构各自最新的那一版（列表已按登记时间倒序）。
 *
 * 一次发布是 arm64、x64 两份包，CI 串行登记，服务端的 `latest` 只是最后登记的那一份——
 * 只拿它标「最新」的话，同一次发布的另一份看着像旧版。机器取包也是按自己的架构取最新
 * （db.latestBotRelease 带 arch），这里和它一个口径。没有架构后缀的老版本单算一组。
 */
function latestPerArch(releases) {
  const out = new Map()
  for (const r of releases || []) {
    const m = /-(x64|arm64)$/.exec(String(r.version || ''))
    const arch = m ? m[1] : ''
    if (!out.has(arch)) out.set(arch, r.version)
  }
  return new Set(out.values())
}

function releaseRow(r, latest) {
  // 下载地址永远给出来，**包括字节就在 Gateway 磁盘上的时候**：那台 Debian 上没有
  // 别的地方能看到它，这一栏写「本机存储」等于没给。字节在哪儿降级成一行小字。
  //
  // 能直连的（GitHub Release 那种，见 gateway/src/releases.ts 的 directReleaseUrl）主行
  // 就是那个外部地址——机器真去的是那儿；Gateway 转发地址降成小字，只剩老管家拉 bot 包用。
  const dl = r.directUrl || r.downloadUrl || r.url || ''
  const from = r.directUrl
    ? `${t('老管家经 Gateway 转发')} ${esc(r.downloadUrl || '')}`
    : r.url ? `${t('外部来源')} ${esc(r.url)}` : t('本机存储')
  const where = `<span style="display: flex; flex-direction: column; gap: 2px; min-width: 0;">
      <span style="font-family: var(--font-mono, ui-monospace, monospace); word-break: break-all;">${esc(dl)}</span>
      <span style="color: var(--muted-foreground); word-break: break-all;">${from}${dl ? ` · <button type="button" class="satu-linkbtn" data-act="copy-release-url" data-url="${esc(dl)}">${t('复制')}</button>` : ''}</span>
    </span>`
  return `<div class="satu-memberrow" style="grid-template-columns: 240px 90px 120px 1fr 150px;">
    ${/* 行里的格子一律单行省略（shell.css），版本号一长，跟在后面的「最新」会先被截掉——
         0.1.16+…-arm64 比 -x64 长两个字，同一次发布一个有标一个没有。所以版本号自己省略
         （悬停看全），标签 flex: none 不让它挤。 */ ''}<span style="display: flex; flex-direction: column; gap: 2px;">
      <span style="display: flex; align-items: center; gap: 6px; min-width: 0;">
        <span title="${esc(r.version)}" style="min-width: 0; overflow: hidden; text-overflow: ellipsis; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;">${esc(r.version)}</span>
        ${(latest instanceof Set ? latest.has(r.version) : r.version === latest) ? `<span class="tag tag-accent" style="flex: none;">${t('最新')}</span>` : ''}
      </span>
      ${r.minDesktopVersion ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t('需要 Desktop', 'Needs Desktop')} ≥ ${esc(r.minDesktopVersion)}</span>` : ''}
    </span>
    <span style="font-size: 13px;">${esc(fmtSize(r.size))}</span>
    <span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted-foreground);">${esc(shaShort(r.sha256))}</span>
    <span style="font-size: 12px;">${where}</span>
    <span style="font-size: 13px; color: var(--muted-foreground);">${esc(fmtTime(r.createdAt))}</span>
  </div>`
}

/**
 * `latest` 是一个版本号，或者一组（每个架构 / 平台各有一个「最新」）。
 * `extra` 摆在说明和列表之间，给某一类独有的东西用。
 */
function releaseSection({ kind, title, hint, data, desired, extra = '' }) {
  const d = data || { releases: [], latest: null, desired: '' }
  const rows = d.releases || []
  // 两个 tab 各翻各的：管家和 Bot 是两条独立的版本线，在管家那边翻到第 3 页，
  // 切过去看 Bot 时没有理由也停在第 3 页。
  const view = pageSlice(`releases:${kind}`, rows)
  const table = rows.length
    ? `<div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover); overflow: hidden;">
        <div class="satu-memberhead" style="grid-template-columns: 240px 90px 120px 1fr 150px;">
          <span>${t('版本')}</span><span>${t('大小')}</span><span>sha256</span><span>${t('下载地址')}</span><span>${t('时间')}</span>
        </div>
        ${view.rows.map((r) => releaseRow(r, d.latest)).join('')}
        ${listPager(`releases:${kind}`, view, '版')}
      </div>`
    : `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground); border: 1px solid var(--border); border-radius: var(--radius-lg);">${t('还没有发布版本')}</div>`
  // 期望版本：管家和 Bot 运行时都是机器心跳时自己去追一个目标版本（Bot 是席位跟版，见
  // gateway/src/deploy.ts 的 queueBotFollow）。桌面端本地 Bot 没有这一档。
  const desiredForm = desired
    ? `<form data-form="release-desired" data-kind="${esc(kind)}" style="display: flex; gap: var(--space-2); align-items: flex-end;">
        <div class="field" style="margin: 0; flex: 1;">
          <label for="desired-${esc(kind)}">${t('期望版本')}</label>
          <input class="input" id="desired-${esc(kind)}" name="version" value="${esc(d.desired || '')}" placeholder="${esc(t('留空 = 跟最新'))}" autocomplete="off">
        </div>
        <button type="submit" class="btn" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
      </form>`
    : ''
  return `<div class="satu-panel" style="display: flex; flex-direction: column; gap: var(--space-3);">
    <span class="satu-panel-title">${esc(title)}</span>
    <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${esc(hint)}</p>
    ${desiredForm}
    ${extra}
    ${table}
    ${addReleaseForm(kind)}
  </div>`
}

/**
 * 新增版本。
 *
 * 四个字段都必填：**大小和 sha256 是拿来核对的，不是拿来记录的**。保存时 Gateway
 * 会把包整个拉一遍,比对这两项、确认入口文件在,对不上就不入库——一条指向坏包的
 * 记录会一路传染到席位机器上,而那时已经没人能上去看了。
 */
function addReleaseForm(kind) {
  const busy = state.busy
  return `<details ${state.addRelease === kind ? 'open' : ''}>
    <summary style="cursor: pointer; font-size: 13px; color: var(--muted-foreground);">${t('新增版本')}</summary>
    <form data-form="add-release" data-kind="${kind}" style="display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-3);">
      <div style="display: flex; gap: var(--space-3); flex-wrap: wrap;">
        <div class="field" style="margin: 0; flex: 1; min-width: 200px;">
          <label for="ar-ver-${kind}">${t('版本号')}</label>
          <input class="input" id="ar-ver-${kind}" name="version" required placeholder="${kind === 'local-bot' ? '0.1.0+abc1234-windows-x64' : '0.1.0+abc1234-arm64'}" autocomplete="off">
        </div>
        <div class="field" style="margin: 0; width: 160px;">
          <label for="ar-size-${kind}">${t('大小')}（${t('字节')}）</label>
          <input class="input" id="ar-size-${kind}" name="size" required inputmode="numeric" placeholder="9376749" autocomplete="off">
        </div>
        ${kind === 'local-bot' ? `<div class="field" style="margin: 0; width: 160px;">
          <label for="ar-mindesk-${kind}">${t('最低 Desktop 版本', 'Min Desktop version')}</label>
          <input class="input" id="ar-mindesk-${kind}" name="minDesktopVersion" pattern="\\d+\\.\\d+\\.\\d+" placeholder="0.1.0" autocomplete="off">
        </div>` : ''}
      </div>
      <div class="field" style="margin: 0;">
        <label for="ar-sha-${kind}">sha256</label>
        <input class="input" id="ar-sha-${kind}" name="sha256" required placeholder="${esc(t('64 位十六进制'))}" autocomplete="off">
      </div>
      <div class="field" style="margin: 0;">
        <label for="ar-url-${kind}">${t('下载地址')}</label>
        <input class="input" id="ar-url-${kind}" name="url" required placeholder="https://…/${kind}-0.1.0.tgz" autocomplete="off">
      </div>
      <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('保存前会把包整个拉一遍，核对大小与 sha256、确认入口文件在。验不过不入库。')}</p>
      <div><button type="submit" class="btn btn-primary" ${busy ? 'disabled' : ''}>${busy ? t('验证中…') : t('验证并保存')}</button></div>
    </form>
  </details>`
}
