/** Bounded avatar thumbnails; empty means the account's initial is displayed. */
export const SQL = `alter table accounts add column if not exists avatar text not null default '';`
