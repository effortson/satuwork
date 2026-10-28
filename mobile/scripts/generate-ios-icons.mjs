import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mobile = resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = resolve(mobile, '../gateway/ui/assets/satuwork-logo.svg')
const svg = readFileSync(source, 'utf8')
const roundedBackground = '<rect width="512" height="512" rx="124" fill="url(#clay)"/>'
if (!svg.includes(roundedBackground)) throw new Error('Satuwork logo background changed; update iOS icon generation')

const temp = mkdtempSync(join(tmpdir(), 'satuwork-ios-icons-'))
try {
  // iOS applies its own corner mask. Extend the original gradient to every corner;
  // Tauri flattens the result into opaque PNGs required by App Store Connect.
  const input = join(temp, 'ios.svg')
  writeFileSync(input, svg.replace(roundedBackground, '<rect width="512" height="512" fill="url(#clay)"/>'))
  const tauri = join(mobile, 'node_modules/.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri')
  execFileSync(tauri, ['icon', input, '-o', join(temp, 'icons')], { cwd: mobile, stdio: 'pipe' })
  for (const name of readdirSync(join(temp, 'icons/ios'))) {
    if (!name.endsWith('.png')) continue
    for (const target of ['src-tauri/icons/ios', 'src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset']) {
      copyFileSync(join(temp, 'icons/ios', name), join(mobile, target, name))
    }
  }
  console.log('iOS icons: generated Satuwork branding and synced the Xcode asset catalog')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
