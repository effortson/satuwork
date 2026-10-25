/**
 * 起一个测试用 Gateway：清数据目录 → 要端口 → spawn → 等 /health。
 *
 * 三十多套用例各抄了一遍这一段，抄着抄着就有人漏了 `child`（起不来时只剩一句「等不到」）
 * 或者把 schema 写死（被别的 worktree 清掉）。这里只管所有套件都一样的那几项：
 * 数据目录、库、schema、清库、监听地址和端口。**其余的一律由调用方在 env 里明说**——
 * GATEWAY_ACCESS_HOST、GATEWAY_SEED_OWNER 各套口径不一，不在这里替它们定默认值。
 *
 * 不清库、不清目录的重启（同一份数据再起一遍）别走这里，自己用 `env` 里返回的那份再 start。
 */
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, waitHttp } from './harness.mjs'
import { PG_URL } from './pg.mjs'
import { freePort } from './ports.mjs'

const gwRoot = join(dirname(dirname(fileURLToPath(import.meta.url))), 'gateway')

/**
 * @param name     子进程名（日志前缀）
 * @param what     等不到时报的名字
 * @param home     数据目录（tmpOf 过的），起之前清掉
 * @param schema   schema 名（schemaOf 过的），带 GATEWAY_PG_RESET=1 起，自己清库重建
 * @param port     要先知道端口的（env 里要拼地址）自己要好传进来；不给就现要一个
 * @param host     GATEWAY_HOST；null 就不设
 * @param env      其余环境变量，原样合进去（同名的盖掉上面几项）
 * @param timeout  等 /health 的额度，不给用 waitHttp 的默认值
 * @returns `{ gw, base, port, home, schema, env }`——env 是实际传给子进程的那份
 */
export async function startGateway({ name, what, home, schema, port, host = '127.0.0.1', env = {}, timeout }) {
  port ||= await freePort()
  const base = `http://127.0.0.1:${port}`
  rmSync(home, { recursive: true, force: true })
  const full = {
    SATUWORK_GATEWAY_HOME: home,
    GATEWAY_DATABASE_URL: PG_URL,
    GATEWAY_PG_SCHEMA: schema,
    GATEWAY_PG_RESET: '1',
    ...(host ? { GATEWAY_HOST: host } : {}),
    GATEWAY_PORT: String(port),
    ...env,
  }
  const gw = start(name, ['--import', 'tsx', join(gwRoot, 'src/index.ts')], { cwd: gwRoot, env: full })
  // 带上 child：起不来时有用的是它的输出，不是三十秒后那句「等不到」。
  await waitHttp(`${base}/health`, { child: gw, what, ...(timeout ? { timeout } : {}) })
  return { gw, base, port, home, schema, env: full }
}
