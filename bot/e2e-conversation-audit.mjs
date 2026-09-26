/** 席位侧审计切轮、工具证据和出站脱敏的纯函数探针。 */
import { SCORE_ITEMS, auditSystem, chunksOf, completedTurns, redactValue, turnText } from './src/conversation-audit/index.ts'

const ev = (seq, time, type, data) => ({ seq, time, type, data })
const events = [
  ev(1, 1000, 'turn/start', { turn: 1 }),
  ev(2, 1100, 'user/message', { message: { content: [{ type: 'text', text: '发给 alice@example.com，电话 13800138000' }] } }),
  ev(3, 1200, 'tool/call', { turn: 1, name: 'gmail_send' }),
  ev(4, 1300, 'tool/result', { turn: 1, message: { content: [{ type: 'text', text: 'sent id=abc123' }] } }),
  ev(5, 1400, 'assistant/message', { message: { content: [{ type: 'text', text: '已经发送。' }] } }),
  ev(6, 1500, 'turn/end', { turn: 1, reason: 'completed' }),
  ev(7, 1600, 'turn/start', { turn: 2 }),
  ev(8, 1700, 'user/message', { message: { content: [{ type: 'text', text: '这一轮还没结束' }] } }),
]
const turns = completedTurns(events)
const prompt = turnText(turns[0])
const sanitized = redactValue({ at: 1_772_508_600_000, answer: '联系人 bob@example.com，+60 12-345 6789' })

const many = Array.from({ length: 8 }, (_, i) => ({
  ...turns[0], turn: i + 1, firstSeq: i * 10 + 1, lastSeq: i * 10 + 6,
  events: turns[0].events.map((row) => row.type === 'user/message'
    ? { ...row, data: { message: { content: [{ type: 'text', text: '很长的任务说明'.repeat(700) }] } } }
    : row),
}))
const chunks = chunksOf(many)

const zh = auditSystem('zh')
const en = auditSystem('en')

console.log('__RESULT__' + JSON.stringify({
  提示词: {
    要求写评分理由: zh.includes('scoreReasons') && /为什么得这个分/.test(zh),
    五项满分合计一百: SCORE_ITEMS.reduce((n, x) => n + x.max, 0) === 100,
    每项都列进提示词: SCORE_ITEMS.every((x) => zh.includes(`${x.key} 满分 ${x.max}`)),
    英文用户要英文: /in English/.test(en) && !/用简体中文写/.test(en),
    中文用户要中文: /用简体中文写/.test(zh) && !/in English/.test(zh),
  },
  切轮: {
    只收已完成轮次: turns.length === 1,
    seq范围完整: turns[0].firstSeq === 1 && turns[0].lastSeq === 6,
  },
  证据: {
    读取真实工具结果形状: prompt.includes('sent id=abc123'),
    保留工具名: prompt.includes('gmail_send'),
  },
  脱敏: {
    输入邮箱已脱敏: !prompt.includes('alice@example.com') && prompt.includes('[邮箱已脱敏]'),
    输入电话已脱敏: !prompt.includes('13800138000'),
    输出字符串再脱敏: !sanitized.answer.includes('bob@example.com'),
    时间数字不被误伤: sanitized.at === 1_772_508_600_000,
  },
  分块: {
    超长输入会分块: chunks.length > 1,
    不拆开单轮: chunks.flat().length === many.length && chunks.every((rows) => rows.length > 0),
  },
}))
