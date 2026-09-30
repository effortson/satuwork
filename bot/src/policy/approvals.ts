import type { Context } from '@deepseek-ai/cordis'
import { agentsOf, type ToolCall } from '../tools/index.ts'
import { applyEdits, unwrapCall, type ApprovalForm } from './forms.ts'
import { SHELL_TOOLS } from './shell.ts'

/** 一条还等着人拍板的调用。刷新页面之后界面靠它把卡片摆回来。 */
export interface PendingApproval {
  sessionId: string
  callId: string
  name: string
  arguments: string
  reason: string
  /** 这次要用哪张卡、卡上有哪几格（见 forms.ts）。界面照着它画。 */
  form: ApprovalForm
  createdAt: number
  expiresAt: number
}

export type Verdict = 'approved' | 'denied' | 'timeout' | 'aborted'

/**
 * 拦停名单里的键：剥掉 `*_sw_run` 这层壳之后的真实工具名。
 * 没套壳时就是工具名本身，所以非壳工具的行为和以前完全一样。
 */
function blockKey(call: { name: string; arguments: string }): string {
  return unwrapCall(call).tool
}

/**
 * 风险写在**参数**里、不写在工具名上的那几把。
 *
 * 眼下只有 `terminal`：它弹卡的理由是「这条命令」会毁东西（policy/shell.ts 的
 * destructiveCommand），同一把工具的下一条命令毁的可能是完全不同的东西。MCP 工具的风险
 * 是按工具标的（发信那把每次都是发信），按工具名放行正是那颗按钮的本意。浏览器那几把
 * 虽然也按参数判，但它们的卡片本来就指望「这一轮都批准」来消化（见 browser.ts 的
 * submitAction），不收进来。
 */
const ARGUMENT_RISK = SHELL_TOOLS

/**
 * 放行名单里的键。
 *
 * 大多数工具就是剥壳后的工具名。`terminal` 要连**命令本身和工作目录**一起记：只按
 * 工具名记的话，人对 `rm -f build.log` 点的「这一轮都批准」会放行这一轮后面每一条要
 * 确认的命令——递归删工作区、强推、网页内容里被塞进来的那几条，一张卡片都不弹，而
 * 一轮能走一百多步。收成「同一条命令」：重试、原样再跑一次不用再问，换了目标就重新问。
 * 空白压成一个，免得多一个空格就要再点一次。
 *
 * 拦停那一侧照旧按工具名（blockKey）：挡得宽是安全的那一侧。
 */
function grantKey(call: { name: string; arguments: string }): string {
  const { tool, args } = unwrapCall(call)
  if (!ARGUMENT_RISK.has(tool)) return tool
  const command = String(args.command ?? '').trim().replace(/\s+/g, ' ')
  const workdir = String(args.workdir ?? '').trim()
  return `${tool} ${JSON.stringify([command, workdir])}`
}

/**
 * 一次确认的结果。
 *
 * 光有 verdict 不够：**「谁批的、按哪种范围批的」得能从日志重建**，而
 * 「这次对话都批准」之后的调用连卡片都不会出现——不带出 `viaGrant`，事后看到的
 * 就是一串没有来由的 approved。
 */
export interface Decision {
  verdict: Verdict
  /** 人点的是「这一次」还是「这一轮都批准」。没人点（超时、被停止）时没有这一项。 */
  scope?: 'once' | 'turn'
  /** 这次是被此前那条「这一轮都批准」直接放行的，没有再问过人。 */
  viaGrant?: boolean
  /** 这次是被此前那条「这一轮别再试了」直接挡下的，没有再问过人。 */
  viaBlock?: boolean
  /** 人在卡片上改过哪几格（标签，给日志和审计看）。没改就没有这一项。 */
  edited?: string[]
}

/**
 * 等多久。到点按**拒绝**处理，不是按批准。
 *
 * 五分钟：人正坐在对面时够他看清参数再点，人已经离开时也不至于让那一轮挂到天荒地老
 * ——工具那边是真的 await 在这儿，会话上那一轮一直开着。
 */
const TIMEOUT_MS = Math.max(10_000, Math.trunc(Number(process.env.SATUWORK_APPROVAL_TIMEOUT_MS) || 5 * 60_000))

/**
 * 高风险操作的确认往返。
 *
 * **拦下来告诉模型「你需要先问用户」是不够的**：模型会去问，用户会说「好」，然后模型
 * 原样再调一次——而那一次和上一次在这里长得一模一样，于是再被拦一次。要么陷在循环里
 * 撞步数硬顶，要么就得让模型自己声明「我已经问过了」，那等于把边界交回给它。
 *
 * 所以确认是**一次真的往返**：调用停在这里等，人在界面上点批准，这次调用继续跑下去。
 * 决定权和执行点之间没有中间人。
 */
export class ApprovalGate {
  private waiting = new Map<
    string,
    {
      rec: PendingApproval
      /**
       * **那次调用本身**，不是它的副本。
       *
       * 人在卡片上改了正文之后，改的必须是真正要执行的那份参数——`ToolService.execute`
       * 里的 `run()` 是在 `next()` 之后才读 `call.arguments` 的（见 tools/index.ts），
       * 所以在这里改它，跑出去的就是改过的那一份。留一份副本再「同步回去」的话，
       * 中间那一步迟早会漏，而漏掉的表现是：界面显示改过了，发出去的还是原文。
       */
      call: ToolCall
      settle: (v: Verdict, scope?: 'once' | 'turn', edited?: string[]) => void
    }
  >()
  /**
   * 「这一轮都批准」的口子：sessionId → 工具名（terminal 是工具名 + 命令，见 grantKey）。**轮末清空**（见 clearGrants）。
   *
   * 一开始这里是「本会话都批准」，那是错的：**一个 Bot 一辈子只有一条会话**
   * （registry.ts 的 ensureSession——有就复用，只增不减），而席位上的 bot 是常驻进程。
   * 于是那颗按钮实际给出去的是「这台席位上这把工具从此不再问」，可能一连几周。按钮上
   * 写的是「这次对话」，人读到的是「眼下这一段」——一次点击换走一张无限期通行证，
   * 而这正是这条边界要防的事。
   *
   * 收成一轮，正好是人点它时脑子里的那个范围：「我让它发三封信，别问我三遍」。
   * 下一句话是新的意图，重新问一次。
   *
   * **只在内存里。** 落盘的话它还会跨过重启，而丢失的方向是多问一次，安全。
   */
  private grants = new Map<string, Set<string>>()

  /**
   * 「这一轮别再试了」的口子：sessionId → 工具名。和放行名单同生共死（轮末一起清）。
   *
   * **为什么要有它**：拒绝目前只作用于这一次，模型下一步完全可以换个措辞再调一遍同样的
   * 东西——人得一次次点拒绝，而每一次都长得差不多。点了这个，这一轮里同一把工具直接挡掉，
   * 理由如实告诉模型「刚拒过」，让它去换做法，而不是换措辞。
   *
   * **是一颗单独的按钮，不是「拒绝」的默认行为。** 默认就挡掉的话，「拒绝 → 我跟它说
   * 改发给李总 → 它重发」这条最自然的路会被自己挡死：插话（steer）是插进**同一轮**的，
   * 那时工具已经在黑名单上了。
   */
  private denials = new Map<string, Set<string>>()

  /**
   * 轮末清空这条会话上的放行 / 拦停名单。
   *
   * 挂在 `turn/end` 上（policy/index.ts）。轮首也清一次：进程如果在上一轮中途硬死过，
   * 那一轮的 `turn/end` 根本没写下来，名单会带着一张没人再看着的通行证进下一轮。
   */
  clearTurn(sessionId: string): void {
    this.grants.delete(sessionId)
    this.denials.delete(sessionId)
  }

  constructor(private ctx: Context) {}

  /** 这条会话上还等着的那几条。界面刷新后靠它恢复。 */
  list(sessionId: string): PendingApproval[] {
    return [...this.waiting.values()].filter((w) => w.rec.sessionId === sessionId).map((w) => w.rec)
  }

  /**
   * 停在这儿等人拍板。
   *
   * 三条出路都要走到：人点了、这一轮被中止（停止按钮）、等到超时。少任何一条，
   * 那次调用就会挂着不动——而它挂着的时候，整条会话都在等它。
   */
  async ask(call: ToolCall, reason: string, form: ApprovalForm): Promise<Decision> {
    /**
     * 子代理的调用，**卡片开在主会话上**（见 docs/delegation.md §6.2）。
     *
     * 子代理没有人可问，但它能碰要审批的工具。开在子会话上的卡片落在一条界面上根本没
     * 入口的会话里——等于永远没人点，五分钟后按拒绝收口，而「把这批对账单发出去」这类
     * 活就整个委派不了。
     *
     * **换的只有事件落在哪、名单按谁记，等的仍然是那次真调用本身**（下面那段「不是它的
     * 副本」照旧成立：人在卡片上改的参数就是子代理真正跑出去的那一份）。
     *
     * 顺带两件事自动对了：`scope: 'turn'` 的放行名单记在主会话上，而 clearTurn 由**主
     * 轮**的 turn/end 触发——子代理跑多久都在这一轮里，语义正好；同一个 callId 不会撞，
     * 它本来就是全局唯一的。
     */
    const agents = agentsOf(this.ctx)
    const sessionId = agents?.rootOf?.(call.sessionId) ?? call.sessionId
    /**
     * 拦停名单先看：人这一轮已经说过「别再试了」。
     *
     * 排在放行名单前面——同一把工具不可能既在放行名单又在拦停名单里（点了一个就落定了），
     * 但万一将来两边都能进，**拒绝优先**才是安全的那一侧。
     */
    /**
     * 名单按**剥壳后的内层工具名**记，不按 `call.name`。
     *
     * 连接器收成 `*_sw_run` 元工具之后，`call.name` 对同一个连接器的所有工具都是同一个
     * 壳名：按它记账，人对「查一次仓库列表」点的「这一轮都批准」会顺带放行同一个壳里
     * 的「删仓库」。没套壳的工具 unwrapCall 原样返回，行为不变。查和写（decide）两边
     * 都走 grantKey。
     */
    const blocked = this.denials.get(sessionId)
    if (blocked?.has(blockKey(call))) return { verdict: 'denied', scope: 'turn', viaBlock: true }

    const granted = this.grants.get(sessionId)
    if (granted?.has(grantKey(call))) return { verdict: 'approved', scope: 'turn', viaGrant: true }

    const key = `${sessionId}:${call.callId}`
    const now = Date.now()
    const rec: PendingApproval = {
      sessionId,
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
      reason,
      form,
      createdAt: now,
      expiresAt: now + TIMEOUT_MS,
    }

    /**
     * **先登记，再广播。**
     *
     * 反过来的话，pending 事件已经推到浏览器、而这条还没进 `waiting`：那一瞬间点下
     * 「批准」拿到的是「这条确认已经结束了」，而它其实才刚开始。窗口只有一个微任务，
     * 但它是真的，而且只会在人手最快的时候发作——最难复现的那一类。
     */
    const settled = new Promise<Decision>((resolve) => {
      let done = false
      const finish = (v: Verdict, scope?: 'once' | 'turn', edited?: string[]) => {
        if (done) return
        done = true
        clearTimeout(timer)
        call.signal?.removeEventListener('abort', onAbort)
        this.waiting.delete(key)
        resolve({ verdict: v, ...(scope ? { scope } : {}), ...(edited?.length ? { edited } : {}) })
      }
      const onAbort = () => finish('aborted')
      const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS)
      // 已经是 aborted 的信号不会再发事件——那种情况要当场收，否则这次确认会挂在一个
      // 早就被喊停的轮次里等满五分钟。
      this.waiting.set(key, { rec, call, settle: finish })
      if (call.signal?.aborted) return finish('aborted')
      call.signal?.addEventListener('abort', onAbort, { once: true })
    })

    await this.append(rec.sessionId, {
      callId: rec.callId,
      name: rec.name,
      arguments: rec.arguments,
      reason,
      form: rec.form,
      state: 'pending',
      expiresAt: rec.expiresAt,
    })

    const decision = await settled
    /**
     * 终态事件带的是**最终那一份**：参数、表单里的值都取改过之后的。
     *
     * 落原文的话，日志上写着模型起草的那封信，而实际发出去的是人改过的另一封——
     * 「发了什么」这个问题从此没有答案，而这正是留这条记录的全部理由。
     */
    await this.append(rec.sessionId, {
      callId: rec.callId,
      name: rec.name,
      // decide() 把改过的那份同时写回了 rec.arguments（和 call.arguments 是同一串）。
      arguments: rec.arguments,
      reason,
      form: rec.form,
      ...(decision.edited?.length ? { edited: decision.edited } : {}),
      state: decision.verdict,
      // **范围要落进终态事件。** 少了它，「这次对话都批准」在日志里跟「只批这一次」
      // 长得一模一样，而后面那些不再弹卡片的调用就成了没有出处的放行。
      ...(decision.scope ? { scope: decision.scope } : {}),
    })
    return decision
  }

  /**
   * 人点了。
   *
   * 返回三种结果而不是布尔：「批准了」「这条早就不在了」对用户是完全不同的两句话——
   * 两个标签页各点一次，后点的那个必须知道自己点的是一条已经结束的确认，而不是以为
   * 自己批准了什么。
   */
  decide(
    sessionId: string,
    callId: string,
    decision: 'approve' | 'deny',
    scope: 'once' | 'turn' = 'once',
    edits?: Record<string, unknown>,
  ): 'ok' | 'gone' {
    const hit = this.waiting.get(`${sessionId}:${callId}`)
    if (!hit) return 'gone'
    let edited: string[] = []
    if (decision === 'approve' && edits && typeof edits === 'object') {
      /**
       * 改动写回**真正要执行的那份参数**（见 waiting 里 call 上的说明），
       * 而且只认席位这边算出来的那几格可改字段——浏览器送来的 key 一概不作数。
       */
      const patched = applyEdits(hit.call.arguments, hit.rec.form, edits)
      hit.call.arguments = patched.arguments
      hit.rec.arguments = patched.arguments
      hit.rec.form = { ...hit.rec.form, fields: patched.fields }
      edited = patched.changed
    }
    /**
     * **改过的这一次不能顺带放行后面几次。**
     *
     * 「这一轮都批准」的意思是「后面同样的调用不用再问我」，而后面那些调用带的是
     * 模型自己写的内容，不是人刚改的这一份。两件事凑在一起，等于人改了一封信，
     * 然后默许了之后几封没人看过的。
     */
    if (edited.length) scope = 'once'
    // 记的是剥壳后的内层工具名（terminal 连命令一起，见 grantKey），和查的那一侧用同一把钥匙。
    if (decision === 'approve' && scope === 'turn') {
      const set = this.grants.get(sessionId) ?? new Set<string>()
      set.add(grantKey(hit.rec))
      this.grants.set(sessionId, set)
    }
    // 「这一轮别再试了」：拒绝也能带范围，落进拦停名单，这一轮同一把工具直接挡。
    if (decision === 'deny' && scope === 'turn') {
      const set = this.denials.get(sessionId) ?? new Set<string>()
      set.add(blockKey(hit.rec))
      this.denials.set(sessionId, set)
    }
    /**
     * 范围两边都要带出去。
     *
     * 以前拒绝一律不带 scope（那时它只有一种拒法）。现在「拒绝」和「这一轮别再试了」
     * 是两件事，日志上分不出来的话，事后就答不了「他是拒了这一次，还是把这条路关了」。
     */
    hit.settle(decision === 'approve' ? 'approved' : 'denied', scope, edited)
    return 'ok'
  }

  /** 这条会话上「这一轮都批准」过的工具。给 /api/sessions/:id/approvals 报出去。 */
  grantedIn(sessionId: string): string[] {
    return [...(this.grants.get(sessionId) ?? new Set<string>())]
  }

  /** 这条会话上「这一轮别再试了」的那几把工具。 */
  blockedIn(sessionId: string): string[] {
    return [...(this.denials.get(sessionId) ?? new Set<string>())]
  }

  private async append(sessionId: string, data: {
    callId: string
    name: string
    arguments: string
    reason: string
    form?: ApprovalForm
    edited?: string[]
    state: 'pending' | Verdict
    scope?: 'once' | 'turn'
    expiresAt?: number
  }): Promise<void> {
    try {
      await this.ctx.sessions.append(sessionId, 'tool/approval', data)
    } catch (e) {
      // 写不进日志不能让这次确认失效：等还是要等的，只是界面上那张卡片没了。
      this.ctx.logger?.warn?.(`policy: 确认事件写不进会话 ${(e as Error).message}`)
    }
  }
}
