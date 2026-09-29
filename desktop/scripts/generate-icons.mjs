import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = resolve(desktop, '../gateway/ui/assets/satuwork-logo.svg')
const icons = join(desktop, 'src-tauri/icons')
const tauri = join(desktop, 'node_modules/.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri')
const svg = readFileSync(source, 'utf8')
const viewBox = 'viewBox="0 0 512 512"'
if (!svg.includes(viewBox)) throw new Error('Satuwork logo viewBox changed; update the macOS icon padding')

const temp = mkdtempSync(join(tmpdir(), 'satuwork-icons-'))
try {
  // 网页 logo 和普通桌面尺寸保持原稿。macOS Dock 需要留白，视觉大小才和相邻 app 对齐。
  const standard = join(temp, 'standard')
  execFileSync(tauri, ['icon', source, '-o', standard], { cwd: desktop, stdio: 'pipe' })
  for (const name of readdirSync(icons)) {
    if (name === 'icon.ico' || name === 'icon.png' || name === '32x32.png' || name === '128x128.png' || name === '128x128@2x.png' || name === 'StoreLogo.png' || name.startsWith('Square')) {
      copyFileSync(join(standard, name), join(icons, name))
    }
  }
  const padded = join(temp, 'macos.svg')
  writeFileSync(padded, svg.replace(viewBox, 'viewBox="-48 -48 608 608"'))
  const macos = join(temp, 'macos')
  execFileSync(tauri, ['icon', padded, '-o', macos], { cwd: desktop, stdio: 'pipe' })
  copyFileSync(join(macos, 'icon.icns'), join(icons, 'icon.icns'))
  console.log('macOS icon.icns: added transparent Dock padding')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
