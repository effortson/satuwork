import type { Context } from '@deepseek-ai/cordis'
import { gatewayToken, gatewayUrl } from '../llm/gateway.ts'

/**
 * 主 Bot 派活：assign_task（docs/bot-tasks.md）。
 *
 * **只有主 Bot 有这把工具。** 不是这里判的——Gateway 只给这个账号的主 Bot 下发 `assignable`
 * 名单，名单空着它就不进工具表（agent 的 toolSchemasFor）；接口那头再认一次（不是主 Bot 403）。
 *
 * 它本身是**异步**的：Gateway 记一条、当场返回「已派出」。结论由工人发回这条会话，落在新的
 * 一轮里（source.plugin = 'task', phase = 'result'）——所以回给模型的那段话要让它先回复用户，
 * 别在这儿等。
 */
export const name = 'satu-tools-assign'
export const inject = ['tools', 'catalog']

class AssignFailure extends Error {}

export function apply(ctx: Context) {
  ctx.tools.register({
    name: 'assign_task',
    /**
     * 只有主代理有。子代理（delegate_task 开出来的那份干净的自己）**不许**再往外派：一层
     * 委派里再套一层派活，谁也说不清结论该回到哪一轮。
     */
    delegation: { mode: 'root-only' },
    // 出席位（打 Gateway 记一条），但它自己不改任何东西；真正干活的是对方那颗 Bot，按它自己的边界走。
    risk: ['external'],
    get description() {
      const list = ctx.catalog?.assignable ?? []
      const names = list.length ? list.map((b) => (b.desc ? `「${b.name}」（${b.desc}）` : `「${b.name}」`)).join('、') : '（当前没有）'
      return (
        '把一件事派给名单上的另一颗 Bot 去做（你是主 Bot，只有你能派）。' +
        `可派的 Bot：${names}。` +
        '对方跑在自己的席位上，有自己的人设、能力和连接；它做完会把结论以一条「任务结果」消息发回**这条对话**，落在新的一轮里，到时候你再处理。' +
        '这次调用**当场返回**，不等结果——派出去之后先告诉用户已经派给谁了，不要在这里空等、也不要反复追问要不要等。' +
        '指令要**自足**：对方看不见这条对话，背景、要求、交付形式都写进去。一次派一件事；同一颗 Bot 上一件还没交回来时不要再派。'
      )
    },
    parameters: {
      type: 'object',
      properties: {
        bot: { type: 'string', description: '派给谁：名单上的名字。' },
        instruction: { type: 'string', description: '交给对方的原话，要自足，最多 4000 字。' },
      },
      required: ['bot', 'instruction'],
    },
    async execute(args, call) {
      const a = (args ?? {}) as { bot?: string; instruction?: string }
      const want = String(a.bot ?? '').trim()
      const instruction = String(a.instruction ?? '').trim()
      const list = ctx.catalog?.assignable ?? []
      const names = list.map((b) => `「${b.name}」`).join('、')
      if (!list.length) return { text: '你现在不是主 Bot，派不了活。' }
      if (!want) return { text: `要派给谁？可派的 Bot：${names}。` }
      if (!instruction) return { text: '指令不能为空：把要对方做的事写清楚。' }
      const lower = want.toLowerCase()
      const target = list.find((b) => b.id === want) || list.find((b) => b.name.toLowerCase() === lower)
      if (!target) return { text: `名单上没有「${want}」。可派的 Bot：${names}。` }
      try {
        const out = await callGateway({
          fromBotId: (process.env.SATUWORK_BOT_ID || '').trim(),
          toBot: target.id,
          instruction,
          sessionId: call.sessionId,
          callId: call.callId,
        })
        return {
          text:
            `已派给 @${target.name}（任务 ${out.task.id.slice(0, 8)}）。` +
            '它做完会把结果以「任务结果」消息发回这条对话，到时候你再处理。现在先告诉用户已经派出去了，不要在这儿等。',
        }
      } catch (e) {
        if (e instanceof AssignFailure) return { text: e.message }
        throw e
      }
    },
  })
}

async function callGateway(body: unknown): Promise<{ task: { id: string } }> {
  const base = gatewayUrl()
  const token = gatewayToken()
  if (!base || !token) throw new AssignFailure('这台机器没有配 Gateway，派不了活。')
  let r: Response
  try {
    r = await fetch(`${base}/runtime/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (e) {
    throw new Error(`连不上 Gateway：${(e as Error).message}`)
  }
  const text = await r.text().catch(() => '')
  let json: { task?: { id?: unknown }; error?: unknown } | null = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  // 403 / 404 / 409 都是业务上的「派不了」，原话回给模型，让它换个做法或告诉用户。
  if (r.status === 403 || r.status === 404 || r.status === 409 || r.status === 400) {
    throw new AssignFailure(`派不了：${String(json?.error ?? text ?? '').slice(0, 300) || `HTTP ${r.status}`}`)
  }
  if (!r.ok) throw new Error(`Gateway 返回 HTTP ${r.status}${text ? ` ${text.slice(0, 200)}` : ''}`)
  const id = typeof json?.task?.id === 'string' ? json.task.id : ''
  if (!id) throw new Error('Gateway 没回任务 id')
  return { task: { id } }
}
