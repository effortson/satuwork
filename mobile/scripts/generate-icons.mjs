import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const mobile = resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = resolve(mobile, '../gateway/ui/assets/satuwork-logo.png')
const tauri = join(mobile, 'node_modules/.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri')
const androidOnly = process.argv.includes('--android')
const android = join(mobile, 'src-tauri/gen/android/app/src/main/res')
const temp = androidOnly ? mkdtempSync(join(tmpdir(), 'satuwork-android-icons-')) : null
try {
  const output = temp ? join(temp, 'icons') : null
  execFileSync(tauri, ['icon', source, ...(output ? ['-o', output] : [])], { cwd: mobile, stdio: 'inherit' })
  if (output) cpSync(join(output, 'android'), android, { recursive: true })

  // 原图已有留白，但直接铺满 108dp 前景层仍会被桌面的自适应遮罩放大、裁掉外框和底座。
  // 前景每边内缩 20%，完整图案落在中心安全区；百分比随启动器图标尺寸一起缩放。
  const adaptive = join(android, 'mipmap-anydpi-v26')
  mkdirSync(adaptive, { recursive: true })
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/ic_launcher_background"/>
  <foreground>
    <inset android:drawable="@mipmap/ic_launcher_foreground" android:inset="20%"/>
  </foreground>
</adaptive-icon>
`
  for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) writeFileSync(join(adaptive, name), xml)
  console.log('Android: adaptive launcher icons regenerated with 20% foreground insets')
  if (!androidOnly) syncIosIcons()
} finally {
  if (temp) rmSync(temp, { recursive: true, force: true })
}

// 初始化 iOS 工程后 Tauri 直接写入资源目录；同时维护 icons/ios 里的源图标。
function syncIosIcons() {
  const ios = join(mobile, 'src-tauri/icons/ios')
  const assets = join(mobile, 'src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset')
  const generated = existsSync(assets) ? assets : ios
  mkdirSync(ios, { recursive: true })
  let count = 0
  for (const name of readdirSync(generated)) {
    if (!name.endsWith('.png')) continue
    // 缩放后即使白底图也可能残留 254 的 alpha；iOS 图标必须去掉 alpha 通道。
    const image = PNG.sync.read(readFileSync(join(generated, name)))
    const opaque = PNG.sync.write(image, {
      colorType: 2,
      bgColor: { red: 255, green: 255, blue: 255 },
    })
    writeFileSync(join(generated, name), opaque)
    if (generated !== ios) writeFileSync(join(ios, name), opaque)
    count++
  }
  console.log(`iOS: ${count} opaque RGB icons generated and synced`)
}
