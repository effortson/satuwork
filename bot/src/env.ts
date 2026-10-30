/**
 * 部署注入的那几个环境变量。**每次现读 `process.env`，不在模块加载时读死**——
 * `GATEWAY_URL` 会被 gateway-url.ts 在运行中改写（Gateway 换了地址），读死了就跟不上。
 *
 * 以前住在 llm/gateway.ts 里，十几个跟模型无关的模块为了这几行去 import 那个大文件。
 */

export function gatewayUrl(): string {
  return (process.env.GATEWAY_URL || '').replace(/\/$/, '')
}

/**
 * 模型调用（所有 `/v1/*`：目录、补全）打哪里。
 *
 * 管家部署出来的席位会多拿一个 `GATEWAY_LLM_URL`（形如 `http://127.0.0.1:8443/llm`）：
 * 模型调用由**同机的管家转发**，provider 密钥只在管家进程里，从不进 bot 进程；而
 * Gateway 搬上 Vercel 之后也不再替席位流式转发模型输出——函数有时长上限，一条
 * 几分钟的流撑不住。所以 `/v1/*` 走这里，其余（会话上传、/internal、日常任务）
 * 照旧走 `GATEWAY_URL`。鉴权头不变，还是 `Bearer GATEWAY_API_KEY`，管家原样带过去。
 *
 * 没设就退回 `GATEWAY_URL`：本地桌面 bot 和老席位一个字都不用改。
 */
export function llmBaseUrl(): string {
  return (process.env.GATEWAY_LLM_URL || process.env.GATEWAY_URL || '').replace(/\/$/, '')
}

/** 席位票（`sat_`）。出站打 Gateway 带它，入站守卫也只认它。 */
export function gatewayToken(): string {
  return (process.env.GATEWAY_TOKEN || '').trim()
}

export function gatewayApiKey(): string {
  return (process.env.GATEWAY_API_KEY || '').trim()
}

/** 这台席位钉的那颗 Bot（`SATUWORK_BOT_ID`）。空 = 没钉。 */
export function pinnedBotId(): string {
  return (process.env.SATUWORK_BOT_ID || '').trim()
}

/** 桌面端的本地 Bot（`SATUWORK_RUNTIME_KIND=local`），不是远程席位。 */
export function isLocalRuntime(): boolean {
  return (process.env.SATUWORK_RUNTIME_KIND || '').trim() === 'local'
}
