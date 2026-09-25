import type { Context } from '@deepseek-ai/cordis'
import { gatewayToken, gatewayUrl } from '../llm/gateway.ts'
import { clip, fail, registerTool } from './common.ts'

/**
 * 日常任务：让主代理查看、创建、修改和立即触发自己的定时任务。
 *
 * 定义、排期和运行流水的唯一真相都在 Gateway（docs/routines.md）。席位只提供两把薄工具，
 * 不在本地复制下一次运行时间的算法，也不自己起定时器——否则页面和 Agent 各写一套，迟早
 * 会出现一边说“明早九点”、另一边实际十点跑的分叉。
 */
export const name = 'satu-tools-routine'
export const inject = ['tools']

type Trigger = {
  kind: 'schedule'
  every: 'hour' | 'day' | 'week' | 'month'
  at: string
  weekday: number
  day: number
  tz: string
}

type Run = {
  id: string
  trigger: string
  status: string
  sessionId: string | null
  error: string | null
  startedAt: number
  endedAt: number | null
}

type Routine = {
  id: string
  botId: string
  name: string
  instruction: string
  active: boolean
  triggers: Trigger[]
  modelRole: 'daily' | 'utility'
  nextRunAt: number | null
  retryAt: number | null
  retryCount: number
  retryMax: number
  lastRun?: Run | null
  createdAt: number
  updatedAt: number
}

function botId(): string {
  return (process.env.SATUWORK_BOT_ID || '').trim()
}

/** Gateway 的 4xx 是参数或权限问题，原话给模型；5xx / 断网才是管道故障。 */
async function callGateway<T>(method: string, path: string, body?: unknown): Promise<T> {
  const base = gatewayUrl()
  const token = gatewayToken()
  if (!base || !token) fail('这台机器没有配 Gateway，日常任务这条路走不通。')
  let res: Response
  try {
    res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    throw new Error(`连不上 Gateway：${(e as Error).message}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let hint = ''
    try {
      hint = String((JSON.parse(text) as { error?: unknown })?.error ?? '')
    } catch {}
    if (res.status >= 400 && res.status < 500) fail(hint || `Gateway 拒绝了这次操作（HTTP ${res.status}）`)
    throw new Error(`Gateway 返回 HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`)
  }
  return (await res.json()) as T
}

function triggerText(t: Trigger): string {
  const when =
    t.every === 'hour'
      ? `每小时 ${t.at.slice(-2)} 分`
      : t.every === 'day'
        ? `每天 ${t.at}`
        : t.every === 'week'
          ? `每周${['日', '一', '二', '三', '四', '五', '六'][t.weekday] ?? t.weekday} ${t.at}`
          : `每月 ${t.day} 日 ${t.at}`
  return `${when}（${t.tz}）`
}

function timeText(at: number | null): string {
  return at == null ? '—' : new Date(at).toISOString()
}

function routineText(r: Routine, full = false): string {
  const schedule = r.triggers.length ? r.triggers.map(triggerText).join('；') : '没有触发时间'
  const last = r.lastRun
    ? `${r.lastRun.status}，${timeText(r.lastRun.startedAt)}${r.lastRun.error ? `，${r.lastRun.error}` : ''}`
    : '还没有运行记录'
  const instruction = full ? r.instruction : clip(r.instruction.replace(/\s+/g, ' ').trim(), 180)
  return [
    `「${r.name || '未命名'}」`,
    `id: ${r.id}`,
    `状态: ${r.active ? '启用' : '停用'}`,
    `时间: ${schedule}`,
    `下一次: ${timeText(r.nextRunAt)}`,
    `模型: ${r.modelRole === 'utility' ? 'utility（省钱档）' : 'daily（跟平时一样）'}`,
    `指令: ${instruction || '（空）'}`,
    `上一次: ${last}`,
  ].join('\n')
}

function query(bot: string): string {
  return `?botId=${encodeURIComponent(bot)}`
}

async function list(bot: string): Promise<Routine[]> {
  const out = await callGateway<{ routines: Routine[] }>('GET', `/runtime/bots/${encodeURIComponent(bot)}/routines`)
  return Array.isArray(out.routines) ? out.routines : []
}

/** id 或完整名字 → 唯一一条。名字重了就不猜。 */
async function findRoutine(bot: string, ref: string): Promise<Routine> {
  const key = String(ref ?? '').trim()
  if (!key) fail('缺少 routine：写日常任务的 id 或完整名字。先用 routine_list 查看。')
  const rows = await list(bot)
  const byId = rows.find((r) => r.id === key)
  if (byId) return byId
  const exact = rows.filter((r) => r.name === key)
  if (exact.length === 1) return exact[0]
  const folded = rows.filter((r) => r.name.toLowerCase() === key.toLowerCase())
  if (folded.length === 1) return folded[0]
  if (exact.length > 1 || folded.length > 1) {
    const hits = exact.length > 1 ? exact : folded
    fail(`有 ${hits.length} 条都叫「${key}」，不能猜。请改用 id：${hits.map((r) => r.id).join('、')}`)
  }
  const names = rows.slice(0, 10).map((r) => `「${r.name || '未命名'}」(${r.id})`).join('、')
  fail(`没有叫「${key}」的日常任务。${names ? `现有的是：${names}` : '这颗 Bot 还没有日常任务。'}`)
}

const triggerSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['schedule'], description: '目前固定为 schedule。' },
    every: { type: 'string', enum: ['hour', 'day', 'week', 'month'], description: '每小时 / 每天 / 每周 / 每月。' },
    at: { type: 'string', description: '24 小时制 HH:MM；hour 只使用分钟部分。' },
    weekday: { type: 'number', description: '每周使用：0=周日，1=周一，…，6=周六。' },
    day: { type: 'number', description: '每月使用：1–31；当月没有这一天时取月末。' },
    tz: { type: 'string', description: 'IANA 时区，如 Asia/Shanghai。不要把 UTC+8 当时区名。' },
  },
  required: ['kind', 'every', 'at', 'tz'],
} as const

export function apply(ctx: Context) {
  const tool = (
    def: Parameters<typeof registerTool>[1],
    execute: Parameters<typeof registerTool>[2],
  ) => registerTool(ctx, def, execute)

  tool(
    {
      name: 'routine_list',
      risk: ['read'],
      // 日程属于和用户直接对话的主代理；委派子任务不该顺手翻看或改它。
      delegation: { mode: 'root-only' },
      description:
        '查看这颗 Bot 的日常定时任务。无参数列全部；给 routine（id 或完整名字）查看一条及最近运行记录。' +
        '用户问“有哪些定时任务”“下次什么时候跑”“昨晚跑成了吗”时用它。',
      parameters: {
        type: 'object',
        properties: {
          routine: { type: 'string', description: '可选：日常任务 id 或完整名字。' },
        },
      },
    },
    async ({ routine }: { routine?: string }) => {
      const bot = botId()
      if (!bot) fail('这台席位没钉 Bot（缺 SATUWORK_BOT_ID），看不了日常任务。')
      if (routine?.trim()) {
        const hit = await findRoutine(bot, routine)
        const out = await callGateway<{ routine: Routine; runs: Run[] }>(
          'GET',
          `/runtime/routines/${encodeURIComponent(hit.id)}${query(bot)}`,
        )
        const runs = (out.runs || []).slice(0, 10)
        const history = runs.length
          ? `\n\n最近运行：\n${runs.map((r) => `- ${r.status} · ${r.trigger} · ${timeText(r.startedAt)}${r.error ? ` · ${r.error}` : ''}`).join('\n')}`
          : '\n\n还没有运行记录。'
        return clip(routineText(out.routine, true) + history, 12_000)
      }
      const rows = await list(bot)
      if (!rows.length) return '这颗 Bot 还没有日常任务。'
      return clip(`日常任务共 ${rows.length} 条：\n\n${rows.map((r) => routineText(r)).join('\n\n')}`, 16_000)
    },
  )

  tool(
    {
      name: 'routine_manage',
      risk: ['write'],
      delegation: { mode: 'root-only' },
      description:
        '新增、修改或立即触发这颗 Bot 的日常定时任务。' +
        'create 必须有明确的名称、执行指令和时间；缺少时间或时区时先问用户，绝不能自己猜。' +
        'update 的 triggers 会整组替换；改现有任务前可先用 routine_list 核对。' +
        'run 是现在立即试跑一次，即使任务停用也能试跑；它不会改变原排期。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'run'], description: '新增、修改或立即触发。' },
          routine: { type: 'string', description: 'update / run 必填：日常任务 id 或完整名字。' },
          name: { type: 'string', description: 'create 必填；update 可选。最多 80 字。' },
          instruction: { type: 'string', description: '每次触发后真正发给 Bot 的指令。create 必填，最多 4000 字。' },
          active: { type: 'boolean', description: '是否启用。update 可用它停用或重新启用。' },
          triggers: {
            type: 'array',
            description: '触发时间。create 至少一条；update 传入时会替换整组，最多 8 条。',
            items: triggerSchema,
          },
          model_role: {
            type: 'string',
            enum: ['daily', 'utility'],
            description: 'daily=跟这颗 Bot 平时聊天一样（默认）；utility=平台省钱档，适合每天跑的简单活。',
          },
        },
        required: ['action'],
      },
    },
    async (
      args: {
        action?: string
        routine?: string
        name?: string
        instruction?: string
        active?: boolean
        triggers?: Trigger[]
        model_role?: 'utility' | 'daily'
      },
    ) => {
      const bot = botId()
      if (!bot) fail('这台席位没钉 Bot（缺 SATUWORK_BOT_ID），改不了日常任务。')
      const action = String(args.action ?? '')

      if (action === 'create') {
        const name = String(args.name ?? '').trim()
        const instruction = String(args.instruction ?? '').trim()
        if (!name) fail('create 缺少 name：这条日常任务叫什么？')
        if (!instruction) fail('create 缺少 instruction：每次触发后具体要做什么？')
        if (!Array.isArray(args.triggers) || !args.triggers.length) {
          fail('create 缺少 triggers：什么时候跑、用哪个时区？信息不全时先问用户，不要自己猜。')
        }
        const out = await callGateway<{ routine: Routine }>(
          'POST',
          `/runtime/bots/${encodeURIComponent(bot)}/routines`,
          {
            name,
            instruction,
            triggers: args.triggers,
            ...(args.model_role ? { modelRole: args.model_role } : {}),
          },
        )
        return `已新增日常任务：\n${routineText(out.routine, true)}\n\n它会按上面的时间自动触发。`
      }

      if (action === 'update') {
        const hit = await findRoutine(bot, String(args.routine ?? ''))
        const patch: Record<string, unknown> = {}
        if (args.name !== undefined) patch.name = String(args.name).trim()
        if (args.instruction !== undefined) patch.instruction = String(args.instruction).trim()
        if (args.active !== undefined) patch.active = args.active === true
        if (args.triggers !== undefined) patch.triggers = args.triggers
        if (args.model_role !== undefined) patch.modelRole = args.model_role
        if (!Object.keys(patch).length) fail('update 没有任何要修改的字段。')
        const out = await callGateway<{ routine: Routine }>(
          'PATCH',
          `/runtime/routines/${encodeURIComponent(hit.id)}${query(bot)}`,
          patch,
        )
        return `已修改日常任务：\n${routineText(out.routine, true)}`
      }

      if (action === 'run') {
        const hit = await findRoutine(bot, String(args.routine ?? ''))
        const out = await callGateway<{ run: Run }>(
          'POST',
          `/runtime/routines/${encodeURIComponent(hit.id)}/run${query(bot)}`,
          {},
        )
        return `已立即触发「${hit.name || '未命名'}」。运行 id: ${out.run.id}，当前状态: ${out.run.status}。这次是手动试跑，不改变原来的定时排期。`
      }

      fail('action 只能是 create / update / run。')
    },
  )
}
