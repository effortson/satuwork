/**
 * 维护节拍（routines.ts 的 maintenanceTick，Debian 调度器和 `/cron/tick` 共用）每一步单独兜错。
 *
 * 以前是一条 `.then` 链收尾一个 `.catch`：任何一步持续报错，排在它后面的删除终审、卡住的部署
 * 对账每一拍都被跳过，而日志里只有一句「日常任务扫描失败」。
 */
import { runProbe } from './probe.mjs'

export async function runMaintenance({ root, test, assert, log }) {
  log('\n# maintenance')
  const result = await runProbe(root, 'gateway/e2e-maintenance.mjs')
  for (const [group, checks] of Object.entries(result)) {
    for (const [name, ok] of Object.entries(checks)) {
      await test(`${group}：${name}`, () => assert(ok === true, `${group}：${name} 不成立`))
    }
  }
}
