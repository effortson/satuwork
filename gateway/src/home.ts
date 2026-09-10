import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Gateway 的数据目录。
 *
 * 默认 `~/.satuwork-gateway`，可用 `SATUWORK_GATEWAY_HOME` 覆盖。
 * 和 Bot 的 `$SATUWORK_HOME` 分开——控制面和运行面不共用一份库。
 */
/**
 * 数据目录。函数环境（Vercel）里没有可写的家目录，只有 /tmp，而且不跨实例、不跨部署——
 * 放在那儿的东西（发布包）等于随手丢。密钥已经不走磁盘（crypto.ts），发布包挪到对象存储是
 * ADR §3 的待办；在那之前 Vercel 上传发布包会静默丢失，routes/machines.ts 那条会明说。
 */
export function gatewayHome(...segments: string[]): string {
  const root = process.env.SATUWORK_GATEWAY_HOME
    ? resolve(process.env.SATUWORK_GATEWAY_HOME)
    : process.env.VERCEL
      ? '/tmp/satuwork-gateway'
      : join(homedir(), '.satuwork-gateway')
  return segments.length ? join(root, ...segments) : root
}
