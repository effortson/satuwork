/**
 * Vercel Blob 的公共那一小块：token、e2e 的假 Blob 地址、「这个地址是不是我们自己库里的」。
 * 发布包（releases.ts）和知识库原文件（knowledge-store.ts）共用——私有 Blob 的取法是
 * GET + Bearer，**带 token 之前必须先认准地址**，这道闸只能有一份。
 *
 * `VERCEL_BLOB_API_URL` 是 SDK 自己认的覆盖项，e2e 用它把上传指到一个假的 Blob。
 */
export function blobToken(): string {
  return (process.env.BLOB_READ_WRITE_TOKEN || '').trim()
}

function blobApiUrl(): string {
  return (process.env.VERCEL_BLOB_API_URL || '').trim().replace(/\/$/, '')
}

/** 这个地址是不是我们自己 Blob 库里的：拉它要带 token。别的地址什么都不带。 */
export function isOurBlobUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:' && u.hostname.endsWith('.blob.vercel-storage.com')) return true
    const raw = blobApiUrl()
    if (!raw) return false
    // **按解析后的 origin 比，不按字符串前缀。** `https://blob.example` 是
    // `https://blob.example.evil.com/x.tgz` 的前缀——登记一个这样的远端包，拉的时候
    // 就把 BLOB_READ_WRITE_TOKEN 送到别人家去了。路径前缀也按段比，/api 不认 /api-x。
    const api = new URL(raw)
    if (u.origin !== api.origin) return false
    const base = api.pathname.replace(/\/$/, '')
    return !base || u.pathname === base || u.pathname.startsWith(base + '/')
  } catch {
    return false
  }
}
