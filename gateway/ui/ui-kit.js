/**
 * 页面上反复出现的几块壳子：弹窗、页头、页内切 tab 的那排按钮。
 *
 * 只收「各处逐字一样」的那部分。调用点各自的差别（弹窗本体的属性、页头右边那几颗按钮）原样
 * 由调用方给。长得像但有出入的（标题 18px、没有 data-stop、
 * 缩进多一层的）就留在原处，别为了套进来改它的样子。
 */

/**
 * 弹窗：背景层（点背景关）+ 弹窗本体 + 头上的标题和一句说明，`x` 为真时右上角再带一颗 ×。
 *
 * `attrs` 是弹窗本体那个元素的属性，原样一串（id、class、style、data-stop 的先后各处不一）。
 * `close` 既是背景层的 data-act，也是那颗 × 的。`title` / `sub` 是现成的 HTML，转义由调用方管。
 * `body` 接在头后面，自己带着缩进。
 */
function modalBox({ close, tag = 'div', attrs, x = true, title, sub, body }) {
  const head = x
    ? `<div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${title}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${sub}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="${close}">${svg(CLOSE_ICON, 16)}</button>
      </div>`
    : `<div>
        <h2 style="font-size: 20px; margin: 0 0 4px;">${title}</h2>
        <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${sub}</p>
      </div>`
  return `<div class="gw-modal-backdrop" data-act="${close}">
    <${tag} ${attrs}>
      ${head}
      ${body}
    </${tag}>
  </div>`
}

/**
 * 页头：大标题、底下一句说明；给了 `acts` 就是右边再摆一组按钮（标题和按钮底边对齐）。
 *
 * `title` / `sub` / `acts` 都是现成的 HTML，转义由调用方管。缩进照着页里最常见的那一层
 * （`.gw-page-inner` 的直接子级）组织；mg-pagehead 供管理页统一控制标题层级。
 */
function pageHead(title, sub, acts) {
  if (acts == null) {
    return `<div class="mg-pagehead">
          <h1 style="font-size: 24px; margin: 0 0 4px;">${title}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${sub}</p>
        </div>`
  }
  return `<div class="mg-pagehead" style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${title}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${sub}</p>
          </div>
          ${acts}
        </div>`
}

/**
 * 页内切 tab 的那一排按钮。`items` 是 `{ key, label }`，label 写中文原文，这里翻译、转义；
 * 按下的是 key 等于 `current` 的那一颗。每颗都发同一个 `act`，带着 data-tab。
 */
function tabPills(items, current, act) {
  return items
    .map(
      (it) =>
        `<button type="button" class="satu-assignee mg-tab" style="padding: 5px 14px;" aria-pressed="${String(current === it.key)}" data-act="${act}" data-tab="${esc(it.key)}">${esc(t(it.label))}</button>`,
    )
    .join('')
}

/** 管理页的只读摘要，与编辑表单分开，额度和状态不伪装成可编辑字段。 */
function managementStats(items) {
  return `<div class="mg-stats">${items.map(({ label, value, note }) => `<div class="satu-stat">
    <span class="mg-stat-label">${esc(label)}</span>
    <strong class="mg-stat-value">${esc(String(value ?? '—'))}</strong>
    ${note ? `<span class="mg-stat-note">${esc(note)}</span>` : ''}
  </div>`).join('')}</div>`
}

/** Render an account thumbnail with an initial underneath as the image fallback. */
function accountAvatar(account, size = 30) {
  const avatar = typeof account?.avatar === 'string' && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(account.avatar) ? account.avatar : ''
  return `<span class="satu-account-avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size * .38)}px" aria-hidden="true"><span>${esc(initialOf(account || {}))}</span>${avatar ? `<img src="${esc(avatar)}" alt="" data-onerror="drop">` : ''}</span>`
}

/** Shared empty states for the resource pages; all copy is escaped at this boundary. */
function resourceEmpty(title, note, icon, action = '') {
  return `<div class="rs-empty">${svg(icon || ['M4 4h16v16H4z', 'M8 9h8', 'M8 13h5'], 24)}<strong>${esc(title)}</strong><p>${esc(note)}</p>${action}</div>`
}
