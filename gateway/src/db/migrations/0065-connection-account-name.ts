/**
 * 0065 · 连接上的账号是谁（connector_connections."accountName"）。
 *
 * 「账号名」（label）是人自己起的（personal、work），不说明这一把连的到底是哪个邮箱——
 * 同一个人连了两个 Gmail，界面上只看得见两个自起的名字。这一列存供应商那边认出来的
 * 账号（邮箱、登录名），只拿来显示，不参与鉴权，也不进工具名。
 *
 * null（或空串）= 还不知道是谁：老连接、刚连上、或者上次没认出来。认不出的不记成「问过了」，
 * 进详情页时按节流再问（routes/connectors.ts 的 nameOf）——认人的规则会改进。
 */
export const SQL = `
  alter table connector_connections add column if not exists "accountName" text;
`
