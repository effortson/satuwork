/**
 * 连接器供应商的抽象层。
 *
 * 接口窄到只剩「换供应商时真的会变的东西」：列有哪些连接器、列它有哪些工具、
 * 发起授权、查授权状态、断开、执行一次工具。别的一律不进来——上层需要什么就在
 * Gateway 里做，不要为了迁就某一家的 SDK 把它的概念漏到接口上。
 *
 * 见 docs/connectors.md §5。
 */

export interface Toolkit {
  /** 供应商侧的 slug，例如 `gmail`。上架之后它会进流水表，不能变。 */
  slug: string
  name: string
  description: string
  /** 图标地址。没有就空串，界面自己退化成首字母。 */
  logo: string
  /** 供应商给的分组，例如 `productivity`。市场里按它分组。 */
  categories: string[]
  /** 这家 toolkit 支持的鉴权方式（`OAUTH2` / `API_KEY` …），给上架那一屏看。 */
  authSchemes: string[]
}

export interface ToolDef {
  /** 工具 slug，例如 `GMAIL_SEND_EMAIL`。它会进工具名和流水表。 */
  slug: string
  name: string
  description: string
  /** JSON Schema。合成 MCP 工具表时原样交给模型。 */
  inputSchema: Record<string, unknown>
}

export interface InitiateInput {
  toolkit: string
  /** 供应商侧的 auth config id。owner 上架时填，公司和员工都看不见。 */
  authConfigId: string
  /** 我们这边的用户标识：`sw_{accountId}` 或 `swc_{companyId}`。不用邮箱。 */
  externalUserId: string
  callbackUrl: string
}

export interface InitiateResult {
  /** 供应商侧的连接 id。存进 connector_connections.externalId。 */
  externalId: string
  /** 让浏览器跳过去的地址。 */
  redirectUrl: string
}

export type ConnectionState = 'pending' | 'active' | 'failed'

export interface StatusResult {
  status: ConnectionState
  error?: string
}

export interface ExecuteInput {
  tool: string
  externalUserId: string
  /** 供应商侧的连接 id。多账号时它决定这次用哪一个。 */
  externalId: string
  args: unknown
  signal: AbortSignal
}

export interface ExecuteResult {
  /** 工具自己说成功了没有。 */
  ok: boolean
  /** 交给模型的正文。 */
  text: string
}

/**
 * 给一份文件向供应商要一个上传位：换回工具参数里认得的句柄，外加一条让席位**自己**把
 * 字节 PUT 过去的地址。
 *
 * 供应商的工具（`GMAIL_SEND_EMAIL` 的 `attachment`）不收字节，只收一个指向它自己存储的
 * 句柄——所以附件要先走这一步。**字节不经 Gateway**：Gateway 跑在函数环境里，请求体
 * 有 4.5 MB 的硬顶；这一步只带 md5 和大小，字节由席位直接推到预签名地址。预签名地址
 * 不带供应商密钥，密钥仍然只在 Gateway（不变量 16）。
 */
export interface PrepareUploadInput {
  toolkit: string
  /** 真实 slug（`GMAIL_SEND_EMAIL`）。供应商按它决定这份文件归谁用。 */
  tool: string
  filename: string
  mimetype: string
  /** 文件内容的 MD5（十六进制）。供应商拿它去重，也是预签名的一部分。 */
  md5: string
  signal: AbortSignal
}

/**
 * 句柄 + 上传位。**句柄的形状是供应商工具参数里那一格的形状**（Composio 叫
 * `FileUploadable`），模型拿到就能原样填进去。
 *
 * `upload` 为 null = 供应商说这份文件它已经有了（按 md5 去重命中），不用再传。
 */
export interface UploadTicket {
  file: StagedFile
  upload: {
    /** 预签名的 PUT 地址。短期有效，拿到就要用。 */
    url: string
    /** PUT 时要带的头（content-type；Azure 还要 x-ms-blob-type）。 */
    headers: Record<string, string>
  } | null
}

/** 工具参数里那一格的形状。 */
export interface StagedFile {
  name: string
  mimetype: string
  s3key: string
}

/** 这家供应商能干什么。调用方按位判断，不按 vendor 名字判断。 */
export interface ProviderCaps {
  /** 能直接给出一个 per-user 的 MCP 地址（将来可以少一跳）。 */
  mcpUrl: boolean
  /** 工具多到装不下时，有没有服务端搜索。 */
  search: boolean
  /** 同一个用户能不能连同一个 toolkit 的多个账号。 */
  multiAccount: boolean
  /** 工具参数里的文件能不能先放到供应商那边（见 prepareUpload）。 */
  fileUpload: boolean
}

export interface ConnectorProvider {
  readonly vendor: string
  readonly caps: ProviderCaps

  /** 供应商密钥配了没有。没配的话上层直接 402，不用等一次失败的网络往返。 */
  configured(): boolean
  /** 拨一下看看通不通。owner 那一屏的「测试连接」。 */
  ping(): Promise<{ ok: boolean; error?: string }>

  listToolkits(): Promise<Toolkit[]>
  listTools(toolkit: string): Promise<ToolDef[]>

  initiate(input: InitiateInput): Promise<InitiateResult>
  status(externalId: string): Promise<StatusResult>
  disconnect(externalId: string): Promise<void>

  execute(input: ExecuteInput): Promise<ExecuteResult>

  /**
   * 给一份文件要上传位：句柄 + 让席位自己 PUT 字节的预签名地址。**不是一次执行，不计费**
   * ——它不产生供应商侧的工具调用，和 `listTools` 同一档。`caps.fileUpload` 为 false 的
   * 供应商抛 ProviderError。
   */
  prepareUpload(input: PrepareUploadInput): Promise<UploadTicket>
}

/** 供应商侧的错误。上层据此决定回 402 / 502，而不是把栈丢给调用方。 */
export class ProviderError extends Error {
  constructor(
    message: string,
    /** 上游的 HTTP 状态。0 = 根本没连上。 */
    readonly status = 0,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
