/**
 * 本地 Bot 只属于建它的那台电脑（docs/local-bot-device.md）。钉这几件事：
 *
 *   · 谁看得到：建它的那台桌面端看得到；别的桌面端、网页、手机都看不到；老桌面壳（桌面源、没带头）只看得到
 *     还没绑设备的；没有 runtimeKind 这个键的老用户 Bot（Telegram 绑定建的那种）哪儿都还在；
 *   · 按 id 直接访问别的电脑上的本地 Bot 一律 404；没带设备头建不了本地 Bot；
 *   · 老数据（没绑设备）谁先来要票归谁，两台并发只有一台拿到；
 *   · 建本地 Bot 默认进「本地」分类，没有就建一个；改过名照样往里放；分类满了也照建；
 *   · 别的电脑上的本地 Bot 按设备数出来（不带名字），可以整台清掉，不能拿本机的设备清；
 *   · 远程主 Bot 的派活名单里没有本地 Bot。
 */
import { rmSync } from 'node:fs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { createCompany } from './org.mjs'
import { freePort } from './ports.mjs'
import { startGateway } from './gateway.mjs'
import { withPg } from './pg.mjs'

const DEV_A = 'e2e-local-device-aaaa'
const DEV_B = 'e2e-local-device-bbbb'

export async function runLocalDevice({ test, req, assert, log }) {
  log('\n# local-device')
  const GW_HOME = tmpOf('satuwork-e2e-local-device')
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`
  const schema = schemaOf('e2e_local_device')
  const { gw } = await startGateway({
    name: 'local-device-gw',
    what: 'local-device gateway',
    home: GW_HOME,
    schema,
    port: GW_PORT,
    env: {
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: 'owner@device.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-device',
    },
  })

  try {
    const reg = await createCompany(req, base, {
      ownerEmail: 'owner@device.test',
      ownerPassword: 'test-owner-device',
      email: 'admin@device.test',
      password: 'correct-horse-1',
      companyName: 'DeviceCo',
      slug: 'deviceco',
    })
    const tok = reg.token
    const me = await req(base, 'GET', '/me', { token: tok })
    const accountId = me.json.account.id
    const seat = await req(base, 'GET', `/platform/accounts/${accountId}`, { token: reg.ownerToken })
    assert(seat.status === 200 && seat.json.accessToken, `席位凭证 ${seat.status} ${seat.text}`)
    const seatTok = seat.json.accessToken

    const onA = { 'x-satuwork-device': DEV_A, 'x-satuwork-client': 'desktop' }
    const onB = { 'x-satuwork-device': DEV_B, 'x-satuwork-client': 'desktop' }
    const legacy = { origin: 'satu://localhost' }
    const mobile = { origin: 'satu://localhost', 'x-satuwork-client': 'mobile' }
    const roster = async (headers) => {
      const r = await req(base, 'GET', '/runtime/bots', { token: tok, headers })
      assert(r.status === 200, `名册 ${r.status} ${r.text}`)
      return r.json
    }
    const ids = (data) => new Set(data.bots.map((b) => b.id))
    const mkLocal = async (name, headers = onA) =>
      req(base, 'POST', '/runtime/bots', { token: tok, headers, body: { name, runtimeKind: 'local', device: { name: name === 'A2' ? '' : 'Mac-A', platform: 'darwin' } } })

    let a1
    let a2
    let localFolder
    await test('建本地 Bot：没带设备头 400；带了就绑到这台、放进新建的「本地」分类', async () => {
      const bare = await req(base, 'POST', '/runtime/bots', { token: tok, body: { name: '无头', runtimeKind: 'local' } })
      assert(bare.status === 400, `没带设备头也建出来了：${bare.status} ${bare.text}`)
      const old = await req(base, 'POST', '/runtime/bots', { token: tok, headers: legacy, body: { name: '老壳', runtimeKind: 'local' } })
      assert(old.status === 400, `老桌面壳（没带头）不该建得出本地 Bot：${old.status}`)

      const r = await mkLocal('A1')
      assert(r.status === 201, `建本地 Bot ${r.status} ${r.text}`)
      a1 = r.json.bot.id
      localFolder = r.json.folder
      assert(localFolder && localFolder.kind === 'local' && localFolder.name === '本地', `没建出「本地」分类：${r.text}`)
      assert(r.json.bot.folderId === localFolder.id, `新 Bot 没放进本地分类：${r.text}`)
      const row = await withPg(schema, (c) => c.query('select "deviceId" from catalog_items where id = $1', [a1]))
      assert(row.rows[0].deviceId === DEV_A, `没绑到 A：${JSON.stringify(row.rows[0])}`)

      // 改了名照样往里放（按标记找，不按名字）。
      const renamed = await req(base, 'PATCH', `/runtime/bot-folders/${localFolder.id}`, { token: tok, body: { name: '我的电脑' } })
      assert(renamed.status === 200, `改名 ${renamed.status} ${renamed.text}`)
      const r2 = await mkLocal('A2')
      assert(r2.status === 201, `建第二颗 ${r2.status} ${r2.text}`)
      a2 = r2.json.bot.id
      assert(r2.json.folder?.id === localFolder.id && r2.json.bot.folderId === localFolder.id, `改过名的本地分类没被沿用：${r2.text}`)
      const folders = (await roster(onA)).folders.filter((f) => f.kind === 'local')
      assert(folders.length === 1, `本地分类不止一个：${JSON.stringify(folders)}`)
    })

    await test('谁看得到：A 看得到；B、网页、手机、老桌面壳都看不到已经归了 A 的', async () => {
      assert(ids(await roster(onA)).has(a1), 'A 自己看不到')
      assert(!ids(await roster(onB)).has(a1), 'B 看到了 A 的本地 Bot')
      assert(!ids(await roster(undefined)).has(a1), '网页看到了本地 Bot')
      assert(!ids(await roster(mobile)).has(a1), '手机看到了本地 Bot')
      // 老壳子起它只会开出一个空工作区的进程，还去抢 A 那颗的活。
      assert(!ids(await roster(legacy)).has(a1), '老桌面壳看到了已经归了 A 的本地 Bot')
      const boot = await req(base, 'POST', `/runtime/bots/${a1}/local-bootstrap`, { token: tok, headers: legacy, body: {} })
      assert(boot.status === 409, `老桌面壳要得到 A 的票：${boot.status}`)
    })

    await test('没有 runtimeKind 键的老用户 Bot（Telegram 绑定建的那种）：网页、手机、两台桌面都还看得到', async () => {
      const r = await req(base, 'POST', '/runtime/bots', { token: tok, body: { name: '老形状' } })
      assert(r.status === 201, `建 Bot ${r.status} ${r.text}`)
      const id = r.json.bot.id
      await withPg(schema, (c) => c.query(`update catalog_items set definition = definition - 'runtimeKind' where id = $1`, [id]))
      for (const [label, headers] of [['网页', undefined], ['手机', mobile], ['A', onA], ['B', onB], ['老壳', legacy]]) {
        assert(ids(await roster(headers)).has(id), `${label}看不到没有 runtimeKind 的远程 Bot`)
      }
      const one = await req(base, 'GET', `/runtime/bots/${id}`, { token: tok })
      assert(one.status === 200, `网页按 id 取不到：${one.status} ${one.text}`)
      await req(base, 'DELETE', `/runtime/bots/${id}`, { token: tok })
    })

    await test('按 id 访问别的电脑上的本地 Bot 一律 404', async () => {
      const patch = await req(base, 'PATCH', `/runtime/bots/${a1}`, { token: tok, headers: onB, body: { description: 'x' } })
      assert(patch.status === 404, `B 改得动 A 的：${patch.status}`)
      // 要票这一条回 409「在另一台电脑上」：界面据此把它从名册里拿掉、不再试着起它。
      const boot = await req(base, 'POST', `/runtime/bots/${a1}/local-bootstrap`, { token: tok, headers: onB, body: {} })
      assert(boot.status === 409, `B 要 A 的票该 409：${boot.status} ${boot.text}`)
      const web = await req(base, 'POST', `/runtime/bots/${a1}/local-bootstrap`, { token: tok, body: {} })
      assert(web.status === 404, `网页要得到本地 Bot 的票：${web.status}`)
      const mem = await req(base, 'GET', `/runtime/bots/${a1}/memories`, { token: tok, headers: onB })
      assert(mem.status === 404, `B 读得到 A 的记忆：${mem.status}`)
      const folder = await req(base, 'PUT', `/runtime/bots/${a1}/folder`, { token: tok, body: { folderId: null } })
      assert(folder.status === 404, `网页挪得动本地 Bot：${folder.status}`)
      const del = await req(base, 'DELETE', `/runtime/bots/${a1}`, { token: tok, headers: onB })
      assert(del.status === 404, `B 删得掉 A 的：${del.status}`)
      const own = await req(base, 'POST', `/runtime/bots/${a1}/local-bootstrap`, { token: tok, headers: onA, body: {} })
      assert(own.status === 200, `A 自己要不到票：${own.status} ${own.text}`)
    })

    await test('老数据没绑设备：两台都看得到，并发来要票只有一台拿到，之后另一台就看不到了', async () => {
      const r = await mkLocal('老的')
      const oldId = r.json.bot.id
      await withPg(schema, (c) => c.query('update catalog_items set "deviceId" = null where id = $1', [oldId]))
      const seen = (await roster(onB)).bots.find((b) => b.id === oldId)
      assert(seen && seen.unclaimed === true, `没绑设备的老本地 Bot，B 该看得到、并标成 unclaimed：${JSON.stringify(seen)}`)
      assert(ids(await roster(legacy)).has(oldId), '老桌面壳该看得到没绑设备的')
      assert(!ids(await roster(undefined)).has(oldId), '网页也不该看到没绑设备的本地 Bot')
      // 老壳子不认领：照旧发票，归属不变。
      const viaLegacy = await req(base, 'POST', `/runtime/bots/${oldId}/local-bootstrap`, { token: tok, headers: legacy, body: {} })
      assert(viaLegacy.status === 200, `老壳子要不到没绑设备的票：${viaLegacy.status}`)
      const [x, y] = await Promise.all([
        req(base, 'POST', `/runtime/bots/${oldId}/local-bootstrap`, { token: tok, headers: onA, body: {} }),
        req(base, 'POST', `/runtime/bots/${oldId}/local-bootstrap`, { token: tok, headers: onB, body: {} }),
      ])
      const codes = [x.status, y.status].sort()
      assert(codes[0] === 200 && codes[1] === 409, `并发认领该一个 200 一个 409：${x.status} ${y.status}`)
      const winner = x.status === 200 ? onA : onB
      const loser = x.status === 200 ? onB : onA
      assert(ids(await roster(winner)).has(oldId) && !ids(await roster(loser)).has(oldId), '认领之后另一台还看得到')
      assert(!(await roster(winner)).bots.find((b) => b.id === oldId).unclaimed, '认领之后还标着 unclaimed')
      assert(!ids(await roster(legacy)).has(oldId), '认领之后老壳子还看得到')
      await req(base, 'DELETE', `/runtime/bots/${oldId}`, { token: tok, headers: winner })
    })

    await test('远程主 Bot 的派活名单里没有本地 Bot', async () => {
      const remote = await req(base, 'POST', '/runtime/bots', { token: tok, body: { name: '远程主' } })
      assert(remote.status === 201, `建远程 Bot ${remote.status} ${remote.text}`)
      const mainId = remote.json.bot.id
      const set = await req(base, 'PUT', '/runtime/main-bot', { token: tok, body: { botId: mainId } })
      assert(set.status === 200, `设主 Bot ${set.status} ${set.text}`)
      const cat = await req(base, 'GET', `/runtime/catalog?botId=${mainId}`, { token: seatTok })
      assert(cat.status === 200, `目录 ${cat.status} ${cat.text}`)
      assert(!(cat.json.assignable || []).some((b) => b.id === a1 || b.id === a2), `远程主 Bot 能派给本地 Bot：${JSON.stringify(cat.json.assignable)}`)
      const task = await req(base, 'POST', '/runtime/tasks', { token: seatTok, body: { fromBotId: mainId, toBot: 'A1', instruction: '做点事', sessionId: 's' } })
      assert(task.status === 404, `远程主 Bot 派得动本地 Bot：${task.status} ${task.text}`)
      const mentions = await req(base, 'GET', '/mentions', { token: tok, headers: onA })
      assert(mentions.status === 200 && mentions.json.mainBotId === mainId, `@ 名单 ${mentions.status} ${mentions.text}`)
      assert(!mentions.json.mentions.some((m) => m.kind === 'bot' && (m.id === a1 || m.id === a2)), '远程主 Bot 的 @ 名单里有本地 Bot')
      // 同一台电脑上的本地主 Bot：@ 名单里有本机的本地 Bot。
      await req(base, 'PUT', '/runtime/main-bot', { token: tok, headers: onA, body: { botId: a1 } })
      const fromLocal = await req(base, 'GET', '/mentions', { token: tok, headers: onA })
      assert(fromLocal.json.mentions.some((m) => m.kind === 'bot' && m.id === a2), `本地主 Bot 的 @ 名单里没有本机的本地 Bot：${fromLocal.text}`)
      await req(base, 'PUT', '/runtime/main-bot', { token: tok, body: { botId: null } })
    })

    await test('别的电脑上的本地 Bot：按设备数出来、不带名字；能整台清掉，不能拿本机的设备清', async () => {
      const fromB = (await roster(onB)).quota
      const a = fromB.elsewhere.find((d) => d.deviceId === DEV_A)
      assert(a && a.count === 2 && a.name === 'Mac-A' && a.platform === 'darwin', `B 看到的 A 那一栏不对：${JSON.stringify(fromB)}`)
      assert(!JSON.stringify(fromB.elsewhere).includes('A1'), '「其他电脑」那一栏漏出了 Bot 名字')
      assert(fromB.used >= 2 && fromB.max === 20, `配额不对：${JSON.stringify(fromB)}`)
      const fromWeb = (await roster(undefined)).quota
      assert(fromWeb.elsewhere.some((d) => d.deviceId === DEV_A), '网页上也该看到 A 占着配额')
      assert(!(await roster(onA)).quota.elsewhere.some((d) => d.deviceId === DEV_A), 'A 自己被算成了「其他电脑」')

      const self = await req(base, 'DELETE', `/runtime/devices/${DEV_A}/local-bots`, { token: tok, headers: onA })
      assert(self.status === 400, `拿本机的设备也清得掉：${self.status}`)
      const cleared = await req(base, 'DELETE', `/runtime/devices/${DEV_A}/local-bots`, { token: tok, headers: onB })
      assert(cleared.status === 200 && cleared.json.cleared === 2, `清 A ${cleared.status} ${cleared.text}`)
      const left = ids(await roster(onA))
      assert(!left.has(a1) && !left.has(a2), 'A 上的本地 Bot 没被清掉')
      assert(!(await roster(onB)).quota.elsewhere.some((d) => d.deviceId === DEV_A), '清完了 A 还在「其他电脑」里')
    })

    await test('本地分类被删了下次再建出来；分类满了照建、不放分类', async () => {
      const del = await req(base, 'DELETE', `/runtime/bot-folders/${localFolder.id}`, { token: tok })
      assert(del.status === 200, `删分类 ${del.status} ${del.text}`)
      const again = await mkLocal('再来', onB)
      assert(again.status === 201 && again.json.folder?.kind === 'local' && again.json.folder.id !== localFolder.id, `删了本地分类之后没再建：${again.text}`)
      await req(base, 'DELETE', `/runtime/bot-folders/${again.json.folder.id}`, { token: tok })
      for (let i = 0; i < 20; i++) {
        const f = await req(base, 'POST', '/runtime/bot-folders', { token: tok, body: { name: `分类${i}` } })
        assert(f.status === 201 || f.status === 200, `建分类 ${i} ${f.status} ${f.text}`)
      }
      const full = await mkLocal('满了', onB)
      assert(full.status === 201 && full.json.folder === null && full.json.bot.folderId === null, `分类满了该照建、不放分类：${full.status} ${full.text}`)
    })
  } finally {
    gw.kill('SIGTERM')
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
