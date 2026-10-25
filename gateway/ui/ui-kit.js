/**
 * 页面上反复出现的几块壳子：弹窗、页头、分段按钮。
 *
 * 只收「各处逐字一样」的那部分。调用点各自的差别（弹窗本体的属性、页头右边那几颗按钮）原样
 * 由调用方给，拼出来的 HTML 和以前一字不差。长得像但有出入的（标题 18px、没有 data-stop、
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
