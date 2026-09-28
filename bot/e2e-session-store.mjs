/**
 * 直接驱动 SessionService 的探针。**不走 HTTP**——要测的是同一条会话上的并发读写，
 * 那在 HTTP 层没法稳定复现。
 *
 * 由 e2e/session-store.mjs 用 `node --import tsx` 拉起，结果以 __RESULT__ 一行 JSON 回去。
 *
 * 放 bot/ 而不是 e2e/：ESM 的裸导入按**文件所在目录**往上找 node_modules，
 * 放在 e2e/ 下解析不到 @deepseek-ai/cordis。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionService } from './src/session/index.ts'
import { SESSION_FORMAT_VERSION } from './src/session/types.ts'

/** 每次都要一个空缓存的服务——竞态只在「还没缓存」那一刻存在。 */
async function freshService(root) {
  const ctx = new Context()
  ctx.plugin(SessionService, { root })
  await ctx.inject(['sessions'], () => {})
  return ctx.sessions
}

const CONCURRENCY = 20

function textOf(i) {
  return `并发消息-${i}`
}

function linesOf(file) {
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
}

async function appendMany(sessions, id) {
  const events = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      sessions.append(id, 'user/message', {
        message: { id: `m-${i}`, role: 'user', content: [{ type: 'text', text: textOf(i) }] },
        source: { kind: 'user' },
      }),
    ),
  )
  return events.map((e) => e.seq)
}

/**
 * 每个场景一个临时目录，跑完在 finally 里收掉——不收的话每跑一轮 /tmp 里多三份。
 * 目录建在外面、场景本体只拿 root：这样场景里头随便怎么 return / 抛，都收得到。
 */
async function inTmp(prefix, fn) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  try {
    return await fn(root)
  } finally {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {}
  }
}

/** 场景一：已经是当前格式，只测并发追加会不会各记各的 seq。 */
const concurrentAppend = () => inTmp('satuwork-sess-a-', async (root) => {
  const first = await freshService(root)
  const id = await first.create({ botId: 'default', title: '并发' })
  const file = join(root, `${id}.jsonl`)

  // 换一个空缓存的服务：模拟进程重启后第一次访问就撞上并发。
  const sessions = await freshService(root)
  const seqs = await appendMany(sessions, id)

  const reloaded = await freshService(root)
  const events = await reloaded.events(id)
  return {
    uniqueSeqs: new Set(seqs).size,
    expectedSeqs: CONCURRENCY,
    fileLines: linesOf(file).length,
    reloadedEvents: events.length,
    expectedEvents: 1 + CONCURRENCY,
    distinctTexts: new Set(
      events.filter((e) => e.type === 'user/message').map((e) => e.data.message.content[0].text),
    ).size,
  }
})

/** 场景二：旧格式（v1，无 botId），迁移重写和并发追加撞在一起。 */
const migrateUnderLoad = () => inTmp('satuwork-sess-b-', async (root) => {
  const id = 's-legacy-under-load'
  const file = join(root, `${id}.jsonl`)
  const legacy = [
    { seq: 1, time: 1, type: 'session', data: { version: 1, id, createdAt: 1, title: '旧会话' } },
    {
      seq: 2,
      time: 2,
      type: 'user/message',
      data: { message: { id: 'm0', role: 'user', content: [{ type: 'text', text: 'LEGACY-KEEP' }] }, source: { kind: 'user' } },
    },
  ]
  writeFileSync(file, legacy.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const sessions = await freshService(root)
  const seqs = await appendMany(sessions, id)

  const reloaded = await freshService(root)
  const events = await reloaded.events(id)
  const root0 = events[0]
  return {
    uniqueSeqs: new Set(seqs).size,
    expectedSeqs: CONCURRENCY,
    fileLines: linesOf(file).length,
    reloadedEvents: events.length,
    expectedEvents: legacy.length + CONCURRENCY,
    rootVersion: root0?.data?.version,
    currentVersion: SESSION_FORMAT_VERSION,
    rootBotId: root0?.data?.botId,
    keptLegacyBody: events.some(
      (e) => e.type === 'user/message' && e.data.message.content[0].text === 'LEGACY-KEEP',
    ),
    strays: readdirSync(root).filter((f) => !f.endsWith('.jsonl')),
  }
})

/**
 * 场景三：上个进程死在一轮对话中间——日志末尾留着一条没有配对 turn/end 的 turn/start。
 *
 * 崩溃、机器重启、以及每一次「重新部署」都会造出这个形状。不收口的话，界面按
 * 「最后一条 turn/start 之后有没有 turn/end」判断，会永远显示「正在处理」。
 */
const danglingTurn = () => inTmp('satuwork-sess-c-', async (root) => {

  // 3a. 悬着的一轮：写到 turn/start 和一条助手消息就断电
  const cut = 's-cut'
  writeFileSync(
    join(root, `${cut}.jsonl`),
    [
      { seq: 1, time: 1, type: 'session', data: { version: 2, id: cut, createdAt: 1, title: '断电', botId: 'default', origin: 'local' } },
      { seq: 2, time: 2, type: 'user/message', data: { message: { id: 'm0', role: 'user', content: [{ type: 'text', text: '在吗' }] }, source: { kind: 'user' } } },
      { seq: 3, time: 3, type: 'turn/start', data: { turn: 7 } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  )

  // 3b. 正常收口的一轮：不该被动
  const done = 's-done'
  const doneLines = [
    { seq: 1, time: 1, type: 'session', data: { version: 2, id: done, createdAt: 1, title: '正常', botId: 'default', origin: 'local' } },
    { seq: 2, time: 2, type: 'turn/start', data: { turn: 1 } },
    { seq: 3, time: 3, type: 'turn/end', data: { turn: 1, reason: 'completed' } },
  ]
  writeFileSync(join(root, `${done}.jsonl`), doneLines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const sessions = await freshService(root)
  const cutEvents = await sessions.events(cut)
  const doneEvents = await sessions.events(done)
  const last = cutEvents[cutEvents.length - 1]

  // 补的那条也要落盘：只补在内存里的话，下次重启又变回悬着的。
  const reloaded = await freshService(root)
  const cutAgain = await reloaded.events(cut)

  return {
    healedType: last?.type,
    healedTurn: last?.data?.turn,
    healedReason: last?.data?.reason,
    // seq 必须接着往下发，不能撞号——SSE 的 ?after= 游标靠它
    healedSeq: last?.seq,
    persisted: linesOf(join(root, `${cut}.jsonl`)).length,
    // 再读一次不该再补一条
    stableOnReload: cutAgain.filter((e) => e.type === 'turn/end').length,
    untouchedDone: doneEvents.length,
  }
})

/** 默认缓存上限是 64；造比它多的会话才挤得动缓存。 */
const CROWD = 72

/** 造 n 条委派子会话，挂在 parent 下面。 */
async function crowd(sessions, parent, n) {
  const ids = []
  for (let i = 0; i < n; i++) {
    ids.push(await sessions.create({ botId: 'default', kind: 'task', parent: { sessionId: parent, callId: `c-${i}`, taskId: `k-${i}` } }))
  }
  return ids
}

/**
 * 场景四：一条委派子会话正跑着一轮（卡在长命令 / 审批上），这时目录里的会话数超过
 * 缓存上限、侧栏又刷了一下列表。
 *
 * 修之前：子会话被挤出缓存，下一次 append 从盘上重读，healDanglingTurn 把正跑着的
 * 这一轮当成上个进程的残局，补一条假的 turn/end error——然后真的 turn/end 再来一条。
 */
const liveTurnUnderChurn = () => inTmp('satuwork-sess-d-', async (root) => {
  const sessions = await freshService(root)
  const main = await sessions.create({ botId: 'default', title: '主会话' })
  const live = await sessions.create({ botId: 'default', kind: 'task', parent: { sessionId: main, callId: 'c-live', taskId: 'k-live' } })
  await sessions.append(live, 'turn/start', { turn: 1 })
  const others = await crowd(sessions, main, CROWD)
  await sessions.list()
  await sessions.list({ tasks: true })
  // 把别的会话都读一遍：每一条都要进缓存，逼着淘汰。
  for (const id of others) await sessions.events(id)
  await sessions.append(live, 'turn/end', { turn: 1, reason: 'completed' })
  const ends = (await sessions.events(live)).filter((e) => e.type === 'turn/end')

  // list() 本身不该往缓存里塞东西：换一个空缓存的服务单独列一次。
  const lister = await freshService(root)
  const listed = await lister.list({ tasks: true })
  return {
    turnEnds: ends.length,
    endReason: ends[0]?.data?.reason,
    listedTotal: listed.length,
    expectedTotal: CROWD + 2,
    cacheAfterList: lister.cache.size,
  }
})

/**
 * 场景五：并发追加的同时别的会话在大批载入、挤缓存。
 *
 * 修之前：拿了号、还没落盘的那条会话被挤出去，再有人读它就从盘上重读出一份更小的
 * seq，下一条事件跟已经发出去的撞号。
 */
const appendUnderChurn = () => inTmp('satuwork-sess-e-', async (root) => {
  const first = await freshService(root)
  const main = await first.create({ botId: 'default', title: '主会话' })
  const [target] = await crowd(first, main, 1)
  const others = await crowd(first, main, CROWD)

  const sessions = await freshService(root)
  const appends = Array.from({ length: CONCURRENCY }, (_, i) =>
    sessions.append(target, 'user/message', {
      message: { id: `m-${i}`, role: 'user', content: [{ type: 'text', text: textOf(i) }] },
      source: { kind: 'user' },
    }),
  )
  const churn = others.map((id) => sessions.events(id))
  const reads = Array.from({ length: CONCURRENCY }, () => sessions.events(target))
  const seqs = (await Promise.all(appends)).map((e) => e.seq)
  await Promise.all([...churn, ...reads])

  const fileSeqs = linesOf(join(root, `${target}.jsonl`)).map((l) => JSON.parse(l).seq)
  return {
    uniqueSeqs: new Set(seqs).size,
    expectedSeqs: CONCURRENCY,
    // 追加排成一条队：调用顺序就是拿号顺序，也是落盘行序。
    increasing: seqs.every((n, i) => i === 0 || n > seqs[i - 1]),
    fileIncreasing: fileSeqs.every((n, i) => i === 0 || n > fileSeqs[i - 1]),
    fileUnique: new Set(fileSeqs).size === fileSeqs.length,
    fileLines: fileSeqs.length,
    expectedLines: 1 + CONCURRENCY,
  }
})

const result = {
  concurrentAppend: await concurrentAppend(),
  migrateUnderLoad: await migrateUnderLoad(),
  danglingTurn: await danglingTurn(),
  liveTurnUnderChurn: await liveTurnUnderChurn(),
  appendUnderChurn: await appendUnderChurn(),
}
console.log('__RESULT__' + JSON.stringify(result))
process.exit(0)
