/**
 * 长期记忆：写入判据、归一化、下发形状（见 docs/memory.md）。
 *
 * **判据只有这一份，在 Gateway。** 席位那把工具不自己判上限、不自己算到期时间——
 * 两边各写一套归一化，一定会分叉，而分叉的表现是「席位说存下了、界面上没有」。
 * 落进席位缓存的必须是这里回过去的那条记录（docs/memory.md 不变量 2）。
 *
 * 例外只有一处：PII 的**判据**在席位上（bot/src/policy/pii.ts），这边只存它报上来的
 * 类型，不解释、不复算。同一条规矩 docs/skills.md §9 已经立过。
 */
import type { BotMemory } from './catalog.ts'
import { MEMORY_ITEM_KINDS, type Memory, type MemoryKind } from '../db/types.ts'

/**
 * 单条正文上限。**200 字**，理由是每一条都逐字进系统提示词、而且每一轮都进：
 * 注入上限拉满（50 条）时就是一万 token，已经比一个挂满 Skill 的提示词还大。
 *
 * 席位那边也有一份同名的数（`SATUWORK_MEMORY_TEXT_MAX`），但它只用来**先劝一句**；
 * 真正说了算的是这里，理由见文件头。
 */
export const MEMORY_TEXT_MAX = Math.max(50, Math.trunc(Number(process.env.GATEWAY_BOT_MEMORY_TEXT_MAX) || 200))

/**
 * 存储硬顶 = 注入上限 × 它。
 *
 * `cap` 是**注入**上限（每轮最多摆几条在提示词里），不是存储上限——但存储也得有个顶，
 * 不然一年之后是一张几千行、没人看得懂的表。取两倍：够放下「暂时挤不进注入、但确实
 * 该记着」的那一截，又不至于让 `memory_list` 变成翻页。
 */
export const MEMORY_STORE_FACTOR = Math.max(1, Math.trunc(Number(process.env.GATEWAY_BOT_MEMORY_FACTOR) || 2))

/**
 * 最多钉住几条。
 *
 * **钉住的不占注入上限**（席位那边 `memoryBlock` 把它们全放进去），所以它必须自己有个
 * 顶——否则「注入上限」那根滑杆就成了摆设：钉满六十条，每一轮白多一万多 token，而那
 * 一段还不在压缩判据里（docs/memory.md §12 ①）。
 *
 * 10 条：够钉住几件真的每轮都要遵守的事（怎么称呼、几个硬口径），又不至于把提示词
 * 前缀撑起来。
 */
export const MEMORY_PIN_MAX = Math.max(1, Math.trunc(Number(process.env.GATEWAY_BOT_MEMORY_PIN_MAX) || 10))

/** 这颗 Bot 最多存几条。上限判据只在 Gateway 这一侧，见文件头。 */
export function memoryStoreMax(mem: BotMemory): number {
  return Math.max(1, Math.trunc(mem.cap * MEMORY_STORE_FACTOR))
}

/**
 * 「保留时长」那个下拉 → 毫秒。`永久保留` 和认不出来的都回 null（不过期）。
 *
 * 认不出来按「永久」而不是按最短：一个拼错的配置不该表现成「它每个月都忘一次事」，
 * 那种故障从现象反推不回配置上。
 */
export function memoryTtlMs(ttl: string): number | null {
  const m = /^(\d+)\s*天$/.exec((ttl || '').trim())
  if (!m) return null
  const days = Number(m[1])
  return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : null
}

/**
 * 按**写入当时**的模版算到期时刻。
 *
 * **改模版不追溯已存的条目**：一条 90 天的记忆不会因为管理员今天改成 30 天就当场过期。
 * 同 `escalateTo` 那条——模版是长期配置，追溯改写历史数据会让「上个月它为什么还记得」
 * 变得无从解释。
 */
export function memoryExpiresAt(mem: BotMemory, now = Date.now()): number | null {
  const ms = memoryTtlMs(mem.ttl)
  return ms == null ? null : now + ms
}

/**
 * 正文归一化：折空白、去首尾。**不截断**——超长直接拒（路由那一层）。
 *
 * 截断的坏处是它写的那句话变了意思，而模型以为记下的是原话。
 */
export function memoryText(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
}

/**
 * 判重用的形状：归一化之后再去掉标点和大小写差异。
 *
 * 只挡**完全重复**（同 hermes 那份），不做近似判重：两条差一个字的记忆很可能是
 * 「上一版」和「改过的这一版」，那种该由模型自己 `replace`，不该由我们猜。
 */
export function memoryKey(text: string): string {
  return memoryText(text)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 类别。认不出来一律拒（返回 undefined），不静默换成一个开着的——那会让公司口径静静失效。 */
export function memoryKindOf(v: unknown): MemoryKind | undefined {
  const s = typeof v === 'string' ? v.trim() : ''
  return (MEMORY_ITEM_KINDS as readonly string[]).includes(s) ? (s as MemoryKind) : undefined
}

/**
 * 模版上「记录哪些内容」勾着这一类吗。
 *
 * **「流程」不在 `MEMORY_ITEM_KINDS` 里**，所以它永远不会走到这个判断——那一格管的是
 * 「撞上一段流程时说哪一句话」，不是「流程能不能存进记忆表」（docs/memory.md §6）。
 */
export function memoryKindAllowed(mem: BotMemory, kind: MemoryKind): boolean {
  return mem.kinds.includes(kind)
}

/**
 * 模版上「记忆范围」那三个 pill → **这颗 Bot 真正读得到的层**。
 *
 * 那四个 pill 是**读的上限**：「仅 Bot」= 只有 bot 层，「仅本人」= 再加 self（这个人
 * 所有 Bot 共用的那层），「所属分组」= 再加分组，「全公司」= 四层全读。认不出的字符串
 * 按最窄的算——一个拼错的配置不该表现成「全公司的记忆突然出现在某个人的提示词里」。
 *
 * **席位那边有一份同样的映射**（bot/src/agent/index.ts 的 `memoryBlock`），因为两个包
 * 各自打包、中间没有共享类型——同 `BotMemory` / `BotBrowser` 那两个形状。改一边就要改
 * 另一边，而两边算出来的必须是同一套：这边拿它判「这条算不算已经记过了」，那边拿它决定
 * 「这条进不进提示词」。对不上的表现是模型被告知「已经记过了」，而那条它永远看不见。
 */
export function memoryScopeLayers(scope: string): Set<string> {
  const layers = new Set(['bot'])
  if (scope === '仅本人' || scope === '所属分组' || scope === '全公司') layers.add('self')
  if (scope === '所属分组' || scope === '全公司') layers.add('group')
  if (scope === '全公司') layers.add('company')
  return layers
}

/**
 * 下发给席位的那一份：去掉**「仅 Bot」读不到的 self 那层**。
 *
 * 上面两层照旧下发——它们改不动，但要列得出来（`memory_list` 靠它，docs/memory.md §4）。
 * self 不一样：「仅 Bot」时它不进任何一颗 Bot 的提示词、模型也改不动它，留在缓存里只会
 * 让它看见了却碰不得；而不认「仅 Bot」的老席位会按老口径把它注入提示词。在源头滤掉，
 * 席位那边就不必每条读路径各判一次。
 */
export function memoriesForSeat<T extends { layer: string }>(all: T[], mem: { scope: string }): T[] {
  if (memoryScopeLayers(mem.scope).has('self')) return all
  return all.filter((m) => m.layer !== 'self')
}

/**
 * 下发/回给界面的那一份。
 *
 * `accountId` **不出去**：席位只认得自己那一个账号，界面上要的是「谁写的」而那个
 * 由 `by` 回答。多发一列没人用的归属 id，只是给日志和缓存多一份要跟着对齐的东西。
 */
export function publicMemory(m: Memory) {
  return {
    id: m.id,
    layer: m.layer,
    kind: m.kind,
    text: m.text,
    by: m.by,
    pii: m.pii,
    pinned: m.pinned,
    expiresAt: m.expiresAt,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  }
}

/**
 * 记忆这一截的指纹，进 `catalogStamp`。
 *
 * **不能省。** 少了它，人在界面上删掉一条之后，每分钟那次探针都判「没变」，席位会
 * 一直带着那条记忆去组提示词——而界面上它已经不在了。私有档 Skill 那次踩的就是这个
 * （docs/skills.md §7），这里是同一个洞。
 *
 * 条数同样不能省：只看「最新的那个时间」的话，删掉一条不会让任何时间变小。
 */
export function memoryStamp(list: Memory[]): string {
  const at = list.reduce((n, m) => Math.max(n, m.updatedAt), 0)
  return `${at}:${list.length}`
}
