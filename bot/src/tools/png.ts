import { crc32, deflateSync, inflateSync } from 'node:zlib'

/**
 * 最小的 PNG 读写：只为蒙版。
 *
 * 读：拿出每个像素的 alpha。蒙版的约定是「透明的地方重画」，要知道涂了哪一块就得真把像素解开。
 * 写：出一张 8 位灰度图——给 Gemini 看的黑白蒙版（它不收透明蒙版，见 image.ts 的 geminiMask）。
 *
 * 不引图像库：部署包是预打好的，原生依赖要按平台编译；而蒙版的形状很窄——浏览器画布导出的
 * 就是 8 位 RGBA、不隔行。这里认的是蒙版可能出现的那几种（RGBA / 灰度 + alpha，8 或 16 位；
 * 调色板 + tRNS），其余老实说「读不出来」，不猜。
 */

export interface Alpha {
  width: number
  height: number
  /** 每像素一个字节，0 是全透明、255 是不透明。 */
  alpha: Uint8Array
}

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')

/** PNG 的头和块：宽高、位深、颜色类型、隔行，外加 tRNS 和全部 IDAT。 */
export interface PngInfo {
  width: number
  height: number
  bitDepth: number
  colorType: number
  interlace: number
  trns?: Buffer
  idat: Buffer[]
}

/**
 * 按块走一遍 PNG。**只认真正的块边界**：「有没有 tRNS」要问的是块表里有没有这个块，而不是
 * 这四个字节有没有在文件里出现过——压缩后的像素数据里随便就能碰出 `tRNS` 这串字节。
 * 不是 PNG、或者块被截断，回 `{ error }`。**纯函数**。
 */
export function pngInfo(buf: Buffer): PngInfo | { error: string } {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) return { error: '不是 PNG' }
  const info: PngInfo = { width: 0, height: 0, bitDepth: 0, colorType: -1, interlace: 0, idat: [] }
  for (let at = 8; at + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    const data = buf.subarray(at + 8, at + 8 + len)
    // 尾巴上那块被截断（常见的是缺 IEND）：头已经读到了就当文件到此为止，浏览器也是这么宽容的；
    // 像素够不够由解码那一步判。连头都没读到才算坏文件。
    if (data.length < len) {
      if (info.width) break
      return { error: 'PNG 被截断了' }
    }
    if (type === 'IHDR' && data.length >= 13) {
      info.width = data.readUInt32BE(0)
      info.height = data.readUInt32BE(4)
      info.bitDepth = data[8]
      info.colorType = data[9]
      info.interlace = data[12]
    } else if (type === 'tRNS') info.trns = data
    else if (type === 'IDAT') info.idat.push(data)
    else if (type === 'IEND') break
    at += 12 + len
  }
  if (!info.width || !info.height) return { error: 'PNG 没有 IHDR' }
  return info
}

/** 读出每个像素的 alpha。读不了的形状回 `{ error }`，一句人话。**纯函数**。 */
export function decodeAlpha(buf: Buffer): Alpha | { error: string } {
  const info = pngInfo(buf)
  if ('error' in info) return info
  const { width, height, bitDepth, colorType, interlace, trns, idat } = info
  if (!idat.length) return { error: 'PNG 里没有像素数据' }
  if (interlace) return { error: '隔行扫描的 PNG 不认' }
  if (width * height > 64 * 1024 * 1024) return { error: 'PNG 太大' }

  // 每像素几个通道；alpha 在第几个通道上（-1 = 靠 tRNS）。
  const layout: Record<number, { channels: number; alphaAt: number }> = {
    6: { channels: 4, alphaAt: 3 },
    4: { channels: 2, alphaAt: 1 },
    3: { channels: 1, alphaAt: -1 },
  }
  const shape = layout[colorType]
  if (!shape) return { error: '这张 PNG 没有 alpha 通道（要 RGBA、灰度 + 透明，或者带透明色的调色板图）' }
  if (colorType === 3 ? bitDepth !== 8 : bitDepth !== 8 && bitDepth !== 16) return { error: `不认 ${bitDepth} 位的这种 PNG` }
  if (colorType === 3 && !trns) return { error: '调色板图没有 tRNS，没有透明' }

  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat))
  } catch {
    return { error: 'PNG 的像素数据解不开' }
  }
  const bytesPer = bitDepth / 8
  const bpp = Math.max(1, shape.channels * bytesPer)
  const stride = width * shape.channels * bytesPer
  if (raw.length < height * (stride + 1)) return { error: 'PNG 的像素数据不完整' }

  const alpha = new Uint8Array(width * height)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let add = 0
      if (filter === 1) add = a
      else if (filter === 2) add = b
      else if (filter === 3) add = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) return { error: 'PNG 的行过滤器不认' }
      line[i] = (line[i] + add) & 0xff
    }
    for (let x = 0; x < width; x++) {
      const px = x * shape.channels * bytesPer
      // 16 位时只看高字节：蒙版只关心透不透明，低字节的那点精度用不上。
      alpha[y * width + x] = shape.alphaAt >= 0 ? line[px + shape.alphaAt * bytesPer] : (trns![line[px]] ?? 255)
    }
    prev = line
  }
  return { width, height, alpha }
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/** 8 位、不隔行的 PNG。`channels` 1 是灰度（颜色类型 0），4 是 RGBA（6）。 */
function encode(width: number, height: number, channels: 1 | 4, px: Uint8Array): Buffer {
  const stride = width * channels
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    // 每行开头一个 0：不过滤。蒙版大片同色，deflate 自己就压得很小。
    raw.set(px.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 1 ? 0 : 6
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** 一张 8 位灰度 PNG。`gray` 每像素一个字节。**纯函数**。 */
export function encodeGray(width: number, height: number, gray: Uint8Array): Buffer {
  return encode(width, height, 1, gray)
}

/** 一张只有 alpha 有意义的 RGBA 蒙版（颜色全黑）。**纯函数**。 */
export function encodeAlphaMask(a: Alpha): Buffer {
  const px = new Uint8Array(a.width * a.height * 4)
  for (let i = 0; i < a.alpha.length; i++) px[i * 4 + 3] = a.alpha[i]
  return encode(a.width, a.height, 4, px)
}

/**
 * JPEG 的段：一段一段往下走到图像数据（SOS）为止，交给回调。
 *
 * 两种不带长度的东西要跳过去，不然会把后面的字节当长度读：填充用的连续 0xFF，和独立标记
 * （RSTn、TEM，以及 SOI 自己）。读错长度的代价是跳进熵编码数据里，在那儿碰到一个长得像帧头
 * 的字节序列，于是量出一个错的尺寸。**纯函数**。
 */
export function jpegSegments(buf: Buffer, visit: (marker: number, data: Buffer) => boolean | void): void {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return
  let i = 2
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) return
    let m = buf[i + 1]
    // 填充：0xFF 后面还是 0xFF。
    while (m === 0xff && i + 2 < buf.length) {
      i++
      m = buf[i + 1]
    }
    i += 2
    // 独立标记没有长度：TEM（01）、RSTn（D0–D7）、SOI（D8）。EOI（D9）就是结尾。
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) continue
    if (m === 0xd9 || i + 2 > buf.length) return
    const len = buf.readUInt16BE(i)
    if (len < 2 || i + len > buf.length) return
    if (visit(m, buf.subarray(i + 2, i + len)) === true) return
    // SOS 之后是熵编码数据，没有段可走了。
    if (m === 0xda) return
    i += len
  }
}

/**
 * JPEG 的 EXIF 方向（1–8，1 是不转）。读不到就当 1。**纯函数**。
 *
 * 手机拍的竖图常常是「按横图存、带一个方向标记」：文件里的像素是 4032×3024，看起来却是
 * 3024×4032。浏览器显示时会照这个标记转过来，所以人在界面上涂的蒙版是**转过之后**的尺寸。
 */
export function jpegOrientation(buf: Buffer): number {
  let orientation = 1
  jpegSegments(buf, (m, d) => {
    if (m !== 0xe1 || d.length < 14 || d.toString('latin1', 0, 6) !== 'Exif\0\0') return
    const t = d.subarray(6)
    const le = t.toString('latin1', 0, 2) === 'II'
    const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o))
    const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o))
    const ifd = u32(4)
    if (ifd + 2 > t.length) return true
    const n = u16(ifd)
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12
      if (e + 12 > t.length) break
      if (u16(e) === 0x0112) {
        const v = u16(e + 8)
        if (v >= 1 && v <= 8) orientation = v
        break
      }
    }
    return true
  })
  return orientation
}

/**
 * 把「按显示方向画的」alpha 换回文件里像素的方向。`w` / `h` 是**文件里**的宽高；方向 5–8 时
 * 显示出来的宽高是反过来的。**纯函数**。
 *
 * 文件像素 (x, y) 显示在哪：
 *   2 水平翻转 (w-1-x, y)       3 转 180° (w-1-x, h-1-y)    4 垂直翻转 (x, h-1-y)
 *   5 转置 (y, x)               6 顺时针 90° (h-1-y, x)      7 反转置 (h-1-y, w-1-x)
 *   8 逆时针 90° (y, w-1-x)
 */
export function unorient(shown: Alpha, orientation: number, w: number, h: number): Alpha {
  if (orientation === 1) return shown
  const out = new Uint8Array(w * h)
  const dw = shown.width
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let u = x
      let v = y
      if (orientation === 2) u = w - 1 - x
      else if (orientation === 3) (u = w - 1 - x), (v = h - 1 - y)
      else if (orientation === 4) v = h - 1 - y
      else if (orientation === 5) (u = y), (v = x)
      else if (orientation === 6) (u = h - 1 - y), (v = x)
      else if (orientation === 7) (u = h - 1 - y), (v = w - 1 - x)
      else if (orientation === 8) (u = y), (v = w - 1 - x)
      out[y * w + x] = shown.alpha[v * dw + u]
    }
  }
  return { width: w, height: h, alpha: out }
}
