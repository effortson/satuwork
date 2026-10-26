import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { registerTool } from './common.ts'
import { isLocalRuntime } from '../env.ts'

/**
 * 本地 Bot 向用户**申请访问一个文件夹**（`request_folder_access`）。
 *
 * 本地 Bot 只看得见自己的工作区（workspace/index.ts 的 resolve）。用户要它处理
 * `~/Downloads` 里的东西时，以前它只能回一句「不在我的工作区里，我访问不到」，然后等人
 * 自己想起右栏那颗「批准访问其他文件夹」。现在它可以直接开口：这把工具在对话里开一张
 * 确认卡，卡上写着它要的文件夹（`suggested`）。人点「批准」就批那一个；要的不是它就点
 * 「换一个文件夹…」，在系统选择框里自己选。两条路都由 Desktop 建入口（approve_local_directory），
 * 这里再把**新批准的那几个入口**报回给模型，它接着用 `External/<名字>` 去读。
 *
 * **批准的是卡上人看过的那个路径。** 批之前 Desktop 会核对它是真实存在的文件夹，并挡掉
 * 整个磁盘和整个用户目录——那种范围得人在选择框里亲手选，不能顺着模型的一句提示点掉。
 *
 * 只在本地 Bot 上挂：远程席位没有「批准」这回事，工作区就是边界，挂上只会让模型去申请
 * 一件永远批不下来的事。
 */
export const name = 'satu-tools-folders'
export const inject = ['tools', 'workspace', 'policy']

function describe(mounts: { mount: string; path: string }[]): string {
  return mounts.map((m) => `- \`${m.mount}\`（${m.path}）`).join('\n')
}

export function apply(ctx: Context) {
  if (!isLocalRuntime()) return
  registerTool(
    ctx,
    {
      name: 'request_folder_access',
      delegation: {},
      // 它本身不读不写任何东西：动手的是人（在选择框里选）。批准之后的读写照旧走文件工具。
      risk: ['read'],
      description:
        '请用户批准你访问工作区之外的一个文件夹（比如 ~/Downloads、~/Desktop 或某个项目目录）。' +
        '调用后对话里会出现一张卡片，用户点批准（就是你报的那个文件夹）或者自己另选一个之后你才能访问；这次调用会一直等到用户批准或拒绝。' +
        '批准后文件夹挂在工作区的 `External/<名字>` 下，用 read_file / search_files / write_file 按这个路径访问。' +
        '**用户提到工作区外的文件夹时，直接调它申请，不要让用户自己去拷贝文件或去找设置。** 已经批准过的（系统提示里「用户批准你访问的文件夹」那一段）不用再申请。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '为什么要访问，一句话，会原样显示在卡片上。比如「整理下载目录里本周的发票」。' },
          suggested: {
            type: 'string',
            description:
              '要访问的文件夹，写完整路径或 ~/ 开头的路径，比如 ~/Downloads。用户点批准批的就是它，所以要具体到那个文件夹；' +
              '整个用户目录（~）或磁盘根目录不能一键批准。不确定是哪个就不填，让用户自己选。',
          },
        },
        required: ['reason'],
      },
    },
    async (args: { reason?: string; suggested?: string }, call) => {
      const reason = String(args.reason || '').trim() || '需要访问工作区之外的一个文件夹'
      const suggested = String(args.suggested || '').trim()
      const before = new Set(ctx.workspace.approvedMounts().map((m) => m.mount))
      const decision = await ctx.policy.approvals.ask(call, reason, {
        kind: 'folder',
        tool: 'request_folder_access',
        fields: [
          { key: 'reason', label: '用途', value: reason },
          ...(suggested ? [{ key: 'suggested', label: '建议的文件夹', value: suggested }] : []),
        ],
      })
      if (decision.verdict === 'timeout') return '用户没有在时限内处理这次申请。先接着做不需要这个文件夹的部分，或者问用户要不要再申请一次。'
      if (decision.verdict !== 'approved') return '用户拒绝了这次文件夹访问申请。不要再申请同一个文件夹；换个做法，或者问用户希望怎么处理。'
      const all = ctx.workspace.approvedMounts()
      const added = all.filter((m) => !before.has(m.mount))
      /**
       * 批的正是一个早就批过的文件夹（卡上「批准」直批 suggested，那个文件夹已经在名单里）。
       * 照「没有选新的文件夹」说的话，模型会转述成一句含糊的「重新授权成功」，而其实什么都
       * 没变——它该知道的是：那个入口一直都在，直接用。
       */
      const asked = suggested.replace(/^~(?=\/|$)/, homedir()).replace(/\/+$/, '')
      const already = !added.length && asked ? all.find((m) => m.path === asked) : undefined
      if (already) {
        return `这个文件夹早就批准过了，入口一直在：\n${describe([already])}\n\n直接用这个 \`External/…\` 路径；如果刚才访问失败，原因不在批准上，把报错原样告诉用户。`
      }
      if (!added.length) {
        return all.length
          ? `用户批准了，但这次没有选新的文件夹。现在能访问的是：\n${describe(all)}`
          : '用户点了批准，但没有选文件夹（可能是在 Telegram 或浏览器里批准的，那里拉不起文件夹选择框）。请用户在 Satuwork 桌面端里批准。'
      }
      return `用户已批准，现在可以访问：\n${describe(added)}\n\n用这些 \`External/…\` 路径调用 read_file / search_files / write_file；在对话里提到其中的文件时也写这个路径。`
    },
  )
}
