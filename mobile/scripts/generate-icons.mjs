import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const mobile = resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = resolve(mobile, '../gateway/ui/assets/satuwork-logo.png')
const tauri = join(mobile, 'node_modules/.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri')
execFileSync(tauri, ['icon', source], { cwd: mobile, stdio: 'inherit' })

// 初始化 iOS 工程后 Tauri 直接写入资源目录；同时维护 icons/ios 里的源图标。
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
