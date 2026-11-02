import type { Context } from '@deepseek-ai/cordis'
import { cachedMemories, type CachedMemory } from '../catalog/index.ts'
import { pinnedBotId } from '../env.ts'
import { memoryOf } from '../registry/index.ts'
import { scanPii } from '../policy/pii.ts'
import { fail, registerTool, runtimeGateway } from './common.ts'

/**
 * 长期记忆：`memory_write` / `memory_list`（见 docs/memory.md）。
 *
 * **记的是事实，不是方法。** 一句话说得完的进这里，有步骤有分支的进 Skill
 * （`skill_manage`）。判据是"要不要展开"——一段流程值得单独打开来读，一句事实展开了
 * 还是它自己，为它跑一次 `skill_view` 是纯往返（docs/memory.md §1）。
 *
 * **唯一一份在 Gateway。** 席位这边是缓存：读走缓存（每一轮装配提示词都要读，不能打
 * 网络），写要等 Gateway 回话，落进缓存的必须是它回来的那一份——判重怎么判、到期时间
 * 落成什么，全是那边说了算。两边各写一套归一化，一定会分叉。
 *
 * **写失败就说失败**，不落队列重试。这一条和转人工那边相反（那边"必须能重试"）：一张
 * 没报上去的交接单丢了没人知道，而一条没写成的记忆，模型会在回答里说"记住了"——
 * 假装记住比没记住坏得多。
 */
export const name = 'satu-tools-memory'
export const inject = ['tools', 'storage', 'catalog', 'sessions', 'roster']

/**
 * 单条正文的上限，席位这一份只用来**先劝一句**。
 *
 * 真正说了算的是 Gateway（`GATEWAY_BOT_MEMORY_TEXT_MAX`）：两边各写一份判据，迟早
 * 一边说存下了、另一边说太长。这边留一道是为了省一次往返，数字对不上时以那边为准。
 */
const TEXT_MAX = Math.max(50, Math.trunc(Number(process.env.SATUWORK_MEMORY_TEXT_MAX) || 200))

/** `memory_list` 一次最多列几条。记忆总量本来就有硬顶，这道闸只防它把上下文冲掉。 */
const LIST_MAX = 100

/**
 * 打 Gateway 的 runtime 面。
 *
 * 连不上是**管道故障**（模型改什么都没用），4xx 里那句话是**业务失败**——它是 Gateway
 * 判出来的、能照着改的东西（写满了、类别没开、改不动别人的），原话直接给模型看。
 * 两者混成一种，模型要么白重试、要么把一次可修复的拒绝当成系统坏了。（口径在 common.ts 的 runtimeGateway）
 */
const callGateway = runtimeGateway('这台机器没有配 Gateway，记忆这条路走不通。')

/** 这条记忆是模型自己写得动的那两层吗。上面两层读得到、改不动。 */
export function ownLayer(m: CachedMemory): boolean {
  return m.layer === 'bot' || m.layer === 'self'
}

/** 到期了吗。**到期只是不再注入，条目还在**——所以列表里照样看得见，标一句「已过期」。 */
export function expired(m: CachedMemory, now = Date.now()): boolean {
  return !m.pinned && m.expiresAt != null && m.expiresAt <= now
}

/**
 * 看起来是一段**流程**吗。
 *
 * **只认结构，不猜语义**：换行两处以上、或者出现编号列表。同 docs/memory.md §11 那条
 * 「不做启发式的语义扫描」——「先 A 再 B」和「他习惯先看 A 再看 B」在字面上分不开，
 * 而这道闸只要误伤过一次，模型学到的就是「记忆这把工具不好使」。
 *
 * 判据要在**折空白之前**跑：正文归一化会把换行折掉，折完再判就什么都判不出来了。
 */
export function looksProcedural(raw: string): boolean {
  const text = String(raw ?? '')
  if ((text.match(/\n/g) ?? []).length >= 2) return true
  return /^\s*(?:\d+[.、)]|[-*]\s|第[一二三四五六七八九十]+步)/m.test(text)
}

/** 子串匹配的候选。**只在模型自己那两层里找**——上面两层它改不动，匹配上只会更费解。 */
export function matchMemories(list: CachedMemory[], needle: string): CachedMemory[] {
  const q = needle.trim().toLowerCase()
  if (!q) return []
  return list.filter((m) => ownLayer(m) && m.text.toLowerCase().includes(q))
}

const LAYER_LABEL: Record<CachedMemory['layer'], string> = {
  bot: '这颗 Bot',
  self: '你的主人',
  group: '分组',
  company: '全公司',
}

function line(m: CachedMemory, now: number): string {
  const tags = [
    `[${m.kind}]`,
    ownLayer(m) ? '' : `（${LAYER_LABEL[m.layer]}，管理员设的，改不了）`,
    m.pinned ? '（钉住）' : '',
    expired(m, now) ? '（已过期，不再进上下文）' : '',
  ]
    .filter(Boolean)
    .join('')
  return `- ${tags} ${m.text}`
}

export function apply(ctx: Context) {
  const tool = (
    def: Parameters<typeof registerTool>[1],
    execute: Parameters<typeof registerTool>[2],
  ) => registerTool(ctx, def, execute)

  /** 这颗席位钉的那颗 Bot 的记忆策略。取不到就按出厂默认（memoryOf 的口径）。 */
  const policy = () => memoryOf(ctx.roster.get(pinnedBotId()))

  /**
   * 会话里那张卡（`memory/saved`）。
   *
   * 员工唯一一次**在事情发生的当下**看见 Bot 记了什么的机会——记忆每一轮都在影响它的
   * 回答，事后去设置页翻等于没有。落不进去也不影响这次写入：那条记忆已经在 Gateway
   * 上了，少的只是一张卡（同 skill/saved）。
   *
   * **开了「写入前需用户确认」时，add / replace 不出这张卡**：审批卡刚刚才摆在那儿、
   * 人亲手点的批准，紧接着再来一张"已保存"是同一件事说两遍（docs/memory.md §9）。
   *
   * **但 remove 永远出。** 那道确认闸只拦 add / replace（副文案写的是「提议**记住**某条
   * 信息时先征求同意」），所以删一条既不弹卡片、也没人点过头——这张卡是人唯一能看见
   * 「它刚忘掉了什么」的地方。按 confirm 一刀切掉的话，开着确认的 Bot 反而是**删得最
   * 无声无息**的那种，而那正好是最该被看见的一种改动。
   */
  const noteCard = async (
    call: { callId: string; sessionId: string },
    action: 'add' | 'replace' | 'remove',
    id: string,
    text: string,
    out: { used?: number; max?: number },
  ) => {
    if (action !== 'remove' && policy().confirm) return
    try {
      await ctx.sessions.append(call.sessionId, 'memory/saved', {
        callId: call.callId,
        id,
        text,
        action,
        ...(typeof out.used === 'number' ? { used: out.used } : {}),
        ...(typeof out.max === 'number' ? { max: out.max } : {}),
      })
    } catch {
      // 卡片落不进去不影响这次写入，见上。
    }
  }

  // ── memory_list ──────────────────────────────────────────────────────

  tool(
    {
      name: 'memory_list',
      /** 读是安全的，子代理照常有：它恰恰需要知道"这个人的报表放哪儿"。 */
      delegation: {},
      risk: ['read'],
      description:
        '列出你记下的全部事实，包括**这一轮没能摆进上下文的那些**（注入有条数上限，存的可能比摆出来的多）。' +
        '在记一条新的之前用它核对有没有记过；用户问「你都记得我什么」时也用它。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: '只看某一类：偏好 / 事实 / 联系人。' },
          query: { type: 'string', description: '只看正文里带这几个字的。普通子串，不是正则。' },
        },
      },
    },
    ({ kind, query }: { kind?: string; query?: string }) => {
      const now = Date.now()
      const q = (query ?? '').trim().toLowerCase()
      const k = (kind ?? '').trim()
      const all = cachedMemories(ctx)
        .filter((m) => (!k || m.kind === k) && (!q || m.text.toLowerCase().includes(q)))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
      if (!all.length) {
        return k || q ? '没有符合的记忆。不带参数再列一次可以看全部。' : '还没有记下任何事实。'
      }
      const shown = all.slice(0, LIST_MAX)
      const more = all.length > shown.length ? `\n…还有 ${all.length - shown.length} 条没列出来。` : ''
      const mine = all.filter(ownLayer).length
      return (
        `记下的事实（共 ${all.length} 条，其中你自己记的 ${mine} 条）：\n` +
        shown.map((m) => line(m, now)).join('\n') +
        more
      )
    },
  )

  // ── memory_write ─────────────────────────────────────────────────────

  tool(
    {
      name: 'memory_write',
      /**
       * **只有主代理有它。** 子代理跑完就没了、也没有人在看它，而一次委派开出五个
       * 子代理、每个都觉得自己学到了点什么，就是五条谁都没审过的记忆。子代理要留下
       * 事实，把它写进交回来的结论里，由主代理决定记不记——决定权跟着那条和人对着的
       * 会话走（docs/memory.md §4）。
       */
      delegation: { mode: 'root-only' },
      /**
       * **不带 `external` 位。** 那一位的意思是「出这台席位，打别人家的系统」，而
       * Gateway 是我们自己的控制面；标上它，`no-external` 那道闸一打开，Bot 连自己的
       * 记忆都写不进去（同 skill_manage，docs/skills.md §9）。
       *
       * 代价：`outboundOf` 那道 PII 闸认的也是 `external`，所以策略层不会替记忆挡敏感
       * 信息——那一道由这把工具自己扫（见下面 add / replace 里的 scanPii）。
       */
      risk: ['write'],
      description:
        '记下一句跨对话有效的**事实**，或者改掉、删掉一条已经记下的。' +
        '用户说「以后都…」「记住…」「别再叫我…」，或者你发现一个每次都要用到的口径时调它。\n' +
        '记的是一句话说得完的事实：称呼、偏好、某样东西在哪儿、某个人是谁。' +
        '**一段有步骤的流程不要往这儿塞**——那个用 skill_manage。' +
        '能靠 history_search 翻出来的具体对话也不要记，那是历史，不是事实。\n' +
        '你只能写自己这两层（bot / self）；分组和全公司那两层是管理员设的，你读得到、改不了。',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add', 'replace', 'remove'], description: '记一条、改一条、删一条。' },
          text: { type: 'string', description: `add / replace 的正文，一句话，最多 ${TEXT_MAX} 字。` },
          match: {
            type: 'string',
            description: 'replace / remove 用：要动的那条里**一小段独一无二的字**，不用抄全文。匹配到多条会让你重挑。',
          },
          kind: { type: 'string', enum: ['偏好', '事实', '联系人'], description: '哪一类。' },
          layer: {
            type: 'string',
            enum: ['bot', 'self'],
            description: 'bot = 只有这颗 Bot 用得上（默认）；self = 这个人所有的 Bot 都用得上（称呼、习惯这种）。',
          },
        },
        required: ['op'],
      },
    },
    async (
      { op, text, match, kind, layer }: { op?: string; text?: string; match?: string; kind?: string; layer?: string },
      call,
    ) => {
      if (!pinnedBotId()) fail('这台席位没钉 Bot（缺 SATUWORK_BOT_ID），写不了记忆。')
      const mem = policy()
      const q = `?botId=${encodeURIComponent(pinnedBotId())}`
      const all = cachedMemories(ctx)

      /** replace / remove 都要先认出是哪一条。**匹配到多条不许猜**，摆出来让它自己挑。 */
      const pick = (): CachedMemory => {
        const needle = (match ?? '').trim()
        if (!needle) fail('缺少 match：要动哪一条？写那条里一小段独特的字就行。')
        const hits = matchMemories(all, needle)
        if (!hits.length) {
          /**
           * **匹配到的是上面两层时，要说清「改不了」，不能回「没有这条」。**
           *
           * 模型看得见它就在自己的记忆里（那两层照常注入，也照常出现在 memory_list
           * 里），一句「不存在」只会让它换个说法再试一次，然后再被拒一次
           * ——两三轮之后它会告诉用户「我这边好像出问题了」（docs/memory.md §4）。
           */
          const upper = all.filter((m) => !ownLayer(m) && m.text.toLowerCase().includes(needle.toLowerCase()))
          if (upper.length) {
            fail(
              `「${upper[0].text}」是${LAYER_LABEL[upper[0].layer]}那一层的，管理员设的，我改不了。` +
                '要改得请用户去 Bot 设置里改。你自己那两层里没有带这几个字的。',
            )
          }
          const near = all.filter(ownLayer).slice(0, 5)
          fail(
            `没有哪条记忆里带「${needle}」。` +
              (near.length ? `你自己记的是这些：\n${near.map((m) => `- ${m.text}`).join('\n')}` : '你还没记下任何事实。'),
          )
        }
        if (hits.length > 1) {
          fail(
            `「${needle}」匹配到 ${hits.length} 条，说不准是哪一条：\n` +
              hits.map((m) => `- ${m.text}`).join('\n') +
              '\n换一段更具体的字再来一次。',
          )
        }
        return hits[0]
      }

      /** add / replace 共用的正文闸：流程 → 指路，超长 → 拒，PII → 拒。 */
      const bodyOf = (): string => {
        const raw = String(text ?? '')
        if (!raw.trim()) fail('缺少 text：要记下什么？')
        /**
         * 一段流程不往记忆里塞。**拒绝语分两种**，因为 `skill_manage` 未必在工具表里
         * ——模版上「让它自己记 Skill」关着时，把它推去用一把没有的工具，正是条件加载
         * 那条原则要防的事（docs/memory.md §6）。
         */
        if (looksProcedural(raw)) {
          const bot = ctx.roster.get(pinnedBotId())
          const canSkill = bot?.selfSkills !== false && ctx.tools.has('skill_manage')
          if (!mem.kinds.includes('流程')) {
            fail('这个 Bot 不记流程。记忆放的是一句话说得完的事实，把结论挑一句出来再记。')
          }
          fail(
            canSkill
              ? '这看着是一段流程（有换行或分步）。流程用 skill_manage 记成 Skill，那儿放得下步骤、也能按需展开；记忆放的是一句话说得完的事实。'
              : '这看着是一段流程，记忆放不下——它每一轮都进上下文，所以只放一句话说得完的事实。挑一句结论出来记，或者让用户在 Bot 设置里打开「让它自己记 Skill」。',
          )
        }
        const flat = raw.replace(/\s+/g, ' ').trim()
        if (flat.length > TEXT_MAX) {
          fail(`这条太长（${flat.length} 字，上限 ${TEXT_MAX}）。拆成几条，或者它其实是一段流程——那用 skill_manage。`)
        }
        /**
         * **敏感信息的拒绝不在这儿，在 policy 那道闸上**（policy/index.ts 的
         * `memory_write` 那一段）。
         *
         * 摆在这里是错的位置：确认卡在 `tools/pre-execute` 里弹，比工具执行早——人会
         * 先读完卡片、点了批准，然后才收到一句「这条里有手机号，没记」。那次点击白花了。
         * policy 那一侧同一条规矩写着「一次注定要被拦的调用，不该先把人叫来点一次头」。
         *
         * 这边照旧扫一遍，但那一次是**报给 Gateway 存档**用的（只存不判，界面拿它标红），
         * 见下面 add / replace 里的 `pii: scanPii(body)`。
         */
        return flat
      }

      if (op === 'add') {
        const body = bodyOf()
        const out = await callGateway<{ memory: CachedMemory; used: number; max: number }>('POST', `/runtime/memories${q}`, {
          text: body,
          kind: (kind ?? '事实').trim(),
          layer: (layer ?? 'bot').trim(),
          sessionId: call.sessionId,
          // 席位扫出来的类型随写入一起发上去，Gateway **只存不判**：判据那一份在这边
          // （policy/pii.ts），抄第二份就会分叉。界面拿它标红给管理员看。
          pii: scanPii(body),
        })
        ctx.catalog.noteMemory(out.memory)
        void ctx.catalog.pull().catch(() => {})
        await noteCard(call, 'add', out.memory.id, out.memory.text, out)
        /**
         * **必须说「下一轮才生效」。**
         *
         * 这一轮的系统提示词在 runTurn 开头就定死了，新记的这条不在里面。不说这一句，
         * 模型会当场去提示词里找、发现没有，然后转头告诉用户「好像没记住」——一次成功
         * 的写入被它自己描述成失败（docs/memory.md §4）。
         */
        return (
          `已记下：「${out.memory.text}」（你自己记的第 ${out.used} 条，上限 ${out.max}）。\n` +
          '它从**下一轮**开始出现在你的记忆里，这一轮你手上就是刚写的这句。\n' +
          '跟用户说一句你记住了。'
        )
      }

      if (op === 'replace') {
        const cur = pick()
        const body = bodyOf()
        const out = await callGateway<{ memory: CachedMemory; used: number; max: number }>(
          'PATCH',
          `/runtime/memories/${encodeURIComponent(cur.id)}${q}`,
          {
            text: body,
            ...(kind ? { kind: String(kind).trim() } : {}),
            pii: scanPii(body),
          },
        )
        ctx.catalog.noteMemory(out.memory)
        void ctx.catalog.pull().catch(() => {})
        await noteCard(call, 'replace', out.memory.id, out.memory.text, out)
        return `已改成：「${out.memory.text}」（原来是「${cur.text}」）。下一轮起用新的这句。`
      }

      if (op === 'remove') {
        const cur = pick()
        const out = await callGateway<{ used: number; max: number }>(
          'DELETE',
          `/runtime/memories/${encodeURIComponent(cur.id)}${q}`,
        )
        ctx.catalog.dropMemory(cur.id)
        void ctx.catalog.pull().catch(() => {})
        await noteCard(call, 'remove', cur.id, cur.text, out)
        return `已删掉：「${cur.text}」。你自己记的还剩 ${out.used} 条（上限 ${out.max}）。下一轮起它不再出现。`
      }

      fail('op 只能是 add / replace / remove。')
    },
  )
}
