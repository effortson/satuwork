/**
 * Composio 这一家。
 *
 * **裸 fetch，不引 `@composio/core`。** 我们只用到六个动作（见 types.ts），而那个 SDK
 * 会把一整套「agent 跑在你自己进程里」的 provider 适配层拖进控制面——我们的 agent 跑在
 * 席位机器上，那些东西一行都用不上。
 *
 * 响应解析一律**防御式**：字段名在两版之间改过（`items` / `data`、`successful` /
 * `successfull`），少一个字段不该让整条路挂掉。
 */
import { createHash } from 'node:crypto'
import { ProviderError, type ConnectorProvider, type ExecuteInput, type ExecuteResult, type InitiateInput, type InitiateResult, type ProviderCaps, type StageFileInput, type StagedFile, type StatusResult, type ToolDef, type Toolkit } from './types.ts'

const DEFAULT_BASE = 'https://backend.composio.dev/api/v3'
/** 列目录这类只读请求的超时。慢过这个数，界面上等着也没意义。 */
const LIST_TIMEOUT_MS = 20_000

type Json = Record<string, unknown>

function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/** 列表接口的外壳在不同版本里叫过 `items` 和 `data`，两个都认。 */
function listOf(body: unknown): Json[] {
  const o = obj(body)
  for (const key of ['items', 'data', 'results']) {
    const v = o[key]
    if (Array.isArray(v)) return v.map(obj)
  }
  return Array.isArray(body) ? (body as unknown[]).map(obj) : []
}

/**
 * 授权地址在响应里出现过好几个位置。挨个找，找不到就是真的没有——那时抛错，
 * 不要把一个空字符串交给浏览器去跳转。
 */
function redirectOf(body: Json): string {
  const direct = str(body.redirect_url || body.redirectUrl || body.redirect_uri)
  if (direct) return direct
  const nested = obj(obj(body.connectionData).val)
  return str(nested.redirectUrl || nested.redirect_url || nested.authUri)
}

export class ComposioProvider implements ConnectorProvider {
  readonly vendor = 'composio'
  readonly caps: ProviderCaps = { mcpUrl: true, search: true, multiAccount: true, fileUpload: true }

  constructor(
    private readonly apiKey: string,
    private readonly base = (process.env.COMPOSIO_BASE_URL || DEFAULT_BASE).replace(/\/$/, ''),
  ) {}

  configured(): boolean {
    return Boolean(this.apiKey)
  }

  private async call(
    method: string,
    path: string,
    init: { body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (!this.apiKey) throw new ProviderError('没有 Composio 的密钥', 0)
    const signal = init.signal ?? AbortSignal.timeout(init.timeoutMs ?? LIST_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          'x-api-key': this.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal,
      })
    } catch (e) {
      // 超时和连不上在这里是同一类：我们没拿到任何上游结果。计费那边据此判定不收钱。
      throw new ProviderError(`连不上 Composio：${(e as Error).message}`, 0)
    }
    const text = await res.text().catch(() => '')
    let parsed: unknown
    try {
      parsed = text.trim() ? JSON.parse(text) : {}
    } catch {
      parsed = { raw: text }
    }
    if (!res.ok) {
      const err = obj(obj(parsed).error)
      const msg = str(err.message) || str(obj(parsed).message) || text.slice(0, 200) || `HTTP ${res.status}`
      throw new ProviderError(msg, res.status)
    }
    return parsed
  }

  async ping(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.call('GET', '/toolkits?limit=1')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  async listToolkits(): Promise<Toolkit[]> {
    const body = await this.call('GET', '/toolkits?limit=500')
    return listOf(body)
      .map((t) => {
        const meta = obj(t.meta)
        const categories = Array.isArray(meta.categories)
          ? (meta.categories as unknown[]).map((c) => str(obj(c).name || c)).filter(Boolean)
          : []
        const schemes = Array.isArray(t.auth_schemes)
          ? (t.auth_schemes as unknown[]).map((x) => str(obj(x).mode || obj(x).auth_scheme || x)).filter(Boolean)
          : []
        return {
          slug: str(t.slug || t.key || t.name).toLowerCase(),
          name: str(t.name || t.slug),
          description: str(meta.description || t.description),
          logo: str(meta.logo || t.logo),
          categories,
          authSchemes: [...new Set(schemes)],
        }
      })
      .filter((t) => t.slug)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async listTools(toolkit: string): Promise<ToolDef[]> {
    const body = await this.call('GET', `/tools?toolkit_slug=${encodeURIComponent(toolkit)}&limit=500`)
    return listOf(body)
      .map((t) => ({
        slug: str(t.slug || t.name),
        name: str(t.name || t.slug),
        description: str(t.description),
        inputSchema: obj(t.input_parameters || t.inputParameters || t.parameters),
      }))
      .filter((t) => t.slug)
      .sort((a, b) => a.slug.localeCompare(b.slug))
  }

  /**
   * 发起授权走 **`/connected_accounts/link`**。
   *
   * 老的 `POST /connected_accounts` 对「Composio 托管的 OAuth」已经不受理了，回的是一句
   * `Creating connections on this endpoint ... is no longer supported. Use POST
   * /api/v3/connected_accounts/link instead.`——界面上就是那条红字。新的这条对所有认证
   * 方式（含非 OAuth、自建配置）都是推荐路径，所以不留两条路。
   *
   * **`allow_multiple` 必须带。** 我们的口径是一个安装底下挂多把连接（`default`、
   * `personal`……），而它们的 `user_id` 和 auth config 完全一样。不带这个标记的话，
   * 第二次 link 会把**同一把** connected account 还给我们：两行本地记录共用一个
   * externalId，断开其中一个另一个跟着废。要不要允许第二把由我们自己判（见
   * `routes/connectors.ts` 里的 `def.multiAccount`），走到这里就是已经准了。
   */
  async initiate(input: InitiateInput): Promise<InitiateResult> {
    const body = obj(
      await this.call('POST', '/connected_accounts/link', {
        body: {
          auth_config_id: input.authConfigId,
          user_id: input.externalUserId,
          callback_url: input.callbackUrl,
          allow_multiple: true,
        },
      }),
    )
    const externalId = str(body.connected_account_id || body.connectedAccountId || body.id || obj(body.connectedAccount).id)
    if (!externalId) throw new ProviderError('Composio 没有返回连接 id', 0)
    const redirectUrl = redirectOf(body)
    if (!redirectUrl) throw new ProviderError('Composio 没有返回授权地址', 0)
    return { externalId, redirectUrl }
  }

  async status(externalId: string): Promise<StatusResult> {
    const body = obj(await this.call('GET', `/connected_accounts/${encodeURIComponent(externalId)}`))
    const raw = str(body.status || obj(body.connectedAccount).status).toUpperCase()
    if (raw === 'ACTIVE') return { status: 'active' }
    // INITIATED / INITIALIZING 都是「还在走」。别的一律当失败，并把原文带出去——
    // 供应商将来加一个新状态时，界面上要能看见它叫什么，而不是永远转圈。
    if (raw === 'INITIATED' || raw === 'INITIALIZING' || raw === 'PENDING' || !raw) return { status: 'pending' }
    return { status: 'failed', error: str(body.status_reason || body.error) || raw }
  }

  async disconnect(externalId: string): Promise<void> {
    try {
      await this.call('DELETE', `/connected_accounts/${encodeURIComponent(externalId)}`)
    } catch (e) {
      // 上游已经没有这条了（404）就算断开成功：我们的目的是「它不再能用」，而不是
      // 「一定要由我们来删」。别的错原样抛出去。
      if (e instanceof ProviderError && e.status === 404) return
      throw e
    }
  }

  /**
   * **异常一律往上抛，不在这里吞。**
   *
   * 吞成 `{ ok:false }` 的话，上面那层就分不出「超时」和「参数写错了」——而超时要收钱
   * （发出去的邮件不会因为我们没等到响应就退回来），参数错不收。判定超时靠的是调用方
   * 手里那个 AbortSignal，不是错误文案，所以只能由调用方来做。
   */
  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    const body = obj(
      await this.call('POST', `/tools/execute/${encodeURIComponent(input.tool)}`, {
        body: {
          user_id: input.externalUserId,
          connected_account_id: input.externalId,
          arguments: input.args ?? {},
        },
        signal: input.signal,
      }),
    )
    // 拼写在两版之间变过（`successful` / `successfull`），两个都认；都没有就看有没有 error。
    const okField = body.successful ?? body.successfull
    const errText = str(body.error)
    const ok = typeof okField === 'boolean' ? okField : !errText
    const data = body.data ?? body.response ?? body
    const text = ok ? JSON.stringify(data) : errText || JSON.stringify(data)
    // 走到这里说明上游回了 2xx——它真的跑了一遍，哪怕工具自己说失败（「邮箱不存在」）。
    return { ok, text }
  }

  /**
   * 附件先暂存：**两步**，和官方 SDK 的 `files.upload` 一样。
   *
   *  1. `POST /files/upload/request { toolkit_slug, tool_slug, filename, mimetype, md5 }`
   *     ——拿到一个 `key` 和一条预签名地址。`md5` 是必填的：上游拿它去重，同一份文件
   *     第二次传可能直接回 `key` 而不给地址（那时就不用再 PUT）
   *  2. 把字节 `PUT` 到预签名地址。那是 S3（或 Azure Blob）的地址，**不带 x-api-key**，
   *     也不能当 JSON 发；Azure 要多一个 `x-ms-blob-type: BlockBlob` 头
   *
   * 回去的 `s3key` 就是第一步的 `key`——工具参数里 `FileUploadable` 那一格要的就是它。
   * 字段名在两版之间也改过（`new_presigned_url` / `newPresignedUrl`），都认。
   *
   * **这不是一次执行。** 上游不会因为它跑任何工具，所以调用方不计费、不落流水。
   */
  async stageFile(input: StageFileInput): Promise<StagedFile> {
    const md5 = createHash('md5').update(input.bytes).digest('hex')
    const body = obj(
      await this.call('POST', '/files/upload/request', {
        body: {
          toolkit_slug: input.toolkit,
          tool_slug: input.tool,
          filename: input.filename,
          mimetype: input.mimetype,
          md5,
        },
        signal: input.signal,
      }),
    )
    const key = str(body.key || body.s3key || body.s3_key)
    if (!key) throw new ProviderError('Composio 没有返回文件句柄', 0)
    const url = str(
      body.new_presigned_url ||
        body.newPresignedUrl ||
        body.update_presigned_url ||
        body.updatePresignedUrl ||
        body.presigned_url ||
        body.presignedUrl,
    )
    const type = str(body.type).toLowerCase()
    // 去重命中：上游说「已经有这份了」，没给地址，直接用那个 key。
    if (!url) {
      if (type === 'existing' || type === 'exists') return { name: input.filename, mimetype: input.mimetype, s3key: key }
      throw new ProviderError('Composio 没有返回上传地址', 0)
    }
    const backend = str(obj(body.metadata).storage_backend || obj(body.metadata).storageBackend).toLowerCase()
    let res: Response
    try {
      res = await fetch(url, {
        method: 'PUT',
        headers: {
          'content-type': input.mimetype,
          ...(backend.startsWith('azure') ? { 'x-ms-blob-type': 'BlockBlob' } : {}),
        },
        body: new Uint8Array(input.bytes),
        signal: input.signal,
      })
    } catch (e) {
      throw new ProviderError(`传不到 Composio 的存储：${(e as Error).message}`, 0)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ProviderError(`Composio 的存储拒收了这份文件：HTTP ${res.status}${text ? ` ${text.slice(0, 120)}` : ''}`, res.status)
    }
    await res.arrayBuffer().catch(() => undefined)
    return { name: input.filename, mimetype: input.mimetype, s3key: key }
  }
}
