/**
 * 机器的挑选与负载：一个账号该落在哪台机器、每台上有几个人、槽位怎么分。
 */
import type { Db, Machine, SeatRuntime } from '../db.ts'
import { MAX_SLOT, SlotsExhausted, botBaseOf, machinePaired } from './paths.ts'

/** 槽位**按机器**分配，不是按公司：端口从槽位算出来，两台机器上的 slot 0 互不冲突。 */
export async function allocateSlot(db: Db, machineId: string, keep?: number): Promise<number> {
  if (keep != null && keep >= 0) return keep
  const used = new Set((await db.seatRuntimesOfMachine(machineId)).map((r) => r.slot))
  let i = 0
  while (used.has(i)) i += 1
  if (i > MAX_SLOT) throw new SlotsExhausted()
  return i
}

/** 一台机器上「激活账号」的数量：有已部署席位的不同账号。 */
export function activeAccountsOf(seats: SeatRuntime[]): Set<string> {
  return new Set(seats.filter((r) => r.status !== 'none').map((r) => r.accountId))
}

export interface MachineLoad {
  machine: Machine
  /**
   * 这台机器上的席位行。
   *
   * **算负载的时候本来就查过一遍**，所以顺手带出来：下游要画席位清单的地方（机器
   * 卡片）不必再查一次同一批行。少一次往返事小，两份可能对不上的数据事大——负载
   * 数字和席位清单出自同一次查询，界面上「账号位 3/10」和底下那张表就永远一致。
   */
  seatRows: SeatRuntime[]
  accounts: number
  seats: number
  full: boolean
}

export async function machineLoads(db: Db, companyId: string): Promise<MachineLoad[]> {
  const machines = await db.machinesOfCompany(companyId)
  return Promise.all(machines.map((machine) => machineLoadOf(db, machine)))
}

/** 单台机器的负载。多机公司走 machineLoads，平台侧按 id 拿单台的走这条。 */
export async function machineLoadOf(db: Db, machine: Machine): Promise<MachineLoad> {
  const seatRows = await db.seatRuntimesOfMachine(machine.id)
  const accounts = activeAccountsOf(seatRows).size
  return { machine, seatRows, accounts, seats: seatRows.length, full: accounts >= machine.maxAccounts }
}

/**
 * 这个账号该落在哪台机器上。
 *
 * 两条规则：
 *
 * 1. **粘住。** 账号已经有席位了就还用那台机器——同一个员工的所有 bot 共用一个 uid
 *    和 `~/work`，拆到两台机器上「共享文件」就不成立了。
 * 2. **填满一台再用下一台。** 在没满的机器里挑**已用最多**的那台（并列按登记先后）。
 *    不是最闲优先——那样会把账号摊平到所有机器上，谁也没满，反而没法把空机器腾出来
 *    下线或者转给别的公司。
 */
export async function machineForAccount(
  db: Db,
  companyId: string,
  accountId: string,
): Promise<{ ok: true; machine: Machine } | { ok: false; status: number; error: string }> {
  const loads = await machineLoads(db, companyId)
  const paired = loads.filter((l) => machinePaired(l.machine))
  if (!paired.length) return { ok: false, status: 409, error: '公司还没有配对任何运行机器' }

  /**
   * 粘住是**不变量，不是优化**。
   *
   * 以前这里只有 `if (hit) return …`：找到了这个账号的机器、但它此刻不可用
   * （没配对好、换过地址、token 轮换失败、正在重装），就直接往下走「填满一台再用
   * 下一台」，把这个人的新 bot 部署到另一台机器上。共享 `~/work` 靠的是同一个 uid
   * 在同一台机器上，劈开之后这条就不成立了——而且没有任何告警，人只是从此看不见
   * 自己在另一台机器上的文件。
   *
   * 更糟的是下一次：seatRuntimesOfAccount 按 slot 排序，而 slot 是**按机器**分配的，
   * 跨机器排序没有语义——一旦劈开，挑哪台就变成任意的。
   *
   * 所以找到了就必须用那台；那台不行就报出来，让人先去修机器。
   */
  const mine = (await db.seatRuntimesOfAccount(accountId)).find((r) => r.machineId)
  if (mine) {
    const hit = paired.find((l) => l.machine.id === mine.machineId)
    // 粘住的机器就算已经满了也继续用：它的容量早就把这个账号算进去了。
    if (hit) return { ok: true, machine: hit.machine }
    const stale = loads.find((l) => l.machine.id === mine.machineId)?.machine
    return {
      ok: false,
      status: 409,
      error: stale
        ? `这个账号的席位在机器 ${stale.id.slice(0, 8)}（${stale.host || '地址未知'}）上，那台还没配对好。` +
          '先把它修好再部署——换一台会让这个人的共享文件对不上。'
        : '这个账号的席位所在的机器已经不在这家公司名下了。先把它派回来，或者删掉这个账号的旧席位。',
    }
  }

  const open = paired.filter((l) => !l.full).sort((a, b) => b.accounts - a.accounts || a.machine.createdAt - b.machine.createdAt)
  if (!open.length) {
    const total = paired.reduce((n, l) => n + l.machine.maxAccounts, 0)
    return { ok: false, status: 409, error: `所有运行机器都满了（${paired.length} 台，共 ${total} 个账号位）` }
  }
  return { ok: true, machine: open[0].machine }
}

export async function companyMachineOf(db: Db, companyId: string): Promise<Machine | undefined> {
  const company = await db.company(companyId)
  if (!company) return
  if (company.machineId) {
    const m = await db.machine(company.machineId)
    if (m) return m
  }
  return db.machineOfCompany(companyId)
}

/**
 * 机器地址改了之后，把这台机器上所有席位的 `instances.host` 重铺一遍。
 *
 * **不做这件事，改地址会把聊天打断，而桌面看着一切正常。**
 *
 * 两条路读的不是同一个地方：桌面和诊断走 `managerTargetFor`，每次现从
 * `machines.host` 拼；聊天走 `instanceHostFor`，读的是 `instances.host`——而那一行
 * 只在部署时由 `upsertInstance` 写下，之后没有任何人碰它。于是把机器换到新地址
 * （典型场景：前面加一层 nginx 终结 TLS，管家跟着收回 127.0.0.1）之后，存量席位的
 * 聊天还在往那个已经不听的老地址打，右栏的桌面却是好的。
 *
 * 表现是「这颗 bot 挂了」，不是「地址改错了」——最难查的那一类，而且改地址的人当场
 * 看不出来：他改完点一下桌面，一切正常。
 *
 * **只改本来就指着管家的那些。** `instances.host` 不止一种形状：
 *
 *   - `botBaseOf(machine.host, seatId)` —— 管家反代，也就是这里要跟着改的那种
 *   - `http://127.0.0.1:<botPort>` —— 只有 `SATUWORK_DEPLOY_STUB=1` 那条路会写
 *   - 本地 Bot（桌面端）**没有这一行**：Gateway 连不到员工的电脑，对话由桌面端直连本机（见 ui/data.js 的 localRoute）
 *
 * 后两种和机器地址没有关系，无差别盖成管家形状等于把它们打断。所以逐行比对形状，
 * 对不上就跳过——宁可少改一行让人再点一次，也不能把一条本来好的路改坏。
 *
 * `upsertInstance` 会顺带把 `lastReadyAt` 刷成现在。那一列全库只写不读（没有任何
 * 查询或界面用它），所以这里不为它单开一个方法。
 *
 * 返回真正改了几行，好让调用方写进审计、也回给界面。
 */
export async function rehostSeatInstances(db: Db, machineId: string, host: string): Promise<number> {
  const seats = await db.seatRuntimesOfMachine(machineId)
  let changed = 0
  for (const seat of seats) {
    const next = botBaseOf(host, seat.seatId)
    if (!next) continue
    const cur = await db.instance(seat.accountId, seat.botId)
    // 尾巴是 `/seats/<seatId>/bot` 才算「本来就指着管家」——前面那截正是要换掉的老地址。
    if (!cur?.host.endsWith(`/seats/${encodeURIComponent(seat.seatId)}/bot`)) continue
    if (cur.host === next) continue
    await db.upsertInstance({
      accountId: seat.accountId,
      botId: seat.botId,
      companyId: seat.companyId,
      host: next,
    })
    changed++
  }
  return changed
}
