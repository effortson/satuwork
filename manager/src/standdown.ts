import { rmSync } from 'node:fs'
import { seatsPath, statePath, type ManagerState } from './config.ts'
import { run } from './run.ts'
import { removeSeat, seats } from './seats.ts'

/**
 * 注销：这台机器在平台上被移除了，自己收拾干净然后退出。
 *
 * **信号是肯定式的，不是 401。** Gateway 移除一台在线机器时不会立刻删记录，而是留
 * 一行墓碑，在心跳回包里带 `removed: true`——「我认识你，并且我告诉你你被移除了」。
 * 用 401 当信号是不行的：那是「我不认识你」，Gateway 回滚版本、库恢复到旧快照、
 * DNS 指错了一台 Gateway，都会让整个机队同时收到 401，据此自毁就是全机队自杀。
 *
 * 收拾的顺序有讲究：
 *
 * 1. **先停席位。** 反过来的话，管家一停，那些 bot / x11vnc 就成了没人管得着的
 *    孤儿进程——端口还占着，谁也不知道它们在跑什么。
 * 2. **再删 manager.json。** 少了它，重启回来不会再去敲一个已经不认识自己的
 *    Gateway。这一步必须在停自己之前，否则 systemd 拉起来又是一轮。
 * 3. **最后 disable + stop 自己。** 走 `systemd-run` 的瞬态单元，理由和自升级重启
 *    那处一样：管家的子进程去 `systemctl stop` 自己会连命令一起被杀（同一个
 *    cgroup），命令根本发不出去。
 *
 * 席位拆不掉不阻断后面的步骤：这台机器要下线了，卡在一个拆不干净的席位上没有意义,
 * 拆不掉的会记在日志里，人上去看得到。
 */
export async function standDown(state: ManagerState, dryRun: boolean): Promise<void> {
  console.log('satuwork-manager: 这台机器已在平台上移除，开始注销')

  const rows = seats()
  for (const row of rows) {
    try {
      await removeSeat(row.seatId)
      console.log(`satuwork-manager: 已拆席位 ${row.seatId}`)
    } catch (e) {
      // 记下来就往下走。下线路上没有「回滚」这个选项。
      console.error(`satuwork-manager: 席位 ${row.seatId} 没拆干净：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 回执。Gateway 收到就当场把那行删了；发不出去也不要紧，墓碑有 TTL 会自己过期。
  try {
    await fetch(`${state.gatewayUrl}/internal/machines/${encodeURIComponent(state.machineId)}/removed`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + state.token, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    /* 送不到就算了：Gateway 那边到点自己会收。 */
  }

  // 配对状态和席位名册一起清掉：留着 manager.json 的话，下一次开机又会去敲。
  rmSync(statePath(), { force: true })
  rmSync(seatsPath(), { force: true })
  console.log(`satuwork-manager: 已拆 ${rows.length} 个席位，配对状态已清除`)

  if (dryRun) {
    console.log('satuwork-manager: dryRun，跳过 systemctl disable')
    return
  }
  await run(
    'systemd-run',
    // `--collect`：瞬态单元失败了别留在 failed 态，不然下一次同名的 systemd-run 会被拒。
    ['--on-active=2s', '--collect', '--unit=satuwork-manager-standdown', 'systemctl', 'disable', '--now', 'satuwork-manager.service'],
    { timeout: 15_000 },
  )
  console.log('satuwork-manager: 2 秒后停止并取消开机自启')
}
