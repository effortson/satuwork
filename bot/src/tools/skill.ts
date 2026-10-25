import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { cachedSkills, type CachedSkill } from '../catalog/index.ts'
import { satuworkHome } from '../home.ts'
import { pinnedBotId } from '../env.ts'
import { scanPii } from '../policy/pii.ts'
import { clip, fail, registerTool, runtimeGateway, ToolFailure } from './common.ts'
import { isWithin } from '../workspace/index.ts'

/**
 * Skill 工具集：`skill_view` / `skills_list` / `skill_manage`。
 *
 * Skill 是这家公司写好的做事方法。改这套之前，挂上的每一条正文都全量拼进系统提示词，
 * 每一轮都在；现在按需的那些只在提示词里留「名字 + 一句话」，正文由模型自己取。
 * 整套的理由、分档、边界见 docs/skills.md。
 *
 * **三个名字照上游（Hermes）原样抄**，包括 `skills_list` 那个和另外两把不一致的复数：
 * 工具名越接近模型见过的约定，调用就越准，这个收益压得过前缀整齐那点洁癖（同
 * docs/file-terminal-tools.md §1）。
 *
 * 读的那两把只看**本机缓存**（目录同步下来的那份），不打网络——它们在每一轮里都可能
 * 被调好几次，而正文早就在手上了。真正要出去的只有两件事：包里的文件（按需拉，见
 * `fetchFiles`）和 `skill_manage` 的写入。
 */
export const name = 'satu-tools-skill'
export const inject = ['tools', 'storage', 'catalog', 'sessions']

/** 单次返回的上限。喂回模型的东西必须有界，理由同 tools/file.ts 那一排上限。 */
const VIEW_MAX_CHARS = Math.max(2000, Math.trunc(Number(process.env.SATUWORK_SKILL_VIEW_MAX_CHARS) || 40_000))
const SEARCH_LIMIT = Math.max(1, Math.trunc(Number(process.env.SATUWORK_SKILL_SEARCH_LIMIT) || 10))
const SEARCH_MAX_LIMIT = Math.max(1, Math.trunc(Number(process.env.SATUWORK_SKILL_SEARCH_MAX_LIMIT) || 20))

/**
 * 席位上 skill 包文件缓存的总量封顶。
 *
 * 一个包最大 5 MB（Gateway 侧 MAX_PACKAGE_BYTES），几十条就能把一块小盘吃掉，而这
 * 底下**全是缓存**：删干净了下次用到再拉一遍就是。
 */
const CACHE_MAX_BYTES = Math.max(
  4 * 1024 * 1024,
  Math.trunc(Number(process.env.SATUWORK_SKILL_FILES_CACHE_MAX) || 64 * 1024 * 1024),
)

/** 缓存根目录。**在席位私有目录里，不在工作区**——它不是员工的文件。 */
const CACHE_ROOT = satuworkHome('skills')

interface RemoteFile {
  path: string
  bytes: number
}

/** 打 Gateway 的 runtime 面。业务失败和管道故障怎么分见 common.ts 的 runtimeGateway。 */
const callGateway = runtimeGateway('这台机器没有配 Gateway，Skill 的这条路走不通。')

export function apply(ctx: Context) {
  // 换版之后缓存里可能是上一版写下的行（缺 displayName / description 这些键），
  // 所以读缓存一律过 catalog 那份归一化，别在这儿直接摸字段。
  const all = () => cachedSkills(ctx)

  /**
   * 名字 → 那条 Skill。
   *
   * 三种都认：索引里印的那个名字（重名时带序号）、原名、id。**模型是照抄索引的**，
   * 但它也会顺手把「退款审核（2）」缩成「退款审核」，所以原名也要认。
   *
   * **原名撞了两条就不许猜。** 那两条讲的是不同的做法（否则管理员不会建第二条），
   * 猜中一半的代价是它照着错的那套把活干完，而没有任何东西会提醒任何人。这时候摆出
   * 带序号的那几个名字，让它自己挑。
   */
  const find = (key: string): CachedSkill => {
    const want = key.trim()
    if (!want) fail('缺少 skill 参数：要哪一条？')
    const list = all()
    /**
     * **重名要看 displayName，不是 name。** 正常情况下 Gateway 已经把重名分开了
     * （「周报模版」「周报模版（2）」），此时输入哪个都不含糊。分不开只发生在老 Gateway
     * 不发这个字段的时候——那时索引里是两行一模一样的字，模型没有任何办法指到第二条，
     * 而**猜中一半的代价是它照着错的那套把活干完**，没有任何东西会提醒任何人。
     */
    const byShown = list.filter((s) => s.displayName === want)
    if (byShown.length > 1) {
      fail(
        `有 ${byShown.length} 条都叫「${want}」，我分不出你要哪一条。` +
          '让管理员把它们改成不同的名字，或者先告诉我这一条是干什么的。',
      )
    }
    if (byShown.length === 1) return byShown[0]
    const sameName = list.filter((s) => s.name === want)
    if (sameName.length > 1) {
      fail(
        `有 ${sameName.length} 条都叫「${want}」，你要哪一条？照索引里的全名写：` +
          `${sameName.map((s) => s.displayName).join('、')}`,
      )
    }
    return (
      sameName[0] ??
      list.find((s) => s.id === want) ??
      list.find((s) => s.displayName.toLowerCase() === want.toLowerCase() || s.name.toLowerCase() === want.toLowerCase()) ??
      missing(want)
    )
  }

  /**
   * 找不到时说什么。
   *
   * **不许只回一句「没有这个 Skill」。** 那在模型眼里等于「这件事没人写过做法」，它
   * 会转头告诉用户做不到——而真相往往只是名字抄歪了一个字。给它几条最像的，外加一条
   * 明确的下一步。
   */
  const missing = (key: string): never => {
    const list = all()
    if (!list.length) {
      fail(`这台席位上一条 Skill 都没有，所以「${key}」也不在。别去猜它的内容，按你自己的判断做事。`)
    }
    const near = rank(list, key).slice(0, 5)
    const hint = near.length
      ? `最像的几条是：${near.map((s) => s.displayName).join('、')}。`
      : `现有的是：${list.slice(0, 8).map((s) => s.displayName).join('、')}${list.length > 8 ? ' 等' : ''}。`
    fail(`没有叫「${key}」的 Skill。${hint}名字要和索引里的一字不差。`)
  }

  /** 分词匹配：名字权重最高，其次说明和标签。**本机搜，不打 Gateway**。 */
  const rank = (list: CachedSkill[], query: string): CachedSkill[] => {
    const terms = query.toLowerCase().split(/[\s,，、]+/).filter(Boolean)
    if (!terms.length) return list
    const scored = list.map((s) => {
      const name = `${s.displayName} ${s.name}`.toLowerCase()
      const desc = s.description.toLowerCase()
      const tags = s.tags.join(' ').toLowerCase()
      let score = 0
      for (const t of terms) {
        if (name.includes(t)) score += 3
        if (desc.includes(t)) score += 2
        if (tags.includes(t)) score += 1
      }
      return { s, score }
    })
    return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).map((x) => x.s)
  }

  // ── 包文件：用到才拉，拉回来就落在席位私有目录里 ──────────────────────

  /** 这条 Skill 这一版的缓存目录。版本进路径，改一次就自然换一个目录。 */
  const cacheDir = (s: CachedSkill) => join(CACHE_ROOT, s.id, String(s.updatedAt))

  /**
   * 缓存总量超了就把最旧的整版删掉。
   *
   * 按目录的 mtime 淘汰，不按「哪条 Skill 更重要」——那是猜。删掉的下次用到再拉，
   * 代价是一次往返，而磁盘满了的代价是这台席位上所有东西一起坏。
   */
  const prune = async () => {
    let entries: { dir: string; bytes: number; at: number }[] = []
    try {
      for (const id of await readdir(CACHE_ROOT)) {
        for (const ver of await readdir(join(CACHE_ROOT, id)).catch(() => [])) {
          const dir = join(CACHE_ROOT, id, ver)
          const info = await stat(dir).catch(() => null)
          if (!info?.isDirectory()) continue
          entries.push({ dir, bytes: await dirBytes(dir), at: info.mtimeMs })
        }
      }
    } catch {
      return
    }
    let total = entries.reduce((n, e) => n + e.bytes, 0)
    if (total <= CACHE_MAX_BYTES) return
    entries = entries.sort((a, b) => a.at - b.at)
    for (const e of entries) {
      if (total <= CACHE_MAX_BYTES) break
      await rm(e.dir, { recursive: true, force: true }).catch(() => {})
      total -= e.bytes
    }
  }

  const dirBytes = async (dir: string): Promise<number> => {
    let n = 0
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) n += await dirBytes(full)
      else if (entry.isFile()) n += (await stat(full).catch(() => null))?.size ?? 0
    }
    return n
  }

  /**
   * 这条 Skill 带了哪些文件。
   *
   * 拉不到时**要说清是哪一种**：「目录取不到」和「这条没有文件」混成同一个空列表的话，
   * Gateway 抖一下模型就会告诉用户资料不存在（docs/skills.md §8）。
   */
  const fetchFiles = async (s: CachedSkill): Promise<RemoteFile[]> => {
    if (!s.hasFiles) return []
    const listFile = join(cacheDir(s), '.files.json')
    try {
      return JSON.parse(await readFile(listFile, 'utf8')) as RemoteFile[]
    } catch {
      // 没缓存过，下面去拉。
    }
    const out = await callGateway<{ files?: RemoteFile[] }>(
      'GET',
      `/runtime/skills/${encodeURIComponent(s.id)}/files?botId=${encodeURIComponent(pinnedBotId())}`,
    )
    const files = Array.isArray(out.files) ? out.files : []
    await mkdir(dirname(listFile), { recursive: true })
    await writeFile(listFile, JSON.stringify(files), 'utf8')
    return files
  }

  /** 一个文件的内容。缓存命中就不出门。返回文本和它落在磁盘上的绝对路径。 */
  const fetchFile = async (s: CachedSkill, path: string): Promise<{ text: string; abs: string }> => {
    const filesDir = join(cacheDir(s), 'files')
    const abs = join(filesDir, path)
    // 比较要带分隔符（isWithin）：不带的话 `files-evil/x` 也以 `files` 开头，越界检查形同虚设。
    if (!isWithin(filesDir, abs)) fail(`路径越界：${path}`)
    try {
      return { text: await readFile(abs, 'utf8'), abs }
    } catch {
      // 没缓存过，下面去拉。
    }
    const out = await callGateway<{ text?: string }>(
      'GET',
      `/runtime/skills/${encodeURIComponent(s.id)}/file?botId=${encodeURIComponent(pinnedBotId())}&path=${encodeURIComponent(path)}`,
    )
    const text = typeof out.text === 'string' ? out.text : ''
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, text, 'utf8')
    await prune()
    return { text, abs }
  }

  const tool = (
    def: Parameters<typeof registerTool>[1],
    execute: Parameters<typeof registerTool>[2],
  ) => registerTool(ctx, def, execute)

  /**
   * 会话里那张卡（`skill/saved`）。
   *
   * 员工唯一一次**在事情发生的当下**看见 Bot 改了自己的机会——事后去 Skill 页面翻
   * 等于没有。落不进去也不影响这次写入：那条 Skill 已经在 Gateway 上了，少的只是
   * 一张卡（docs/skills.md §13）。
   */
  const noteCard = async (
    call: { callId: string; sessionId: string },
    action: 'create' | 'update' | 'remove',
    id: string,
    name: string,
    out: { used?: number; max?: number },
  ) => {
    try {
      await ctx.sessions.append(call.sessionId, 'skill/saved', {
        callId: call.callId,
        id,
        name,
        action,
        ...(typeof out.used === 'number' ? { used: out.used } : {}),
        ...(typeof out.max === 'number' ? { max: out.max } : {}),
      })
    } catch {
      /* 卡片是给人看的，落不下也不该把这次写入判失败 */
    }
  }

  // ── skill_view ───────────────────────────────────────────────────────

  tool(
    {
      name: 'skill_view',
      // 子代理照常有：Skill 是「这家公司怎么做这件事」，它不看就会用通用做法把活干完，
      // 结论看着对、口径全错。
      delegation: {},
      risk: ['read'],
      description:
        '展开一条 Skill 的正文——系统提示词里的 Skill 索引只有名字和一句话说明，真正的做法在这里。' +
        '要按公司的方法做事时先调它，不要照着索引那一句话猜。' +
        '名字照抄索引里的那个。带 file 参数可以读这条 Skill 附带的参考资料、模版或脚本（先不带 file 调一次，返回里会列出它有哪些文件）。',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Skill 的名字，照抄索引里的那个。' },
          file: { type: 'string', description: '要读这条 Skill 附带的哪个文件，路径照返回里列出的那个写。' },
        },
        required: ['skill'],
      },
    },
    async ({ skill, file }: { skill?: string; file?: string }) => {
      if (!skill) fail('缺少 skill 参数：要展开哪一条？')
      const s = find(skill)

      if (file) {
        const files = await fetchFiles(s)
        const hit = files.find((f) => f.path === file)
        if (!hit) {
          const list = files.length ? files.map((f) => f.path).join('、') : '（这条 Skill 没有附带文件）'
          fail(`「${s.displayName}」的包里没有 ${file}。它有的是：${list}`)
        }
        /**
         * 包里只会有文本。二进制在上架那一步就被丢掉了（Gateway 的 `filesOf` 只收
         * `text` 是字符串的条目），所以这里不用再判一次——真要支持二进制，得先让那一侧
         * 收得下，不是在这里猜。
         */
        const got = await fetchFile(s, hit.path)
        return `Skill: ${s.displayName}\n文件: ${hit.path}（本机路径 ${got.abs}）\n\n${clip(got.text, VIEW_MAX_CHARS)}`
      }

      const head = `Skill: ${s.displayName}${s.displayName === s.name ? '' : `（原名「${s.name}」，重名所以带序号）`}`
      let tail = ''
      if (s.hasFiles) {
        try {
          const files = await fetchFiles(s)
          tail = files.length
            ? `\n\n这条 Skill 带了 ${files.length} 个文件，用 skill_view("${s.displayName}", file="路径") 读：\n` +
              files.map((f) => `- ${f.path}（${f.bytes} 字节）`).join('\n')
            : ''
        } catch (e) {
          // **不是「没有文件」**，是这会儿取不到——说清楚，否则模型会告诉用户资料不存在。
          const why = e instanceof ToolFailure ? e.message : (e as Error).message
          tail = `\n\n（这条 Skill 带了文件，但清单这会儿取不到：${why}。正文你手上有，可以先照正文做。）`
        }
      }
      return `${head}\n\n${clip(s.body, VIEW_MAX_CHARS)}${tail}`
    },
  )

  // ── skills_list ──────────────────────────────────────────────────────

  tool(
    {
      name: 'skills_list',
      delegation: {},
      risk: ['read'],
      description:
        '在这台席位的 Skill 里找。返回名字和一句话说明，正文要用 skill_view 展开。' +
        '不带 query 就列出全部。系统提示词里已经有完整索引时不需要它。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词。留空列出全部。' },
          limit: { type: 'number', description: `最多返回几条，默认 ${SEARCH_LIMIT}。` },
        },
      },
    },
    ({ query, limit }: { query?: string; limit?: number }) => {
      const list = all()
      if (!list.length) return '这台席位上一条 Skill 都没有。按你自己的判断做事，不用去找。'
      const cap = Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(Number(limit) || SEARCH_LIMIT)))
      const q = (query ?? '').trim()
      const hits = q ? rank(list, q) : list
      if (!hits.length) {
        /**
         * **搜不到不许回空。** 空结果在模型眼里等于「这个东西不存在」，它会转头告诉
         * 用户做不到。给它路标：有哪些标签、一共几条、下一步怎么走。
         */
        const tags = [...new Set(list.flatMap((s) => s.tags))].slice(0, 10)
        return (
          `这台席位有 ${list.length} 条 Skill，「${q}」一条都没命中。` +
          (tags.length ? `现有的标签是：${tags.join('、')}。` : '') +
          '换个词试试，或者不带 query 调一次看全部。'
        )
      }
      const shown = hits.slice(0, cap)
      const more = hits.length > shown.length ? `\n…还有 ${hits.length - shown.length} 条没列出来，把词写具体一点。` : ''
      return (
        shown.map((s) => `- ${s.displayName}：${s.description || '（这条没写说明）'}${s.hasFiles ? '（带文件）' : ''}`).join('\n') +
        `${more}\n\n用 skill_view("名字") 展开正文。`
      )
    },
  )

  // ── skill_manage ─────────────────────────────────────────────────────

  tool(
    {
      name: 'skill_manage',
      /**
       * **只有主代理有它。** 写记忆是主会话的事：子代理跑完就没了、也没有人在看它，
       * 而一次委派开出五个子代理、每个都觉得自己学到了点什么，就是五条私有档。
       * 子代理要留下方法，把它写进交回来的结论里，由主代理决定记不记。
       */
      delegation: { mode: 'root-only' },
      /**
       * **不带 `external` 位。** 那一位的意思是「出这台席位，打别人家的系统」，而
       * Gateway 是我们自己的控制面；标上它，`no-external` 那道闸一打开，Bot 连自己的
       * 记忆都写不进去（docs/skills.md §9）。
       */
      risk: ['write'],
      description:
        '把一套做法记成 Skill 留下来，下次直接用。用户说「以后都这么干」、或者你刚摸索出一个会重复用到的流程时调它。' +
        '写的是**方法**：什么时候用、分几步、每步的判断依据。不要写具体的人名、单号、金额、密钥——那些是这一次的事，不是方法。' +
        '你只能改自己记下的这些；公司管理员写的那些你读得到、改不了。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'remove'], description: '建一条、改一条、删一条。' },
          skill: { type: 'string', description: 'update / remove 时：要动哪一条，写名字。' },
          name: { type: 'string', description: 'create 时的名字；update 时可用来改名。短、说清是什么活。' },
          body: { type: 'string', description: '正文，markdown。写清「什么时候用」和步骤。' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签，可选。' },
        },
        required: ['action'],
      },
    },
    async (
      {
        action,
        skill,
        name: newName,
        body,
        tags,
      }: {
        action?: string
        skill?: string
        name?: string
        body?: string
        tags?: string[]
      },
      call,
    ) => {
      if (!pinnedBotId()) fail('这台席位没钉 Bot（缺 SATUWORK_BOT_ID），写不了 Skill。')
      const q = `?botId=${encodeURIComponent(pinnedBotId())}`

      if (action === 'create') {
        const nm = (newName ?? '').trim()
        const text = (body ?? '').trim()
        if (!nm) fail('缺少 name：这条 Skill 叫什么？')
        if (!text) fail('缺少 body：把做法写下来，光有名字没用。')
        const out = await callGateway<{ skill: Record<string, unknown>; used: number; max: number }>('POST', `/runtime/skills${q}`, {
          name: nm,
          body: text,
          tags: Array.isArray(tags) ? tags : [],
          pii: scanPii(text),
        })
        ctx.catalog.noteSkill(out.skill)
        void ctx.catalog.pull().catch(() => {})
        const shown = String((out.skill as { displayName?: string }).displayName || nm)
        await noteCard(call, 'create', String((out.skill as { id?: string }).id ?? ''), shown, out)
        /**
         * **必须说「下一轮才看得见」。**
         *
         * 这一轮的系统提示词和工具表在开头就定死了，新建的 Skill 不在索引里。不说这
         * 一句，模型会当场 `skills_list` 一次、发现找不到，然后转头告诉用户「好像没
         * 保存上」——一次成功的写入被它自己描述成失败（docs/skills.md §7）。
         */
        return (
          `已保存：「${shown}」（你自己记下的第 ${out.used} 条，上限 ${out.max}）。\n` +
          '它从**下一轮**开始出现在你的 Skill 索引里，这一轮里你手上就是刚写的那份正文。\n' +
          '记得跟用户说一句你把这套做法记下来了。'
        )
      }

      if (action === 'update') {
        if (!skill) fail('缺少 skill：要改哪一条？')
        const s = find(skill)
        if (s.origin !== 'seat') {
          fail(
            `「${s.displayName}」是${s.origin === 'global' ? '平台' : '公司'}目录里的 Skill，我改不了。` +
              '要改得请管理员在 Skill 页面上改。你可以另建一条自己的补充说明。',
          )
        }
        const text = body === undefined ? undefined : String(body).trim()
        const out = await callGateway<{ skill: Record<string, unknown>; used: number; max: number }>(
          'PATCH',
          `/runtime/skills/${encodeURIComponent(s.id)}${q}`,
          {
            ...(newName ? { name: String(newName).trim() } : {}),
            ...(text === undefined ? {} : { body: text }),
            ...(Array.isArray(tags) ? { tags } : {}),
            ...(text === undefined ? {} : { pii: scanPii(text) }),
          },
        )
        ctx.catalog.noteSkill(out.skill)
        void ctx.catalog.pull().catch(() => {})
        await noteCard(call, 'update', s.id, String((out.skill as { displayName?: string }).displayName || s.displayName), out)
        return `已改好：「${String((out.skill as { displayName?: string }).displayName || s.displayName)}」。索引在下一轮跟上。`
      }

      if (action === 'remove') {
        if (!skill) fail('缺少 skill：要删哪一条？')
        const s = find(skill)
        if (s.origin !== 'seat') {
          fail(`「${s.displayName}」不是你自己记下的，删不了。公司目录里的东西要管理员在界面上删。`)
        }
        const out = await callGateway<{ used: number; max: number }>('DELETE', `/runtime/skills/${encodeURIComponent(s.id)}${q}`)
        ctx.catalog.dropSkill(s.id)
        void ctx.catalog.pull().catch(() => {})
        await noteCard(call, 'remove', s.id, s.displayName, out)
        return `已删掉「${s.displayName}」。你自己记下的还剩 ${out.used} 条（上限 ${out.max}）。`
      }

      fail('action 只能是 create / update / remove。')
    },
  )
}
