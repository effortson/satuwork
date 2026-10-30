/** 仅保存用于通知的短摘要，完整会话仍由席位保管。 */
export const SQL = `
  alter table notification_events add column if not exists preview text not null default '' check (char_length(preview) <= 240);
`
