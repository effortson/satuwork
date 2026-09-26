/**
 * 0042 · 审计条目的评分理由与语言。
 *
 * `scoreBreakdown` 只有每一项的分数，公司管理员看到「完成度 30 / 40」却不知道扣的那 10 分
 * 扣在哪儿——分数本身没法复核，也没法据此跟员工沟通。`scoreReasons` 与它同键，每一项
 * 一句原因，由审计模型在同一次调用里写出来。
 *
 * `locale` 是这一条的文字（摘要、时间线、原因……）用哪种语言写的，取自会话主人在个人设置
 * 里选的界面语言。老条目两列都是默认值：没有原因、按中文算——它们本来就是中文写的。

`scoreMax` 是每一项的满分，见下面那条注释。
 */
export const SQL = `
  alter table conversation_audit_items add column if not exists "scoreReasons" jsonb not null default '{}'::jsonb;
  alter table conversation_audit_items add column if not exists locale text not null default 'zh';
  -- 每一项的满分，由席位按它评分时用的那份规则写进来。界面照它画「得分 / 满分」，
  -- 不在前端另抄一份权重——规则改了，老条目仍按当时的满分画。老条目为空，界面按旧规则补。
  alter table conversation_audit_items add column if not exists "scoreMax" jsonb not null default '{}'::jsonb;
  -- 列表按 coalesce("endedAt","createdAt") 排序和翻页（游标比较的也是它），原来那条
  -- ("companyId","endedAt" desc, id desc) 用不上，每一页都要把整家公司的条目排一遍。
  create index if not exists conversation_audit_item_company_at
    on conversation_audit_items ("companyId", (coalesce("endedAt","createdAt")) desc, id desc);
`
