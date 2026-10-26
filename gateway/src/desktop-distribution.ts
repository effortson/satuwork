/** Optional download mirror. No signing keys or credentials belong in this value. */
export function desktopDownloadMeta(raw = process.env.GATEWAY_DESKTOP_DOWNLOAD_BASE): string {
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return ''
    const base = url.href.replace(/\/+$/, '')
    return `<meta name="satu-desktop-download" content="${base.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}">\n`
  } catch { return '' }
}
