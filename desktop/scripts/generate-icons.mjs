import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = resolve(desktop, '../gateway/ui/assets/satuwork-logo.png')
const icons = join(desktop, 'src-tauri/icons')
const tauri = join(desktop, 'node_modules/.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri')
// 原图已经包含透明留白，macOS 直接沿用，避免重复加边距后 Dock 图标偏小。
const temp = mkdtempSync(join(tmpdir(), 'satuwork-icons-'))
try {
  // 各平台从同一原图生成；macOS 沿用原图自带的边距，与相邻 Dock 图标保持接近的视觉大小。
  const standard = join(temp, 'standard')
  execFileSync(tauri, ['icon', source, '-o', standard], { cwd: desktop, stdio: 'pipe' })
  for (const name of readdirSync(icons)) {
    if (name === 'icon.icns' || name === 'icon.ico' || name === 'icon.png' || name === '32x32.png' || name === '128x128.png' || name === '128x128@2x.png' || name === 'StoreLogo.png' || name.startsWith('Square')) {
      copyFileSync(join(standard, name), join(icons, name))
    }
  }
  console.log('macOS icon.icns: using the original artwork padding (no extra Dock inset)')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
