import type { MessageSource, SessionEvent } from '../session/types.ts'

/**
 * 主 Bot 派来的活在目标 Bot 会话里占的那几轮（docs/bot-tasks.md §7）。
 *
 * 派活跑在目标 Bot 的**主会话**里——人在它的对话里看得见这件活。可那一轮是替主 Bot 跑的
 * 一次性差事，不是人和它聊的天：
 *
 *   · 做完了，结论已经交回主 Bot，这边再留在上下文里只是噪音；
 *   · 被停了，这件事就作废了。留在上下文里的话，人下一句随口打个招呼，模型看见的最后一件
 *     事是「一件没做完的活」，会接着把它做完——2026-10-24 设计师那条会话就是这样，人说「你好」，
 *     它又调了 21 次工具。
 *
 * 所以这几轮**不进任何一轮的上下文**：人后面的对话看不见，下一件派来的活也看不见（每件活
 * 自足，指令里写全了）。日志里原样留着，界面照样画（折起来），翻历史工具照样翻得到。
 */

/** 这条 user/message 是不是主 Bot 派来的指令。兜底送回的「任务结果」（phase=result）是主 Bot 自己要处理的，不算。 */
export function isTaskInstruction(source: MessageSource | undefined): boolean {
  return Boolean(source && source.kind === 'plugin' && source.plugin === 'task' && source.phase !== 'result')
}

/** 两种上下文边界：不管落在哪儿都不能丢，toAgentMessages 和压缩都靠它们认「从哪开始」。 */
const BOUNDARY = new Set(['session/compact', 'session/reset'])

/**
 * 去掉派活那几轮：指令本身、它开的那一轮从 turn/start 到 turn/end 的全部事件，以及之后才到、
 * 但带着那一轮轮号的零星几条（晚到的截图之类）。
 *
 * 认法：指令落下时**没有轮次开着**，紧接着的那个 turn/start 就是它的。老席位会把派活插进
 * 人正在跑的那一轮（steered）——那一轮是人的，只去掉指令那一句，别的不动。
 */
export function withoutTaskTurns<T extends SessionEvent>(events: readonly T[]): T[] {
  let open: number | null = null
  let pending = false
  let inTask = false
  /**
   * 上一条就是派来的指令。上一轮只有 turn/start、没有 turn/end（进程死在半路的老日志）时 open 一直
   * 不是 null，pending 永远立不起来，之后派来的活全被当成插话、进了后续上下文。插话后面跟的是人那一轮
   * 的助手、工具事件；指令紧挨着一个 turn/start，就是它开了自己的一轮（同 core 的 fold）。
   */
  let justTask = false
  const taskTurns = new Set<number>()
  const drop = new Set<number>()
  for (const e of events) {
    const turnOf = (e.data as { turn?: unknown } | undefined)?.turn
    const afterTask = justTask
    justTask = false
    if (e.type === 'user/message') {
      if (isTaskInstruction((e.data as { source?: MessageSource }).source)) {
        drop.add(e.seq)
        if (open === null) pending = true
        justTask = true
        continue
      }
      // 指令之后没开成轮（落盘半截的老日志），接下来人说的那句开的是人自己的一轮。
      if (open === null) pending = false
    } else if (e.type === 'turn/start') {
      open = Number(turnOf)
      inTask = pending || afterTask
      pending = false
      if (inTask) taskTurns.add(open)
    } else if (e.type === 'turn/end') {
      if (inTask || taskTurns.has(Number(turnOf))) drop.add(e.seq)
      if (Number(turnOf) === open) {
        open = null
        inTask = false
      }
      continue
    }
    if (BOUNDARY.has(e.type)) continue
    if (inTask || (typeof turnOf === 'number' && taskTurns.has(turnOf))) drop.add(e.seq)
  }
  return drop.size ? events.filter((e) => !drop.has(e.seq)) : events.slice()
}
