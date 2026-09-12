/**
 * 两份 e2e 同时在跑的时候，别互相拆台。
 *
 * 这个仓库里「两个 worktree、两个会话各跑一遍 e2e」是常态，而套件里那些共享资源的
 * 名字全是写死的：PostgreSQL 的 schema（`e2e_manager`…）、`/tmp` 下的数据目录
 * （`/tmp/satuwork-e2e-manager-gw`…）。两边都在起手处把自己那份**清掉重建**，于是
 * 后开跑的那个进程一句 `drop schema cascade` / `rmSync` 就把前一个正在跑的端了。
 *
 * 坏在这上头的现象一律指不回真正的原因：
 *
 * - schema 被清 → 表在重建窗口里查不到（`relation ... does not exist`）、账号 id
 *   全换了新的（401「账号不存在」），而日志里没有任何一句提到有人清过库；
 * - 数据目录被删 → `ENOENT: jwt-private.pem` / `manager.json`，看着像本机环境坏了。
 *
 * 所以名字统一带上一个后缀，**按 checkout 路径散列**：
 *
 * - 两个 worktree 天然分开，谁也碰不到谁；
 * - 同一个 worktree 反复跑还是同一批名字，库里和 /tmp 下不会越攒越多。
 *
 * **后缀按 checkout 路径散列、而不是按这一次运行散列，是有意的**：按运行散列的话每跑
 * 一遍就在库里和 /tmp 下各留一份，没有人会回头清。代价是下面这条。
 *
 * ## 同一个 worktree 同时跑两份 e2e：别这么干，而且它自己报不清楚
 *
 * 这里原先写着「由 Gateway 那侧的认领锁当场报出来（gateway/src/db.ts 的 claimSchema），
 * 而不是把数据抹掉」。**那句话只对了一半，实测栽过一次。** 认领锁确实拦得住库那半边，
 * 可它要等 Gateway 起来才生效，而各套用例是**先 rmSync 自己的 /tmp 数据目录、再起
 * Gateway**（e2e/manager.mjs 就是 rmSync 在前、start 在后）。于是真实的次序是：
 *
 *   后开跑的那个 → rmSync 把**前一个正在跑**的数据目录删了 → 前一个当场炸
 *                → 它才轮到去认领 schema，这时才撞上锁
 *
 * 先炸的是前一个，炸法是 `ENOENT: jwt-private.pem` / `ENOENT: manager.json`
 * ——一串指不回真正原因的失败（管家套件里一次见了 5 条），看着像本机环境坏了。
 * 后开跑的那个拿到的 SchemaBusyError 反倒说得清，但没人会把两边联系起来。
 *
 * 所以：**一个 worktree 同一时刻只跑一份 `pnpm e2e`。** 要并行就开第二个 worktree，
 * 那是这个后缀本来就管好了的情形。哪天想把这条从「说明」变成「拦得住」，位置在
 * e2e/run.mjs 起手处加一把按 SUFFIX 的运行锁（带 PID 存活判断，好让硬杀之后的残留锁
 * 不至于把人挡在门外），要赶在任何一套 rmSync 之前。
 */
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SUFFIX = createHash('sha256')
  .update(resolve(dirname(dirname(fileURLToPath(import.meta.url)))))
  .digest('hex')
  .slice(0, 8)

/**
 * 套件的 schema 名。**所有写死的 `e2e_xxx` 都要从这里过一遍**——漏一处，那一套的
 * Gateway 和它的探针客户端就会看着两个不同的 schema，症状是「表在库里，代码说没有」。
 */
export function schemaOf(name) {
  return `${name}_${SUFFIX}`
}

/** 套件在 /tmp 下的目录。同理，写死的 `/tmp/satuwork-e2e-xxx` 都要从这里过。 */
export function tmpOf(name) {
  return `/tmp/${name}-${SUFFIX}`
}
