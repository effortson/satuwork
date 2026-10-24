/**
 * 主 Bot 派活（docs/bot-tasks.md）：Gateway 这一层的全部规矩。
 *
 * 机器上的工人和席位都是假的——这里验的是「记、租、收」：只有主 Bot 能派；目标席位领到带
 * 指令的 run 活、回报结论之后主席位领到带结论的 deliver 活；目标砸了也要送回去；租约到期放回
 * 去再领；管家太旧当场记成没跑起来。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { createCompany } from './org.mjs'
import { publishRelease } from './release.mjs'
import { pairMachine } from './pair.mjs'
import { freePort } from './ports.mjs'

const SCHEMA = schemaOf('e2e_bot_tasks')
const LEASE_MS = 1500

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function runBotTasks({ gwRoot, test, req, start, waitHttp, assert, log }) {
  log('\n# bot-tasks')

  const GW_HOME = tmpOf('satuwork-e2e-bot-tasks')
  const GW_PORT = await freePort()
  const gwBase = `http://127.0.0.1:${GW_PORT}`
  rmSync(GW_HOME, { recursive: true, force: true })

  const gw = start('bot-tasks-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: SCHEMA,
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: 'owner@tasks.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-tasks',
      SATUWORK_DEPLOY_STUB: '1',
      GATEWAY_ROUTINE_TICK_MS: '500',
      GATEWAY_ROUTINE_LEASE_MS: String(LEASE_MS),
      GATEWAY_TASK_WAIT_LEASE_MS: '5000',
    },
  })

  try {
    await waitHttp(gwBase + '/health', { child: gw, what: 'bot-tasks gateway' })

    const reg = await createCompany(req, gwBase, {
      ownerEmail: 'owner@tasks.test',
      ownerPassword: 'test-owner-tasks',
      email: 'admin@tasks.test',
      password: 'correct-horse',
      companyName: 'TasksCo',
      slug: 'tasksco',
      seats: 3,
    })
    const adminTok = reg.token
    const ownerTok = reg.ownerToken
    const orgId = reg.company.id
    const me = await req(gwBase, 'GET', '/me', { token: adminTok })
    const accountId = me.json.account.id
    const secrets = await req(gwBase, 'GET', `/platform/accounts/${accountId}`, { token: ownerTok })
    const seatTok = secrets.json.accessToken

    const mk = async (name, description) => {
      const r = await req(gwBase, 'POST', '/runtime/bots', { token: adminTok, body: { name, description } })
      assert(r.status === 201, `建 Bot ${name} ${r.status} ${r.text}`)
      return r.json.bot.id
    }
    const mainBot = await mk('助手', '统筹')
    const finBot = await mk('财务', '做报表、对账')

    const machine = await pairMachine({ req, gwBase, ownerTok, orgId })
    const machineTok = machine.token
    await publishRelease({ req, gwBase, token: ownerTok, version: '0.1.0', note: 'e2e-bot-tasks' })
    for (const botId of [mainBot, finBot]) {
      const dep = await req(gwBase, 'POST', '/runtime/deploy', { token: adminTok, body: { botId } })
      assert(dep.status === 200, `deploy ${dep.status} ${dep.text}`)
    }
    const heartbeat = (protocol) =>
      req(gwBase, 'POST', `/internal/machines/${machine.machineId}/heartbeat`, { token: machineTok, body: { protocol, managerVersion: 'e2e' } })
    const due = () => req(gwBase, 'GET', '/worker/tasks/due', { token: machineTok })
    const post = (taskId, act, body = {}) => req(gwBase, 'POST', `/worker/tasks/${taskId}/${act}`, { token: machineTok, body })
    const assign = (body, token = seatTok) => req(gwBase, 'POST', '/runtime/tasks', { token, body })
    const tasksOf = async (sessionId) => {
      const r = await req(gwBase, 'GET', `/runtime/tasks?sessionId=${encodeURIComponent(sessionId)}`, { token: adminTok })
      assert(r.status === 200, `列任务 ${r.status} ${r.text}`)
      return r.json.tasks
    }
    const taskById = async (id, sessionId = 's-main') => {
      const t = (await tasksOf(sessionId)).find((x) => x.id === id)
      assert(t, `任务 ${id} 不在列表里`)
      return t
    }
    const until = async (id, status, what, ms = 8000) => {
      const deadline = Date.now() + ms
      for (;;) {
        const t = await taskById(id)
        if (t.status === status) return t
        assert(Date.now() < deadline, `${what}：一直是 ${t.status}，没等到 ${status}（${t.error || ''}）`)
        await sleep(100)
      }
    }

    await test('只有主 Bot 能派；目标得在名单上、不能是自己', async () => {
      assert((await heartbeat(12)).status === 200, '心跳')
      // 还没设主 Bot：谁都派不了。
      const none = await assign({ fromBotId: mainBot, toBot: '财务', instruction: '做一份月报', sessionId: 's-main' })
      assert(none.status === 403, `没设主 Bot 该 403：${none.status} ${none.text}`)
      const set = await req(gwBase, 'PUT', '/runtime/main-bot', { token: adminTok, body: { botId: mainBot } })
      assert(set.status === 200, `设主 Bot ${set.status} ${set.text}`)
      const notMain = await assign({ fromBotId: finBot, toBot: '助手', instruction: '你来', sessionId: 's-fin' })
      assert(notMain.status === 403, `不是主 Bot 该 403：${notMain.status}`)
      const self = await assign({ fromBotId: mainBot, toBot: '助手', instruction: '自己做', sessionId: 's-main' })
      assert(self.status === 400, `派给自己该 400：${self.status}`)
      const nobody = await assign({ fromBotId: mainBot, toBot: '法务', instruction: '看合同', sessionId: 's-main' })
      assert(nobody.status === 404, `不在名单上该 404：${nobody.status}`)
      const empty = await assign({ fromBotId: mainBot, toBot: '财务', instruction: '  ', sessionId: 's-main' })
      assert(empty.status === 400, `空指令该 400：${empty.status}`)
      const anon = await req(gwBase, 'POST', '/runtime/tasks', { token: adminTok, body: { fromBotId: mainBot, toBot: '财务', instruction: 'x' } })
      assert(anon.status === 401, `登录票不能派（要席位票）：${anon.status}`)
    })

    await test('主 Bot 的席位拉目录：可派名单里有别的 Bot，指纹和探针一致（不会每分钟白拉一遍）', async () => {
      const cat = await req(gwBase, 'GET', `/runtime/catalog?botId=${mainBot}`, { token: seatTok })
      assert(cat.status === 200, `目录 ${cat.status} ${cat.text}`)
      const names = (cat.json.assignable || []).map((b) => b.name)
      assert(names.includes('财务') && !names.includes('助手'), `主 Bot 的可派名单不对：${JSON.stringify(cat.json.assignable)}`)
      const probe = await req(gwBase, 'GET', `/runtime/catalog/version?botId=${mainBot}`, { token: seatTok })
      assert(probe.json.stamp === cat.json.stamp, `目录和探针的指纹对不上，席位会每分钟重拉：\n${cat.json.stamp}\n${probe.json.stamp}`)
      // 别的 Bot 拿到的永远是空名单：只有主 Bot 有 assign_task。
      const other = await req(gwBase, 'GET', `/runtime/catalog?botId=${finBot}`, { token: seatTok })
      assert((other.json.assignable || []).length === 0, `非主 Bot 也拿到了名单：${JSON.stringify(other.json.assignable)}`)
      const otherProbe = await req(gwBase, 'GET', `/runtime/catalog/version?botId=${finBot}`, { token: seatTok })
      assert(otherProbe.json.stamp === other.json.stamp, '非主 Bot 的指纹也对不上')
    })

    let taskId = ''
    await test('派出去：目标席位领到带指令的 run 活，回报结论后主席位领到带结论的 deliver 活', async () => {
      const made = await assign({ fromBotId: mainBot, toBot: '财务', instruction: '做一份本月的费用月报，按部门分列', sessionId: 's-main', callId: 'call-1' })
      assert(made.status === 201, `派 ${made.status} ${made.text}`)
      taskId = made.json.task.id
      assert(made.json.task.status === 'queued' && made.json.toName === '财务', `形状不对：${made.text}`)
      // 同一颗上一件没交回来，不许再派；反过来派也不许。
      const again = await assign({ fromBotId: mainBot, toBot: '财务', instruction: '再来一份', sessionId: 's-main' })
      assert(again.status === 409, `重复派该 409：${again.status} ${again.text}`)

      const anon = await req(gwBase, 'GET', '/worker/tasks/due')
      assert(anon.status === 401, `无票 ${anon.status}`)
      const got = await due()
      assert(got.status === 200, `due ${got.status} ${got.text}`)
      assert(got.json.jobs.length === 1, `该领到 1 条，领到 ${got.json.jobs.length}：${got.text}`)
      const job = got.json.jobs[0]
      assert(job.taskId === taskId && job.phase === 'run' && job.botId === finBot, `活不对：${JSON.stringify(job)}`)
      assert(job.instruction.includes('【主 Bot「助手」派来的任务】') && job.instruction.includes('做一份本月的费用月报'), `指令全文不对：${job.instruction}`)
      assert(job.task.phase === 'instruction' && job.task.from.name === '助手' && job.task.id === taskId, `身份不对：${JSON.stringify(job.task)}`)
      assert(job.seatId && job.leaseMs === LEASE_MS && job.timeoutMs > 0, `活上缺字段：${JSON.stringify(job)}`)
      assert((await due()).json.jobs.length === 0, '同一条不该领两次')
      assert((await taskById(taskId)).status === 'running', '领走了该是 running')

      const started = await post(taskId, 'started', { sessionId: 's-fin' })
      assert(started.status === 200 && started.json.blocked === null, `started ${started.status} ${started.text}`)
      assert((await post(taskId, 'renew')).status === 200, 'renew')
      const fin = await post(taskId, 'finish', { kind: 'completed', result: '月报做好了：研发 12 万、销售 8 万，合计 20 万。', sessionId: 's-fin' })
      assert(fin.status === 200, `finish ${fin.status} ${fin.text}`)
      const reporting = await taskById(taskId)
      assert(reporting.status === 'reporting' && reporting.result.includes('合计 20 万'), `该是 reporting 且带结论：${JSON.stringify(reporting)}`)
      assert((await post(taskId, 'renew')).status === 404, 'run 那一步收场后再续该 404')

      const got2 = await due()
      assert(got2.json.jobs.length === 1, `该领到送回去的那一步：${got2.text}`)
      const deliver = got2.json.jobs[0]
      assert(deliver.taskId === taskId && deliver.phase === 'deliver' && deliver.botId === mainBot, `deliver 活不对：${JSON.stringify(deliver)}`)
      assert(deliver.instruction.startsWith('【任务结果】@财务 做完了') && deliver.instruction.includes('合计 20 万') && deliver.instruction.includes('做一份本月的费用月报'), `结论全文不对：${deliver.instruction}`)
      assert(deliver.task.phase === 'result' && deliver.task.from.name === '财务', `结论身份不对：${JSON.stringify(deliver.task)}`)
      assert((await post(taskId, 'started', { sessionId: 's-main' })).status === 200, 'deliver started')
      const done = await post(taskId, 'finish', { kind: 'delivered' })
      assert(done.status === 200, `deliver finish ${done.status} ${done.text}`)
      const final = await taskById(taskId)
      assert(final.status === 'done' && final.deliveredAt > 0, `该是 done：${JSON.stringify(final)}`)
      // 做完了就能再派。
      assert((await due()).json.jobs.length === 0, '收场后不该还有活')
    })

    await test('目标那边砸了也要送回去：结论写成「没做成」', async () => {
      const made = await assign({ fromBotId: mainBot, toBot: '财务', instruction: '对一下上季度的账', sessionId: 's-main' })
      assert(made.status === 201, `派 ${made.status} ${made.text}`)
      const id = made.json.task.id
      const job = (await due()).json.jobs[0]
      assert(job && job.taskId === id && job.phase === 'run', '没领到')
      await post(id, 'started', { sessionId: 's-fin' })
      assert((await post(id, 'finish', { kind: 'failed', error: '席位那头报错了' })).status === 200, 'finish failed')
      const t = await taskById(id)
      assert(t.status === 'reporting' && t.result.startsWith('没做成：席位那头报错了'), `砸了也该进 reporting：${JSON.stringify(t)}`)
      const deliver = (await due()).json.jobs[0]
      assert(deliver && deliver.phase === 'deliver' && deliver.instruction.startsWith('【任务结果】@财务 没做成'), `送回去的话不对：${deliver && deliver.instruction}`)
      await post(id, 'started', { sessionId: 's-main' })
      await post(id, 'finish', { kind: 'delivered' })
      assert((await taskById(id)).status === 'done', '送到了该是 done')
    })

    await test('转人工挡着：started 直接当没做成送回去，工人收到 blocked', async () => {
      const made = await assign({ fromBotId: mainBot, toBot: '财务', instruction: '报销单审一下', sessionId: 's-main' })
      const id = made.json.task.id
      const job = (await due()).json.jobs[0]
      assert(job && job.taskId === id, '没领到')
      // 目标会话上挂一张挡路的交接单。
      const h = await req(gwBase, 'POST', '/internal/handoffs', {
        token: seatTok,
        body: { companyId: orgId, accountId, id: 'h-block', sessionId: 's-fin', botId: finBot, state: 'open', claimedBy: '', blocking: true, repeats: 0, reason: '卡住了', ask: '要人批', createdAt: Date.now(), updatedAt: Date.now() },
      })
      assert(h.status === 200 || h.status === 201, `挂交接单 ${h.status} ${h.text}`)
      const started = await post(id, 'started', { sessionId: 's-fin' })
      assert(started.status === 200 && started.json.blocked, `该被挡：${started.text}`)
      const t = await taskById(id)
      assert(t.status === 'reporting' && t.result.includes('转人工'), `挡住该送回去：${JSON.stringify(t)}`)
      const deliver = (await due()).json.jobs[0]
      assert(deliver && deliver.phase === 'deliver', '该领到送回去的那一步')
      await post(id, 'started', { sessionId: 's-main' })
      await post(id, 'finish', { kind: 'delivered' })
      // 单子关掉，别挡后面的测试。
      await req(gwBase, 'POST', '/internal/handoffs', {
        token: seatTok,
        body: { companyId: orgId, accountId, id: 'h-block', sessionId: 's-fin', botId: finBot, state: 'returned', claimedBy: '', blocking: true, repeats: 0, reason: '卡住了', ask: '要人批', createdAt: Date.now(), updatedAt: Date.now() },
      })
    })

    await test('领走了没回报：租约到期放回去再领，第三次还不回报就送回「机器没回报」', async () => {
      const made = await assign({ fromBotId: mainBot, toBot: '财务', instruction: '算一下年终奖', sessionId: 's-main' })
      const id = made.json.task.id
      for (let n = 1; n <= 3; n++) {
        const deadline = Date.now() + 8000
        let job = null
        while (!job && Date.now() < deadline) {
          job = (await due()).json.jobs.find((j) => j.taskId === id) || null
          if (!job) await sleep(150)
        }
        assert(job && job.phase === 'run', `第 ${n} 次该又领到 run 那一步`)
        await sleep(LEASE_MS + 1500)
      }
      const t = await until(id, 'reporting', '三次没回报')
      assert(t.result.includes('机器没回报'), `该写明机器没回报：${JSON.stringify(t)}`)
      const deliver = (await due()).json.jobs.find((j) => j.taskId === id)
      assert(deliver && deliver.phase === 'deliver', '该领到送回去的那一步')
      await post(id, 'started', { sessionId: 's-main' })
      await post(id, 'finish', { kind: 'delivered' })
    })

    await test('管家太旧：当场记成没跑起来；主 Bot 那头也领不了就是 failed', async () => {
      assert((await heartbeat(11)).status === 200, '心跳')
      const made = await assign({ fromBotId: mainBot, toBot: '财务', instruction: '随便做点什么', sessionId: 's-main' })
      assert(made.status === 201, `派 ${made.status} ${made.text}`)
      const t = made.json.task
      assert(t.status === 'failed' && /管家太旧/.test(t.error || ''), `该当场 failed 并说明管家太旧：${JSON.stringify(t)}`)
      assert((await due()).json.jobs.length === 0, 'failed 的不该再有活')
      assert((await heartbeat(12)).status === 200, '心跳回 12')
    })

    await test('同步等待：主 Bot 的席位带着等待租约派活，结论答给它而不是走送回', async () => {
      const made = await assign({ fromBotId: mainBot, toBot: '财务', instruction: '算一下本月差旅', sessionId: 's-main', wait: true })
      assert(made.status === 201, `派 ${made.status} ${made.text}`)
      const id = made.json.task.id
      const poll = () => req(gwBase, 'GET', `/runtime/tasks/${id}`, { token: seatTok })
      assert((await poll()).json.task.status === 'queued', '还没人领，该是 queued')
      const job = (await due()).json.jobs.find((j) => j.taskId === id)
      assert(job && job.phase === 'run', '目标席位该领到 run 那一步')
      await post(id, 'started', { sessionId: 's-fin' })
      const running = (await poll()).json.task
      assert(running.status === 'running', '领走了该是 running')
      // 对方那条会话要交给界面：「看过程」去那里取。
      assert(running.runSessionId === 's-fin', `该带上对方的会话 id：${JSON.stringify(running)}`)
      assert(running.progress === null, `还没报过进度该是 null：${JSON.stringify(running.progress)}`)
      // 进度随续租报上来，逐字段截；形状不对的当没报，续租本身照样成功。
      const long = 'x'.repeat(500)
      const renewed = await post(id, 'renew', { progress: { steps: 3, tool: { name: 'web_search', detail: long }, todo: { done: 1, total: 4, now: '核对 AUM' } } })
      assert(renewed.status === 200, `带进度续租 ${renewed.status} ${renewed.text}`)
      const p = (await poll()).json.task.progress
      assert(p && p.steps === 3 && p.tool.name === 'web_search' && p.tool.detail.length === 160, `进度没记上或没截：${JSON.stringify(p)}`)
      assert(p.todo.done === 1 && p.todo.total === 4 && p.todo.now === '核对 AUM', `清单进度不对：${JSON.stringify(p.todo)}`)
      assert((await post(id, 'renew', { progress: { steps: 'x' } })).status === 200, '进度形状不对也不该让续租失败')
      assert((await post(id, 'renew')).status === 200, '老领活方不带进度照旧能续')
      assert((await poll()).json.task.progress.steps === 3, '不带进度的续租不该把进度清掉')
      await post(id, 'finish', { kind: 'completed', result: '差旅合计 3.2 万', sessionId: 's-fin' })
      // 有人在等：不进 reporting，也就没有 deliver 那一步。
      assert((await due()).json.jobs.every((j) => j.taskId !== id), '有人在等时不该再派送回的活')
      const got = await poll()
      assert(got.json.task.status === 'done' && got.json.task.result === '差旅合计 3.2 万' && got.json.task.runKind === 'completed', `该当场交出结论：${got.text}`)
      // 别的账号拿不到。
      const anon = await req(gwBase, 'GET', `/runtime/tasks/${id}`, { token: adminTok })
      assert(anon.status === 401, `登录票不能取（要席位票）：${anon.status}`)
    })

    await test('同步等待：目标起不来时结论当场交给等的一方，不绕送回', async () => {
      assert((await heartbeat(11)).status === 200, '心跳')
      const made = await assign({ fromBotId: mainBot, toBot: '财务', instruction: '随便做点什么', sessionId: 's-main', wait: true })
      assert(made.status === 201 && made.json.task.status === 'answered', `该当场 answered：${made.text}`)
      const got = await req(gwBase, 'GET', `/runtime/tasks/${made.json.task.id}`, { token: seatTok })
      assert(got.json.task.status === 'done' && /管家太旧/.test(got.json.task.result), `结论该说明管家太旧：${got.text}`)
      assert((await heartbeat(12)).status === 200, '心跳回 12')
    })

    await test('同步等待：等的一方没了（租约过期），结论走兜底送回，不丢', async () => {
      const made = await assign({ fromBotId: mainBot, toBot: '财务', instruction: '对一下发票', sessionId: 's-main', wait: true })
      const id = made.json.task.id
      const job = (await due()).json.jobs.find((j) => j.taskId === id)
      assert(job, '没领到')
      await post(id, 'started', { sessionId: 's-fin' })
      // 不再轮询：等待租约（5 秒）过期之后再交结论。领活的那一方照常续它自己的租约。
      for (let i = 0; i < 11; i++) {
        await post(id, 'renew')
        await sleep(500)
      }
      await post(id, 'finish', { kind: 'completed', result: '发票都对得上', sessionId: 's-fin' })
      const deliver = (await due()).json.jobs.find((j) => j.taskId === id)
      assert(deliver && deliver.phase === 'deliver' && deliver.instruction.includes('发票都对得上'), `该转兜底送回：${JSON.stringify(deliver)}`)
      await post(id, 'started', { sessionId: 's-main' })
      await post(id, 'finish', { kind: 'delivered' })
    })

    await test('停止：没被领走的直接作废；在跑的交回结论也不再送回', async () => {
      const a = await assign({ fromBotId: mainBot, toBot: '财务', instruction: '先不用做了', sessionId: 's-main', wait: true })
      const c1 = await req(gwBase, 'POST', `/runtime/tasks/${a.json.task.id}/cancel`, { token: seatTok, body: {} })
      assert(c1.status === 200 && c1.json.task.status === 'cancelled', `没领走的该直接作废：${c1.text}`)
      assert((await due()).json.jobs.every((j) => j.taskId !== a.json.task.id), '作废的不该再被领走')
      const b = await assign({ fromBotId: mainBot, toBot: '财务', instruction: '跑一半停', sessionId: 's-main', wait: true })
      const id = b.json.task.id
      const job = (await due()).json.jobs.find((j) => j.taskId === id)
      assert(job, '没领到')
      await post(id, 'started', { sessionId: 's-fin' })
      const before = await post(id, 'renew')
      assert(before.status === 200 && before.json.cancelled === false, `没停时续租该说没停：${before.text}`)
      await req(gwBase, 'POST', `/runtime/tasks/${id}/cancel`, { token: seatTok, body: {} })
      // 续租的回复要立刻告诉工人「停了」，它才去中止目标那一轮。
      const after = await post(id, 'renew')
      assert(after.status === 200 && after.json.cancelled === true, `停了之后续租该说停了：${after.text}`)
      assert(job.cancelPollMs > 0 && job.cancelPollMs <= 5000, `续租节拍该很勤：${job.cancelPollMs}`)
      await post(id, 'finish', { kind: 'aborted' })
      const got = await req(gwBase, 'GET', `/runtime/tasks/${id}`, { token: seatTok })
      assert(got.json.task.status === 'cancelled', `停了的交回来也不该送回：${got.text}`)
      assert((await due()).json.jobs.every((j) => j.taskId !== id), '停了的不该有送回那一步')

      // 领走了、还没开跑就被停：started 直接挡下，指令一个字都不发进去。
      const c = await assign({ fromBotId: mainBot, toBot: '财务', instruction: '刚领走就停', sessionId: 's-main', wait: true })
      const cid = c.json.task.id
      assert((await due()).json.jobs.some((j) => j.taskId === cid), '没领到')
      await req(gwBase, 'POST', `/runtime/tasks/${cid}/cancel`, { token: seatTok, body: {} })
      const st = await post(cid, 'started', { sessionId: 's-fin' })
      assert(st.status === 200 && st.json.blocked && st.json.cancelled === true, `开跑前被停该挡下：${st.text}`)
      const gone = await req(gwBase, 'GET', `/runtime/tasks/${cid}`, { token: seatTok })
      assert(gone.json.task.status === 'cancelled', `该记成已停止：${gone.text}`)
    })

    await test('目标 Bot 那边有人按了停止：记成已停止、作废，不是没做成；主 Bot 没在等时送回的也这么说', async () => {
      // 主 Bot 在等：结论交给它，runKind 留着 aborted，话说成「已停止、作废」。
      const a = await assign({ fromBotId: mainBot, toBot: '财务', instruction: '那边会被人停', sessionId: 's-main', wait: true })
      const id = a.json.task.id
      assert((await due()).json.jobs.some((j) => j.taskId === id), '没领到')
      await post(id, 'started', { sessionId: 's-fin' })
      await post(id, 'finish', { kind: 'aborted' })
      const got = await req(gwBase, 'GET', `/runtime/tasks/${id}`, { token: seatTok })
      assert(got.json.task.runKind === 'aborted', `runKind 该是 aborted：${got.text}`)
      assert(String(got.json.task.result || '').startsWith('已停止') && !String(got.json.task.result || '').includes('没做成'), `该说成已停止、作废：${got.text}`)

      // 主 Bot 没在等（等太久先回去了）：兜底送回那条的标题说「那边停止了」，并叮嘱别重派。
      const b = await assign({ fromBotId: mainBot, toBot: '财务', instruction: '没人等着的那件', sessionId: 's-main' })
      const bid = b.json.task.id
      assert((await due()).json.jobs.some((j) => j.taskId === bid), '没领到')
      await post(bid, 'started', { sessionId: 's-fin' })
      await post(bid, 'finish', { kind: 'aborted' })
      const back = (await due()).json.jobs.find((j) => j.taskId === bid && j.phase === 'deliver')
      assert(back && back.instruction.includes('那边停止了') && back.instruction.includes('别重派'), `送回的话不对：${JSON.stringify(back)}`)
      await post(bid, 'finish', { kind: 'delivered' })
    })

    await test('别的机器领不到、也回报不了这台机器的活', async () => {
      const other = await pairMachine({ req, gwBase, ownerTok, orgId, managerPort: 18997 })
      const made = await assign({ fromBotId: mainBot, toBot: '财务', instruction: '查一下发票', sessionId: 's-main' })
      assert(made.status === 201, `派 ${made.status} ${made.text}`)
      const id = made.json.task.id
      const theirs = await req(gwBase, 'GET', '/worker/tasks/due', { token: other.token })
      assert(theirs.status === 200 && theirs.json.jobs.length === 0, `别的机器不该领到活：${theirs.text}`)
      const mine = (await due()).json.jobs.find((j) => j.taskId === id)
      assert(mine, '自己该领到')
      const steal = await req(gwBase, 'POST', `/worker/tasks/${id}/finish`, { token: other.token, body: { kind: 'completed', result: '偷的' } })
      assert(steal.status === 404, `别的机器回报该 404：${steal.status}`)
      await post(id, 'started', { sessionId: 's-fin' })
      assert((await post(id, 'finish', { kind: 'completed', result: '发票齐了' })).status === 200, '自己回报')
      const list = await tasksOf('s-main')
      assert(list.length >= 5 && list[0].id === id, `列表该按新的在前：${list.map((t) => t.id).join(',')}`)
    })
  } finally {
    gw.kill('SIGTERM')
  }
}
