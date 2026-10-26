// Build-time only. Versioned assets are bundled so desktop rendering needs no overseas CDN.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { UI_CDN_PACKAGES } from '../gateway/src/ui-cdn.ts'

export async function bundleUiLibs(out) {
  const temp = mkdtempSync(join(tmpdir(), 'satu-ui-'))
  const registry = 'https://registry.npmjs.org'
  try {
    for (const spec of [...UI_CDN_PACKAGES, '@fontsource/outfit@5.2.5']) {
      const at = spec.lastIndexOf('@'), name = spec.slice(0, at), version = spec.slice(at + 1)
      const metaResponse = await fetch(`${registry}/${encodeURIComponent(name)}/${version}`)
      if (!metaResponse.ok) throw Error(`npm metadata failed: ${spec} HTTP ${metaResponse.status}`)
      const meta = await metaResponse.json()
      const integrity = meta.dist?.integrity
      if (!/^sha512-[A-Za-z0-9+/=]+$/.test(integrity || '')) throw Error(`Missing SHA512 integrity: ${spec}`)
      const tarResponse = await fetch(meta.dist.tarball)
      if (!tarResponse.ok) throw Error(`npm archive failed: ${spec}`)
      const data = Buffer.from(await tarResponse.arrayBuffer())
      if (`sha512-${createHash('sha512').update(data).digest('base64')}` !== integrity) throw Error(`npm integrity mismatch: ${spec}`)
      const archive = join(temp, 'package.tgz')
      writeFileSync(archive, data)
      const target = join(out, 'vendor/npm', spec)
      mkdirSync(target, { recursive: true })
      const extracted = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [join(dirname(fileURLToPath(import.meta.url)), 'extract-ui-package.py'), archive, target], { stdio: 'inherit' })
      if (extracted.status !== 0) throw Error(`Cannot extract ${spec}`)
      console.log(`Bundled ${spec}`)
    }
    // Verify the same pinned SRI values the browser enforces.
    const markdown = readFileSync(join(out, 'markdown.js'), 'utf8')
    for (const match of markdown.matchAll(/path: '([^']+)',\s+sri: 'sha384-([^']+)'/g)) {
      const bytes = readFileSync(join(out, 'vendor/npm', match[1]))
      if (createHash('sha384').update(bytes).digest('base64') !== match[2]) throw Error(`UI SRI mismatch: ${match[1]}`)
    }
    // Keep the byte-for-byte upstream assets: the UI's SRI hashes still apply.
    const index = join(out, 'index.html')
    writeFileSync(index, readFileSync(index, 'utf8').replace('<head>', '<head>\n<meta name="satu-cdn" content="/vendor/npm">'))
    const { desktopDownloadMeta } = await import('../gateway/src/desktop-distribution.ts')
    const meta = desktopDownloadMeta(process.env.SATUWORK_DESKTOP_DOWNLOAD_BASE)
    if (!meta) throw Error('Missing domestic desktop download address')
    writeFileSync(index, readFileSync(index, 'utf8').replace('</head>', meta + '</head>'))
    const theme = join(out, 'theme.css')
    const localFonts = [200, 300, 400, 500, 600, 700].map(weight => `@import url("/vendor/npm/@fontsource/outfit@5.2.5/${weight}.css");`).join('\n')
    writeFileSync(theme, readFileSync(theme, 'utf8').replace(/@import url\("https:\/\/fonts\.googleapis\.com\/[^\n]+\n/, localFonts + '\n'))
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
