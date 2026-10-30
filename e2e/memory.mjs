/**
 * 长期记忆的 Gateway 一侧（docs/memory.md）。
 *
 * 验的是这一侧的口径——四层怎么归属、谁写得了哪一层、指纹跟不跟着变、删一颗 Bot 时
 * 哪些跟着走。席位那一侧（挑条、话术、标注）在 bot/e2e-memory.mjs。
 *
 * **用线上的默认参数**，不靠调小上限把测试凑出来。唯一调过的是注入上限那一档
 * （模版默认 20 × 2 = 40 条才写得满），因为「写满了」那条路照默认要建四十条，那四十次
 * 往返验的是同一件事。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadApp } from './ui-dom.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { startGateway } from './gateway.mjs'

export async function runMemory({ root, gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-memory')
  // 端口向内核要（见 ports.mjs）：写死的数迟早撞上别的套件或别的 worktree。
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`

  log('\n# memory')

  const { gw } = await startGateway({
    name: 'memory-gw',
    what: 'memory gateway',
    home: GW_HOME,
    schema: schemaOf('e2e_memory'),
    port: GW_PORT,
    env: {
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
      GATEWAY_PLATFORM_TOKEN: 'e2e-platform-memory',
    },
  })

  let owner = ''
  let adminTok = ''
  let memberTok = ''
  let memberId = ''
  let orgId = ''
  let seatTok = ''
  let botId = ''
  let otherBotId = ''

  const q = () => `?botId=${encodeURIComponent(botId)}`

  /** 席位视角的那一份目录。记忆、指纹都从这里读。 */
  const catalog = async (bot = botId) => {
    const r = await req(base, 'GET', `/runtime/catalog?botId=${encodeURIComponent(bot)}`, { token: seatTok })
    assert(r.status === 200, `catalog ${r.status} ${r.text}`)
    return r.json
  }
  const stamp = async () => {
    const r = await req(base, 'GET', `/runtime/catalog/version?botId=${encodeURIComponent(botId)}`, { token: seatTok })
    assert(r.status === 200, `probe ${r.status} ${r.text}`)
    return r.json.stamp
  }
  const seatWrite = (body) => req(base, 'POST', `/runtime/memories${q()}`, { token: seatTok, body })

  try {
    await test('建公司、员工、两颗 Bot，席位拿得到票', async () => {
      const setup = await req(base, 'POST', '/auth/setup', {
        body: { email: 'o@mem.test', name: 'o', password: 'correct-horse-1' },
      })
      assert(setup.status === 201 || setup.status === 200, `setup ${setup.status} ${setup.text}`)
      owner = setup.json.token

      const org = await req(base, 'POST', '/platform/orgs', {
        token: owner,
        body: {
          name: 'Acme', slug: 'acme-mem',
          contactName: '张三', contactPhone: '+86 138 0000 0000', contactEmail: 'z@acme.test',
          adminEmail: 'a@mem.test', adminPassword: 'correct-horse-1',
        },
      })
      assert(org.status === 201, `org ${org.status} ${org.text}`)
      orgId = org.json.company.id
      adminTok = (await req(base, 'POST', '/auth/login', { body: { email: 'a@mem.test', password: 'correct-horse-1' } })).json.token
      await req(base, 'PUT', `/platform/orgs/${orgId}/plan`, { token: owner, body: { seats: 3 } })

      const made = await req(base, 'POST', `/orgs/${orgId}/accounts`, {
        token: adminTok,
        body: { email: 'm@mem.test', name: '小王', password: 'correct-horse-1', role: 'member' },
      })
      assert(made.status === 201, `member ${made.status} ${made.text}`)
      memberId = made.json.account.id
      memberTok = (await req(base, 'POST', '/auth/login', { body: { email: 'm@mem.test', password: 'correct-horse-1' } })).json.token
      seatTok = (await req(base, 'GET', `/platform/accounts/${memberId}`, { token: owner })).json.accessToken

      const a = await req(base, 'POST', '/runtime/bots', { token: memberTok, body: { name: '销售助理' } })
      assert(a.status === 201, `bot ${a.status} ${a.text}`)
      botId = a.json.bot.id
      const b = await req(base, 'POST', '/runtime/bots', { token: memberTok, body: { name: '数据助理' } })
      assert(b.status === 201, `bot2 ${b.status} ${b.text}`)
      otherBotId = b.json.bot.id
    })

    await test('模版上的记忆策略真的下发到席位', async () => {
      /**
       * **这一条是那个坑本身。** Gateway 一直在发 `memory`，而席位的 `RemoteBot` 不声明
       * 就读进来即丢——管理员改了模版、版本号也涨了，运行面纹丝不动（docs/memory.md 开头）。
       * 这里只能验发的那一半，收的那一半在 bot/e2e-memory.mjs。
       */
      const before = await catalog()
      assert(before.bots[0].memory, `目录里该带记忆策略：${JSON.stringify(before.bots[0]).slice(0, 300)}`)
      const saved = await req(base, 'PUT', `/orgs/${orgId}/bot-template`, {
        token: adminTok,
        body: { memory: { on: true, scope: '全公司', kinds: ['偏好', '事实', '联系人'], ttl: '30 天', cap: 5, confirm: false, pii: true } },
      })
      assert(saved.status === 200, `template ${saved.status} ${saved.text}`)
      const after = await catalog()
      assert(after.bots[0].memory.scope === '全公司', `改过的策略没下来：${JSON.stringify(after.bots[0].memory)}`)
      assert(after.bots[0].memory.cap === 5, `cap 没下来：${JSON.stringify(after.bots[0].memory)}`)
    })

    await test('席位写一条：botId 从票和 query 取，写进去的是归一化之后的那份', async () => {
      const r = await seatWrite({ text: '  他姓赵，  不要叫他小王  ', kind: '偏好', layer: 'bot', pii: [] })
      assert(r.status === 201, `write ${r.status} ${r.text}`)
      // 折空白是**这一侧**做的：落进席位缓存的必须是这份，席位不许自己拼一份。
      assert(r.json.memory.text === '他姓赵， 不要叫他小王', `正文该归一化：${JSON.stringify(r.json.memory)}`)
      assert(r.json.memory.layer === 'bot' && r.json.memory.by === 'agent', `层和来源不对：${JSON.stringify(r.json.memory)}`)
      // 模版 ttl 是 30 天：到期时间在**写入当时**算好，之后改模版不追溯。
      assert(typeof r.json.memory.expiresAt === 'number', `该按模版算出到期时间：${JSON.stringify(r.json.memory)}`)
      assert(r.json.used === 1 && r.json.max === 10, `用量该是 1/10（cap 5 × 2）：${r.text}`)
    })

    await test('指纹跟着记忆变——不然改了也永远同步不下来', async () => {
      /**
       * 记忆不在 `catalog_items` 里：不算进指纹的话，每分钟那次探针都判「没变」，
       * 席位会一直带着旧的那份去组提示词，而写接口明明回了成功。私有档 Skill 那次
       * 踩的是同一个洞（docs/skills.md §7、docs/memory.md §5）。
       */
      const before = await stamp()
      const r = await seatWrite({ text: '季度报表在 work/reports 底下', kind: '事实' })
      assert(r.status === 201, `write ${r.status} ${r.text}`)
      const after = await stamp()
      assert(before !== after, `写完指纹该变：${before}`)
      const del = await req(base, 'DELETE', `/runtime/memories/${r.json.memory.id}${q()}`, { token: seatTok })
      assert(del.status === 200, `delete ${del.status} ${del.text}`)
      // 删一条也要能看出来：只看「最新的那个时间」的话，删除不会让任何时间变小。
      assert((await stamp()) !== after, '删完指纹也该变')
    })

    await test('模型只写得了下面两层——上面两层是一条权限边界', async () => {
      for (const layer of ['group', 'company']) {
        const r = await seatWrite({ text: `想写进${layer}`, kind: '事实', layer })
        assert(r.status === 403, `${layer} 层该被拒：${r.status} ${r.text}`)
        // 静默降级会让模型以为自己写成了一条全公司的记忆。
        assert(r.text.includes('管理员'), `拒绝要说清为什么：${r.text}`)
      }
      const all = (await catalog()).memories
      assert(!all.some((m) => m.text.startsWith('想写进')), `一条都不该落库：${JSON.stringify(all)}`)
    })

    await test('类别没勾就拒；认不出的类别也拒', async () => {
      // 模版上勾的是偏好/事实/联系人——把「联系人」摘掉再试。
      await req(base, 'PUT', `/orgs/${orgId}/bot-template`, {
        token: adminTok,
        body: { memory: { on: true, scope: '全公司', kinds: ['偏好', '事实'], ttl: '30 天', cap: 5, confirm: false, pii: true } },
      })
      const off = await seatWrite({ text: '张经理管华东', kind: '联系人' })
      assert(off.status === 403 && off.text.includes('联系人'), `没勾的类别该拒且说清是哪一类：${off.status} ${off.text}`)
      const bad = await seatWrite({ text: '随便一句', kind: '流程' })
      // 「流程」根本不是记忆的一种：它走 Skill 那条路（docs/memory.md §1）。
      assert(bad.status === 400, `认不出的类别该拒：${bad.status} ${bad.text}`)
    })

    await test('完全重复的挡下；太长的挡下且报实际字数', async () => {
      const dup = await seatWrite({ text: '他姓赵， 不要叫他小王', kind: '偏好' })
      assert(dup.status === 409 && dup.text.includes('已经记过'), `重复该挡下：${dup.status} ${dup.text}`)
      const long = await seatWrite({ text: '很长'.repeat(200), kind: '事实' })
      assert(long.status === 400 && long.text.includes('200'), `太长该挡下并报上限：${long.status} ${long.text}`)
    })

    await test('写满了不自动淘汰最老的，让它自己整合', async () => {
      /**
       * 自动淘汰意味着「它记住了，然后某天悄悄忘了」，而人不会收到任何提示。让它撞墙、
       * 自己整合，是唯一能让「忘了什么」留下痕迹的做法（docs/memory.md §8）。
       */
      const filler = []
      let hitCap = false
      for (let i = 0; i < 20 && !hitCap; i++) {
        const r = await seatWrite({ text: `第 ${i} 条占位的事实`, kind: '事实' })
        if (r.status === 409) {
          assert(r.text.includes('记忆满了'), `到顶要说清：${r.text}`)
          assert(r.text.includes('第 0 条'), `要把最老的几条列出来让它整合：${r.text}`)
          hitCap = true
          break
        }
        assert(r.status === 201, `write ${r.status} ${r.text}`)
        filler.push(r.json.memory.id)
      }
      assert(hitCap, '写了二十条还没满，上限没生效')
      // **收拾干净**：写满是这一条的全部内容，留着它会让后面每一次写入都撞上限——
      // 那种失败指向的是这条用例，而不是被它压垮的那几条。
      for (const id of filler) await req(base, 'DELETE', `/runtime/memories/${id}${q()}`, { token: seatTok })
    })

    await test('replace 也判重——不然能改出两条一模一样的', async () => {
      /**
       * 少了这一道，一次 `replace` 就能造出两条一模一样的记忆：两条都每轮进提示词、
       * 都占着额度，而之后想删掉其中一条时 `match` 必然「匹配到多条」——哪条都删不掉。
       */
      const a = await seatWrite({ text: '开票抬头用全称', kind: '事实' })
      assert(a.status === 201, `a ${a.status} ${a.text}`)
      const b = await seatWrite({ text: '收件地址填总部', kind: '事实' })
      assert(b.status === 201, `b ${b.status} ${b.text}`)
      const clash = await req(base, 'PATCH', `/runtime/memories/${b.json.memory.id}${q()}`, {
        token: seatTok,
        body: { text: '开票抬头用全称' },
      })
      assert(clash.status === 409 && clash.text.includes('重复'), `改成另一条的原文该被挡下：${clash.status} ${clash.text}`)
      for (const id of [a.json.memory.id, b.json.memory.id]) {
        await req(base, 'DELETE', `/runtime/memories/${id}${q()}`, { token: seatTok })
      }
    })

    await test('钉住有上限——它不占注入上限，所以自己得有个顶', async () => {
      /**
       * 钉住的每一轮都在、不受「注入上限」那根滑杆约束。没有这道闸的话，钉满几十条
       * 就是每轮白多上万 token，而那一段还不在压缩判据里（docs/memory.md §12 ①）。
       */
      const ids = []
      for (let i = 0; i < 12; i++) {
        const r = await req(base, 'POST', `/runtime/bots/${botId}/memories`, {
          token: memberTok,
          body: { text: `钉住候选 ${i}`, kind: '事实' },
        })
        assert(r.status === 201, `建 ${r.status} ${r.text}`)
        ids.push(r.json.memory.id)
      }
      // 新建时不许直接钉：钉住要过上限那道判断。
      assert(
        (await req(base, 'GET', `/runtime/bots/${botId}/memories`, { token: memberTok })).json.items.every((m) => !m.pinned),
        '新建的不该直接是钉住的',
      )
      let hit = ''
      for (const id of ids) {
        const r = await req(base, 'PATCH', `/runtime/bots/${botId}/memories/${id}`, { token: memberTok, body: { pinned: true } })
        if (r.status === 409) {
          hit = r.text
          break
        }
        assert(r.status === 200, `钉 ${r.status} ${r.text}`)
      }
      assert(hit.includes('最多只能钉住'), `钉到上限该说清：${hit || '一直没到上限'}`)
      for (const id of ids) await req(base, 'DELETE', `/runtime/bots/${botId}/memories/${id}`, { token: memberTok })
    })

    await test('bot 层不跨 Bot，self 层跨', async () => {
      const self = await req(base, 'POST', `/runtime/memories?botId=${encodeURIComponent(otherBotId)}`, {
        token: seatTok,
        body: { text: '他习惯早上看数据', kind: '偏好', layer: 'self' },
      })
      assert(self.status === 201, `self ${self.status} ${self.text}`)
      const here = (await catalog(botId)).memories.map((m) => m.text)
      const there = (await catalog(otherBotId)).memories.map((m) => m.text)
      // self 层两颗都看得到。
      assert(here.includes('他习惯早上看数据') && there.includes('他习惯早上看数据'), 'self 层该跨 Bot')
      // bot 层只有自己那颗看得到——**可见性写在 where 里**，不是调用点过滤。
      assert(here.includes('他姓赵， 不要叫他小王'), 'bot 层在自己这儿该看得到')
      assert(!there.includes('他姓赵， 不要叫他小王'), 'bot 层不该跨 Bot')
    })

    await test('人这一侧改得动自己那两层，改不动上面两层', async () => {
      const list = await req(base, 'GET', `/runtime/bots/${botId}/memories`, { token: memberTok })
      assert(list.status === 200, `list ${list.status} ${list.text}`)
      const one = list.json.items.find((m) => m.text.startsWith('他姓赵'))
      assert(one, `该看得见 Bot 记的东西：${list.text}`)
      const patched = await req(base, 'PATCH', `/runtime/bots/${botId}/memories/${one.id}`, {
        token: memberTok,
        body: { text: '他姓赵，叫他赵工' },
      })
      assert(patched.status === 200, `patch ${patched.status} ${patched.text}`)
      // 人改过一个字就等于确认它还成立——`by` 跟着换，事后才查得出这句话是谁定的。
      assert(patched.json.memory.by === 'user', `人改过就该记成 user：${patched.text}`)
    })

    await test('升层只有管理员点得动，而且是搬家不是复制', async () => {
      const list = await req(base, 'GET', `/runtime/bots/${otherBotId}/memories`, { token: memberTok })
      const self = list.json.items.find((m) => m.layer === 'self')
      assert(self, `该有一条 self 层的：${list.text}`)
      const nope = await req(base, 'POST', `/runtime/memories/${self.id}/lift`, {
        token: memberTok,
        body: { to: 'company' },
      })
      assert(nope.status === 403, `成员不该升得动：${nope.status} ${nope.text}`)
      /**
       * 那两层会逐字进入本公司每个人的系统提示词——不是一条设置，是一次对所有人的广播
       * （docs/memory.md §12 ⑤）。
       */
      /**
       * **管理员的 Bot 列表里没有这颗 Bot**——这条路要是挂在 `/runtime/bots/:botId/`
       * 底下，按调用者自己的 Bot 认人，一定是 404。升层是公司这一层的动作。
       */
      const lifted = await req(base, 'POST', `/runtime/memories/${self.id}/lift`, {
        token: adminTok,
        body: { to: 'company' },
      })
      assert(lifted.status === 200, `lift ${lifted.status} ${lifted.text}`)
      assert(lifted.json.memory.layer === 'company', `该升上去：${lifted.text}`)
      const after = (await catalog(otherBotId)).memories.filter((m) => m.text === '他习惯早上看数据')
      // 搬家不是复制：留一份在原处，两份会各自被编辑，然后在某天说不同的话。
      assert(after.length === 1 && after[0].layer === 'company', `该只剩升上去的那一条：${JSON.stringify(after)}`)
    })

    await test('席位改不动升上去的那条，而且要说清为什么', async () => {
      const co = (await catalog()).memories.find((m) => m.layer === 'company')
      assert(co, '公司层那条该下发给这颗 Bot')
      const r = await req(base, 'PATCH', `/runtime/memories/${co.id}${q()}`, { token: seatTok, body: { text: '改一下' } })
      assert(r.status === 403, `该拒：${r.status} ${r.text}`)
      // 回一句「没有这条」只会让模型换个说法再试一次（docs/memory.md §4）。
      assert(r.text.includes('管理员'), `要说清为什么，不是说不存在：${r.text}`)
    })

    await test('判重只看这颗 Bot 真的读得到的那几层', async () => {
      /**
       * `scope` 是「仅本人」时，公司层那些条目一条都不会进它的提示词——拿它们去挡写入，
       * 模型收到的是「这条已经记过了」，而它永远看不见那一条，于是既记不下来、也答不
       * 上来（docs/memory.md §6）。
       */
      const co = (await catalog()).memories.find((m) => m.layer === 'company')
      assert(co, '得先有一条公司层的（上一条用例升上去的）')
      // 「全公司」范围下：公司层看得见，所以判重该挡。
      const blocked = await seatWrite({ text: co.text, kind: '事实' })
      assert(blocked.status === 409, `范围含公司层时该判重：${blocked.status} ${blocked.text}`)
      // 收窄到「仅本人」：那一条不再进提示词，也就不该再拿它挡写入。
      await req(base, 'PUT', `/orgs/${orgId}/bot-template`, {
        token: adminTok,
        body: { memory: { on: true, scope: '仅本人', kinds: ['偏好', '事实'], ttl: '30 天', cap: 5, confirm: false, pii: true } },
      })
      const allowed = await seatWrite({ text: co.text, kind: '事实' })
      assert(allowed.status === 201, `收窄范围之后该记得下：${allowed.status} ${allowed.text}`)
      await req(base, 'DELETE', `/runtime/memories/${allowed.json.memory.id}${q()}`, { token: seatTok })
      await req(base, 'PUT', `/orgs/${orgId}/bot-template`, {
        token: adminTok,
        body: { memory: { on: true, scope: '全公司', kinds: ['偏好', '事实'], ttl: '30 天', cap: 5, confirm: false, pii: true } },
      })
    })

    await test('删一颗 Bot：bot 层跟着走，self 层留下', async () => {
      /**
       * **删除确认框那句话原来是错的**：`self` 层是这个人所有 Bot 共用的一份——删掉
       * 销售助理，不该让数据助理忘了他姓什么（docs/memory.md §12 ④）。
       */
      const selfOne = await req(base, 'POST', `/runtime/memories${q()}`, {
        token: seatTok,
        body: { text: '他在杭州办公', kind: '事实', layer: 'self' },
      })
      assert(selfOne.status === 201, `self ${selfOne.status} ${selfOne.text}`)
      const del = await req(base, 'DELETE', `/runtime/bots/${botId}`, { token: memberTok })
      assert(del.status === 200, `删 Bot ${del.status} ${del.text}`)
      const left = (await catalog(otherBotId)).memories.map((m) => m.text)
      assert(left.includes('他在杭州办公'), `self 层该留下：${JSON.stringify(left)}`)
      assert(!left.includes('他姓赵，叫他赵工'), `bot 层该跟着 Bot 走：${JSON.stringify(left)}`)
    })
    await test('界面：「它记下的事实」那一块真的进得了自己那颗 Bot 的设置页', () => {
      /**
       * **这一条盯的是「这张列表有没有进任何一个页面」。**
       *
       * 第一版就栽在这儿：`memoryPanel` 只挂在公司模版页和公司 Bot 详情页上，而那两处
       * 都不拉每颗 Bot 的记忆——于是「已存记忆」在**任何一屏上都看不到**。接口是通的、
       * 挑选逻辑是对的、文件也装载得起来，没有一处会因此变红，只有人打开那一屏才发现
       * 底下什么都没有。
       *
       * 所以这里**真的把那一屏渲染出来**，按人看得见的字去找。
       */
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base })
      ui.state.template = { version: 4, prompt: 'soul', skills: [], mcps: [] }
      ui.state.botOptions = { skills: [], mcps: [] }
      const bot = { id: 'b1', name: '我的助手', scope: 'user', origin: 'company', templateVersion: 4 }
      const draft = {
        name: '我的助手', description: '', icon: 'bot', enabled: true, extraPrompt: '', greeting: '',
        guards: [], memoryOn: true, scope: '所属分组', kinds: ['偏好', '事实'], ttl: '90 天', cap: 20,
        confirmOn: true, piiOn: true, memoryUsed: 1, memoryMax: 40,
        memories: [{ id: 'm1', layer: 'self', kind: '偏好', text: '发邮件时提醒抄送法务', by: 'agent', pii: [], pinned: false, expiresAt: Date.now() + 86_400_000 }],
      }
      const html = ui.myBotPage(bot, draft)
      assert(html.includes('它记下的事实'), '自己那颗 Bot 的设置页上没有记忆那一块')
      assert(html.includes('发邮件时提醒抄送法务'), `正文没渲染出来`)
      assert(html.includes('所有 Bot'), 'self 层该标出「所有 Bot」')
      // 这一块是**能动的**，不像上面那几块「继承自公司模版」是只读的。
      assert(html.includes('bot-mem-del') && html.includes('bot-mem-pin'), '删除 / 钉住按钮不在')
      assert(html.includes('1 / 40'), '用量该写成「存了多少 / 存得下多少」')
      // 删完要等一次目录探针，不说的话人会以为「删除没用」。
      assert(html.includes('一分钟'), '少了「改动最多一分钟后生效」那句')
      // 没拉到记忆时整块不画：空列表和「还没拉过」不能长得一样（模版页就属于后者）。
      assert(!ui.myBotPage(bot, { ...draft, memories: undefined }).includes('它记下的事实'), '没拉到记忆时不该画这一块')
      // 开关关着时条目仍要列出来——人得删得掉遗留的那些。
      assert(ui.myBotPage(bot, { ...draft, memoryOn: false }).includes('不会进对话'), '开关关着时该说清这些不进对话')
    })
  } finally {
    gw.kill('SIGTERM')
    // 自己的数据目录自己收。
    rmSync(GW_HOME, { recursive: true, force: true })
  }
}
