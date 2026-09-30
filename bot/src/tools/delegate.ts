import type { Context } from '@deepseek-ai/cordis'
import { blankOutcome, type TaskOutcome, type TaskSpec, type TurnModelRole } from '../agent/index.ts'
import { fail, registerTool } from './common.ts'

/**
 * 委派：把一件事整个交给一个新开的、干净的自己。
 *
 * 全部取舍见 docs/delegation.md。这个文件只做四件事：**收参数、发租约、并发跑、拼结论**。
 * 子代理怎么跑在 agent/index.ts 的 `runTask` 里，工具表怎么算在那边的 `taskTools` 里。
 */
export const name = 'satu-tools-delegate'
export const inject = ['tools', 'agents']

/**
 * 一次最多派几条。
 *
 * v1 的委派是**同步**的（工具真的 await 在那儿），所以「席位级并发上限」是白送的：
 * 一颗席位同时只有一轮在跑，那一轮里只有这一次调用。上限就是这个数组的长度。
 */
const MAX_TASKS = 3

/** 单条子任务的步数上限。见 docs/delegation.md §9：不是主代理那 120 步，尺度不一样。 */
const DEFAULT_MAX_STEPS = 30

/**
 * 墙钟。Hermes 明确不设，我们必须设——主轮真的 await 在这次调用上，人对着一个转圈的
 * 图标。20 分钟比高风险确认的 5 分钟宽，因为那边等的是人，这边等的是机器。
 */
const TIMEOUT_MS = Math.max(
  60_000,
  Math.trunc(Number(process.env.SATUWORK_DELEGATE_TIMEOUT_MS) || 20 * 60_000),
)

interface RawTask {
  goal?: unknown
  context?: unknown
  deliver?: unknown
  tools?: unknown
  model_reason?: unknown
  model_role?: unknown
  max_steps?: unknown
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

function human(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

const STATE_WORD: Record<TaskOutcome['state'], string> = {
  done: 'done',
  capped: 'capped',
  timeout: 'timeout',
  failed: 'failed',
  aborted: 'aborted',
}

/**
 * 回给模型的那一段。
 *
 * **档位必须出现在这段文本里**，不能只留在事件上：模型看不见事件，而它下一步要靠这个
 * 决定要不要把撞顶的那条换成 daily 再派一次（docs/delegation.md §8.6）。
 *
 * `model_reason` **不进**这段——那是主代理自己写的，原样念回去只占上下文。
 */
function render(outcomes: TaskOutcome[]): string {
  const total = outcomes.length
  return outcomes
    .map((o) => {
      const head =
        `[${o.index + 1}/${total} ${STATE_WORD[o.state]} · ${o.model.role} · ${o.steps} 步 · ${human(o.ms)}] ${o.goal}`
      const lines = [head, `  结论：${o.summary.split('\n').join('\n  ')}`]
      if (o.files.length) {
        const shown = o.files.slice(0, 8).map((f) => f.path).join('、')
        lines.push(`  产出：${shown}${o.files.length > 8 ? ` 等 ${o.files.length} 个` : ''}`)
      }
      // 移交过来的东西要点名：主代理下一步很可能就要拿这个 id 去调 process。
      for (const h of o.handedOver) lines.push(`  接手的后台进程：${h.id} · ${h.label}`)
      return lines.join('\n')
    })
    .join('\n\n')
}

/**
 * 一条**根本没跑起来**的子任务。
 *
 * 和「跑了但失败了」分开：后者由 runTask 自己收成终态、有子会话可以点开，这里连子会话
 * 都可能没建出来。原因原样交给模型——它下一步要决定是重派一次还是换个做法。
 */
function crashed(spec: TaskSpec, reason: unknown): TaskOutcome {
  return blankOutcome(spec, 'failed', `没跑起来：${(reason as Error)?.message ?? String(reason)}`)
}

export function apply(ctx: Context) {
  registerTool(
    ctx,
    {
      name: 'delegate_task',
      /**
       * **只读。包装器不叠风险，风险在子代理每一次真调用上判。**
       *
       * 最初这里写的是 `['write', 'external']`，理由是「子代理能干什么它就是什么风险」。
       * 那句话听着稳妥，实际上错得很具体，而且一上线就被两条边界同时打中：
       *
       *  1. **外发闸直接拦死。** `checkExternal` 判的是「这次调用打的是哪个外部系统」，
       *     而 `delegate_task` 根本没有那个东西可判——它落到函数最后那句兜底上，回一句
       *     「会访问外部系统，而它不在已授权的名单里」。开着 no-external 的 Bot 因此
       *     **一次都派不出去**，而拒绝话术还把人引去模版里加授权，那儿根本没有它
       *  2. **每一次委派都弹一张确认卡。** `needsApproval` 的规则是 external + write，
       *     于是「读一遍日志找原因」这种纯只读的委派也要人点一下头
       *
       * 而它自己**不出席位**：开一条会话、在本机跑一个循环，没有任何东西发出去。真正
       * 会发出去的是子代理的那些调用，而它们**每一次都单独过同一条管道**——子会话的
       * `botOf` 拿到的是同一颗 Bot、同一套开关，外发闸、PII 闸、审批、浏览器闸一条不少
       * （e2e-guards 的 delegation 那一组钉的就是这个）。叠在包装器上不是多一层保护，
       * 是把同一件事算两遍，而算错的那一遍拦的是所有人。
       *
       * 这正是 tools/index.ts 开头那句话的另一面：决策要在**做出它的那个操作**里强制
       * 执行。子代理要发一封邮件，该拦的是那次发信，不是「它被派出去了」这件事。
       */
      risk: ['read'],
      /**
       * 深度定死 1：子代理拿不到这把工具。
       *
       * **靠 schema 不给是不够的**——模型硬报一个没在表里的名字照样调得通，真正的拒绝
       * 来自 policy 的 pre-execute 短路，判据就是这处标注（见 docs/delegation.md §6.1）。
       */
      delegation: { mode: 'root-only' },
      description:
        '把一件事整个交给一个新开的、干净的子代理去做，它跑完只交回一段结论。最多同时派 ' +
        `${MAX_TASKS} 条，它们并行跑。\n` +
        '**什么时候用**：过程比结论长十倍（翻一堆日志/文件找一个答案）；几件互不相干的事可以同时做；' +
        '需要一份干净的上下文去评审你自己刚做的东西。\n' +
        '**什么时候别用**：一步就能做完的；需要跟人来回确认的（子代理问不了人）；要连续操作浏览器的。\n' +
        '**context 必须自足**：子代理看不到这场对话。一句「修一下那个错」它完全不知道「那个」是什么——' +
        '把文件路径、报错原文、已经试过什么、什么算做完全写进去。\n' +
        '**有依赖的不要放进同一批**：一批是并行跑的，「对着前两条的结果做判断」是下一次委派。\n' +
        '**先写 model_reason 再写 model_role**：\n' +
        '  两问都是「是」才给 utility——① 做法是不是已经定死了？② 做错了，看结论能看出来吗？\n' +
        '  拿不准给 daily。写了 utility 却没给 model_reason 的，会被降成 daily。',
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: `要派出去的子任务，1 到 ${MAX_TASKS} 条。单条也要写成一个元素的数组。`,
            items: {
              type: 'object',
              properties: {
                goal: { type: 'string', description: '一句祈使句：要它做成什么。不是话题，是完成判据。' },
                context: {
                  type: 'string',
                  description: '它需要知道的全部：文件路径、报错原文、已经试过什么、什么算做完。它看不见这段对话。',
                },
                deliver: { type: 'string', description: '结论里必须包含什么。可选。' },
                tools: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '只准它用这几把工具（工具名）。可选，不给就继承你现在这张表。浏览器、席位桌面这两组一批里各只有一条拿得到，想给谁就在谁这里点名。',
                },
                model_reason: {
                  type: 'string',
                  description: '一句话：为什么这一条配这一档模型。先写它，再写 model_role。',
                },
                model_role: {
                  type: 'string',
                  enum: ['daily', 'utility'],
                  description: 'daily = 跟你同一个模型；utility = 便宜的小模型，只给机械活。',
                },
                max_steps: { type: 'number', description: `最多连跑多少步。默认 ${DEFAULT_MAX_STEPS}。` },
              },
              required: ['goal', 'context', 'model_reason', 'model_role'],
            },
          },
        },
        required: ['tasks'],
      },
    },
    async ({ tasks }: { tasks?: unknown }, call) => {
      const agents = ctx.agents
      /**
       * 换版静默期里**不开新的子代理**。
       *
       * 已经在跑的那一批照旧——它们属于正在跑的这一轮，由排空去等（子会话进了 live，
       * `busy().running` 自动把它们算进去）。
       */
      if (agents.quiesced()) fail('席位正在换新版本，这几秒不派新的子任务；等它起来再试一次')

      if (!Array.isArray(tasks) || !tasks.length) fail('tasks 要是一个非空数组，每个元素是一条子任务。')
      if (tasks.length > MAX_TASKS) {
        fail(`一次最多派 ${MAX_TASKS} 条，这次给了 ${tasks.length} 条。拆成两次，或者把相近的合并成一条。`)
      }

      const specs: TaskSpec[] = (tasks as RawTask[]).map((raw, index) => {
        const goal = str(raw.goal)
        const context = str(raw.context)
        if (!goal) fail(`第 ${index + 1} 条没有 goal。`)
        if (!context) fail(`第 ${index + 1} 条没有 context。子代理看不见这场对话，不写它就等于让它猜。`)

        /**
         * 档位的三种情况分开处理（docs/delegation.md §8.3、§8.5）：
         *
         *  - 没写 → `daily`，记一行日志。为一个能安全默认的字段把整次委派打回去，换来的是
         *    模型重试一次、上下文里多一段垃圾，而默认的那一档本来就是安全的那一档
         *  - 写错 → **整次委派不发生**。当默认值处理的话，界面、日志、账单上全都显示按
         *    daily 跑，而模型以为自己省了钱——这类「回 200 但没照做」正是要防的
         *  - 写了 utility 却没给理由 → **降成 daily**。理由是 utility 的入场券：选了便宜档
         *    却说不出为什么，就不给便宜档
         */
        const rawRole = raw.model_role === undefined || raw.model_role === null ? '' : String(raw.model_role)
        if (rawRole && rawRole !== 'daily' && rawRole !== 'utility') {
          fail(`第 ${index + 1} 条的 model_role 是「${rawRole}」，只能是 daily 或 utility。整次委派没有发生，改完重调一次。`)
        }
        let role: TurnModelRole = (rawRole || 'daily') as TurnModelRole
        if (!rawRole) ctx.logger?.info?.(`delegate: 第 ${index + 1} 条没写 model_role，按 daily 跑`)
        const reason = str(raw.model_reason)
        let downgraded = false
        if (role === 'utility' && !reason) {
          role = 'daily'
          downgraded = true
          ctx.logger?.info?.(`delegate: 第 ${index + 1} 条选了 utility 但没给理由，降成 daily`)
        }

        /**
         * `tools` 收窄。**名字要校验**——不校验的话，一个认不出的名字会把工具表过滤成空
         * 的，而子代理拿着一张空表只能干说，最后交回一段「我什么都做不了」，中间没有任何
         * 一处提到问题出在工具名上。
         *
         * 最容易撞上的正是**旧名字**：`read` / `grep` / `bash` 那一套刚改过（见 tools/index.ts
         * 的 RENAMED），而模型自己的历史里还全是它们。
         *
         * 判据是「这台席位上有没有这把工具」，不是「子代理拿不拿得到」：root-only 和没租到
         * 的独占资源由 taskTools 去筛，那是另一件事，混在一起会让错误话术指错方向。
         */
        const picked = Array.isArray(raw.tools)
          ? (raw.tools as unknown[]).map((t) => String(t).trim()).filter(Boolean)
          : undefined
        const unknown = picked?.filter((n) => !ctx.tools.has(n)) ?? []
        if (unknown.length) {
          fail(
            `第 ${index + 1} 条的 tools 里有认不出的工具名：${unknown.join('、')}。` +
              '整次委派没有发生——按你现在这张表里的名字写，或者干脆不给 tools（那就继承你现在的全部工具）。',
          )
        }
        const maxSteps = Math.max(
          1,
          Math.min(agents.maxSteps, Math.trunc(Number(raw.max_steps) || DEFAULT_MAX_STEPS)),
        )
        return {
          index,
          goal,
          context,
          deliver: str(raw.deliver) || undefined,
          tools: picked?.length ? picked : undefined,
          modelRole: role,
          modelReason: reason || undefined,
          downgraded,
          maxSteps,
          leases: [],
          timeoutMs: TIMEOUT_MS,
        }
      })

      /**
       * 独占资源的租约（今天是浏览器和席位桌面）。
       *
       * **按资源名发，不按 `browser_` 前缀判**：将来席位上再多一样只能有一个主人的东西，
       * 它写上自己的资源名就自动落进这套租约，这里一行都不用改（docs/delegation.md §7.1）。
       *
       * 谁拿到：在 `tools` 里点名了那把工具的第一条；一个都没点名就给第 0 条。
       */
      const resources = new Set(
        ctx.tools.schemas().map((t) => ctx.tools.delegationOf(t.name).exclusive).filter((r): r is string => !!r),
      )
      for (const res of resources) {
        const named = specs.find((sp) =>
          sp.tools?.some((n) => ctx.tools.delegationOf(n).exclusive === res),
        )
        ;(named ?? specs[0]).leases.push(res)
      }

      /**
       * **allSettled，不是 all。**
       *
       * `runTask` 自己吃掉子代理的失败（模型报错、撞顶、超时都收成一个终态），所以它抛
       * 出来只剩一种来路：建会话 / 写事件那几跳真的 I/O 失败。用 `all` 的话，那一条会
       * 让整批 reject——另外两条**已经跑完、已经花过钱**的结论就此丢掉，模型什么都拿不到，
       * 而它们的 `agent/task` 事件还好好地摆在界面上。人看得见、模型看不见，是最难查的
       * 一种不一致。
       */
      const settled = await Promise.allSettled(
        specs.map((spec) => agents.runTask(call.sessionId, call.callId, spec, call.signal)),
      )
      const outcomes = settled.map((r, i) => (r.status === 'fulfilled' ? r.value : crashed(specs[i], r.reason)))
      for (const [i, r] of settled.entries()) {
        if (r.status === 'rejected') {
          ctx.logger?.warn?.(`delegate: 第 ${i + 1} 条没跑起来：${(r.reason as Error)?.message ?? r.reason}`)
        }
      }
      // 已经是 index 序（specs 就是按序建的），显式再排一次：**结果按 index，不按谁先跑完**。
      outcomes.sort((a, b) => a.index - b.index)
      return { text: render(outcomes), files: outcomes.flatMap((o) => o.files) }
    },
  )
}
