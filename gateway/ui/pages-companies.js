/** 平台侧的公司详情：资料、套餐、席位，和这家公司手上那几台机器的卡片。原先在 pages-audit.js。 */
function companyDetailPage() {
  // 同 machineDetailPage：id 对不上就是上一家公司的，宁可画「载入中」。
  const c = state.org && state.org.id === companyIdOfPath(state.path) ? state.org : null
  if (!c) {
    return `<div class="gw-page"><div class="gw-page-inner">${flashes()}<p style="color: var(--muted-foreground);">${t('载入中…')}</p></div></div>`
  }
  const plan = state.plan || { seats: 0, used: 0 }
  const seats = state.seats || { total: plan.seats || 0, used: plan.used || 0 }
  const members = state.accounts || []
  const billing = state.billing || { plan: {}, invoices: [] }
  const bplan = billing.plan || {}
  const invoices = Array.isArray(billing.invoices) ? billing.invoices : []
  const used = plan.used ?? seats.used ?? 0
  const total = plan.seats ?? seats.total ?? 0
  const envCols = 'minmax(170px, 2fr) 88px 72px minmax(90px, 1fr) minmax(120px, 1.3fr) 72px'
  const memberRows = members
    .map((m) => {
      const st = MEMBER_STATUS[m.status] || MEMBER_STATUS.active
      const runtimes = Array.isArray(m.runtimes) ? m.runtimes : []
      // 这一列本来只说「装的是哪个包」。模版版本跟在后面：一眼扫下去，落在旧版上的那
      // 几行就自己跳出来了，不用挨个点开。
      const env = runtimes.length
        ? runtimes
            .map((rt) => {
              const base = esc(rt.botVersion || rt.botId || rt.status || '—')
              return rt.tplVersion ? `${base} · ${t('模版', 'tpl')} v${esc(String(rt.tplVersion))}` : base
            })
            .join(' · ')
        : t('未部署')
      return `<div class="satu-memberrow" style="grid-template-columns: ${envCols};">
      <button type="button" class="satu-linkbtn" data-act="seat-open" data-id="${esc(m.id)}" style="min-width: 0; display: flex; align-items: center; gap: var(--space-3); text-align: left; padding: 0; border: 0; background: transparent;">
        <span class="satu-avatar" style="background: var(--color-neutral-300); color: var(--color-neutral-800);">${esc((m.name || m.email || '·').slice(0, 1).toUpperCase())}</span>
        <div style="min-width: 0;">
          <div style="font-size: 13.5px; font-weight: 600;">${esc(m.name || m.email)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(m.email)}</div>
        </div>
      </button>
      ${roleTag(m.role)}
      <span class="tag ${st.tag}">${t(st.label)}</span>
      <span style="font-size: 13px; color: var(--muted-foreground);">${esc(ago(m.lastSeenAt))}</span>
      <span style="font-size: 13px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${env}</span>
      <button type="button" class="satu-linkbtn" data-act="seat-open" data-id="${esc(m.id)}">${t('查看')}</button>
    </div>`
    })
    .join('')
  const invoiceRows = invoices.map((b) => invoiceRow(b)).join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        ${pageHead(esc(c.name || t('公司详情')), esc(c.slug || ''))}
        ${flashes()}
        <form class="satu-panel" data-form="org-profile" data-id="${esc(c.id)}" style="gap: var(--space-4);">
          <span class="satu-panel-title">${t('公司信息')}</span>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-3);">
            <div class="field" style="margin: 0;">
              <label for="cd-name">${t('名称')}</label>
              <input class="input" id="cd-name" name="name" value="${esc(c.name || '')}" required>
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-slug">slug</label>
              <input class="input" id="cd-slug" name="slug" value="${esc(c.slug || '')}" required>
            </div>
            <div class="field" style="margin: 0;">
              <label>${t('状态')}</label>
              <div style="display: flex; align-items: center; gap: var(--space-3);">
                ${companyStatusTag(c.status)}
                <button type="button" class="btn btn-secondary" data-act="org-status" data-id="${esc(c.id)}" data-next="${c.status === 'disabled' ? 'active' : 'disabled'}">
                  ${c.status === 'disabled' ? t('启用') : t('停用')}
                </button>
              </div>
              <span style="font-size: 12px; color: var(--muted-foreground);">${t('状态单独生效，不用保存这张表单。停用后这家公司的人一律登不进来')}</span>
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-contact-name">${t('联系人')}</label>
              <input class="input" id="cd-contact-name" name="contactName" value="${esc(c.contactName || '')}" required>
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-contact-phone">${t('电话')}</label>
              ${phoneField('cd-contact-phone', c.contactPhone)}
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-contact-email">${t('联系邮箱')}</label>
              <input class="input" id="cd-contact-email" name="contactEmail" type="email" value="${esc(c.contactEmail || '')}" required>
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-address">${t('公司地址')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
              <input class="input" id="cd-address" name="address" value="${esc(c.address || '')}">
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-website">${t('网站')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
              <input class="input" id="cd-website" name="website" value="${esc(c.website || '')}" placeholder="https://acme.com">
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-url">${t('访问地址')}</label>
              <input class="input" id="cd-url" name="accessUrl" value="${esc(c.accessUrl || '')}" placeholder="https://acme.satuwork.com">
            </div>
          </div>
          <div class="satu-kv"><span>id</span><span>${esc(c.id || '—')}</span></div>
          <div class="satu-kv"><span>${t('创建时间')}</span><span>${esc(fmtTime(c.createdAt))}</span></div>
          <div class="satu-kv"><span>machineId</span><span>${esc(c.machineId || '—')}</span></div>
          <div style="display: flex; justify-content: flex-end;">
            <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
          </div>
        </form>
        ${machinePanel(c.id)}
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
            <h2 style="font-size: 18px; margin: 0;">${t('成员')}</h2>
            <div style="display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;">
              <span style="font-size: 12px; color: var(--muted-foreground);">${/* 一次发布有 arm64 / x64 两份，这里说的是「平台发到哪一版」，架构后缀去掉——
     不然永远显示最后登记的那份（x64），arm64 的公司看着像自己落后了。 */ ''}${t(`平台最新 ${esc(state.latestRelease ? String(state.latestRelease).replace(/-(x64|arm64)$/, '') : t('还没有发布版本'))}`, `Latest ${esc(state.latestRelease ? String(state.latestRelease).replace(/-(x64|arm64)$/, '') : t('还没有发布版本'))}`)} · ${t(`${members.length} 人`, `${members.length} people`)} · ${t('已用')} ${t(`${esc(used)} / ${esc(total)} 席位`, `${esc(used)} / ${esc(total)} seats`)}</span>
            </div>
          </div>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-memberhead" style="grid-template-columns: ${envCols};">
              <span>${t('成员')}</span><span>${t('角色')}</span><span>${t('状态')}</span><span>${t('最近活跃')}</span><span>${t('环境')}</span><span></span>
            </div>
            ${memberRows || emptyBox(t('还没有成员'))}
          </div>
        </div>
        <div class="satu-panel">
          <span class="satu-panel-title">${t('订阅')}</span>
          <div style="display: flex; align-items: baseline; gap: var(--space-2);">
            <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(planLabel(plan) || t('无套餐'))}</span>
            ${plan.expiresAt && plan.expiresAt < Date.now() ? `<span class="tag tag-neutral">${t('已到期')}</span>` : ''}
          </div>
          <div class="satu-kv"><span>${t('席位')}</span><span>${esc(used)} / ${esc(total)}</span></div>
          <div class="satu-kv"><span>${t('知识库')}</span><span>${esc(plan.knowledgeUsed || 0)} / ${esc(plan.knowledgeBases || 0)}</span></div>
          <div class="satu-kv"><span>${t('账期')}</span><span>${esc(bplan.period || '—')}</span></div>
          <div class="satu-kv"><span>${t('到期时间')}</span><span>${esc(plan.expiresAt ? dayISO(plan.expiresAt) : t('不限期'))}</span></div>
          <div class="satu-kv"><span>${t('周期费用')}</span><span>${esc(bplan.amount || '—')}</span></div>
          <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('订阅按订单走：套餐、席位、到期时间都跟着订单，改这些请到订单页下单。')}</p>
        </div>
        ${balancePanel()}
        ${topupRecordsPanel()}
        ${billTable(t('订阅账单'), [t('账期'), t('金额'), t('状态'), t('付款时间'), ''], invoiceRows, t('还没有订阅账单。支付接上之后，账期会列在这里。'))}
        ${chargeTable('org', state.org?.id || '')}
        ${seatEnvModal()}
      </div>
    </div>`
}

function machinePanel(orgId) {
  const list = state.machines || []
  const cap = state.machineCapacity || { accounts: 0, max: 0 }
  const code = state.pairingCode
  // 配对码只在生成的那一刻拿得到，刷新页面就没了——所以要显眼，还要能一键复制。
  const codeBox = code
    ? `<div class="satu-panel" style="margin: 0; background: var(--muted);">
        <div class="satu-kv"><span>${t('配对码')}</span><span style="font-family: var(--font-mono); font-size: 16px; letter-spacing: 1px;">${esc(code.code)}</span></div>
        <div class="satu-kv"><span>${t('有效期至')}</span><span>${esc(new Date(code.expiresAt).toLocaleString())}</span></div>
        <p style="margin: var(--space-2) 0 6px; font-size: 12px; color: var(--muted-foreground);">${t('在那台 Debian 上用 root 跑这一条，装完即配对：')}</p>
        <pre style="margin: 0; padding: 10px; overflow-x: auto; background: var(--background); border-radius: var(--radius); font-size: 12px;"><code>${esc(code.installCommand)}</code></pre>
        <p style="margin: var(--space-2) 0 0; font-size: 12px; color: var(--muted-foreground);">${t('同一个地址重跑 = 重新配对那一台；换一台机器跑 = 新增一台。')}</p>
        <div style="margin-top: var(--space-2);"><button type="button" class="satu-linkbtn" data-act="copy-install">${t('复制命令')}</button></div>
      </div>`
    : ''
  const cards = list.length
    ? list.map((m) => machineCard(orgId, m)).join('')
    : `<p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('还没有配对任何机器')}</p>`
  return `<div class="satu-panel">
    <span class="satu-panel-title">${t('运行机器')}</span>
    <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('装上机器管家并配对之后，建账号、装包、起桌面全归它——Gateway 不保存任何登录这台机器的凭据。')}</p>
    <div class="satu-kv"><span>${t('账号位')}</span><span>${cap.accounts} / ${cap.max}${cap.max && cap.accounts >= cap.max ? ' · ' + t('已满，新员工无法部署') : ''}</span></div>
    ${cards}
    ${list.length ? timezoneOptions() : ''}
    ${codeBox}
    <div><button type="button" class="btn btn-primary" data-act="pairing-code" data-id="${esc(orgId)}" ${state.busy ? 'disabled' : ''}>${list.length ? t('新增 / 重配机器') : t('生成配对码')}</button></div>
  </div>`
}

/**
 * 通联状态 → 一盏灯 + 一句话。
 *
 * **判据是心跳的新旧，不是 `lastError`。** 能报错说明线是通的；把两件事塞进同一盏灯，
 * 「机器失联」和「机器在线但升级失败」就长成一个样子，而这两种的处置完全不同。错误
 * 另有一行 lastError 管。
 *
 * 中间那档 `stale` 不是凑数：换版重启本身就会断几十秒，一超时就报红会让每次自升级都
 * 闪一次红灯，几次之后没人再信这盏灯。
 */
const LINK_TEXT = {
  online: () => t('在线'),
  stale: () => t('心跳迟了'),
  offline: () => t('失联'),
  unpaired: () => t('还没有配对'),
  unknown: () => t('状态未知'),
}

/** 「多久之前」。秒级起步——心跳 30 秒一轮，只报到分钟就看不出刚刚断没断。 */
function sinceMs(ms) {
  if (ms == null) return ''
  return SatuCore.agoText(localeMode, ms, true)
}

/**
 * 卡片的头一行：灯、编号、短码、状态，右端一颗刷新。
 *
 * **编号和短码是两样东西。** 「1 号机」是给人照着念的，中间删掉一台后面就会往前挪；
 * 要唯一地指一台得用 id，所以短码那颗按钮复制的是**完整 id**，显示的只是前 8 位——
 * 完整 UUID 摆在卡片头上，占一行，还没人读得下来。
 */
function machineHead(orgId, card, m) {
  // **「后端没给这个字段」不等于「机器没配对」。** 这两件事差得最远，而合成一个兜底
  // 值的代价是：一台心跳正常、版本刚升完的机器，界面上写着「还没有配对」。开发时
  // 前端比后端新一步就会撞上（浏览器读的是磁盘上的 app.js，Gateway 要重启才换代码）。
  //
  // `paired` 是老响应里就有的，可信；`link` 缺了就老实说不知道，不替它猜一个。
  const link = m.link || (m.paired === false ? 'unpaired' : 'unknown')
  const label = (LINK_TEXT[link] || LINK_TEXT.unknown)()
  // 「还没有配对」本身就说完了，再缀一个「从未」是废话；配对过却没心跳过才要点出来。
  // 状态未知时也不缀——那个数字同样来自缺席的那批字段。
  const when =
    link === 'unpaired' || link === 'unknown'
      ? ''
      : m.heartbeatAge == null
        ? ' · ' + t('从未心跳')
        : ' · ' + sinceMs(m.heartbeatAge)
  const short = String(m.id || '').slice(0, 8)
  return `<div class="satu-machinehead">
    <span class="satu-linkdot" data-link="${esc(link)}" title="${esc(label)}"></span>
    ${/* 编号缺席时整个略过，不画「机器 ?」——一个问号既指代不了机器，也说不清是哪儿出了问题。 */ ''}
    ${card.no ? `<span class="satu-machineno">${t('机器')} ${esc(card.no)}</span>` : ''}
    ${short ? `<button type="button" class="satu-linkbtn satu-machineid" data-act="copy-machine-id" data-machine="${esc(m.id)}" title="${t('复制完整编号')}">${esc(short)}</button>` : ''}
    <span style="font-size: 13px; color: var(--muted-foreground);">${esc(label)}${esc(when)}</span>
    ${/* 卡片上的心跳、版本都是机器自报的，下完指令要等下一轮心跳才变——所以要有一颗
         「我现在就想知道」的按钮。它只重拉 Gateway 手上这一份，不去戳机器。

         没有 data-machine：机器那个接口一次回整张列表，重拉就是全都新的，没有
         「只刷这一台」这回事。挂一个用不上的 id 会让人以为有。 */ ''}
    <button type="button" class="satu-linkbtn satu-machinerefresh" data-act="machine-refresh" data-id="${esc(orgId)}" ${state.busy ? 'disabled' : ''} title="${t('重新拉一遍这台机器的信息')}">${t('刷新')}</button>
  </div>`
}

/**
 * 一台机器一张卡：地址、容量、两行版本、各自的升级按钮。
 *
 * 「已用」是**激活账号数**，不是席位数——一个员工的多个 bot 落在同一台机器上，只占
 * 一个账号位。席位数另外标出来，运维时想知道机器上到底有多少个进程。
 */
function machineCard(orgId, card) {
  const m = card.machine || {}
  const full = card.full
  return `<div class="satu-panel" style="margin: 0; background: var(--muted);">
    ${machineHead(orgId, card, m)}
    <div class="satu-kv"><span>${t('地址')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; word-break: break-all;">
      ${esc(m.host || '—')}
      ${/* 有席位也给点：席位的登记会跟着一起没，点下去先弹确认（见 removeMachine）。
           以前有席位就整个不画这颗按钮，结果是人只会以为功能没做。 */ ''}
      <button type="button" class="satu-linkbtn" data-act="machine-remove" data-id="${esc(orgId)}" data-machine="${esc(m.id)}" ${state.busy ? 'disabled' : ''}>${t('移除')}</button>
    </span></div>
    <div class="satu-kv"><span>${t('账号位')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
      ${m.paired ? `${card.accounts} / ${card.maxAccounts}` : `<span style="color: var(--muted-foreground);">${t('未配对，不提供账号位')}</span>`}${full ? ` <span class="tag">${t('已满')}</span>` : ''} · ${t('席位')} ${card.seats}
      <form data-form="machine-capacity" data-id="${esc(orgId)}" data-machine="${esc(m.id)}" style="display: inline-flex; gap: 6px; align-items: center;">
        <input class="input" name="maxAccounts" type="number" min="1" max="1000" value="${esc(card.maxAccounts)}" style="width: 84px;">
        <button type="submit" class="satu-linkbtn" ${state.busy ? 'disabled' : ''}>${t('改容量')}</button>
      </form>
    </span></div>
    <div class="satu-kv"><span>${t('最近心跳')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
      ${m.lastHeartbeatAt ? esc(new Date(m.lastHeartbeatAt).toLocaleString()) : t('还没有')}
      ${/* 没有 SSH 的时候，「这台机器怎么了」只能靠日志。管家自己那条和各席位的 bot
           那条答的不是同一个问题，所以两个都要能选。 */ ''}
      ${m.paired ? `<button type="button" class="satu-linkbtn" data-act="machine-logs" data-id="${esc(orgId)}" data-machine="${esc(m.id)}">${t('查看日志')}</button>` : ''}
    </span></div>
    ${machineLoadRow(m)}
    ${timezoneRow(orgId, m, card)}
    ${managerVersionRow(orgId, m, card)}
    ${botVersionRow(orgId, card)}
    ${botTemplateRow(card)}
    ${m.lastError ? `<div class="satu-kv"><span>lastError</span><span>${esc(m.lastError)}</span></div>` : ''}
    <form data-form="machine" data-id="${esc(orgId)}" data-machine="${esc(m.id)}" style="display: flex; gap: var(--space-2); align-items: flex-end;">
      <div class="field" style="margin: 0; flex: 1;">
        <label>${t('管家地址')}</label>
        <input class="input" name="host" value="${esc(m.host || '')}" placeholder="http://10.0.0.12:8443" autocomplete="off">
      </div>
      <button type="submit" class="btn" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
    </form>
    <form data-form="machine-direct" data-id="${esc(orgId)}" data-machine="${esc(m.id)}" style="display: flex; gap: var(--space-2); align-items: flex-end;">
      <div class="field" style="margin: 0; flex: 1;">
        <label>${t('桌面直连地址')}</label>
        <input class="input" name="directUrl" value="${esc(m.directUrl || '')}" placeholder="https://m001.example.com" autocomplete="off">
      </div>
      <button type="submit" class="btn" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
    </form>
    <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('填上之后桌面画面由浏览器直连这台机器，不再经过 Gateway。必须公网可达且是 https。留空 = 照旧从 Gateway 反代。')}${m.directPending ? `<br><b>${t('地址填了，但这台机器的管家版本还不够新，桌面仍在走 Gateway 反代——等它自升级上来会自动切过去。')}</b>` : ''}</p>
  </div>`
}

/**
 * 负载与日志占用，**只读一行**。
 *
 * 这张卡答的是「这家公司手上有几台、够不够用」，不是运维台——所以这里只把最吃紧的
 * 那一项和 journal 的大小摆出来，改上限、手动清理这些动作都在平台的机器详情页
 * （那一页才是为「这台机器怎么了」准备的）。两处共用同一批渲染函数（见
 * pages-machines.js），免得同一台机器在两个页面上说两种话。
 *
 * 机器没报过就整行不画：一行「—」占着地方却什么也没说。
 */
function machineLoadRow(m) {
  const load = (m.telemetry && m.telemetry.metrics) || null
  const logs = (m.telemetry && m.telemetry.logs) || null
  if (!load && !logs) return ''
  const age = m.telemetryAge == null ? '' : sinceMs(m.telemetryAge)
  return `<div class="satu-kv"><span>${t('负载')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
    ${load ? machineLoadCell(m) : ''}
    ${logs ? `<span style="font-size: 13px; color: var(--muted-foreground);">${t('日志')} ${esc(fmtBytes(logs.journalBytes))}</span>` : ''}
    ${age ? `<span style="font-size: 12px; color: var(--muted-foreground);">· ${esc(age)}</span>` : ''}
  </span></div>`
}

/**
 * 机器时区行。
 *
 * 和「升级」是同一条路：Gateway 没有登录这台机器的凭据，填进去只是**把期望时区钉在
 * 这台机器上**，真正 `timedatectl set-timezone` 的是机器上的管家，下一轮心跳才知道
 * 成没成。所以这里显示的是**机器自报的实际时区**，指令还没落地时另标一句，不写成
 * 「已生效」。
 *
 * 留空 = 不再管这台机器的时区（不会把机器改回去）。
 */
function timezoneRow(orgId, m, card) {
  const cur = m.currentTimezone || (m.paired ? t('机器没报') : '—')
  const note = card.timezonePending
    ? ` · ${t('已下指令，等机器改')} → ${esc(m.timezone || '')}`
    : m.timezone
      ? ` · ${t('已生效')}`
      : ` · ${t('没有指定，跟机器现状')}`
  return `<div class="satu-kv"><span>${t('时区')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
    ${esc(cur)}${note}
    <form data-form="machine-timezone" data-id="${esc(orgId)}" data-machine="${esc(m.id)}" style="display: inline-flex; gap: 6px; align-items: center;">
      <input class="input" name="timezone" list="satu-timezones" value="${esc(m.timezone || '')}" placeholder="Asia/Shanghai" autocomplete="off" spellcheck="false" style="width: 200px;">
      <button type="submit" class="satu-linkbtn" ${state.busy ? 'disabled' : ''}>${t('改时区')}</button>
    </form>
  </span></div>`
}

/**
 * 时区候选。浏览器自己就有全套 IANA 表（`Intl.supportedValuesOf`），不必在前端塞一份
 * 会过期的清单。取不到就退回几个常用的——datalist 只是补全，手打任何合法名字都收，
 * 真正认不认由 Gateway 判。
 *
 * **整个面板只出一份**（不是每台机器一份）：id 要唯一，而且这张表有四百多项，
 * 多机公司逐台复制一遍纯属白搭 DOM。
 */
let timezoneList = null
function timezoneOptions() {
  if (!timezoneList) {
    try {
      timezoneList = Intl.supportedValuesOf('timeZone')
    } catch {
      timezoneList = ['Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Kolkata', 'Europe/London', 'UTC']
    }
  }
  return `<datalist id="satu-timezones">${timezoneList.map((z) => `<option value="${esc(z)}"></option>`).join('')}</datalist>`
}

/** 管家版本行。说明和按钮和机器详情页同一份，见 pages-machines.js 的 managerUpgradeBits。 */
function managerVersionRow(orgId, m, card) {
  const cur = m.managerVersion || '—'
  const { note, btn } = managerUpgradeBits(card, `data-id="${esc(orgId)}" data-machine="${esc(m.id)}"`)
  return `<div class="satu-kv"><span>${t('管家版本')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">${esc(cur)}${note}${btn}</span></div>`
}

/**
 * Bot 运行时版本行。
 *
 * 一台机器上可以同时躺着几个版本——有的席位部署得早、有的重新部署过。混版本本身
 * 不是错误，但得看得见，不然「升级完了吗」永远说不清。所以列的是清单加席位数。
 */
function botVersionRow(orgId, card) {
  const list = card.botVersions || []
  const text = list.length ? esc(botVersionsSummary(list)) : t('还没有部署席位')
  const canUp = card.botOutdated
  // 「可升级」比的是目标版本（平台钉的那一版，没钉就是最新），所以这里说的也是目标版本。
  const note = canUp ? ` · ${t('目标版本')} ${esc(card.botDesired || card.botLatest || state.botLatest || '')}` : ''
  const btn = canUp
    ? `<button type="button" class="btn" data-act="upgrade-bot" data-id="${esc(orgId)}" ${state.updatingRuntime ? 'disabled' : ''}>${state.updatingRuntime ? t('更新中…') : t('全部升级')}</button>`
    : ''
  return `<div class="satu-kv"><span>${t('Bot 运行时')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">${text}${note}${btn}</span></div>`
}

/**
 * 这台机器上的席位在跑哪一版**公司模版**。
 *
 * 和上面那行「Bot 运行时」是两件事：那行说的是装了哪个发布包，这行说的是跑着哪一版
 * 模版。两者会各自落后——包升到最新了、模版还停在三版之前，只看上面那行看不出来。
 *
 * 数字是**席位自己报上来的**（探针捎回，见迁移 0013）。没报到过的单独说，不混进某个
 * 版本号里：那多半意味着那台上的 bot 进程不在了，而它和「跑着旧版本」要查的是两件事。
 */
function botTemplateRow(card) {
  const list = card.tplVersions || []
  if (!list.length) return ''
  const known = list.filter((v) => v.version)
  const unknown = list.find((v) => !v.version)
  const text = [
    ...known.map((v) => `v${esc(String(v.version))} × ${v.seats}`),
    ...(unknown ? [t(`还没报到 × ${unknown.seats}`, `never reported × ${unknown.seats}`)] : []),
  ].join('、')
  return `<div class="satu-kv"><span>${t('Bot 模版')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">${text}</span></div>`
}

function botNameOfId(id) {
  const b = (state.bots || []).find((x) => x.id === id)
  return (b && b.name) || id || '—'
}

function seatEnvModal() {
  if (!state.seatMember) return ''
  const m = state.seatMember
  const runtimes = Array.isArray(state.seatRuntimes) ? state.seatRuntimes : []
  const body = runtimes.length
    ? runtimes
        .map((rt) => {
          const pw = rt && rt.vncPassword ? (state.seatReveal ? rt.vncPassword : '••••••••') : '—'
          return `<div class="satu-panel" style="margin: 0;">
        <span class="satu-panel-title">${esc(botNameOfId(rt.botId))}</span>
        <div class="satu-kv"><span>botId</span><span>${esc(rt.botId || '—')}</span></div>
        <div class="satu-kv"><span>linuxUser</span><span>${esc(rt.linuxUser || '—')}</span></div>
        <div class="satu-kv"><span>seatId</span><span style="word-break: break-all;">${esc(rt.seatId || '—')}</span></div>
        <div class="satu-kv"><span>${t('共享目录')}</span><span style="word-break: break-all;">${esc(rt.sharedDir || '—')}</span></div>
        ${rt.workDir ? `<div class="satu-kv"><span>${t('Bot 工作目录')}</span><span style="word-break: break-all;">${esc(rt.workDir)}</span></div>` : ''}
        <div class="satu-kv"><span>DISPLAY</span><span>${esc(rt.display != null ? ':' + rt.display : '—')}</span></div>
        <div class="satu-kv"><span>noVNC</span><span style="word-break: break-all;">${esc(rt.novncUrl || '—')}</span></div>
        <div class="satu-kv"><span>${t('VNC 密码')}</span><span>${esc(pw)} <button type="button" class="satu-linkbtn" data-act="seat-reveal">${state.seatReveal ? t('隐藏') : t('显示')}</button></span></div>
        <div class="satu-kv"><span>${t('状态')}</span><span>${esc(rt.status || '—')}</span></div>
        <div class="satu-kv"><span>${t('Bot 版本')}</span><span>${esc(rt.botVersion || t('未部署'))}</span></div>
        <!-- 两个「版本」问的是两件事：装的是哪个发布包、跑的是哪一版公司模版。后者由席位
             自己报上来，所以还带着「什么时候报的」——版本号对得上、汇报停在两小时前，
             说明那个进程已经不在了。 -->
        <div class="satu-kv"><span>${t('模版版本')}</span><span>${
          rt.tplVersion
            ? esc(`v${rt.tplVersion} · ${ago(rt.tplSyncedAt)}`)
            : t('还没报到过', 'never reported')
        }</span></div>
        ${rt.lastError ? `<div class="satu-kv"><span>lastError</span><span>${esc(rt.lastError)}</span></div>` : ''}
      </div>`
        })
        .join('') +
      `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('x11vnc 只听 localhost；noVNC 走内网 HTTP。不要当成公网安全。')}</p>`
    : `<p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${state.seatError || t('还没有部署。员工自己建一颗 Bot，它就会自己装上。')}</p>`
  return modalBox({
    close: 'seat-close',
    attrs: 'class="gw-modal" style="max-width: 520px;" data-stop',
    title: t('员工环境'),
    sub: `${esc(m.name || m.email)} · ${esc(m.email)}`,
    body: `${body}`,
  })
}
