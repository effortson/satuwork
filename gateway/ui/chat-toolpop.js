/** 工具痕迹的悬浮窗。原先在 chat.js 里，拆出来只是搬家（顺序见 index.html）。 */
/* ── 工具痕迹的悬浮窗 ────────────────────────────────────────────────────
 *
 * 药丸上只有「工具名 · 状态」，而人真正想知道的是**它拿什么参数跑的、跑出了什么**。
 * 失败的那几颗尤其——以前想知道为什么失败，只能去「导出 Markdown」里翻整段 JSON。
 *
 * 浮层挂在 body 上，不放进气泡里：气泡有自己的圆角和 overflow，浮层长在里面会被裁掉
 * 一角；而且最后一条消息贴着输入框时，往上弹还是往下弹得按视口算，气泡内的坐标系
 * 算不出来。
 *
 * 鼠标移开有一小段宽限，且移到浮层上算「还在看」——否则一个能滚动的浮层，人刚要伸手
 * 去滚它就没了。
 */
const TOOLPOP_HIDE_MS = 160
const TOOLPOP_MAX_CHARS = 4000
let toolPop = null
let toolPopAnchor = null
let toolPopHost = null
let toolPopIndex = -1
let toolPopHideTimer = null

function toolPopEl() {
  if (toolPop) return toolPop
  toolPop = document.createElement('div')
  toolPop.className = 'sw-toolpop'
  toolPop.hidden = true
  toolPop.addEventListener('mouseenter', () => clearTimeout(toolPopHideTimer))
  toolPop.addEventListener('mouseleave', () => hideToolPop(TOOLPOP_HIDE_MS))
  document.body.appendChild(toolPop)
  return toolPop
}

/** 参数是 bot 那边 stringify 过的原串。能 parse 就缩进展示，不能就原样——不猜格式。 */
function prettyArgs(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text) return ''
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** 超长就截断并说清楚截了多少。悄悄截掉会让人以为工具真的只输出了这么点。 */
function clip(text) {
  const s = String(text == null ? '' : text)
  if (s.length <= TOOLPOP_MAX_CHARS) return s
  return s.slice(0, TOOLPOP_MAX_CHARS) + '\n\n…（还有 ' + (s.length - TOOLPOP_MAX_CHARS) + ' 个字符，完整内容见「导出 Markdown」）'
}

function toolPopBody(x) {
  if (x && x.approval) return approvalPopBody(x)
  const label = x.result == null ? t('调用中') : x.failed ? t('失败') : t('完成')
  const state_ = x.result == null ? 'running' : x.failed ? 'error' : 'done'
  const args = prettyArgs(x.args)
  const rows = [
    `<div class="sw-toolpop-head"><span class="sw-toolpop-name">${esc(x.name)}</span>` +
      `<span class="sw-toolpop-state" data-state="${state_}">${esc(label)}</span></div>`,
  ]
  // 参数为空是常事（now、ls 这种），那就不摆一个空框——空框看着像「读不出来」。
  if (args) rows.push(`<div class="sw-toolpop-k">${esc(t('参数'))}</div><pre>${esc(clip(args))}</pre>`)
  if (x.result == null) {
    rows.push(`<div class="sw-toolpop-wait">${esc(t('还在跑，结果出来后这里会填上'))}</div>`)
  } else {
    const out = String(x.result || '').trim()
    rows.push(
      `<div class="sw-toolpop-k">${esc(x.failed ? t('错误') : t('结果'))}</div>` +
        (out ? `<pre>${esc(clip(out))}</pre>` : `<div class="sw-toolpop-wait">${esc(t('（没有输出）'))}</div>`),
    )
  }
  return rows.join('')
}

/**
 * 收起来的那颗确认，展开之后要看到的东西：为什么要确认、当时批的是什么参数。
 *
 * 参数留在这里而不是留在气泡里，是因为**它只在被问起时才重要**：批的那一刻必须摊开，
 * 批完之后是一条痕迹。翻旧对话的人要的是「这一步谁点的头」，需要细看时再停一下鼠标。
 */
function approvalPopBody(a) {
  const label = (APPROVAL_CHIP_LABEL[a.state] || APPROVAL_CHIP_LABEL.denied)()
  const rows = [
    `<div class="sw-toolpop-head"><span class="sw-toolpop-name">${esc(a.name)}</span>` +
      `<span class="sw-toolpop-state" data-state="${a.state === 'approved' ? 'done' : 'error'}">${esc(label)}</span></div>`,
  ]
  if (a.reason) rows.push(`<div class="sw-toolpop-k">${esc(t('为什么要确认', 'Why approval was needed'))}</div><div>${esc(a.reason)}</div>`)
  /**
   * **改过要说出来，而且要说改了哪几格。**
   *
   * 下面摆的是最终那一份（席位在终态事件里给的就是改后的）。不写这一行的话，翻记录
   * 的人会以为模型起草的就是这个样子——而「这句话是谁写的」正是事后最要紧的问题。
   */
  if ((a.edited || []).length) {
    rows.push(
      `<div class="sw-toolpop-k">${esc(t('批准时改过', 'Edited before approving'))}</div><div>${esc(a.edited.join('、'))}</div>`,
    )
  }
  // 退回修改时写的那句：下一版为什么长成那样，答案就在这儿。
  if (a.feedback) {
    rows.push(`<div class="sw-toolpop-k">${esc(t('修改意见', 'Changes requested'))}</div><div>${esc(a.feedback)}</div>`)
  }
  const fields = (a.form && a.form.fields) || []
  if (fields.length) {
    // 有表单就按表单摆（收件人 / 主题 / 正文），比一段带转义符的 JSON 好读得多。
    rows.push(
      `<div class="sw-toolpop-k">${esc(t('内容', 'Content'))}</div>` +
        fields
          .filter((f) => f.value)
          .map(
            (f) =>
              `<div class="sw-toolpop-field"><span>${esc(f.label)}</span>${
                f.multiline ? `<pre>${esc(clip(f.value))}</pre>` : `<div>${esc(f.value)}</div>`
              }</div>`,
          )
          .join(''),
    )
  } else {
    const args = prettyArgs(a.args)
    if (args) rows.push(`<div class="sw-toolpop-k">${esc(t('参数'))}</div><pre>${esc(clip(args))}</pre>`)
  }
  return rows.join('')
}

/**
 * 定位。先填内容再量高度——内容是刚换的，没量过就不知道往上弹放不放得下。
 * 放不下就翻到下面，两边都不够时贴住视口，宁可挡一点也不要跑到屏幕外面去。
 */
function placeToolPop(chip) {
  const pop = toolPopEl()
  const r = chip.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  pop.style.maxWidth = Math.min(520, vw - 24) + 'px'
  const box = pop.getBoundingClientRect()
  const above = r.top >= box.height + 12
  let top = above ? r.top - box.height - 8 : r.bottom + 8
  if (!above && top + box.height > vh - 8) top = Math.max(8, vh - box.height - 8)
  let left = r.left
  if (left + box.width > vw - 12) left = vw - 12 - box.width
  if (left < 12) left = 12
  pop.style.top = Math.max(8, top) + 'px'
  pop.style.left = left + 'px'
  pop.setAttribute('data-side', above ? 'top' : 'bottom')
}

function showToolPop(chip) {
  const x = chip.__tool
  if (!x) return
  clearTimeout(toolPopHideTimer)
  const pop = toolPopEl()
  // 同一颗药丸重复触发（鼠标在药丸里移动）就别重画了，否则滚动位置每帧都被重置。
  if (toolPopAnchor !== chip || pop.hidden) {
    toolPopAnchor = chip
    toolPopHost = chip.parentElement
    toolPopIndex = Number(chip.getAttribute('data-i'))
    pop.innerHTML = toolPopBody(x)
    pop.hidden = false
    placeToolPop(chip)
  }
}

function hideToolPop(delay) {
  clearTimeout(toolPopHideTimer)
  const run = () => {
    if (toolPop) toolPop.hidden = true
    toolPopAnchor = null
    toolPopHost = null
    toolPopIndex = -1
  }
  if (!delay) run()
  else toolPopHideTimer = setTimeout(run, delay)
}

/**
 * chips 重画之后把浮层接到新节点上。
 *
 * 节点是 innerHTML 整体换掉的，原来那个 anchor 已经脱离文档。按容器 + 下标重新认一次
 * ——「调用中 → 完成」正是人盯着它看的那一刻，那时候浮层闪没最难受。认不回来才关。
 */
function refreshToolPop() {
  if (!toolPop || toolPop.hidden) return
  if (toolPopAnchor && document.contains(toolPopAnchor)) return
  const list = toolPopHost ? toolPopHost.querySelectorAll('.sw-toolchip') : []
  const next = toolPopIndex >= 0 ? list[toolPopIndex] : null
  if (!next || !next.__tool) return hideToolPop(0)
  toolPopAnchor = next
  toolPop.innerHTML = toolPopBody(next.__tool)
  placeToolPop(next)
}

/**
 * 发信卡上写的修改意见，随手记进草稿表。
 *
 * 挂在 document 上而不是每张卡上：卡片是 innerHTML 换出来的，节点每次重画都是新的，
 * 挂在节点上的监听会跟着没。
 */
document.addEventListener('input', (e) => {
  const el = e.target instanceof Element ? e.target : null
  if (!el || !el.hasAttribute('data-feedback')) return
  approvalDrafts.set(draftKey(el.getAttribute('data-call') || '', FEEDBACK_KEY), el.value)
})

document.addEventListener('mouseover', (e) => {
  const el = e.target instanceof Element ? e.target : null
  if (!el) return
  const chip = el.closest('.sw-toolchip')
  if (chip) return showToolPop(chip)
  if (el.closest('.sw-toolpop')) return
  if (toolPop && !toolPop.hidden) hideToolPop(TOOLPOP_HIDE_MS)
})

// 键盘也要能看。药丸带 tabindex，Tab 到就出，离开就收。
document.addEventListener('focusin', (e) => {
  const el = e.target instanceof Element ? e.target : null
  const chip = el && el.closest('.sw-toolchip')
  if (chip) showToolPop(chip)
  else if (el && !el.closest('.sw-toolpop')) hideToolPop(0)
})

/**
 * 滚动时立刻收：浮层是 fixed 的，跟不上锚点，留在原地就是一块飘着的脏东西。
 *
 * **但浮层自己滚不算。** 结果那一段有自己的滚动区（`.sw-toolpop pre`，最高 220px），
 * 内容一长就得在里面滚着看——而这个监听器是捕获阶段挂在 window 上的，滚它也照收不误：
 * 手一动窗口就没了，长输出永远看不完。这里按事件源头分一下：源头在浮层里就不收。
 */
window.addEventListener(
  'scroll',
  (e) => {
    const el = e.target instanceof Element ? e.target : null
    if (el && el.closest('.sw-toolpop')) return
    hideToolPop(0)
  },
  true,
)
window.addEventListener('resize', () => hideToolPop(0))
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && toolPop && !toolPop.hidden) hideToolPop(0)
})
