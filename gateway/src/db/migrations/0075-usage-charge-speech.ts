/**
 * 0075 · 账本多一种 kind：`speech`（手机端语音输入的转写，lib/speech.ts）。做法同 0052。
 */
export const SQL = `
  alter table usage_charges drop constraint if exists usage_charges_kind_check;
  alter table usage_charges add constraint usage_charges_kind_check check (kind in ('llm', 'connector', 'web', 'kb', 'speech'));
`
