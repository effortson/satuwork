/**
 * 全局 Bot / Skill / MCP：owner 建的，所有公司都看得见、都用得上，但只有 owner 能改。
 *
 * 底层早就有 scope='global'，缺的是 owner 这条入口，以及公司管理页原来只读
 * companyCatalog（公司作用域），全局项在公司侧根本不出现。
 */
import { rmSync } from 'node:fs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { startGateway } from './gateway.mjs'

export async function runGlobalCatalog({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-global')
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`

  log('\n# global-catalog')

  const { gw } = await startGateway({
    name: 'global-gw',
    what: 'global gateway',
    home: GW_HOME,
    schema: schemaOf('e2e_global'),
    port: GW_PORT,
    env: {
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
    },
  })

  let owner = ''
  let adminA = ''
  let adminB = ''
  let orgA = ''
  let orgB = ''
  let gBot = ''
  let gSkill = ''
  let gMcp = ''

  const mkOrg = async (name, slug) => {
    const r = await req(base, 'POST', '/platform/orgs', {
      token: owner,
      body: {
        name, slug,
        contactName: '张三', contactPhone: '+86 138 0000 0000', contactEmail: `z@${slug}.test`,
        adminEmail: `a@${slug}.test`, adminPassword: 'correct-horse-1',
      },
    })
    assert(r.status === 201, `org ${name} ${r.status} ${r.text}`)
    const login = await req(base, 'POST', '/auth/login', { body: { email: `a@${slug}.test`, password: 'correct-horse-1' } })
    return { id: r.json.company.id, token: login.json.token }
  }

  try {
    await test('owner 能建全局 Skill / MCP / Bot', async () => {
      const setup = await req(base, 'POST', '/auth/setup', {
        body: { email: 'o@global.test', name: 'o', password: 'correct-horse-1' },
      })
      assert(setup.status === 201, `setup ${setup.status} ${setup.text}`)
      owner = setup.json.token

      const a = await mkOrg('Alpha', 'alpha-g')
      const b = await mkOrg('Beta', 'beta-g')
      orgA = a.id; adminA = a.token
      orgB = b.id; adminB = b.token

      const skill = await req(base, 'POST', '/platform/skills', {
        token: owner, body: { name: '全局周报', body: '# 全局周报\n1. 收集\n2. 汇总', tags: ['通用'] },
      })
      assert(skill.status === 201, `skill ${skill.status} ${skill.text}`)
      gSkill = skill.json.skill.id
      assert(skill.json.skill.origin === 'global', `origin ${skill.json.skill.origin}`)

      const mcp = await req(base, 'POST', '/platform/mcp-servers', {
        token: owner, body: { name: '全局检索', kind: 'SSE', endpoint: 'https://mcp.test/sse', perm: '只读' },
      })
      assert(mcp.status === 201, `mcp ${mcp.status} ${mcp.text}`)
      gMcp = mcp.json.server.id
      assert(mcp.json.server.origin === 'global', `origin ${mcp.json.server.origin}`)

      const bot = await req(base, 'POST', '/platform/bots', {
        token: owner, body: { name: '全局助理', skills: [gSkill], mcps: [gMcp] },
      })
      assert(bot.status === 201, `bot ${bot.status} ${bot.text}`)
      gBot = bot.json.bot.id
      assert(bot.json.bot.origin === 'global', `origin ${bot.json.bot.origin}`)
      assert(bot.json.bot.skills.includes(gSkill), '全局 Bot 没挂上全局 Skill')
      assert(bot.json.bot.mcps.includes(gMcp), '全局 Bot 没挂上全局 MCP')
    })

    await test('两家公司都看得见这三样', async () => {
      for (const [label, token, id] of [['Alpha', adminA, orgA], ['Beta', adminB, orgB]]) {
        const bots = await req(base, 'GET', `/orgs/${id}/bots`, { token })
        assert(bots.status === 200, `${label} bots ${bots.status} ${bots.text}`)
        const b = (bots.json.bots || []).find((x) => x.id === gBot)
        assert(b, `${label} 看不到全局 Bot`)
        assert(b.origin === 'global', `${label} 全局 Bot 没标 origin`)

        const sk = await req(base, 'GET', `/orgs/${id}/skills`, { token })
        assert((sk.json.skills || []).some((x) => x.id === gSkill), `${label} 看不到全局 Skill`)
        assert((sk.json.servers || []).some((x) => x.id === gMcp), `${label} 看不到全局 MCP`)
      }
    })

    await test('公司管理员改不动、删不掉全局项', async () => {
      const patch = await req(base, 'PATCH', `/orgs/${orgA}/bots/${gBot}`, { token: adminA, body: { name: '偷改' } })
      assert(patch.status === 404, `改全局 Bot ${patch.status} ${patch.text}`)
      const del = await req(base, 'DELETE', `/orgs/${orgA}/skills/${gSkill}`, { token: adminA })
      assert(del.status === 404, `删全局 Skill ${del.status}`)
      const delMcp = await req(base, 'DELETE', `/orgs/${orgA}/mcp-servers/${gMcp}`, { token: adminA })
      assert(delMcp.status === 404, `删全局 MCP ${delMcp.status}`)
      // 确认真的没被改掉
      const still = await req(base, 'GET', '/platform/bots', { token: owner })
      assert(still.json.bots.find((x) => x.id === gBot).name === '全局助理', '全局 Bot 被公司管理员改掉了')
    })

    await test('公司管理员打得开全局 Bot 的详情（能看不能改）', async () => {
      // 列表里给了入口，详情就得能拉开——否则点「查看」是个死链。
      const one = await req(base, 'GET', `/orgs/${orgA}/bots/${gBot}`, { token: adminA })
      assert(one.status === 200, `详情 ${one.status} ${one.text}`)
      assert(one.json.bot.origin === 'global', '详情没标 origin')
      // 但写还是不行。
      const patch = await req(base, 'PATCH', `/orgs/${orgA}/bots/${gBot}`, { token: adminA, body: { name: '偷改' } })
      assert(patch.status === 404, `改 ${patch.status}`)
      const del = await req(base, 'DELETE', `/orgs/${orgA}/bots/${gBot}`, { token: adminA })
      assert(del.status === 404, `删 ${del.status}`)
    })

    await test('公司这一层不再建 Bot：POST /orgs/:id/bots 没有这条路由', async () => {
      // 公司的配置收成了一份 Bot 模版，Bot 由员工自己建（POST /runtime/bots）。
      const r = await req(base, 'POST', `/orgs/${orgA}/bots`, { token: adminA, body: { name: '公司 Bot' } })
      assert(r.status === 404, `还能建公司 Bot：${r.status} ${r.text}`)
    })

    await test('别人建的 Bot，管理目录里拉不到', async () => {
      const mine = await req(base, 'POST', '/runtime/bots', { token: adminB, body: { name: 'B 家的私人 Bot' } })
      assert(mine.status === 201, `建 ${mine.status} ${mine.text}`)
      const peek = await req(base, 'GET', `/orgs/${orgA}/bots/${mine.json.bot.id}`, { token: adminA })
      assert(peek.status === 404, `A 家看到了 B 家的 Bot：${peek.status}`)
      // 自己家的管理目录里也不该出现：那一页列的是全局项和停用掉的老公司 Bot。
      const listB = await req(base, 'GET', `/orgs/${orgB}/bots`, { token: adminB })
      assert(!(listB.json.bots || []).some((x) => x.id === mine.json.bot.id), '自建 Bot 漏进了管理目录')
    })

    await test('头像两套不重合：跨层级用会落回本层级默认', async () => {
      // 光靠界面上色不够——那样公司随手改成全局那一款，列表里就分不出来了。
      const sneaky = await req(base, 'POST', '/runtime/bots', {
        token: adminA, body: { name: '越界头像', icon: 'g-shield' },
      })
      assert(sneaky.status === 201, `建 ${sneaky.status} ${sneaky.text}`)
      assert(sneaky.json.bot.icon === 'c-bot', `公司 Bot 用上了全局头像：${sneaky.json.bot.icon}`)

      const back = await req(base, 'POST', '/platform/bots', {
        token: owner, body: { name: '全局用公司头像', icon: 'c-chat' },
      })
      assert(back.json.bot.icon === 'g-core', `全局 Bot 用上了公司头像：${back.json.bot.icon}`)
      await req(base, 'DELETE', `/platform/bots/${back.json.bot.id}`, { token: owner })

      // 改也一样挡住：传了另一层级的键就当没传，保留原值。
      const ok = await req(base, 'PATCH', `/runtime/bots/${sneaky.json.bot.id}`, { token: adminA, body: { icon: 'c-flow' } })
      assert(ok.json.bot.icon === 'c-flow', `本层级的没生效：${ok.json.bot.icon}`)
      const no = await req(base, 'PATCH', `/runtime/bots/${sneaky.json.bot.id}`, { token: adminA, body: { icon: 'g-vault' } })
      assert(no.json.bot.icon === 'c-flow', `跨层级改成功了：${no.json.bot.icon}`)
    })

    await test('全局一套八个、公司一套十个，由 options 下发', async () => {
      const g = await req(base, 'GET', '/platform/bots/options', { token: owner })
      assert(g.json.icons?.length === 8, `全局 ${g.json.icons?.length} 个`)
      assert(g.json.icons.every((k) => k.startsWith('g-')), `全局那套混了别的：${g.json.icons}`)
      const c = await req(base, 'GET', `/orgs/${orgA}/bots/options`, { token: adminA })
      // 公司那套后来补了「设计」「财务」两个（6db31e2）。
      assert(c.json.icons?.length === 10, `公司 ${c.json.icons?.length} 个`)
      assert(c.json.icons.every((k) => k.startsWith('c-')), `公司那套混了别的：${c.json.icons}`)
      // 两套不能有交集，否则「凭头像分辨层级」就不成立了。
      const overlap = g.json.icons.filter((k) => c.json.icons.includes(k))
      assert(overlap.length === 0, `两套有重合：${overlap}`)
    })

    await test('改版前存的老头像键落到新的一套上，不变成默认', async () => {
      const bot = await req(base, 'POST', '/runtime/bots', { token: adminA, body: { name: '老 Bot' } })
      // 直接把库里的 icon 改回旧键，模拟改版前建的 Bot。
      await req(base, 'PATCH', `/runtime/bots/${bot.json.bot.id}`, { token: adminA, body: { icon: 'c-chart' } })
      const read = await req(base, 'GET', `/runtime/bots/${bot.json.bot.id}`, { token: adminA })
      assert(read.json.bot.icon === 'c-chart', `拿到 ${read.json.bot.icon}`)
    })

    await test('公司模版能挂全局 Skill / MCP，员工的 Bot 跟着拿到', async () => {
      const put = await req(base, 'PUT', `/orgs/${orgA}/bot-template`, {
        token: adminA, body: { skills: [gSkill], mcps: [gMcp] },
      })
      assert(put.status === 200, `存模版 ${put.status} ${put.text}`)
      assert(put.json.template.skills.includes(gSkill), '模版挂不上全局 Skill')
      assert(put.json.template.mcps.includes(gMcp), '模版挂不上全局 MCP')

      const mine = await req(base, 'POST', '/runtime/bots', { token: adminA, body: { name: '本公司助理' } })
      assert(mine.status === 201, `建 ${mine.status} ${mine.text}`)
      assert(mine.json.bot.skills.includes(gSkill), '自建 Bot 没继承到模版的 Skill')
      assert(mine.json.bot.mcps.includes(gMcp), '自建 Bot 没继承到模版的 MCP')
      assert(mine.json.bot.scope === 'user', `scope ${mine.json.bot.scope}`)
    })

    await test('全局 Bot 挂不上某一家公司的 Skill——别的公司会找不到它', async () => {
      const own = await req(base, 'POST', `/orgs/${orgA}/skills`, { token: adminA, body: { name: 'A 家私有', body: 'x' } })
      assert(own.status === 201, `建公司 Skill ${own.status} ${own.text}`)
      const bot = await req(base, 'POST', '/platform/bots', {
        token: owner, body: { name: '越界助理', skills: [own.json.skill.id] },
      })
      assert(bot.status === 201, `建 ${bot.status} ${bot.text}`)
      assert(bot.json.bot.skills.length === 0, `公司 Skill 被挂到全局 Bot 上了：${JSON.stringify(bot.json.bot.skills)}`)
      await req(base, 'DELETE', `/platform/bots/${bot.json.bot.id}`, { token: owner })
    })

    await test('B 家看不到 A 家的私有 Skill', async () => {
      const a = await req(base, 'GET', `/orgs/${orgA}/skills`, { token: adminA })
      const priv = a.json.skills.find((x) => x.name === 'A 家私有')
      assert(priv, 'A 家自己看不到自己的 Skill')
      const b = await req(base, 'GET', `/orgs/${orgB}/skills`, { token: adminB })
      assert(!b.json.skills.some((x) => x.id === priv.id), 'B 家看到了 A 家的私有 Skill')
    })

    await test('owner 能改能删全局项；删完两家都看不见了', async () => {
      const patch = await req(base, 'PATCH', `/platform/bots/${gBot}`, { token: owner, body: { name: '全局助理 v2' } })
      assert(patch.status === 200 && patch.json.bot.name === '全局助理 v2', `改 ${patch.status} ${patch.text}`)

      const del = await req(base, 'DELETE', `/platform/mcp-servers/${gMcp}`, { token: owner })
      assert(del.status === 200, `删 ${del.status} ${del.text}`)
      for (const [label, token, id] of [['Alpha', adminA, orgA], ['Beta', adminB, orgB]]) {
        const sk = await req(base, 'GET', `/orgs/${id}/skills`, { token })
        assert(!(sk.json.servers || []).some((x) => x.id === gMcp), `${label} 还看得到已删的全局 MCP`)
      }
    })

    await test('公司管理员进不了平台目录接口', async () => {
      for (const path of ['/platform/bots', '/platform/skills', '/platform/mcp-servers']) {
        const r = await req(base, 'GET', path, { token: adminA })
        assert(r.status === 403, `${path} 拿到 ${r.status}`)
      }
      const create = await req(base, 'POST', '/platform/bots', { token: adminA, body: { name: '偷建' } })
      assert(create.status === 403, `偷建 ${create.status}`)
      const unauth = await req(base, 'GET', '/platform/bots')
      assert(unauth.status === 401, `无票 ${unauth.status}`)
    })

    await test('全局 Skill 的标签跟公司标签互不干扰', async () => {
      const tag = await req(base, 'POST', '/platform/skills/tags', { token: owner, body: { name: '平台专用' } })
      assert(tag.status === 201, `建标签 ${tag.status} ${tag.text}`)
      assert(tag.json.tags.includes('平台专用'), '平台标签没存下')
      const a = await req(base, 'GET', `/orgs/${orgA}/skills`, { token: adminA })
      assert(!(a.json.tags || []).includes('平台专用'), '平台标签漏进公司标签表了')
    })

    /**
     * 平台目录和公司目录以前是两份抄出来的实现，已经漂出两个 bug。收成一个工厂之后
     * 这两条钉的是「两边真的走同一段代码」。
     */
    await test('两个作用域的标签规则一样：12 个字的上限两边都有', async () => {
      const long = '一二三四五六七八九十十一十二十三'
      for (const [label, path, token] of [
        ['平台', '/platform/skills/tags', owner],
        ['公司', `/orgs/${orgA}/skills/tags`, adminA],
      ]) {
        const r = await req(base, 'POST', path, { token, body: { name: long } })
        assert(r.status === 400, `${label}侧超长标签应 400，得到 ${r.status} ${r.text}`)
        const ok = await req(base, 'POST', path, { token, body: { name: '正好' } })
        assert(ok.status === 201, `${label}侧建标签 ${ok.status} ${ok.text}`)
      }
    })

    await test('标签名里有 % 也删得掉，不会变成 500', async () => {
      // 路由器已经 decodeURIComponent 过一次了（见 http.ts 的 Router.match）。
      // 平台那条以前又解了一次，「5%折扣」二次解码抛 URIError，兜底 catch 变 500。
      const tag = '5%折扣'
      for (const [label, path, token] of [
        ['平台', '/platform/skills/tags', owner],
        ['公司', `/orgs/${orgA}/skills/tags`, adminA],
      ]) {
        const made = await req(base, 'POST', path, { token, body: { name: tag } })
        assert(made.status === 201, `${label}侧建 ${made.status} ${made.text}`)
        assert(made.json.tags.includes(tag), `${label}侧没存下：${JSON.stringify(made.json.tags)}`)
        const gone = await req(base, 'DELETE', `${path}/${encodeURIComponent(tag)}`, { token })
        assert(gone.status === 200, `${label}侧删 ${gone.status} ${gone.text}`)
        assert(!gone.json.tags.includes(tag), `${label}侧没删掉：${JSON.stringify(gone.json.tags)}`)
        // touched 两边都要有——以前只有公司侧返回它。
        assert(typeof gone.json.touched === 'number', `${label}侧缺 touched：${gone.text}`)
      }
    })
  } finally {
    gw.kill()
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
