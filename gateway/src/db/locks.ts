/**
 * `db.lockExclusive` 用的那几个号，全放这一处。
 *
 * 每一处各取一个常数，别复用同一个数：两件不相干的事排在一条队上，是最难查的那种慢。
 * 以前它们散在各个路由文件里，新加一把的人看不见别处已经占了哪些号；放在一起，撞号一眼
 * 就看得出来。**数值一个都别改**——跑着的两个版本（滚动发布那几分钟）得排在同一条队上。
 *
 * 按字符串散列的那几把（公司管理员、账本、结算、部署、渠道对齐）不在这里，见 db.ts 的
 * xactLock：它们的键本身就是名字，撞不上这一组。
 */

/**
 * 「数这个人有几个 Bot、再插一个」那一段。两条建 Bot 的路（POST /runtime/bots 和
 * channels.ts 绑 Telegram 时顺手建的那颗）数的是同一个配额，所以**必须是同一把锁**——
 * 各用各的号，两边就能同时读到「还差一个」一起挤进来。
 */
export const USER_BOT_QUOTA_LOCK = 0x43484e

/**
 * 席位写私有档 Skill / 长期记忆时「查重名、数条数、再插」那一段（第二个键是对象，见
 * db.lockExclusive）。不锁的话并发的两次写都读到「还差一条」「没有同名」，一起插进去。
 */
export const SEAT_SKILL_LOCK = 0x534b4c
export const SEAT_MEMORY_LOCK = 0x4d454d

/** 主 Bot 派活：同一个人、同一对 Bot 的「先查有没有没收场的、再建」排队（见 POST /runtime/tasks）。 */
export const BOT_TASK_PAIR_LOCK = 0x54534b

/**
 * 连接器「可用 Bot」范围的「读出原来的、并上这台看不到的那几颗、再写回」（第二个键是 连接:账号）。
 * 两台电脑同时保存的话，不锁就是后写的那一方把先写那一方刚勾上的本机本地 Bot 冲掉。
 */
export const CONNECTOR_BOT_SCOPE_LOCK = 0x434253

/** 知识库配额：按公司排队数库。 */
export const KB_QUOTA_LOCK = 0x4b4251
/** 知识库容量：按库排队扣字节。 */
export const KB_BYTES_LOCK = 0x4b4242

/** 建系统管理员（首次 setup）。一个随手取的常数，唯一的要求是别和上面这些撞上。 */
export const SETUP_LOCK = 20260831
