/**
 * 0049 · 摘掉旧「升级管家」按钮留下的单机钉，让这些机器回到跟平台走。
 *
 * 那颗按钮不带版本时也是钉：把**按下那一刻的最新版**写进 `machines."desiredManagerVersion"`。
 * 点过一次的机器从此停在那一版，之后发的新版都轮不到它（见 lib/machines.ts 的
 * retargetManager）。按钮改掉之后，已经钉上的不会自己解开。
 *
 * **一律清，不挑。** 到这一版为止，界面上没有任何地方能带着版本号去钉一台机器——单机钉的
 * 唯一来源就是那颗按钮，钉的都是「当时的最新」，没有一条是有人想把机器留在旧版本上。
 * 清掉之后它们跟平台走：平台钉了就是平台那一版，没钉就是这个架构的最新，下一轮心跳自己换。
 * 要单机灰度的，之后在机器详情页按版本重新钉。
 *
 * 这是一次数据改写，放在迁移里是为了每个库只跑一次、跟着这一版一起上；新库一行都不会命中。
 */
export const SQL = `
  update machines set "desiredManagerVersion" = null where "desiredManagerVersion" is not null;
`
