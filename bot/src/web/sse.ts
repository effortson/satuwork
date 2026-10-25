import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '../session/types.ts'
import { historySlice, publicSessionEvents, visibleEvents } from '../session/replay.ts'
import { randomUUID } from 'node:crypto'
import { watchClose, watchOpen } from '../session/watchers.ts'

/** 会话事件流（SSE）：先回放、再跟上实时，连着心跳；每条流开口先报进程身份。 */

/**
 * 这个 bot 进程的身份。**每次起来都是新的一份。**
 *
 * 换版就是 `systemctl restart`：席位换了一个进程，而浏览器那头毫不知情——它手上那条
 * SSE 只是「断了」，和网络抖一下长得一模一样。于是它按老样子退避重连、拿着换版前的
 * 游标续传，界面上那些从旧进程攒下来的状态（正在跑的那一轮、排队的 dock、目录里的
 * 工具）就都成了旧闻，而没有任何东西会来纠正它。
 *
 * 所以每条流一开口就先自报家门：`instanceId` 变了 = 这不是你上次连的那个进程，客户端
 * 据此整条会话重来（见 gateway/ui/chat.js 的 runtime/hello）。**这是「重启信号」唯一
 * 送得出去的时刻**——进程死掉的那一刻它已经没法说话了，只能在重新连上的第一帧补说。
 */
export const INSTANCE_ID = randomUUID()
export const STARTED_AT = Date.now()

/** 导出只为探针（bot/e2e-replay.mjs）能直接起一条流、模拟中途断开。 */
export function sse(
  ctx: Context,
  sessionId: string,
  after: number,
  res: { _res?: { on?: Function; destroyed?: boolean } },
  tail = 0,
) {
  const encoder = new TextEncoder()
  /**
   * 收尾：摘监听、停心跳、关流。**幂等**，三条路都会叫它——连接 close、流被 cancel、
   * 重放完发现人早走了。
   *
   * 以前只有 close 那一条，而且是重放**之后**才挂上的：重放慢（长会话要从盘上读），
   * 客户端在那期间断开，close 在监听器出现之前就已经发过了——off()/offQueue() 从此
   * 没人调，每次重连在进程里留一个死监听器。
   */
  let closed = false
  let cleanup = () => {}
  return new Response(
    new ReadableStream({
      cancel() {
        cleanup()
      },
      async start(controller) {
        const send = (event: SessionEvent) => {
          if (closed) return
          const safe = publicSessionEvents([event])[0]
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(safe)}\n\n`))
        }
        /** 直播（含快照后补发的队列）走这条：发过的不再发，见下面 lastSeq。 */
        const sendLive = (event: SessionEvent) => {
          if (event.seq <= lastSeq) return
          lastSeq = event.seq
          send(event)
        }

        /**
         * **第一帧：我是谁、从什么时候开始的。**
         *
         * 排在重放之前，不是之后：重放可能很长，而客户端要先知道「这是不是上次那个
         * 进程」才好决定这一批事件是接着看还是全部作废。它不是会话事件，不进事件桶
         * （和 replay/done、queue/change 一样按 type 分流）。
         */
        let beat: NodeJS.Timeout | undefined
        // 有人连着这条会话：手机推送据此省掉短轮次的那一条（session/watchers.ts）。cleanup 幂等，只减一次。
        watchOpen(sessionId)
        cleanup = () => {
          if (closed) return
          closed = true
          watchClose(sessionId)
          if (beat) clearInterval(beat)
          off()
          offQueue()
          try {
            controller.close()
          } catch {}
        }

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: 'runtime/hello', instanceId: INSTANCE_ID, startedAt: STARTED_AT, version: process.env.SATUWORK_VERSION || '' })}\n\n`,
          ),
        )

        let queue: SessionEvent[] | null = []
        const off = ctx.on('session/event', (id: string, event: SessionEvent) => {
          if (id !== sessionId) return
          if (queue) queue.push(event)
          else sendLive(event)
        })
        /**
         * 排队的消息有变。
         *
         * 走同一条流，因为界面要画的是同一屏；而且**队列的真相在这边**——浏览器刷新
         * 之后必须能把 dock 恢复出来，靠它自己记就会出现「界面上没有但它还是跑了」。
         * 帧的形状和 `replay/done` 一样是个非会话事件，客户端按 type 分流。
         */
        const offQueue = ctx.on('queue/change', (id: string, queued: unknown) => {
          if (id !== sessionId) return
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'queue/change', queued })}\n\n`))
          } catch {
            /* 流已经关了，下一次心跳会清掉 */
          }
        })
        // 长连接不该等到插件卸载才释放（ctx.on 是 effect，那只是兜底）。**挂在重放之前**，
        // 理由见上面 cleanup。
        res._res?.on?.('close', () => cleanup())

        let replayed = 0
        let firstSeq: number | null = null
        let hasMore = false
        /**
         * 已经发出去的最大 seq。
         *
         * 监听器挂在快照之前，而 SessionService.append 是先把事件推进内存、落盘之后
         * 才广播——落盘那一瞬间连上来的流会把这条事件既从快照里重放一遍，又从队列里
         * 再收一遍。所以排队的和后来直播的都拿它把关：小于等于它的就是已经发过的。
         */
        let lastSeq = after
        try {
          if (after > 0) {
            // 断线续传：从游标之后原样发，不切也不筛——那是「补上错过的」，
            // 和「打开页面看最近几轮」是两件事。只有 `/clear` 之前的照样不给：游标停在
            // 清除点之前（断线期间别的标签页清过）时，那一段不该借续传又流回来。
            const all = await ctx.sessions.events(sessionId)
            const missed = visibleEvents(all).filter((e) => e.seq > after)
            for (const event of publicSessionEvents(missed)) {
              send(event)
              replayed++
              if (event.seq > lastSeq) lastSeq = event.seq
            }
          } else {
            // 头一次连上：只发最近 tail 轮，并且丢掉已经作废的流式 chunk（见 replay.ts）。
            const slice = historySlice(await ctx.sessions.events(sessionId), { turns: tail })
            for (const event of slice.events) {
              send(event)
              replayed++
              if (event.seq > lastSeq) lastSeq = event.seq
            }
            firstSeq = slice.firstSeq
            hasMore = slice.hasMore
          }
        } catch (e) {
          if (closed) return
          ctx.logger?.warn?.(`sse: 会话 ${sessionId} 读不出来：${(e as Error).message}`)
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify({ error: (e as Error).message })}\n\n`),
          )
          return cleanup()
        }
        // 重放期间人已经走了：close 那一下可能早于上面那个监听器（socket 先断了），再看一眼。
        if (closed || res._res?.destroyed) return cleanup()

        /**
         * 历史放完了。
         *
         * 这条标记**必须有**：历史和实时走的是同一个通道、同样的 `data:` 帧，客户端
         * 收到一条 `turn/start` 时没法知道它是「几小时前那一轮开始了」还是「刚刚开始
         * 了一轮」。于是重放一段长会话时，界面会一路挂着「正在处理」，直到重放出那个
         * 配对的 `turn/end`——会话越长挂得越久，而那期间什么都没在跑。
         *
         * 有了这条，客户端就能把标记之前的一律当历史，只认之后的状态。
         *
         * `live` 是**这条会话此刻到底在不在跑**，由 agents 直接给。带上它，是因为客户端
         * 原来只能从事件顺序里猜：从头扫，遇 turn/start 算在跑、遇 turn/end 算跑完，最后
         * 一个说了算。这个猜法有个前提——历史必须完整——而它经常不成立：
         *
         *   · 流断在重放中途，客户端手上就只剩半截，尾巴那条 turn/end 没到；
         *   · 进程半路没了（崩溃、机器重启、每一次「重新部署」），日志里那条 turn/end
         *     根本没写成——healDanglingTurn 要等下一次从磁盘读这条会话才补得上。
         *
         * 两种情况下界面都会一直挂着「正在处理」，而那边什么都没在跑，等多久都不会变。
         * 少几条消息是看得出来的，假装在跑不是——所以这件事不该猜，让知道的人说。
         */
        const live = ctx.agents.isRunning(sessionId)
        // 「界面为什么一直显示正在处理」全靠这一行断案：live 是 true 就是真在跑，
        // 是 false 而界面还挂着，那就是前端的事。
        /**
         * **续传那一支不报「还有更早的」。**
         *
         * `firstSeq` / `hasMore` 只有「打开页面取最近几轮」那一支算得出来；续传时它们
         * 停在初始的 `null` / `false`，照着打就是一句**假结论**——日志上写着
         * 「还有更早的=false」，而那条会话前面明明还有几千条。排查刷新卡顿时，这一行
         * 会把人引到「是不是重放了全部消息」上去，而续传只发了游标之后的那几条。
         *
         * 帧里也一并省掉：客户端那边 `noteChatPage` 是按「有没有带这两个值」判的
         * （见 gateway/ui/chat.js），不带就不会覆盖它已经知道的分页游标。
         */
        const resuming = after > 0
        ctx.logger?.info?.(
          `sse: 会话 ${sessionId} 接上，after=${after}，tail=${tail}，重放 ${replayed} 条，live=${live}` +
            (resuming ? '（续传）' : `，还有更早的=${hasMore}`),
        )
        controller.enqueue(
          encoder.encode(
            // 队列一起带上：刷新页面之后 dock 要能原样回来。
            `data: ${JSON.stringify({
              type: 'replay/done',
              live,
              ...(resuming ? {} : { firstSeq, hasMore }),
              queued: ctx.agents.queued(sessionId),
            })}\n\n`,
          ),
        )

        const pending = queue
        queue = null
        for (const event of pending) sendLive(event)

        /**
         * 心跳。
         *
         * **尾巴会卡在缓冲里。** 上面那些 `send()` 是 `controller.enqueue`，不阻塞——
         * 它只把事件塞进队列，什么时候真的写到浏览器由下游决定。而浏览器在 fetch 流
         * 上会攒够一定量才交付（Safari 尤其明显），于是一条安静下来的会话，最后几十
         * 条事件连同 `replay/done` 就一直压在那儿，再也没有新字节把它们顶出去。
         *
         * 实测长这样：bot 报「重放 1078 条」，客户端手上只有 1054 条，`replay/done`
         * 从没到达，而连接看着还开着、也不会重连——历史缺一截，界面因为拿不到那句
         * 「在不在跑」而永远挂着「正在处理」。哪条会话中招取决于它的字节数落在缓冲
         * 边界的哪一侧，所以刷一次换一个，看着像见了鬼。
         *
         * 一条 `: ping` 注释就够：它不是事件，客户端解析时直接跳过，但它是新字节，
         * 会把压着的那一截一起冲出去。顺带也让掉线被及时发现。
         */
        beat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': ping\n\n'))
          } catch {
            cleanup()
          }
        }, 15000)
      },
    }),
    {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    },
  )
}
