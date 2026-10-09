/**
 * 0053 · 账本行多一格 `estimated`：这一笔的用量是估的，不是上游报的。
 *
 * 流在 usage 那一帧之前断了（Bot 的静默超时、人点了停止、管家等不到响应头），上游一个
 * 数都没报，可钱是真花了。以前这种行记 0 元 + unpriced，账本比 OpenAI 后台少一截；现在
 * 按同账号同模型十分钟内上一次结算过的调用推一个数（lib/llm-billing.ts 的 estimateUsage），
 * 照常扣，但要在行上标出来——估的和报的在账上不能长得一样。老行默认 false：它们都是报的。
 */
export const SQL = `
  alter table usage_charges add column if not exists estimated boolean not null default false;
`
