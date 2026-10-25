import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventMap, Usage } from '../session/types.ts'
import type { WorkspaceFile } from '../tools/index.ts'
import type { TaskOutcome, TaskSpec } from './types.ts'

/** 委派子任务的交底和收口：给子代理的那段提示、从子会话里收结论、文件和用量。 */

/**
 * 一次**什么都没发生**的委派。
 *
 * 只有一种来路：runTask 进门时信号已经是 aborted（人在模型发出这次调用和它真正开跑之间
 * 按了停止）。子会话没建、事件没写，所以这里也不能报出一个 child——空串是诚实的。
 */
export function abortedOutcome(spec: TaskSpec, taskId: string, startedAt: number): TaskOutcome {
  return { ...blankOutcome(spec, 'aborted', '还没开始就被停止了。'), taskId, ms: Date.now() - startedAt }
}

/**
 * 一份「什么都没跑成」的结果。
 *
 * 两种没跑成共用：**没起来**（delegate 那边接住了异常，子会话可能都没建）和
 * **还没开跑就被停了**。两边都要交出一份形状完整的 TaskOutcome——模型下一步要靠
 * `state` 和 `summary` 决定是重派还是换做法，缺一格它就得去猜。
 *
 * `child` 一律空串：子会话没建出来，报一个 id 出去是骗人的。
 */
export function blankOutcome(spec: TaskSpec, state: TaskOutcome['state'], summary: string): TaskOutcome {
  return {
    index: spec.index,
    taskId: '',
    child: '',
    goal: spec.goal,
    state,
    summary,
    files: [],
    steps: 0,
    toolCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, cost: 0 },
    model: { role: spec.modelRole, provider: '', id: '' },
    handedOver: [],
    ms: 0,
  }
}

/**
 * 送进子代理的那句话。
 *
 * **不是 goal 一行。** 子代理以全新对话启动，它对主对话一无所知——`context` 写不全的
 * 表现就是它回一句「不知道你说的『那个错』是什么」。所以四段分开摆，让主代理写的时候
 * 也看得见自己漏了哪一段。
 */
export function taskBrief(spec: TaskSpec): string {
  const parts = [`# 任务\n${spec.goal}`, `# 背景\n${spec.context}`]
  if (spec.deliver?.trim()) parts.push(`# 结论里必须包含\n${spec.deliver.trim()}`)
  return parts.join('\n\n')
}

/**
 * 子代理专属的那一段系统提示词。
 *
 * 主代理那份里没有的四件事，每一件都对应一个它答不出来就会出错的问题：我是谁、
 * 卡住了怎么办、东西写哪儿、结论长什么样。
 */
export function taskBlock(spec: TaskSpec): string {
  return [
    '## 你是一个子代理',
    '',
    '你被派来单独做一件事。你看不到派你来的那场对话，也**没有人可以问**——界面上没有你的位置，',
    '你说的话除了最后那段结论之外没有任何人会看到。',
    '',
    '- **卡住了不要停在半路装作做完了。** 把卡在哪儿、已经排除了什么写进结论交回去，由主代理去问人',
    '- **工作区和主代理共享**（同一个目录）。草稿和中间产物写 `tasks/` 下自己的目录，成品才写',
    '  正常位置；并发跑的几条子任务各有各的文件范围，别越界',
    '- **你起的后台进程会在你收口时交给主代理**，所以起了什么要在结论里点名（session_id + 命令）',
    `- 最多 ${spec.maxSteps} 步。到顶会被收口，那时已经做到的照样交回去——所以边做边把结论攒出来`,
    '',
    '### 结论怎么写',
    '',
    '你最后那条消息**就是**交回去的东西，它会原样进主代理的上下文。所以：',
    '',
    '- 第一段是结论本身，不是过程。「改了 7 个文件共 23 处，两处 catch 里的改成了 warn」',
    '- 没做成的部分单独说，写清卡在哪儿、下一步该看什么',
    '- 产出的文件写相对工作区的路径',
    '- 不要复述任务，不要写「好的，我来做这件事」',
  ].join('\n')
}

/** 子会话里最后一条助手文本。**这就是结论**——没有就是没有，不编。 */
export function lastAssistantText(events: Awaited<ReturnType<Context['sessions']['events']>>): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (e.type !== 'assistant/message') continue
    const text = (e.data as SessionEventMap['assistant/message']).message.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('')
      .trim()
    if (text) return text
  }
  return ''
}

/** 子代理产出的文件。从 tool/result 上收，**不去正则扫文本猜路径**（同 ToolResult.files）。 */
export function taskFiles(events: Awaited<ReturnType<Context['sessions']['events']>>): WorkspaceFile[] {
  const seen = new Map<string, WorkspaceFile>()
  for (const e of events) {
    if (e.type !== 'tool/result') continue
    for (const f of (e.data as SessionEventMap['tool/result']).files ?? []) seen.set(f.path, f)
  }
  return [...seen.values()]
}

/**
 * 这条子会话花了多少。
 *
 * 从 assistant/message 上累加，**不新增记账路径**——钱那条链子已经在 Gateway 代理侧
 * 一次请求一行了（docs/billing.md）。这里的用途只有一个：卡片上那行「这一次委派花了
 * 多少」，而它答的正是 billing.md 缺口 5 那个问题。
 */
export function sumUsage(events: Awaited<ReturnType<Context['sessions']['events']>>): Usage {
  const out: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, cost: 0 };
  for (const e of events) {
    if (e.type !== 'assistant/message') continue
    const u = (e.data as SessionEventMap['assistant/message']).usage
    out.inputTokens += u.inputTokens ?? 0
    out.outputTokens += u.outputTokens ?? 0
    out.cacheReadTokens += u.cacheReadTokens ?? 0
    out.reasoningTokens += u.reasoningTokens ?? 0
    out.cost = (out.cost ?? 0) + (u.cost ?? 0)
  }
  return out
}
