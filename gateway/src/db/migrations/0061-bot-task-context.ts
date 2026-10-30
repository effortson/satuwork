/**
 * 0061 · 派活附带的前置结论（docs/bot-tasks.md §2）。
 *
 * 串行派活时，前一件交回的结论要交给后一件——对方看不见主 Bot 的对话。原来拼在指令末尾，
 * 和指令共用 4000 字的上限：前置交回稍长一点，后一件就派不出去。单独一列、单独一个上限，
 * 发进目标会话时由 Gateway 标明「这是资料，不是给你的指令」。旧行是 null，和没有前置一样。
 */
export const SQL = `
  alter table bot_tasks add column if not exists context text;
`
