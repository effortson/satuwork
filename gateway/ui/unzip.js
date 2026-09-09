/**
 * 读 ZIP 包，在浏览器里，不带依赖。
 *
 * 解压这件事平台已经给了：`DecompressionStream('deflate-raw')`。缺的只是 ZIP 那层
 * 容器格式——中央目录里每个条目记着「叫什么、怎么压的、数据在哪儿」，照着读就是。
 * 一共不到一百行，比为它引一个包划算。
 *
 * 在**浏览器里**解而不是传给服务端解，是因为解开之前没人知道这个包里是什么。先
 * 解开、把清单摆给人看，确认了再传——传上去的是一份已经看明白的文件列表，不是一
 * 个待拆的黑盒。
 *
 * 不支持 zip64（4 GB 以上或条目超过 65535 个）与加密包，两者都会明说而不是给出
 * 一段乱码。
 */

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/** 从尾部往回找中央目录结尾记录——它后面可能还跟着一段注释，长度不定。 */
function findEocd(view) {
  const max = Math.min(view.byteLength, 0xffff + 22)
  for (let i = 22; i <= max; i++) {
    const at = view.byteLength - i
    if (view.getUint32(at, true) === SIG_EOCD) return at
  }
  throw new Error('这不是一个 ZIP 包（找不到中央目录）')
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * 解出 `[{ path, bytes }]`，目录项与 macOS 那堆 `__MACOSX/`、`.DS_Store` 一并扔掉——
 * 它们不是包的内容，是打包那台机器的痕迹。
 */
export async function unzip(file) {
  const buffer = await file.arrayBuffer()
  const view = new DataView(buffer)
  const eocd = findEocd(view)
  const count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)

  const decoder = new TextDecoder()
  const out = []
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== SIG_CENTRAL) throw new Error('ZIP 包的中央目录读不通')
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const compressed = view.getUint32(at + 20, true)
    const uncompressed = view.getUint32(at + 24, true)
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    const localAt = view.getUint32(at + 42, true)
    const path = decoder.decode(new Uint8Array(buffer, at + 46, nameLen))
    at += 46 + nameLen + extraLen + commentLen

    if (flags & 0x1) throw new Error('加密的 ZIP 包读不了')
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) throw new Error('太大的 ZIP 包（zip64）读不了')
    // 目录项与打包机器留下的痕迹都不是包的内容。
    if (path.endsWith('/') || path.startsWith('__MACOSX/') || path.split('/').pop() === '.DS_Store') continue

    if (view.getUint32(localAt, true) !== SIG_LOCAL) throw new Error(`${path} 的本地头读不通`)
    const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true)
    const raw = new Uint8Array(buffer, dataAt, compressed)
    if (method === 0) out.push({ path, bytes: raw.slice() })
    else if (method === 8) out.push({ path, bytes: await inflate(raw) })
    else throw new Error(`${path} 用了不认识的压缩方式（${method}）`)
  }
  return out
}

/**
 * 顶层只有一个目录时，把它剥掉。
 *
 * 打包出来的 zip 十有八九是 `ticket-triage/SKILL.md` 而不是 `SKILL.md`——那层目录是
 * 打包时的文件夹名，不是包的结构。留着它，后面「根目录要有 SKILL.md」这条就永远
 * 不成立。
 */
export function stripTopDir(entries) {
  const tops = new Set(entries.map((e) => e.path.split('/')[0]))
  if (tops.size !== 1 || entries.every((e) => !e.path.includes('/'))) return entries
  const prefix = `${[...tops][0]}/`
  return entries.map((e) => ({ ...e, path: e.path.slice(prefix.length) })).filter((e) => e.path)
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** 严格 UTF-8 解得开的算文本，解不开的按二进制原样带走。不猜扩展名。 */
export function toPayload(entries) {
  return entries.map(({ path, bytes }) => {
    try {
      return { path, text: utf8.decode(bytes) }
    } catch {
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return { path, base64: btoa(binary) }
    }
  })
}

/**
 * 挂到全局。**这一句原来在 index.html 的一段内联 module 里**，搬过来是为了让那一页
 * 一行内联脚本都没有——CSP 的 `script-src` 不带 `'unsafe-inline'`（见
 * gateway/src/http.ts 的 CSP），留着那一段的话整页脚本会被浏览器拒载。
 *
 * 用它的是 render.js 的 Skill 上传那一屏（`window.satuUnzip`）；那边是普通脚本，
 * import 不进来，所以这条全局是两种脚本之间唯一的桥。
 */
window.satuUnzip = { unzip, stripTopDir, toPayload }
