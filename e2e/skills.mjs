/**
 * Skill 按需加载与私有档（docs/skills.md）。
 *
 * 验的是 Gateway 这一侧的口径——分档字段怎么算、重名怎么分、包文件怎么下发、Bot 自己
 * 写的那一档谁能写谁能删。席位那一侧（索引分档、三把工具的话术）在 bot/e2e-skills.mjs。
 *
 * **用线上的默认参数**，不靠调小上限把测试凑出来：上限调小了，验的就是 mock 而不是
 * 这套东西本身。唯一调过的是私有档条数（30 → 3），因为「写满了」这条路照默认要建 30
 * 条 Skill，那三十次往返验的是同一件事。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'

const PLATFORM_TOK = 'e2e-platform-skills'

export async function runSkills({ root, gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-skills')
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`

  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# skills')

  const gw = start('skills-gw', ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schemaOf('e2e_skills'),
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
      GATEWAY_PLATFORM_TOKEN: PLATFORM_TOK,
      // 「写满了」那条路：默认 30 条要建三十次，验的却是同一件事。
      GATEWAY_SEAT_SKILL_MAX: '3',
    },
  })
  await waitHttp(`${base}/health`, { child: gw, what: 'skills gateway' })

  let owner = ''
  let adminTok = ''
  let memberTok = ''
  let memberId = ''
  let orgId = ''
  let seatTok = ''
  let botId = ''
  let zipId = ''
  let refundId = ''

  /** 席位视角的那一份目录。私有档、重名序号、mode 都从这里读。 */
  const catalogSkills = async () => {
    const r = await req(base, 'GET', `/runtime/catalog?botId=${encodeURIComponent(botId)}`, { token: seatTok })
    assert(r.status === 200, `catalog ${r.status} ${r.text}`)
    return r.json.skills
  }

  const stamp = async () => {
    const r = await req(base, 'GET', `/runtime/catalog/version?botId=${encodeURIComponent(botId)}`, { token: seatTok })
    assert(r.status === 200, `probe ${r.status} ${r.text}`)
    return r.json.stamp
  }

  try {
    await test('建公司、员工、Bot，席位拿得到票', async () => {
      const setup = await req(base, 'POST', '/auth/setup', {
        body: { email: 'o@sk.test', name: 'o', password: 'correct-horse-1' },
      })
      assert(setup.status === 201 || setup.status === 200, `setup ${setup.status} ${setup.text}`)
      owner = setup.json.token

      const org = await req(base, 'POST', '/platform/orgs', {
        token: owner,
        body: {
          name: 'Acme', slug: 'acme-sk',
          contactName: '张三', contactPhone: '+86 138 0000 0000', contactEmail: 'z@acme.test',
          adminEmail: 'a@sk.test', adminPassword: 'correct-horse-1',
        },
      })
      assert(org.status === 201, `org ${org.status} ${org.text}`)
      orgId = org.json.company.id
      adminTok = (await req(base, 'POST', '/auth/login', { body: { email: 'a@sk.test', password: 'correct-horse-1' } })).json.token
      await req(base, 'PUT', `/platform/orgs/${orgId}/plan`, { token: owner, body: { seats: 3 } })

      const made = await req(base, 'POST', `/orgs/${orgId}/accounts`, {
        token: adminTok,
        body: { email: 'm@sk.test', name: '小王', password: 'correct-horse-1', role: 'member' },
      })
      assert(made.status === 201, `member ${made.status} ${made.text}`)
      memberId = made.json.account.id
      memberTok = (await req(base, 'POST', '/auth/login', { body: { email: 'm@sk.test', password: 'correct-horse-1' } })).json.token
      seatTok = (await req(base, 'GET', `/platform/accounts/${memberId}`, { token: owner })).json.accessToken

      const bot = await req(base, 'POST', '/runtime/bots', { token: memberTok, body: { name: '小助手' } })
      assert(bot.status === 201, `bot ${bot.status} ${bot.text}`)
      botId = bot.json.bot.id
    })

    await test('frontmatter 的 description 赢过正文首段；没有 frontmatter 就退回首段', async () => {
      const withMeta = await req(base, 'POST', `/orgs/${orgId}/skills`, {
        token: adminTok,
        body: {
          name: '退款审核',
          body: '---\nname: 别的名字\ndescription: 客户要求退款时，按金额分档走哪条流程\n---\n\n正文第一段不该被当成说明。\n\n- 第一步\n- 第二步',
        },
      })
      assert(withMeta.status === 201, `create ${withMeta.status} ${withMeta.text}`)
      refundId = withMeta.json.skill.id
      assert(withMeta.json.skill.description.startsWith('客户要求退款时'), `description 该来自 frontmatter：${withMeta.text}`)
      // 目录项的名字赢：界面上改的那个才是最终的名字。
      assert(withMeta.json.skill.name === '退款审核', `名字该以目录项为准：${withMeta.json.skill.name}`)

      const plain = await req(base, 'POST', `/orgs/${orgId}/skills`, {
        token: adminTok,
        body: { name: '周报模版', body: '把一周的工单汇成那份固定格式的周报。\n\n- 拉工单\n- 套模版' },
      })
      assert(plain.status === 201, `create ${plain.status} ${plain.text}`)
      assert(plain.json.skill.description.startsWith('把一周的工单'), `没有 frontmatter 该退回首段：${plain.text}`)
    })

    await test('新建的默认按需；存量（定义里没有 mode）读成常驻', async () => {
      const fresh = await req(base, 'GET', `/orgs/${orgId}/skills/${refundId}`, { token: adminTok })
      assert(fresh.json.skill.mode === '按需', `新建该默认按需：${fresh.json.skill.mode}`)

      /**
       * **存量那一条不能靠改常量来验。** 用平台那条原样写 definition 的路造一条「没有
       * mode 键」的记录——那正是这次改动之前库里躺着的形状。它必须读成常驻：那些 Skill
       * 是在「全文常驻」的年代写的，换个默认值就是趁人不注意改了它们的行为。
       */
      const legacy = await req(base, 'POST', '/catalog/skills', {
        token: PLATFORM_TOK,
        body: { name: '老口径', definition: { body: '一律用中文回复。', source: '手动编写', enabled: true } },
      })
      assert(legacy.status === 201, `legacy ${legacy.status} ${legacy.text}`)
      const seen = (await catalogSkills()).find((x) => x.id === legacy.json.item.id)
      assert(seen, '全局 Skill 没下发到席位')
      assert(seen.mode === '常驻', `存量该读成常驻，实际 ${seen.mode}`)

      const patched = await req(base, 'PATCH', `/orgs/${orgId}/skills/${refundId}`, {
        token: adminTok,
        body: { mode: '常驻' },
      })
      assert(patched.json.skill.mode === '常驻', `改档没生效：${patched.text}`)
      // 改正文不该顺手把档位改回默认。
      const again = await req(base, 'PATCH', `/orgs/${orgId}/skills/${refundId}`, {
        token: adminTok,
        body: { body: '改了一版正文。' },
      })
      assert(again.json.skill.mode === '常驻', `没传 mode 就不该动它：${again.text}`)
      await req(base, 'PATCH', `/orgs/${orgId}/skills/${refundId}`, { token: adminTok, body: { mode: '按需' } })
    })

    await test('重名的第二条带序号下发，序号跟着数据走', async () => {
      const dup = await req(base, 'POST', `/orgs/${orgId}/skills`, {
        token: adminTok,
        body: { name: '周报模版', body: '另一套周报做法。' },
      })
      assert(dup.status === 201, `dup ${dup.status} ${dup.text}`)
      const list = await catalogSkills()
      const names = list.filter((x) => x.name === '周报模版').map((x) => x.displayName).sort()
      assert(names.length === 2, `该有两条同名的：${JSON.stringify(names)}`)
      assert(names.includes('周报模版') && names.includes('周报模版（2）'), `序号不对：${JSON.stringify(names)}`)
      await req(base, 'DELETE', `/orgs/${orgId}/skills/${dup.json.skill.id}`, { token: adminTok })
    })

    await test('ZIP 包的文件不随目录下发，用到才拉；包里没有的要说清楚', async () => {
      const zip = await req(base, 'POST', `/orgs/${orgId}/skills`, {
        token: adminTok,
        body: {
          name: '对账流程',
          source: 'ZIP 包',
          files: [
            { path: 'skill.md', text: '每月对账怎么做。\n\n- 拉流水\n- 核差额' },
            { path: 'references/口径.md', text: '差额在 1 元以内不追。' },
          ],
        },
      })
      assert(zip.status === 201, `zip ${zip.status} ${zip.text}`)
      zipId = zip.json.skill.id
      assert(zip.json.skill.hasFiles === true, `该标着有文件：${zip.text}`)

      const inCatalog = (await catalogSkills()).find((x) => x.id === zipId)
      assert(inCatalog.hasFiles === true, '席位要知道它带了文件')
      assert(inCatalog.files === undefined, `正文清单不该随目录下发：${JSON.stringify(inCatalog).slice(0, 200)}`)

      const files = await req(base, 'GET', `/runtime/skills/${zipId}/files?botId=${botId}`, { token: seatTok })
      assert(files.status === 200, `files ${files.status} ${files.text}`)
      const paths = files.json.files.map((f) => f.path)
      assert(paths.includes('references/口径.md'), `清单不对：${JSON.stringify(paths)}`)

      const one = await req(base, 'GET', `/runtime/skills/${zipId}/file?botId=${botId}&path=${encodeURIComponent('references/口径.md')}`, {
        token: seatTok,
      })
      assert(one.status === 200 && one.json.text.includes('1 元以内'), `取文件失败：${one.status} ${one.text}`)

      const nope = await req(base, 'GET', `/runtime/skills/${zipId}/file?botId=${botId}&path=nope.md`, { token: seatTok })
      assert(nope.status === 404, `包里没有的该 404，实际 ${nope.status}`)

      // 管理员那一屏要能核对包里有什么——详情带清单，列表不带。
      const detail = await req(base, 'GET', `/orgs/${orgId}/skills/${zipId}`, { token: adminTok })
      assert(detail.json.skill.files.length === 2, `详情该带文件清单：${detail.text}`)
      const listing = await req(base, 'GET', `/orgs/${orgId}/skills`, { token: adminTok })
      const zipInList = listing.json.skills.find((x) => x.id === zipId)
      assert(zipInList.files === undefined, '列表不该带文件清单')
      assert(zipInList.fileCount === 2, `列表该有文件数：${JSON.stringify(zipInList).slice(0, 200)}`)
    })

    await test('Bot 自己写一条：落私有档、一律按需、指纹跟着变', async () => {
      const before = await stamp()
      const made = await req(base, 'POST', `/runtime/skills?botId=${botId}`, {
        token: seatTok,
        // 模型给了 mode 也不作数：常驻是管理员点的。
        body: { name: '周报工单导出', body: '用户说「以后都这么干」时按这个来。\n\n- 拉上周工单\n- 按状态分组', mode: '常驻', tags: ['自动化'] },
      })
      assert(made.status === 201, `create ${made.status} ${made.text}`)
      assert(made.json.skill.mode === '按需', `模型写的一律按需，实际 ${made.json.skill.mode}`)
      assert(made.json.skill.origin === 'seat', `该落私有档：${made.json.skill.origin}`)
      assert(made.json.used === 1 && made.json.max === 3, `条数不对：${made.text}`)

      /**
       * **指纹必须跟着变。** 不变的话，每分钟那次探针都判「没变」，这条 Skill 永远不会
       * 出现在它的索引里——而工具明明回了成功。这是那种「哪一处看起来都对」的故障。
       */
      assert((await stamp()) !== before, '写完私有档，目录指纹该变')
      const seen = (await catalogSkills()).find((x) => x.id === made.json.skill.id)
      assert(seen && seen.origin === 'seat', '私有档没下发回这颗 Bot')
    })

    await test('私有档不跨 Bot，也不进别人的目录', async () => {
      const other = await req(base, 'POST', '/runtime/bots', { token: memberTok, body: { name: '第二颗' } })
      assert(other.status === 201, `bot2 ${other.status} ${other.text}`)
      const theirs = await req(base, 'GET', `/runtime/catalog?botId=${other.json.bot.id}`, { token: seatTok })
      assert(
        !theirs.json.skills.some((x) => x.origin === 'seat'),
        `另一颗 Bot 不该看见这颗的私有档：${JSON.stringify(theirs.json.skills.map((x) => x.name))}`,
      )

      /**
       * 目录页那条接口成员也调得到。私有档的正文是模型从员工对话里写下的——主人自己
       * 看得见，同公司的另一个成员不行；管理员照旧看全公司的（晋升那条用例在测）。
       */
      const own = await req(base, 'GET', `/orgs/${orgId}/skills`, { token: memberTok })
      assert(own.status === 200, `member list ${own.status} ${own.text}`)
      assert(
        own.json.skills.some((x) => x.origin === 'seat' && x.name === '周报工单导出'),
        `主人该看得见自己 Bot 写的私有档：${JSON.stringify(own.json.skills.map((x) => x.name))}`,
      )
      const peer = await req(base, 'POST', `/orgs/${orgId}/accounts`, {
        token: adminTok,
        body: { email: 'm2@sk.test', name: '小李', password: 'correct-horse-1', role: 'member' },
      })
      assert(peer.status === 201, `member2 ${peer.status} ${peer.text}`)
      const peerTok = (await req(base, 'POST', '/auth/login', { body: { email: 'm2@sk.test', password: 'correct-horse-1' } })).json.token
      const peerList = await req(base, 'GET', `/orgs/${orgId}/skills`, { token: peerTok })
      assert(peerList.status === 200, `member2 list ${peerList.status} ${peerList.text}`)
      assert(
        !peerList.json.skills.some((x) => x.origin === 'seat'),
        `同事不该翻得到别人 Bot 的私有档：${JSON.stringify(peerList.json.skills.map((x) => x.name))}`,
      )
      assert(peerList.json.skills.some((x) => x.id === refundId), '公司目录照旧看得见')
      const seatId = own.json.skills.find((x) => x.origin === 'seat').id
      const peerOne = await req(base, 'GET', `/orgs/${orgId}/skills/${seatId}`, { token: peerTok })
      assert(peerOne.status === 404, `单条详情也不该给同事，实际 ${peerOne.status}`)
    })

    await test('撞名不自动加序号，写满了要说清楚', async () => {
      const clash = await req(base, 'POST', `/runtime/skills?botId=${botId}`, {
        token: seatTok,
        body: { name: '周报工单导出', body: '又写了一遍。' },
      })
      assert(clash.status === 409, `撞名该拒，实际 ${clash.status} ${clash.text}`)
      assert(clash.json.error.includes('周报工单导出'), `拒绝要点名是哪一条：${clash.text}`)

      // 公司目录里那条的名字同样撞得着——模型改不了它，所以只能换个名字。
      const overCompany = await req(base, 'POST', `/runtime/skills?botId=${botId}`, {
        token: seatTok,
        body: { name: '退款审核', body: '我自己的一套。' },
      })
      assert(overCompany.status === 409, `和公司目录撞名也该拒，实际 ${overCompany.status}`)

      for (const n of [2, 3]) {
        const r = await req(base, 'POST', `/runtime/skills?botId=${botId}`, {
          token: seatTok,
          body: { name: `凑数 ${n}`, body: '正文' },
        })
        assert(r.status === 201, `凑数 ${n} 失败：${r.status} ${r.text}`)
      }
      const full = await req(base, 'POST', `/runtime/skills?botId=${botId}`, {
        token: seatTok,
        body: { name: '第四条', body: '正文' },
      })
      assert(full.status === 409, `写满了该拒，实际 ${full.status}`)
      assert(full.json.error.includes('3'), `要说清楚上限是多少：${full.text}`)
    })

    await test('模型改不动公司目录里的那些', async () => {
      const bad = await req(base, 'PATCH', `/runtime/skills/${refundId}?botId=${botId}`, {
        token: seatTok,
        body: { body: '我改一下公司的口径。' },
      })
      assert(bad.status === 403, `该 403，实际 ${bad.status} ${bad.text}`)
      assert(bad.json.error.includes('管理员'), `拒绝要指路：${bad.text}`)

      const badDel = await req(base, 'DELETE', `/runtime/skills/${zipId}?botId=${botId}`, { token: seatTok })
      assert(badDel.status === 403, `删公司目录该 403，实际 ${badDel.status}`)
    })

    await test('晋升是人点的：转成公司 Skill 之后所有 Bot 都看得见', async () => {
      const mine = (await req(base, 'GET', `/orgs/${orgId}/skills`, { token: adminTok })).json.skills.find(
        (x) => x.name === '周报工单导出',
      )
      assert(mine && mine.origin === 'seat', `管理员那一屏要看得见私有档：${JSON.stringify(mine)}`)
      assert(mine.botId === botId, `要看得出是哪颗 Bot 写的：${JSON.stringify(mine)}`)

      const promoted = await req(base, 'POST', `/orgs/${orgId}/skills/${mine.id}/promote`, { token: adminTok })
      assert(promoted.status === 200, `promote ${promoted.status} ${promoted.text}`)
      assert(promoted.json.skill.origin === 'company', `该搬进公司目录：${promoted.text}`)

      const bots = (await req(base, 'GET', '/runtime/bots', { token: memberTok })).json.bots
      const other = bots.find((b) => b.id !== botId)
      const theirs = await req(base, 'GET', `/runtime/catalog?botId=${other.id}`, { token: seatTok })
      assert(theirs.json.skills.some((x) => x.id === mine.id), '晋升之后别的 Bot 也该看得见')

      // 晋升是搬不是拷：私有档那一栏里不该再有它。
      const after = (await req(base, 'GET', `/orgs/${orgId}/skills`, { token: adminTok })).json.skills
      assert(!after.some((x) => x.id === mine.id && x.origin === 'seat'), '晋升之后不该还留在私有档里')
    })

    await test('主人在对话里删得掉自己那条，别人删不掉', async () => {
      const mine = (await catalogSkills()).find((x) => x.origin === 'seat')
      assert(mine, '手上该还有私有档')

      const byAdmin = await req(base, 'DELETE', `/runtime/bots/${botId}/skills/${mine.id}`, { token: adminTok })
      assert(byAdmin.status === 404, `不是主人就删不掉，实际 ${byAdmin.status}`)

      const byOwner = await req(base, 'DELETE', `/runtime/bots/${botId}/skills/${mine.id}`, { token: memberTok })
      assert(byOwner.status === 200, `主人该删得掉：${byOwner.status} ${byOwner.text}`)
      assert(!(await catalogSkills()).some((x) => x.id === mine.id), '删完不该还在目录里')
    })

    await test('管理员也删得掉私有档，审计分得出人和 Bot', async () => {
      const left = (await req(base, 'GET', `/orgs/${orgId}/skills`, { token: adminTok })).json.skills.filter(
        (x) => x.origin === 'seat',
      )
      assert(left.length, '手上该还有私有档')
      const del = await req(base, 'DELETE', `/orgs/${orgId}/skills/${left[0].id}`, { token: adminTok })
      assert(del.status === 200, `管理员该删得掉：${del.status} ${del.text}`)

      const audit = await req(base, 'GET', `/orgs/${orgId}/audit`, { token: adminTok })
      assert(audit.status === 200, `audit ${audit.status} ${audit.text}`)
      const rows = audit.json.events || audit.json.items || []
      const byBot = rows.find((x) => x.action === 'catalog.create' && x.detail && x.detail.by === 'bot')
      assert(byBot, `审计里要分得出「Bot 自己写的」：${JSON.stringify(rows.slice(0, 4))}`)
      assert(byBot.detail.botId === botId, `要记下是哪颗 Bot：${JSON.stringify(byBot.detail)}`)
      assert(rows.some((x) => x.action === 'catalog.promote'), '晋升要落审计')
    })

    await test('界面：点开一条 ZIP Skill，包里的文件清单要真的列出来', async () => {
      /**
       * **清单只有单条详情才带**（列表那一屏几十条，每条再挂两百行路径就是几百 KB）。
       * 弹窗要自己去补那一次请求——不补的话这一格永远是空的，而管理员点开它正是为了
       * 核对包里有什么（docs/skills.md §13 第 3 条）。
       */
      const { loadApp, el } = await import('./ui-dom.mjs')
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: adminTok })
      await ui.boot()
      ui.state.path = '/skills'
      // 这一屏的数据平时由 loadSkills 拉，那个函数没导出来——直接用同一条接口喂进去，
      // 验的是**点开之后补拉详情**那一步，不是列表怎么来的。
      ui.state.skills = (await ui.api('GET', `/orgs/${orgId}/skills`)).skills
      ui.render()
      await ui.fire('click', el('button', { 'data-act': 'skill-edit', 'data-id': zipId }))
      // 详情是点开之后补拉的，等它落地。
      for (let i = 0; i < 50 && !ui.html().includes('references/'); i++) await new Promise((r) => setTimeout(r, 20))
      const html = ui.html()
      assert(html.includes('references/口径.md'), `弹窗里没有包内文件清单：${html.slice(0, 400)}`)
      assert(html.includes('什么时候生效'), '弹窗里没有常驻 / 按需那一行')
    })

    await test('删掉 Bot，它攒下的私有档跟着走', async () => {
      const made = await req(base, 'POST', '/runtime/bots', { token: memberTok, body: { name: '临时工' } })
      assert(made.status === 201, `bot ${made.status} ${made.text}`)
      const tmp = made.json.bot.id
      const wrote = await req(base, 'POST', `/runtime/skills?botId=${tmp}`, {
        token: seatTok,
        body: { name: '临时工的做法', body: '正文' },
      })
      assert(wrote.status === 201, `write ${wrote.status} ${wrote.text}`)

      const gone = await req(base, 'DELETE', `/runtime/bots/${tmp}`, { token: memberTok })
      assert(gone.status === 200, `delete bot ${gone.status} ${gone.text}`)
      /**
       * 留着的话，它们就是谁也看不见、谁也删不掉的行——界面上那一栏按 botId 认主人，
       * 而那颗 Bot 已经不在了。
       */
      const left = (await req(base, 'GET', `/orgs/${orgId}/skills`, { token: adminTok })).json.skills
      assert(!left.some((x) => x.id === wrote.json.skill.id), `Bot 删了，它的私有档还在：${wrote.json.skill.id}`)
    })

    await test('并发写：同名只成一条，条数不超过上限', async () => {
      /**
       * 查重名、数条数、再插原来是三步各走各的：并发的几次都读到「没有同名」「还差一条」，
       * 一起插进去。一颗新 Bot 上先同时写五条同名，再同时写五条不同名（上限 3）。
       */
      const made = await req(base, 'POST', '/runtime/bots', { token: memberTok, body: { name: '并发工' } })
      assert(made.status === 201, `bot ${made.status} ${made.text}`)
      const tmp = made.json.bot.id
      const post = (name) => req(base, 'POST', `/runtime/skills?botId=${tmp}`, { token: seatTok, body: { name, body: '正文' } })
      try {
        const same = await Promise.all([1, 2, 3, 4, 5].map(() => post('同一个名字')))
        const sameOk = same.filter((r) => r.status === 201).length
        assert(sameOk === 1, `同名并发该只成一条，实际 ${same.map((r) => r.status).join(',')}`)
        assert(same.every((r) => r.status === 201 || r.status === 409), `其余该是 409：${same.map((r) => r.status).join(',')}`)

        const many = await Promise.all([1, 2, 3, 4, 5].map((n) => post(`并发 ${n}`)))
        const manyOk = many.filter((r) => r.status === 201).length
        assert(manyOk === 2, `上限 3、已有 1，并发五条该只成两条，实际 ${many.map((r) => r.status).join(',')}`)
        const mine = (await req(base, 'GET', `/runtime/catalog?botId=${encodeURIComponent(tmp)}`, { token: seatTok })).json.skills.filter(
          (x) => x.origin === 'seat',
        )
        assert(mine.length === 3, `这颗 Bot 的私有档该正好 3 条，实际 ${mine.length}`)
      } finally {
        await req(base, 'DELETE', `/runtime/bots/${tmp}`, { token: memberTok })
      }
    })

    await test('模版上那个开关下发到席位', async () => {
      const before = await req(base, 'GET', `/runtime/catalog?botId=${botId}`, { token: seatTok })
      assert(before.json.bots[0].selfSkills === true, `默认该是开的：${JSON.stringify(before.json.bots[0].selfSkills)}`)

      const tpl = await req(base, 'GET', `/orgs/${orgId}/bot-template`, { token: adminTok })
      const saved = await req(base, 'PUT', `/orgs/${orgId}/bot-template`, {
        token: adminTok,
        body: { version: tpl.json.template.version, selfSkills: false },
      })
      assert(saved.status === 200, `template ${saved.status} ${saved.text}`)
      const after = await req(base, 'GET', `/runtime/catalog?botId=${botId}`, { token: seatTok })
      assert(after.json.bots[0].selfSkills === false, `关掉之后要下发 false：${JSON.stringify(after.json.bots[0].selfSkills)}`)
    })
  } finally {
    gw.kill('SIGTERM')
    // 自己的数据目录自己收。
    rmSync(GW_HOME, { recursive: true, force: true })
  }
}
