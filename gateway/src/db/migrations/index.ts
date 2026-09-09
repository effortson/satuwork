import { SQL as m0001 } from './0001-initial.ts'
import { SQL as m0002 } from './0002-bot-template.ts'
import { SQL as m0003 } from './0003-seed-bot-templates.ts'
import { SQL as m0004 } from './0004-connectors.ts'
import { SQL as m0005 } from './0005-connector-bonus-split.ts'
import { SQL as m0006 } from './0006-web-calls.ts'
import { SQL as m0007 } from './0007-usage-charges.ts'
import { SQL as m0008 } from './0008-llm-cache-write.ts'
import { SQL as m0009 } from './0009-multiplier-precision.ts'
import { SQL as m0010 } from './0010-machine-telemetry.ts'
import { SQL as m0011 } from './0011-routines.ts'
import { SQL as m0012 } from './0012-machine-metric-minutes.ts'
import { SQL as m0013 } from './0013-seat-template-version.ts'
import { SQL as m0014 } from './0014-handoffs.ts'
import { SQL as m0015 } from './0015-handoff-webhook.ts'
import { SQL as m0016 } from './0016-routine-model.ts'
import { SQL as m0017 } from './0017-seat-skills.ts'
import { SQL as m0018 } from './0018-memories.ts'
import { SQL as m0019 } from './0019-seat-deploy-progress.ts'
import { SQL as m0020 } from './0020-routine-retry.ts'
import { SQL as m0021 } from './0021-kanban.ts'
import { SQL as m0022 } from './0022-kanban-files.ts'
import { SQL as m0023 } from './0023-card-pending.ts'
import { SQL as m0024 } from './0024-tasks.ts'
import { SQL as m0025 } from './0025-drop-kanban.ts'
import { SQL as m0026 } from './0026-task-extract-logs.ts'
import { SQL as m0027 } from './0027-conversation-audits.ts'
import { SQL as m0028 } from './0028-channels.ts'
import { SQL as m0029 } from './0029-channel-polling-pairing.ts'
import { SQL as m0030 } from './0030-channel-poll-error.ts'
import { SQL as m0031 } from './0031-telegram-private-user.ts'
import { SQL as m0032 } from './0032-channel-event-lease-token.ts'
import { SQL as m0033 } from './0033-channel-approval-prompt.ts'
import { SQL as m0034 } from './0034-drop-task-board.ts'
import { SQL as m0035 } from './0035-routine-one-running.ts'
import { SQL as m0036 } from './0036-channel-event-files.ts'
import { SQL as m0037 } from './0037-channel-event-handoffs.ts'
import { SQL as m0038 } from './0038-machine-direct-url.ts'

export interface Migration {
  /** 四位编号加短横线名字，例如 `0002-seat-labels`。排序就是执行顺序。 */
  id: string
  /** 给人看的一句话，写进 schema_migrations，出问题时日志里认得出是哪一条。 */
  name: string
  sql: string
}

/**
 * 全部迁移，**按编号升序**。
 *
 * ## 怎么加一条
 *
 * 1. 新建 `0002-<短名>.ts`，导出一个 `SQL`
 * 2. 在下面的数组末尾加一行
 * 3. 起一次进程，日志里会打出「已应用 0002-…」
 *
 * 不要改已经发出去的那些文件——校验和会在下次启动时把它拦下来（见 migrate.ts）。
 * 想撤销一条已发布的迁移，写新的一条把它改回去，不要回头编辑。
 *
 * ## 写迁移的两条规矩
 *
 * - **一条迁移一件事**，别把三张表的改动塞进一条。失败时只回滚这一条，粒度越细
 *   越好排查。
 * - **不要在迁移里写业务数据修补**，除非它和这次结构变更绑死（比如新加一列要有初值）。
 *   一次性的数据订正走脚本，那种活儿跑一次就完了，不该每个新库都跟着跑一遍。
 */
export const MIGRATIONS: Migration[] = [
  { id: '0001-initial', name: '初始 schema（编号迁移之前那段幂等脚本）', sql: m0001 },
  { id: '0002-bot-template', name: 'Bot 模版层：bot-template 这一种、user 这一层、accountId', sql: m0002 },
  { id: '0003-seed-bot-templates', name: '每家公司种一份 Bot 模版，旧的公司 Bot 停用', sql: m0003 },
  { id: '0004-connectors', name: '连接器：catalog 的 connector 这一种、安装、连接、调用流水', sql: m0004 },
  { id: '0005-connector-bonus-split', name: '连接器流水按桶分账：这一笔吃了多少套餐赠送', sql: m0005 },
  // 分支上原本占的是 0002，和 main 撞了。**迁移的编号是身份**，撞号意味着两套库
  // 各自记着「0002 跑过了」却跑的是不同的东西，所以让路排到最后。
  { id: '0006-web-calls', name: '网页工具的按次计量表', sql: m0006 },
  { id: '0007-usage-charges', name: '计费账本：三条计费路唯一的钱', sql: m0007 },
  { id: '0008-llm-cache-write', name: 'llm_calls 记下缓存写的 token', sql: m0008 },
  { id: '0009-multiplier-precision', name: '账本的倍率换成 double precision', sql: m0009 },
  { id: '0010-machine-telemetry', name: '机器自报的负载与日志占用，以及日志上限', sql: m0010 },
  // 这条在分支上原本占的是 0010，和 main 上的机器遥测撞了（同 0006 那次）。**编号是
  // 身份**：撞号意味着两套库各自记着「0010 跑过了」，跑的却是不同的东西，所以让路排到
  // 最后。分支还没合进去，没有任何库应用过旧编号的这一条，改号是安全的。
  { id: '0011-routines', name: '日常任务：routine 定义与每次跑的流水', sql: m0011 },
  // 同上一条同一个理由：这条在分支上原本是 0011，撞上了先合进来的日常任务，让路排到
  // 它后面。同样没有任何库应用过旧编号（这一条从没提交过），改号是安全的。
  { id: '0012-machine-metric-minutes', name: '机器负载按分钟归档，只留最近 30 天', sql: m0012 },
  { id: '0013-seat-template-version', name: '席位自报在跑的 Bot 模版版本与汇报时刻', sql: m0013 },
  { id: '0014-handoffs', name: '转人工的交接单：状态、指派、催办', sql: m0014 },
  { id: '0015-handoff-webhook', name: '公司的转人工通知地址', sql: m0015 },
  { id: '0016-routine-model', name: '日常任务选模型：日常还是 utility', sql: m0016 },
  { id: '0017-seat-skills', name: '私有档 Skill：目录项多一维 botId', sql: m0017 },
  { id: '0018-memories', name: '长期记忆：四层、按 Bot / 人 / 分组 / 公司归属', sql: m0018 },
  { id: '0019-seat-deploy-progress', name: '席位部署的阶段与起始时刻', sql: m0019 },
  // 这条在分支上原本占的是 0019，撞上了先合进来的席位部署进度（同 0006、0011、0012 那
  // 几次）。**编号是身份**：撞号意味着两套库各自记着「0019 跑过了」，跑的却是不同的
  // 东西，所以让路排到它后面。这一条还没合进 main，除了 e2e 那几个用完就丢的 schema
  // 没有任何库应用过旧编号，改号是安全的。
  { id: '0020-routine-retry', name: '日常任务失败后的退避重试：下一次重试的时刻与已重试次数', sql: m0020 },
  // 同上一条同一个理由：这条在分支上原本占的是 0019，撞上了先合进来的席位部署进度和
  // 日常任务退避，让路排到它们后面。这一条还没合进 main，除了 e2e 那几个用完就丢的
  // schema 没有任何库应用过旧编号，改号是安全的。
  { id: '0021-kanban', name: '多 Bot 看板：板、成员、卡、依赖、时间线、执行流水', sql: m0021 },
  { id: '0022-kanban-files', name: '看板卡的附件清单（字节落盘在 gateway home 的 kanban/ 下）', sql: m0022 },
  { id: '0023-card-pending', name: '看板卡状态枚举加待定（pending）：人开卡先停在待定', sql: m0023 },
  { id: '0024-tasks', name: '任务看板：从对话里总结出来的任务（tasks / task_events）', sql: m0024 },
  // 建新的和删旧的**分两条**：中间那一版两套并存，回滚只回滚这一条。见 0025 的头注。
  { id: '0025-drop-kanban', name: '删掉旧看板：板、成员、卡、依赖、时间线、附件、执行流水', sql: m0025 },
  { id: '0026-task-extract-logs', name: '任务抽取判定日志：创建、未创建与失败原因', sql: m0026 },
  { id: '0027-conversation-audits', name: '自动对话审计：批次、结构化条目与删除前终审', sql: m0027 },
  { id: '0028-channels', name: '外部渠道：绑定、Webhook 去重与可靠投递', sql: m0028 },
  { id: '0029-channel-polling-pairing', name: 'Telegram 长轮询游标、租约与用户身份配对', sql: m0029 },
  { id: '0030-channel-poll-error', name: 'Telegram 长轮询错误与消息投递错误分开记录', sql: m0030 },
  { id: '0031-telegram-private-user', name: 'Telegram 渠道限定单一私聊用户', sql: m0031 },
  { id: '0032-channel-event-lease-token', name: '渠道消息短租约的续租与所有权隔离', sql: m0032 },
  { id: '0033-channel-approval-prompt', name: '渠道审批提示去重与重启恢复', sql: m0033 },
  { id: '0034-drop-task-board', name: '移除任务看板、时间线与对话任务抽取日志', sql: m0034 },
  { id: '0035-routine-one-running', name: '日常任务同一时刻只允许一条 running 流水', sql: m0035 },
  { id: '0036-channel-event-files', name: '渠道事件保存本轮产出文件，供 Telegram 可靠投递预览', sql: m0036 },
  { id: '0037-channel-event-handoffs', name: '渠道事件保存本轮转人工卡，供 Telegram 可靠投递操作入口', sql: m0037 },
  { id: '0038-machine-direct-url', name: '席位机器的公网直连地址，桌面像素不再经过 Gateway', sql: m0038 },
]

/**
 * 编号必须唯一且升序。
 *
 * 两条分支各加一条迁移然后合并，很容易撞号或者插到中间——那样某些库会跳过一条，
 * 而且再也补不回来（`schema_migrations` 只按 id 查「跑过没有」）。这条检查在模块
 * 加载时跑，也就是进程起来的第一秒，而不是等到某个库上出事。
 */
for (let i = 1; i < MIGRATIONS.length; i++) {
  const prev = MIGRATIONS[i - 1].id
  const cur = MIGRATIONS[i].id
  if (cur <= prev) throw new Error(`迁移编号必须严格升序：${prev} 之后是 ${cur}`)
}
