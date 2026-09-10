import { createServer } from 'node:http'
import { Db, databaseUrl } from './db.ts'
import { loadChannelKey, loadKeys } from './crypto.ts'
import { Router } from './http.ts'
import { gatewayHome } from './home.ts'
import { attach } from './routes.ts'
import { attachDesktopUpgrade } from './desktop.ts'

/**
 * Gateway 的**函数形态**：只有路由，没有监听、没有定时器、没有迁移。
 *
 * index.ts 是 Debian 上的常驻进程：起来先跑迁移、播种、对订阅，再监听端口、起调度器和渠道
 * 分发器。函数环境（Vercel）里这些都不该在请求路径上发生——迁移放到 build 步骤
 * （scripts/migrate.ts），分钟级扫描由 Cron 打 /cron/tick，日常任务和渠道那一轮在席位机器
 * 上的工人里（docs/adr-gateway-vercel-neon.md）。这里剩下的就是「一个请求进来、答它」。
 *
 * 模块级单例：Fluid Compute 复用实例，连接池、Router、密钥只建一次。密钥必须来自环境变量
 * （GATEWAY_JWT_PRIVATE_KEY / GATEWAY_JWT_PUBLIC_KEY / GATEWAY_CHANNEL_KEY）——函数环境没有
 * 跨实例的磁盘，落盘生成的密钥每个实例都不一样，签出去的票在别的实例上验不过。
 *
 * 导出的是一个 http.Server：Vercel 的 Node 函数认它（把请求交给它的 request 监听器），本地
 * e2e 也能直接 listen 起来测。
 */
export function createGatewayServer() {
  if (!process.env.GATEWAY_JWT_PRIVATE_KEY || !process.env.GATEWAY_CHANNEL_KEY) {
    throw new Error('函数形态的 Gateway 要求密钥来自环境变量：GATEWAY_JWT_PRIVATE_KEY / GATEWAY_JWT_PUBLIC_KEY / GATEWAY_CHANNEL_KEY')
  }
  const home = gatewayHome()
  const db = new Db({ url: databaseUrl() })
  const keys = loadKeys(home)
  const channelKey = loadChannelKey(home)
  const router = new Router()
  attach(router, db, keys, channelKey)
  const server = createServer((req, res) => {
    void router.handle(req, res)
  })
  // 桌面反代退路（协议 <4 或没配 directUrl 的机器）还在，它的 WebSocket 升级挂在 server 上。
  attachDesktopUpgrade(server, db, keys)
  // 一条请求处理不了不能把实例带走（同 index.ts 那两句）。
  process.on('unhandledRejection', (reason) => {
    const e = reason as Error
    console.error(`satuwork-gateway: 未处理的 rejection ${e?.stack ?? String(reason)}`)
  })
  return server
}

const server = createGatewayServer()
export default server
