/**
 * 0048 · `llm_calls` 按模型查的索引。
 *
 * 生图模型的预估要拿**自己实测的用量**当基线（lib/image-estimate.ts）：OpenAI 没公布 gpt-image-2
 * 一张图多少 token，而且这个数本来就随画面内容变，没有一张固定的表。基线查的是「这颗模型最近
 * 两百次成功调用」，按 (provider, model) 过滤、按时间倒序——没有这个索引就是整张 llm_calls
 * 扫一遍，而那张表里是所有对话调用。
 */
export const SQL = `
  create index if not exists llm_calls_model on llm_calls (provider, model, "createdAt" desc);
`
