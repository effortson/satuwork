/**
 * 0052 · 账本多一种 kind：`kb`（知识库的检索与入库，docs/knowledge-base.md §10）。
 *
 * 0007 建表时 kind 的 check 是写死的三个值；加一种就得重建这条约束。约束名是 PG 给
 * 内联 check 起的默认名（<表>_<列>_check），drop if exists 兜住已经被人改过名的库。
 */
export const SQL = `
  alter table usage_charges drop constraint if exists usage_charges_kind_check;
  alter table usage_charges add constraint usage_charges_kind_check check (kind in ('llm', 'connector', 'web', 'kb'));
`
