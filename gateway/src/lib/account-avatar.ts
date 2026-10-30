import { HttpError } from '../http.ts'

/** Small, self-contained thumbnails work in authenticated web and desktop views alike. */
export const MAX_AVATAR_BYTES = 128 * 1024
const MAX_AVATAR_SIDE = 512

function jpegDimensions(bytes: Buffer): [number, number] | undefined {
  if (bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at++] !== 0xff) return
    while (bytes[at] === 0xff) at++
    const marker = bytes[at++]
    if (marker === 0xda || marker === 0xd9) return
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (at + 2 > bytes.length) return
    const length = bytes.readUInt16BE(at)
    if (length < 2 || at + length > bytes.length) return
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return
      return [bytes.readUInt16BE(at + 5), bytes.readUInt16BE(at + 3)]
    }
    at += length
  }
}

export function accountAvatarOf(value: unknown): string {
  if (value === '' || value === null) return ''
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_AVATAR_BYTES / 3) * 4 + 32) {
    throw new HttpError(400, '头像图片不能超过 128 KB')
  }
  const match = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match) throw new HttpError(400, '头像须为 JPEG 或 PNG 图片')
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.length < 24 || bytes.length > MAX_AVATAR_BYTES || bytes.toString('base64') !== match[2]) {
    throw new HttpError(400, '头像图片无效或超过 128 KB')
  }
  const dimensions = match[1] === 'png'
    ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND'
      ? [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
      : undefined
    : jpegDimensions(bytes)
  if (!dimensions || dimensions.some((side) => side < 1 || side > MAX_AVATAR_SIDE)) {
    throw new HttpError(400, '头像须为有效图片，宽高不超过 512 像素')
  }
  return value
}
