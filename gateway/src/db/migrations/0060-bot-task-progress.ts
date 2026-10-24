/**
 * 0060 · 派活跑着时的进度（docs/bot-tasks.md §4）。
 *
 * 领走 run 那一步的一方（机器上的工人、本地 Bot）本来就读着目标那一轮的事件流，顺手数出
 * 「第几步、正在调什么、清单做到哪」，随续租一起报上来；主 Bot 的席位轮询时取走，写进自己会话的
 * `bot/assign`，界面上那张卡据此画「正在：…」。
 *
 * 存成一段 JSON 文本：它只是给界面看的一句话，不参与任何判断，也不值得拆成列。旧的领活方不报，
 * 那就一直是 null——界面退回只显示读秒。
 */
export const SQL = `
  alter table bot_tasks add column if not exists progress text;
`
