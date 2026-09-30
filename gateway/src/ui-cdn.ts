/**
 * 界面按需从 CDN 拉的那几个库（KaTeX / highlight.js / Mermaid，首页演示背景的 three.js），
 * 以及 CSP 该放行到哪一层。
 *
 * **CSP 只放到包加版本那一级目录，不放整个 CDN 源。** jsdelivr 出的是任意 npm 包和 GitHub
 * 仓库：放行 `https://cdn.jsdelivr.net` 等于放行任何人发的任何脚本，XSS 注进来一句
 * `<script src=cdn.jsdelivr.net/npm/自己的包>` 就过了，那条头形同虚设。源表达式以 `/` 结尾时
 * 按前缀匹配，所以 `…/npm/mermaid@11.4.1/` 连它运行时再 import 的那些 chunk 一起放行。
 *
 * 这张表和 `gateway/ui/markdown.js` 的 `LIBS`（外加 `pages-landing.js` 的 `LP_THREE`）是一对：那边的每条路径都得落在这里某一项
 * 底下，这里的每一项那边都得用到；桌面端 `desktop/src-tauri/src/main.rs` 的 `UI_CSP` 是照
 * 这张表手抄的。三处由 e2e 的 markdown 那一组按源码核对，**改版本号三处一起改**（markdown.js
 * 那边还要换 SRI 摘要）。
 */
export const UI_CDN_PACKAGES = [
  'katex@0.16.11',
  '@highlightjs/cdn-assets@11.10.0',
  'mermaid@11.4.1',
  'three@0.170.0',
] as const

/** jsdelivr 的 npm 根。markdown.js 里写死的默认值与此相同。 */
export const DEFAULT_UI_CDN = 'https://cdn.jsdelivr.net/npm'

/**
 * `GATEWAY_UI_CDN`：内网镜像的 npm 根（镜像里按 `<包>@<版本>/…` 排）。
 *
 * 只写了源、没写路径的（`https://cdn.jsdelivr.net`，这个变量早先的写法）按 jsdelivr 的布局
 * 补上 `/npm`。解析不了、或不是 http(s) 的，退回默认值并报一句——这个值要拼进响应头，
 * 不能原样信。
 */
export function uiCdnBase(raw = process.env.GATEWAY_UI_CDN): string {
  const text = (raw || '').trim()
  if (!text) return DEFAULT_UI_CDN
  let url: URL
  try {
    url = new URL(text)
  } catch {
    console.warn(`[gateway] GATEWAY_UI_CDN 不是合法地址，退回 ${DEFAULT_UI_CDN}`)
    return DEFAULT_UI_CDN
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    console.warn(`[gateway] GATEWAY_UI_CDN 只认 http(s)，退回 ${DEFAULT_UI_CDN}`)
    return DEFAULT_UI_CDN
  }
  const path = url.pathname.replace(/\/+$/, '')
  // `;` `,` `'` 在 URL 路径里是合法的，进了 CSP 却会切开或改写指令。
  if (!/^[A-Za-z0-9._~@%+/-]*$/.test(path)) {
    console.warn(`[gateway] GATEWAY_UI_CDN 的路径里有 CSP 容不下的字符，退回 ${DEFAULT_UI_CDN}`)
    return DEFAULT_UI_CDN
  }
  return url.origin + (path || '/npm')
}

export const UI_CDN = uiCdnBase()

/** 拼进 CSP 的那一串：每个包一条以 `/` 结尾的路径源。 */
export function uiCdnSources(base = UI_CDN): string {
  return UI_CDN_PACKAGES.map((pkg) => `${base}/${pkg}/`).join(' ')
}

/**
 * 镜像地址怎么交给页面：`<meta name="satu-cdn">`，markdown.js 启动时读它。用默认值时不插，
 * 页面照旧按原文件发。不能用内联脚本设 `window.SATU_CDN`——script-src 不带 'unsafe-inline'。
 */
export function uiCdnMeta(base = UI_CDN): string {
  if (base === DEFAULT_UI_CDN) return ''
  return `<meta name="satu-cdn" content="${base.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}">\n`
}
