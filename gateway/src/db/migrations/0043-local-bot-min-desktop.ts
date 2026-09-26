/**
 * 0043 · 桌面端本地 Bot 包各自登记「最低 Desktop 版本」。
 *
 * 原来这个值在 `/runtime/local-bot-release` 里写死成 `0.1.0`：Desktop 那头早就会比对，
 * 可 Gateway 永远说「谁都能装」。哪天一版运行时用上了新壳才有的东西，老 Desktop 照样
 * 下载、切换，然后本地 Bot 起不来——而那时能说清原因的那一行根本没被用上。
 *
 * 只有 local-bot 这一种有意义：bot / manager 跑在席位机器上，跟 Desktop 无关，留空。
 * 已经登记的 local-bot 包补成 `0.1.0`——它们登记时对外说的就是这个值，补上之后行为不变。
 */
export const SQL = `
  alter table bot_releases add column if not exists "minDesktopVersion" text;
  update bot_releases set "minDesktopVersion" = '0.1.0' where kind = 'local-bot' and "minDesktopVersion" is null;
`
