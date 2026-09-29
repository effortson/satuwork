import {
  channelCommand, channelMentionHelp, channelTodoMarkdown, parseChannelMentions,
} from './src/web/channel.ts'
import { channelDraft, channelFiles, channelHandoffs } from './src/web/index.ts'
import { clearSettledTodos } from './src/tools/todo.ts'

function todoFixture(items) {
  let value = items
  const snapshots = []
  return {
    ctx: {
      storage: {
        collection: () => ({
          get: () => value,
          delete: () => {
            const existed = value !== undefined
            value = undefined
            return existed
          },
        }),
      },
      sessions: { append: async (_sessionId, type, data) => snapshots.push({ type, data }) },
      logger: { warn: () => {} },
    },
    snapshots,
    value: () => value,
  }
}

const candidates = [
  { id: 'gmail-personal', label: 'Gmail (personal)' },
  { id: 'gmail-work', label: 'Gmail (work)' },
  { id: 'notion', label: 'Notion' },
]
const parsed = parseChannelMentions('@Gmail_personal @Notion 查邮件并建立页面', candidates)
const ambiguous = parseChannelMentions('@Gmail 查邮件', candidates)
const todos = channelTodoMarkdown([
  { id: '1', task: '读取邮件', status: 'completed' },
  { id: '2', task: '建立 **页面**', status: 'in_progress' },
  { id: '3', task: '旧步骤', status: 'cancelled' },
])
const draft = channelDraft([
  { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'channel', form: 'update-7' } } },
  { type: 'turn/start', data: { turn: 7 } },
  { type: 'assistant/chunk', data: { turn: 7, step: 1, chunk: { type: 'text-delta', text: '我先' } } },
  { type: 'assistant/chunk', data: { turn: 7, step: 1, chunk: { type: 'text-delta', text: '查行情' } } },
  // 完整消息会替代同一步的 chunks，不能再重复拼一次「我先查行情」。
  { type: 'assistant/message', data: { turn: 7, step: 1, message: { content: [{ type: 'text', text: '我先查行情。' }] } } },
  { type: 'assistant/chunk', data: { turn: 7, step: 2, chunk: { type: 'text-delta', text: '正在生成报告' } } },
], 'update-7')
const toolDraft = channelDraft([
  { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'channel', form: 'update-tools' } } },
  { type: 'turn/start', data: { turn: 8 } },
  { type: 'assistant/message', data: { turn: 8, step: 1, message: { content: [{ type: 'text', text: '我先查一下。' }] } } },
  { type: 'tool/call', data: { turn: 8, step: 1, callId: 'call-search', name: 'web_search', arguments: '{"q":"ETH"}' } },
  { type: 'tool/result', data: { turn: 8, step: 1, callId: 'call-search', text: '找到了', failed: false } },
  { type: 'tool/call', data: { turn: 8, step: 2, callId: 'call-extract', name: 'web_extract', arguments: '{"url":"https://example.test"}' } },
  { type: 'tool/call', data: { turn: 8, step: 2, callId: 'call-failed', name: 'browser_navigate', arguments: '{}' } },
  { type: 'tool/result', data: { turn: 8, step: 2, callId: 'call-failed', text: '超时', failed: true } },
  // 参数和结果可能含敏感内容，只能展示名称和状态。
  { type: 'tool/result', data: { turn: 8, step: 2, callId: 'orphan', text: '不能露出来的结果', failed: false } },
], 'update-tools')
/**
 * 草稿**只往后长**：按事件一条一条喂进来，每喂一条算一帧，每一帧都要以上一帧开头——
 * 不是的话 Telegram 客户端会从分叉处重播打字动画（「前面那段一遍遍重打」）。
 * 序列覆盖以前出问题的那几个点：工具之后下一步的正文、工具状态从调用中变成完成、
 * 一步收口的完整消息、不流式只落完整消息的一步。
 */
const growEvents = [
  { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'channel', form: 'update-grow' } } },
  { type: 'turn/start', data: { turn: 9 } },
  { type: 'assistant/chunk', data: { turn: 9, step: 1, chunk: { type: 'text-delta', text: '我先' } } },
  { type: 'assistant/chunk', data: { turn: 9, step: 1, chunk: { type: 'text-delta', text: '查一下。\n' } } },
  { type: 'assistant/message', data: { turn: 9, step: 1, message: { content: [{ type: 'text', text: '我先查一下。\n' }] } } },
  { type: 'tool/call', data: { turn: 9, step: 1, callId: 'c1', name: 'web_search', arguments: '{"q":"秘密"}' } },
  { type: 'tool/call', data: { turn: 9, step: 1, callId: 'c2', name: 'web_extract', arguments: '{}' } },
  { type: 'tool/result', data: { turn: 9, step: 1, callId: 'c1', text: '结果', failed: false } },
  { type: 'tool/result', data: { turn: 9, step: 1, callId: 'c2', text: '超时', failed: true } },
  { type: 'assistant/chunk', data: { turn: 9, step: 2, chunk: { type: 'text-delta', text: '\n\n找到了三条' } } },
  { type: 'assistant/chunk', data: { turn: 9, step: 2, chunk: { type: 'text-delta', text: '，整理中' } } },
  // 收口时改了措辞（不以已接上的 delta 开头）：不能回头改已经发出去的那几个字。
  { type: 'assistant/message', data: { turn: 9, step: 2, message: { content: [{ type: 'text', text: '找到三条，整理中。' }] } } },
  { type: 'tool/call', data: { turn: 9, step: 2, callId: 'c3', name: 'write_file', arguments: '{}' } },
  { type: 'tool/result', data: { turn: 9, step: 2, callId: 'c3', text: 'ok', failed: false } },
  // 不流式的一步：只落一条完整消息，整段接上。
  { type: 'assistant/message', data: { turn: 9, step: 3, message: { content: [{ type: 'text', text: '报告写好了。' }] } } },
]
const growFrames = growEvents.map((_, i) => channelDraft(growEvents.slice(0, i + 1), 'update-grow').trim())
const growBroken = growFrames.findIndex((frame, i) => i > 0 && !frame.startsWith(growFrames[i - 1]))
const files = channelFiles([
  { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'channel', form: 'update-7' } } },
  { type: 'turn/start', data: { turn: 7 } },
  { type: 'tool/result', data: { turn: 7, files: [
    { path: 'reports/eth.html', name: 'eth.html' },
    { path: 'reports/eth.html', name: 'eth.html' },
    { path: 'reports/summary.pdf', name: 'summary.pdf' },
  ] } },
  // 别轮的产出不能跟进这一条 Telegram 回复。
  { type: 'tool/result', data: { turn: 8, files: [{ path: 'later.txt', name: 'later.txt' }] } },
], 'update-7')
const handoffs = channelHandoffs([
  { time: 100, type: 'user/message', data: { source: { kind: 'plugin', plugin: 'channel', form: 'update-handoff' } } },
  { time: 101, type: 'turn/start', data: { turn: 9 } },
  { time: 102, type: 'human/handoff', data: {
    id: 'handoff-current', callId: 'call-1', state: 'open', reason: '需要短信验证码', ask: '提供验证码',
    summary: '已经登录到验证页', blocking: true, repeats: 0, at: 102,
  } },
  { time: 103, type: 'turn/end', data: { turn: 9 } },
  // 这一轮结束后的旧卡变化不能跟进当前 Telegram 回复。
  { time: 104, type: 'human/handoff', data: {
    id: 'handoff-old', callId: 'call-old', state: 'open', reason: '旧原因', ask: '旧任务', blocking: true, at: 104,
  } },
], 'update-handoff')
const settled = todoFixture([
  { id: '1', task: '完成报告', status: 'completed' },
  { id: '2', task: '不再需要', status: 'cancelled' },
])
const settledCleared = await clearSettledTodos(settled.ctx, 'session-1', 'channel:update-next')
const open = todoFixture([
  { id: '1', task: '继续处理', status: 'pending' },
  { id: '2', task: '已完成部分', status: 'completed' },
])
const openCleared = await clearSettledTodos(open.ctx, 'session-2', 'channel:update-next')

console.log('__RESULT__' + JSON.stringify({
  growFrames,
  growBroken,
  commands: [channelCommand('/new'), channelCommand('/new@satuwork_bot'), channelCommand('/tasks'), channelCommand('/mentions')],
  parsed,
  ambiguous,
  help: channelMentionHelp(candidates),
  todos,
  draft,
  toolDraft,
  files,
  handoffs,
  settledCleared,
  settledValue: settled.value(),
  settledSnapshots: settled.snapshots,
  openCleared,
  openValue: open.value(),
  openSnapshots: open.snapshots,
}))
