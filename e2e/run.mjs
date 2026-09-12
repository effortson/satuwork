#!/usr/bin/env node
/**
 * Satuwork 端到端：真 HTTP，不 mock。
 *
 * Gateway 与 Bot 各自起子进程，隔离数据目录和端口，测完杀掉。
 * 不碰 ~/.satuwork-gateway / ~/.satuwork。
 *
 *   export PATH=/home/box/.local/node24/bin:$PATH
 *   node e2e/run.mjs
 */
import { spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runRuntimePath } from './runtime-path.mjs'
import { runGatewayChat } from './gateway-chat.mjs'
import { runDeployErrors } from './deploy-errors.mjs'
import { runUpgradeDrain } from './upgrade-drain.mjs'
import { runProxyClose } from './proxy-close.mjs'
import { runPairing } from './pairing.mjs'
import { runMachineDeploy } from './machine-deploy.mjs'
import { runLlmUsage } from './llm-usage.mjs'
import { runMarkdown } from './markdown.mjs'
import { runChatFold } from './chat-fold.mjs'
import { runToolNames } from './tool-names.mjs'
import { runSessionStore } from './session-store.mjs'
import { runLlmIdle } from './llm-idle.mjs'
import { runReplaySlice } from './replay-slice.mjs'
import { runRosterStream } from './roster-stream.mjs'
import { runWorkspaceFiles } from './workspace-files.mjs'
import { runPatch } from './patch.mjs'
import { runProcess } from './process.mjs'
import { runDocExtract } from './doc-extract.mjs'
import { runWebBot } from './web-bot.mjs'
import { runVision } from './vision.mjs'
import { runTurnImages } from './turn-images.mjs'
import { runMentions } from './mentions.mjs'
import { runRoutineModel } from './routine-model.mjs'
import { runRoutineTools } from './routine-tools.mjs'
import { runHistoryTime } from './history-time.mjs'
import { runCompact } from './compact.mjs'
import { runGatewayUrl } from './gateway-url.mjs'
import { runMaxSteps } from './max-steps.mjs'
import { runDelegate } from './delegate.mjs'
import { runToolCalls } from './toolcalls.mjs'
import { runShutdown } from './shutdown.mjs'
import { runGuards } from './guards.mjs'
import { runHandoff } from './handoff.mjs'
import { runRoutineRetry } from './routine-retry.mjs'
import { runRoutineWorker } from './routine-worker.mjs'
import { runWorker } from './worker.mjs'
import { runChannelWebhook } from './channel-webhook.mjs'
import { runServerless } from './serverless.mjs'
import { runLocalRoutines } from './local-routines.mjs'
import { runReleaseBlob } from './release-blob.mjs'
import { runBrowser } from './browser.mjs'
import { runMounted } from './mounted.mjs'
import { runSetup } from './setup.mjs'
import { runUiSmoke } from './ui-smoke.mjs'
import { runUiFiles } from './ui-files.mjs'
import { uiSource } from './ui-dom.mjs'
import { runCustomProvider } from './custom-provider.mjs'
import { runStats } from './stats.mjs'
import { runWebTools } from './web-tools.mjs'
import { runBilling } from './billing.mjs'
import { runMigrate } from './migrate.mjs'
import { runGlobalCatalog } from './global-catalog.mjs'
import { runConnectors } from './connectors.mjs'
import { runToolSearch } from './tool-search.mjs'
import { runSkills } from './skills.mjs'
import { runSkillsBot } from './skills-bot.mjs'
import { runMemoryBot } from './memory-bot.mjs'
import { runMemory } from './memory.mjs'
import { runConversationAudit } from './conversation-audit.mjs'
import { runBotTemplate } from './bot-template.mjs'
import { runManager } from './manager.mjs'
import { runManagerConfirm } from './manager-confirm.mjs'
import { runChannels } from './channels.mjs'
import { runTelegramRich } from './telegram-rich.mjs'
import { runTelegramChannel } from './telegram-channel.mjs'
import { PG_URL, requirePg } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { createCompany } from './org.mjs'
import { closeServer, killProbes, withDeadline } from './probe.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const gwRoot = join(root, 'gateway')
const botRoot = join(root, 'bot')

const GW_HOME = process.env.E2E_GW_HOME || tmpOf('satuwork-e2e-gw')
const BOT_HOME = process.env.E2E_BOT_HOME || tmpOf('satuwork-e2e-bot')

/**
 * 当前的会话落盘格式版本，直接从源码里读出来。
 *
 * 写死数字的话，每升一版都要来改一遍测试——改着改着就会有人图省事把断言删掉，
 * 而这几条断言恰恰是「迁移真的跑了」的唯一证据。
 */
const SESSION_FORMAT = Number(
  /SESSION_FORMAT_VERSION = (\d+)/.exec(readFileSync(join(root, 'bot/src/session/types.ts'), 'utf8'))?.[1],
)
/**
 * 端口在 main() 里向内核要（见 ports.mjs）。写死数字迟早会撞，而撞上之后的现象和
 * 真实原因毫无关系——探活会连到别人的残留进程上，然后报一个牛头不对马嘴的断言。
 * 环境变量仍然能钉死，本地调试时要固定地址还用得上。
 */
let GW_PORT = 0
let BOT_PORT = 0
const MACHINE_TOK = 'e2e-machine-token'
// bot 的入站凭据现在**只有**席位票。机器票不再进 bot.env，也不再被 bot 接受——
// 它是管家的 root 控制面凭据，而 bot.env 是席位那个普通 Linux 用户读得到的。
const SEAT_TOK = 'sat_e2e-seat-token'
const PLATFORM_TOK = 'e2e-platform-token'

const children = []
let failed = 0
let passed = 0
const skips = []

function log(line) {
  console.log(line)
}

/**
 * 记一条「这台机器上跑不了」。**和 test() 是两回事**：跳过的不算 passed，最后的
 * 清单里单列出来——一条静默 return 的用例看着是绿的，实际上什么都没验。
 */
function skip(reason) {
  skips.push(reason)
  log(`  # skip  ${reason}`)
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/**
 * 一条用例、一个套件各自的墙钟额度。
 *
 * **这两道闸是诊断，不是保险丝。** 在它们之前，任何一处等不到的东西——探针不退出、
 * 反代那侧不回话、`server.close()` 在等一条永远不断的 keep-alive——都会让整套 e2e
 * 停在上一条 `ok` 后面一动不动。屏幕上看不出卡在哪个套件，也看不出卡了多久，人只能
 * 等到失去耐心再 Ctrl-C，什么线索都没有。加上之后，卡住就是一条带名字的失败，剩下的
 * 用例照跑，一次运行能把问题全抖出来。
 *
 * 套件那道闸比用例那道宽：起 Gateway、起真管家、起 Chrome 都发生在用例之外。
 */
const TEST_TIMEOUT_MS = Number(process.env.E2E_TEST_TIMEOUT_MS) || 120_000
const SUITE_TIMEOUT_MS = Number(process.env.E2E_SUITE_TIMEOUT_MS) || 420_000
const ONLY_SUITES = new Set(String(process.env.E2E_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean))

/**
 * 「超时了，但函数体还在跑」这件事，闸本身管不了。
 *
 * `withDeadline` 只是不再等它：被丢下的那段 async 代码照样往下执行，还会接着调
 * `test()`——套件被判「卡住」之后，它的用例仍然一条条计入总数，甚至和下一个套件的
 * 用例混在同一段日志里。所以：
 *
 * - 每个套件、每条用例各有一个 AbortSignal（作为 fn 的第一个参数传进去），超时就
 *   abort。愿意看它的（等条件的循环、fetch）能就此收手；不看的照旧跑完，但——
 * - 套件用 AsyncLocalStorage 记着「我是谁」：超时之后它再调 `test()` 一律 no-op 并
 *   warn，**不计 passed / failed**。async 上下文跟着 await 链走，所以哪怕下一个套件
 *   已经开跑，僵尸套件的用例也认得出是它的，不会记到别人头上。
 * - 僵尸套件起的子进程仍然进 `children`，最后由 killAll 兜底杀掉。
 *
 * 没做到的：真正打断函数体。那需要每一处 await 都看 signal，这一版只把 signal 递到
 * 手上，逐处接线交给后面。
 */
const suiteScope = new AsyncLocalStorage()

async function test(name, fn) {
  const scope = suiteScope.getStore()
  if (scope?.dead) {
    log(`# warn  套件 ${scope.name} 已经超时，用例「${name}」不再计入`)
    return
  }
  const ac = new AbortController()
  const onSuiteAbort = () => ac.abort(scope.ac.signal.reason)
  scope?.ac.signal.addEventListener('abort', onSuiteAbort, { once: true })
  try {
    await withDeadline(Promise.resolve().then(() => fn({ signal: ac.signal })), `用例「${name}」`, TEST_TIMEOUT_MS)
    passed += 1
    log(`ok  ${name}`)
  } catch (e) {
    if (e?.deadline) ac.abort(e)
    failed += 1
    log(`not ok  ${name}`)
    log(`  ${e.stack || e.message}`)
  } finally {
    scope?.ac.signal.removeEventListener('abort', onSuiteAbort)
  }
}

/**
 * 跑一个套件，记时间，并且不让它卡死整场。
 *
 * 只有「卡住」会被就地记成失败往下走：别的错还是往上抛，行为和以前一样——一个起不来的
 * Gateway 会让后面每个套件各报一堆假失败，那种噪音比早点停下更糟。
 */
async function suite(name, fn) {
  if (ONLY_SUITES.size && !ONLY_SUITES.has(name)) return
  const t0 = Date.now()
  const scope = { name, dead: false, ac: new AbortController() }
  try {
    await withDeadline(
      suiteScope.run(scope, () => Promise.resolve().then(() => fn({ signal: scope.ac.signal }))),
      `套件 ${name}`,
      SUITE_TIMEOUT_MS,
    )
  } catch (e) {
    if (!e?.deadline) throw e
    // 从这一刻起它的 test() 全部 no-op（见 suiteScope）；它的子进程留给 killAll。
    scope.dead = true
    scope.ac.abort(e)
    failed += 1
    log(`not ok  ${name}（整个套件卡住了）`)
    log(`  ${e.message}`)
  }
  log(`# ${name} 用了 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

function start(name, args, { cwd, env }) {
  const child = spawn(process.execPath, args, {
    cwd,
    /**
     * 模型自动发现在 e2e 里一律关掉（GATEWAY_MODEL_DISCOVERY_MS=0）。
     *
     * 它挂在日常任务的那个 tick 上，而 handoff / routine-retry 几套把 tick
     * 调到了几百毫秒——不关的话每跑一次 e2e 就会去 models.dev 拉一遍 4MB，测试要联网
     * 才能过，模型目录的条数还会跟着上游天天变。放在这里而不是各文件里，是因为
     * 「e2e 不出网」是整套的口径，不该指望 27 个 spawn 点各自记得写一遍。
     *
     * 摆在 ...env 前面：真要验这条功能的用例仍然可以自己覆盖掉它。
     */
    env: { ...process.env, GATEWAY_MODEL_DISCOVERY_MS: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child._name = name
  child._out = ''
  const eat = (d) => {
    const s = d.toString()
    child._out += s
    process.stderr.write(`[${name}] ${s}`)
  }
  child.stdout.on('data', eat)
  child.stderr.on('data', eat)
  child.on('exit', (code, sig) => {
    child._exited = { code, sig }
  })
  // spawn 异步失败（找不到可执行文件、EAGAIN）走的是 'error' 事件，不是 'exit'。没人听
  // 它就是一个 uncaughtException，进程当场死、killAll 跑不到，探针和 Gateway 全成孤儿。
  // 记下来、标成已退出：等 waitHttp 那一层去报「起不来」，比在这里炸掉好查得多。
  child.on('error', (e) => {
    child._error = e
    child._exited = { code: null, sig: null }
    log(`[${name}] 子进程起不来：${e.message}`)
  })
  children.push(child)
  return child
}

function killAll() {
  // 探针是 detached 的（见 probe.mjs），终端的 Ctrl-C 到不了它们，这里一并收掉。
  killProbes()
  for (const child of children) {
    if (child._exited) continue
    try {
      child.kill('SIGTERM')
    } catch {}
  }
  const t = Date.now()
  while (Date.now() - t < 800) {
    /* 等一下再强杀 */
  }
  for (const child of children) {
    if (child._exited) continue
    try {
      child.kill('SIGKILL')
    } catch {}
  }
  try {
    unlinkSync(join(botRoot, 'cordis.e2e.yml'))
  } catch {}
}

/**
 * 等一个进程把端口听起来。
 *
 * 两件事容易写错，都在这儿一次做对：
 *
 * 1. **单次请求也要有闸。** 只在两次尝试之间看墙钟的话，一个「连得上却不回话」的
 *    对端会把 `await fetch` 卡在那儿，上面那个 30 秒的额度一次都轮不到检查。
 * 2. **进程已经死了就别再等满。** 起不来的时候有用的是它的输出，不是三十秒之后
 *    那句「等不到」。传 `child` 进来就顺带盯着它。
 */
async function waitHttp(url, { timeout = 30000, child, what } = {}) {
  const startAt = Date.now()
  let last
  while (Date.now() - startAt < timeout) {
    if (child?._exited) {
      const { code, sig } = child._exited
      throw new Error(`${what || url} 起不来：进程已退出（${sig || code}）\n${child._out}`)
    }
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (r.ok) return
      last = `HTTP ${r.status}`
    } catch (e) {
      last = e.message
    }
    await new Promise((x) => setTimeout(x, 150))
  }
  throw new Error(`等不到 ${what || url}：${last}`)
}

/**
 * 一次普通调用。**默认带闸**：`fetch` 自己不会超时，而这套里到处都是「拿一条本该
 * 立刻结束的响应」的调用——万一对面开的是一条带心跳的 SSE，`r.text()` 就永远收不完，
 * 整场停在这一行。要真的读一条流，别走这个助手（见「每条流的第一帧自报进程身份」）。
 */
async function req(base, method, path, { token, body, raw, headers: extra, timeout = 30000 } = {}) {
  const headers = { ...(extra || {}) }
  // raw：直接发字节（上传发布包），不套 JSON。
  if (raw !== undefined) headers['content-type'] = headers['content-type'] || 'application/gzip'
  else if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = 'Bearer ' + token
  const r = await fetch(base + path, {
    method,
    headers,
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await r.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: r.status, json, text, headers: r.headers, res: r }
}

function dumpHas(obj, needle) {
  return JSON.stringify(obj).includes(needle)
}

function treeHas(dir, needle) {
  if (!existsSync(dir)) return false
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let names
    try {
      names = readdirSync(cur)
    } catch {
      continue
    }
    for (const name of names) {
      const f = join(cur, name)
      let st
      try {
        st = statSync(f)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        stack.push(f)
        continue
      }
      try {
        if (readFileSync(f).includes(needle)) return true
      } catch {}
    }
  }
  return false
}

function listenMock(handler) {
  const server = createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, port: addr.port, url: `http://127.0.0.1:${addr.port}` })
    })
  })
}

async function runGateway() {
  log('\n# gateway')
  rmSync(GW_HOME, { recursive: true, force: true })
  const base = `http://127.0.0.1:${GW_PORT}`
  const child = start('gateway', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schemaOf('e2e_main'),
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_MACHINE_TOKEN: MACHINE_TOK,
      GATEWAY_PLATFORM_TOKEN: PLATFORM_TOK,
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: 'owner@satuwork.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-3080',
    },
  })
  // 带上 child：起不来时有用的是它的输出，不是三十秒后那句「等不到」。
  await waitHttp(base + '/health', { child, what: 'gateway' })

  let token
  let orgId
  let memberTok
  let ownerTok
  let botId
  let skillId
  let orgMachineTok
  const secret = 'sk-e2e-never-leak'

  await test('建公司走 owner 那条路：公司 + 管理员 + 席位', async () => {
    // 以前这条打的是 `POST /auth/register`——一次无鉴权请求建出公司加 admin。
    // 那条路没有任何产品入口用，却默认开着，已经删了；这里走界面真正走的那条。
    const made = await createCompany(req, base, {
      ownerEmail: 'owner@satuwork.test',
      ownerPassword: 'test-owner-3080',
      email: 'admin@acme.test',
      password: 'correct-horse',
      companyName: 'Acme',
      slug: 'acme',
      seats: 2,
    })
    assert(typeof made.token === 'string' && made.token.split('.').length === 3, 'jwt')
    assert(made.account.role === 'admin', 'admin')
    assert(made.company.slug === 'acme', 'company')
    assert(made.account.email === 'admin@acme.test', 'email')
    assert(!dumpHas(made.account, 'passwordHash'), '口令哈希不得出现')
    token = made.token
    orgId = made.company.id
    ownerTok = made.ownerToken

    // 没票打不开这家公司——建公司这条本来就是 owner-only 的。
    const anon = await req(base, 'GET', `/orgs/${orgId}`)
    assert(anon.status === 401, `无票读公司应 401，得到 ${anon.status}`)
  })

  await test('POST /auth/login → JWT', async () => {
    const r = await req(base, 'POST', '/auth/login', {
      body: { email: 'admin@acme.test', password: 'correct-horse' },
    })
    assert(r.status === 200, `login ${r.status} ${r.text}`)
    assert(typeof r.json.token === 'string' && r.json.token.split('.').length === 3, 'jwt')
    token = r.json.token
  })

  await test('GET /me → account, company, accessUrl（派机器之后）', async () => {
    const before = await req(base, 'GET', '/me', { token })
    assert(before.status === 200, `me ${before.status}`)
    assert(before.json.account.role === 'admin', 'account')
    assert(before.json.company.id === orgId, 'company')
    assert(before.json.plan.seats === 2, 'plan')
    assert(before.json.company.accessUrl == null, '派机器前不该有 accessUrl')

    // 机器地址是平台的事：管理员写 host 会被挡下，否则他能把 Gateway 的服务端拉取
    // 指到自己的服务器上，连 smt_ 一起送过去。
    const machHost = await req(base, 'POST', `/orgs/${orgId}/machine`, {
      token,
      body: { host: '10.0.0.1' },
    })
    assert(machHost.status === 403, `admin 写 host ${machHost.status} ${machHost.text}`)

    const mach = await req(base, 'POST', `/orgs/${orgId}/machine`, { token, body: {} })
    assert(mach.status === 201, `machine ${mach.status} ${mach.text}`)
    assert(mach.json.company.accessUrl === 'https://acme.satuwork.com', 'accessUrl')
    assert(!mach.json.machine.token, 'admin assign 带了 token')
    assert(!JSON.stringify(mach.json).includes('smt_'), 'admin assign 泄漏 smt_')

    const me = await req(base, 'GET', '/me', { token })
    assert(me.status === 200, `me2 ${me.status}`)
    assert(me.json.account.id, 'account')
    assert(me.json.company.id === orgId, 'company')
    assert(me.json.company.accessUrl === 'https://acme.satuwork.com', 'me.accessUrl')
  })

  await test('GET /jwks', async () => {
    const r = await req(base, 'GET', '/jwks')
    assert(r.status === 200, `jwks ${r.status}`)
    assert(Array.isArray(r.json.keys) && r.json.keys[0]?.kty === 'RSA', 'RSA jwk')
  })

  await test('席位用满后再加账号 → 409', async () => {
    const a = await req(base, 'POST', `/orgs/${orgId}/accounts`, {
      token,
      body: { email: 'member@acme.test', password: 'correct-horse', role: 'member' },
    })
    assert(a.status === 201, `member ${a.status} ${a.text}`)
    const full = await req(base, 'POST', `/orgs/${orgId}/accounts`, {
      token,
      body: { email: 'third@acme.test', password: 'correct-horse' },
    })
    assert(full.status === 409, `seat ${full.status} ${full.text}`)
    assert(full.json.error === '席位已满', '席位已满')
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'member@acme.test', password: 'correct-horse' },
    })
    assert(login.status === 200, 'member login')
    memberTok = login.json.token
  })

  await test('自己建 Bot / 管理员 CRUD 公司 skill；目录可见；成员不能写 skill', async () => {
    // Bot 现在是**每个人自己的**：管理员也走这条，公司那一层只剩一份模版。
    const created = await req(base, 'POST', '/runtime/bots', {
      token,
      body: { name: '公司助手' },
    })
    assert(created.status === 201, `bot ${created.status} ${created.text}`)
    assert(created.json.bot.scope === 'user', 'user bot')
    botId = created.json.bot.id

    const patched = await req(base, 'PATCH', `/runtime/bots/${botId}`, {
      token,
      body: { name: '公司助手改' },
    })
    assert(patched.status === 200, `patch bot ${patched.status}`)
    assert(patched.json.bot.name === '公司助手改', 'renamed')

    const got = await req(base, 'GET', `/runtime/bots/${botId}`, { token })
    assert(got.status === 200 && got.json.bot.name === '公司助手改', 'get bot')

    const skill = await req(base, 'POST', `/orgs/${orgId}/skills`, {
      token,
      body: { name: '内部技能', body: '步骤' },
    })
    assert(skill.status === 201, `skill ${skill.status} ${skill.text}`)
    assert(skill.json.skill && skill.json.skill.name === '内部技能', 'skill shape')
    skillId = skill.json.skill.id
    const skillPatch = await req(base, 'PATCH', `/orgs/${orgId}/skills/${skillId}`, {
      token,
      body: { name: '内部技能改' },
    })
    assert(skillPatch.status === 200, 'patch skill')
    assert(skillPatch.json.skill && skillPatch.json.skill.name === '内部技能改', 'patched skill')
    const skills = await req(base, 'GET', '/catalog/skills', { token })
    assert(skills.json.items.some((i) => i.id === skillId), 'catalog 看见 skill')

    // 员工建自己的 Bot 是**允许**的；不许的是碰公司这一层的东西。
    const ownBot = await req(base, 'POST', '/runtime/bots', {
      token: memberTok,
      body: { name: '员工自己的' },
    })
    assert(ownBot.status === 201, `member bot ${ownBot.status} ${ownBot.text}`)
    const denySkill = await req(base, 'POST', `/orgs/${orgId}/skills`, {
      token: memberTok,
      body: { name: '不该成功' },
    })
    assert(denySkill.status === 403, `member skill ${denySkill.status}`)
    // 但改不了别人那一个：这条是「只有主人看得见」的另一面。
    const denyPatch = await req(base, 'PATCH', `/runtime/bots/${botId}`, {
      token: memberTok,
      body: { name: '不该成功' },
    })
    assert(denyPatch.status === 404, `member patch ${denyPatch.status}`)
    await req(base, 'DELETE', `/runtime/bots/${ownBot.json.bot.id}`, { token: memberTok })

    const del = await req(base, 'DELETE', `/runtime/bots/${botId}`, { token })
    assert(del.status === 200 && del.json.deleted === true, 'delete bot')
    const delS = await req(base, 'DELETE', `/orgs/${orgId}/skills/${skillId}`, { token })
    assert(delS.status === 200 && delS.json.deleted === true, 'delete skill')
  })

  await test('owner platform credentials；公司管理员配得了自家密钥，普通成员不行', async () => {
    const ownerLogin = await req(base, 'POST', '/auth/login', {
      body: { email: 'owner@satuwork.test', password: 'test-owner-3080' },
    })
    assert(ownerLogin.status === 200, `owner login ${ownerLogin.status} ${ownerLogin.text}`)
    ownerTok = ownerLogin.json.token
    const platMach = await req(base, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
    assert(platMach.status === 200, `plat machine ${platMach.status} ${platMach.text}`)
    assert(typeof platMach.json.machine.token === 'string' && platMach.json.machine.token.startsWith('smt_'), 'owner 应看见 smt_')
    orgMachineTok = platMach.json.machine.token
    const orgMach = await req(base, 'GET', `/orgs/${orgId}/machine`, { token })
    assert(orgMach.status === 200, `org machine ${orgMach.status}`)
    assert(!orgMach.json.machine.token, '公司 machine JSON 带了 token')
    assert(!JSON.stringify(orgMach.json).includes(orgMachineTok), '公司 JSON 泄漏 smt_')

    const created = await req(base, 'POST', '/platform/credentials', {
      token: ownerTok,
      body: { provider: 'deepseek', secret },
    })
    assert(created.status === 201, `cred ${created.status} ${created.text}`)
    assert(created.json.credential.configured === true, 'create configured')
    assert(created.json.credential.provider === 'deepseek', 'provider')
    assert(!dumpHas(created.json, secret), 'create 泄漏 secret')
    assert(!Object.prototype.hasOwnProperty.call(created.json.credential, 'secret'), 'create 带 secret 字段')

    const put = await req(base, 'PUT', '/platform/credentials/deepseek', {
      token: ownerTok,
      body: { secret: 'sk-e2e-rotated-never-leak' },
    })
    assert(put.status === 200, `put ${put.status} ${put.text}`)
    assert(put.json.credential.configured === true, 'put configured')
    assert(!dumpHas(put.json, secret), 'put 泄漏旧 secret')
    assert(!dumpHas(put.json, 'sk-e2e-rotated-never-leak'), 'put 泄漏新 secret')

    const plat = await req(base, 'GET', '/platform/credentials', { token: ownerTok })
    assert(plat.status === 200, `plat list ${plat.status}`)
    assert(plat.json.credentials.some((c) => c.provider === 'deepseek' && c.configured === true), 'plat list deepseek')
    assert(!dumpHas(plat.json, secret), 'plat list 泄漏')
    assert(!dumpHas(plat.json, 'sk-e2e-rotated-never-leak'), 'plat list 泄漏新 secret')

    const list = await req(base, 'GET', `/orgs/${orgId}/credentials`, { token })
    assert(list.status === 200, `list ${list.status}`)
    assert(list.json.credentials.some((c) => c.provider === 'deepseek' && c.configured === true), 'list configured')
    assert(!dumpHas(list.json, secret), 'list 泄漏')
    assert(!dumpHas(list.json, 'sk-e2e-rotated-never-leak'), 'list 泄漏新 secret')

    // 公司密钥：管理员配得了（压过平台那把，见 custom-provider / manager 两套的取序用例），
    // 普通成员只能看列表、不能写。密钥同样不回显。
    const deny = await req(base, 'POST', `/orgs/${orgId}/credentials`, {
      token: memberTok,
      body: { provider: 'openai', secret },
    })
    assert(deny.status === 403, `member cred 该 403，实际 ${deny.status} ${deny.text}`)
    const mine = await req(base, 'POST', `/orgs/${orgId}/credentials`, {
      token,
      body: { provider: 'openai', secret },
    })
    assert(mine.status === 201, `admin cred 该 201，实际 ${mine.status} ${mine.text}`)
    assert(mine.json.credential.provider === 'openai' && mine.json.credential.configured === true, `admin cred 形状 ${mine.text}`)
    assert(mine.json.credential.scope === 'company', `公司密钥该标 scope=company，实际 ${mine.json.credential.scope}`)
    assert(!dumpHas(mine.json, secret), 'admin cred 泄漏 secret')
    const scoped = await req(base, 'GET', `/orgs/${orgId}/credentials`, { token })
    const openaiRow = scoped.json.credentials.find((c) => c.provider === 'openai')
    const dsRow = scoped.json.credentials.find((c) => c.provider === 'deepseek')
    assert(openaiRow?.scope === 'company', `列表里公司密钥该标 company：${JSON.stringify(openaiRow)}`)
    assert(dsRow?.scope === 'platform', `列表里平台密钥该标 platform：${JSON.stringify(dsRow)}`)
    const memberList = await req(base, 'GET', `/orgs/${orgId}/credentials`, { token: memberTok })
    assert(memberList.status === 200, `member 看列表该 200，实际 ${memberList.status}`)
    assert(!dumpHas(memberList.json, secret), 'member 列表泄漏 secret')
    // 删掉，别让后面拿 openai 的用例撞上这把假密钥。删第二次是 404。
    const gone = await req(base, 'DELETE', `/orgs/${orgId}/credentials/openai`, { token })
    assert(gone.status === 200, `删公司密钥 ${gone.status} ${gone.text}`)
    const gone2 = await req(base, 'DELETE', `/orgs/${orgId}/credentials/openai`, { token })
    assert(gone2.status === 404, `重复删该 404，实际 ${gone2.status} ${gone2.text}`)
  })

  await test('缺 GATEWAY_MACHINE_TOKEN 的 /internal/* → 401', async () => {
    const a = await req(base, 'POST', '/internal/machines', { body: { host: '10.0.0.2' } })
    assert(a.status === 401, `machines ${a.status}`)
    const b = await req(base, 'POST', '/internal/machines/x/heartbeat')
    assert(b.status === 401, `heartbeat ${b.status}`)
    const c = await req(base, 'POST', '/internal/sessions/index', { body: {} })
    assert(c.status === 401, `sessions ${c.status}`)
  })

  await test('登记机器时 host 要是干净的 http/https 地址', async () => {
    // host 会被 Gateway 带着 smt_ 去 fetch，路径 / 凭证 / 别的协议一律不收。
    for (const host of [
      'http://127.0.0.1:9/internal/sessions/x',
      'http://user:pw@127.0.0.1:9',
      'file:///etc/passwd',
      'http://127.0.0.1:9?a=1',
    ]) {
      const bad = await req(base, 'POST', '/internal/machines', { token: MACHINE_TOK, body: { host } })
      assert(bad.status === 400, `host ${host} 应 400，得到 ${bad.status} ${bad.text}`)
    }
    const ok = await req(base, 'POST', '/internal/machines', {
      token: MACHINE_TOK,
      body: { host: 'http://127.0.0.1:9' },
    })
    assert(ok.status === 201, `干净 host ${ok.status} ${ok.text}`)
    assert(ok.json.machine.host === 'http://127.0.0.1:9', `host 归一化 ${ok.json.machine.host}`)
    const bare = await req(base, 'POST', '/internal/machines', { token: MACHINE_TOK, body: { host: '10.0.0.7:3200' } })
    assert(bare.status === 201, `裸 host ${bare.status} ${bare.text}`)
    assert(bare.json.machine.host === '10.0.0.7:3200', `裸 host 应原样保留 ${bare.json.machine.host}`)
  })

  await test('引导票只能登记机器；心跳/索引/ready/用量要 smt_', async () => {
    const reg = await req(base, 'POST', '/internal/machines', { token: MACHINE_TOK, body: {} })
    assert(reg.status === 201, `register ${reg.status} ${reg.text}`)
    assert(typeof reg.json.machine.token === 'string' && reg.json.machine.token.startsWith('smt_'), '登记应返回 smt_')
    const smt = reg.json.machine.token
    const mid = reg.json.machine.id
    const publicReg = { ...reg.json.machine }
    delete publicReg.token
    assert(!JSON.stringify(publicReg).includes('smt_'), '登记公开字段含 smt_')

    const hbBoot = await req(base, 'POST', `/internal/machines/${mid}/heartbeat`, { token: MACHINE_TOK })
    assert(hbBoot.status === 401, `bootstrap heartbeat ${hbBoot.status}`)
    const idxBoot = await req(base, 'POST', '/internal/sessions/index', {
      token: MACHINE_TOK,
      body: { sessionId: 's-boot', companyId: orgId, accountId: 'x' },
    })
    assert(idxBoot.status === 401, `bootstrap index ${idxBoot.status}`)
    const readyBoot = await req(base, 'POST', '/internal/instances/no-such/ready', {
      token: MACHINE_TOK,
      body: { host: 'http://127.0.0.1:9', botId: 'b' },
    })
    assert(readyBoot.status === 401, `bootstrap ready ${readyBoot.status}`)

    const bind = await req(base, 'POST', `/orgs/${orgId}/machine`, { token, body: { id: mid } })
    assert(bind.status === 201, `bind ${bind.status} ${bind.text}`)
    assert(!bind.json.machine.token, 'bind 响应带 token')
    orgMachineTok = smt

    const hb = await req(base, 'POST', `/internal/machines/${mid}/heartbeat`, { token: smt })
    assert(hb.status === 200, `smt heartbeat ${hb.status} ${hb.text}`)
    const hbWrong = await req(base, 'POST', '/internal/machines/no-such/heartbeat', { token: smt })
    assert(hbWrong.status === 403, `heartbeat id mismatch ${hbWrong.status}`)
  })

  await test('GET /orgs/:id/audit 管理员能看操作记录；成员 403', async () => {
    const deny = await req(base, 'GET', `/orgs/${orgId}/audit`, { token: memberTok })
    assert(deny.status === 403, `member audit ${deny.status} ${deny.text}`)
    const r = await req(base, 'GET', `/orgs/${orgId}/audit`, { token })
    assert(r.status === 200, `audit ${r.status} ${r.text}`)
    assert(Array.isArray(r.json.events) && r.json.events.length > 0, '空操作记录')
    assert(r.json.events.some((e) => e.action === 'platform.org.create' || e.action === 'auth.login' || e.action === 'machine.assign'), '缺已知事件')
  })

  await test('对话审计：索引上报、筛选、成员 403、离线拉全文、不落正文', async () => {
    const UNIQUE = 'UNIQUE-BODY-MUST-NOT-LAND-ON-GATEWAY'
    const adminMe = await req(base, 'GET', '/me', { token })
    assert(adminMe.status === 200, `admin me ${adminMe.status}`)
    const memberMe = await req(base, 'GET', '/me', { token: memberTok })
    assert(memberMe.status === 200, `member me ${memberMe.status}`)
    const adminId = adminMe.json.account.id
    const memberId = memberMe.json.account.id
    const t1 = 1_700_000_000_000
    const t2 = 1_700_000_100_000

    assert(orgMachineTok && orgMachineTok.startsWith('smt_'), 'need bound machine token')
    const plat = await req(base, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
    const deadId = plat.json.machine.id
    assert(plat.json.machine.token === orgMachineTok, 'owner token 应对上')

    const a = await req(base, 'POST', '/internal/sessions/index', {
      token: orgMachineTok,
      body: {
        sessionId: 's-audit-early',
        companyId: orgId,
        accountId: adminId,
        botId: 'bot-audit',
        machineId: deadId,
        title: '早会话',
        origin: 'company',
        remoteId: 'bot-audit',
        messageCount: 3,
        createdAt: t1,
        updatedAt: t1,
        events: [{ type: 'user/message', data: { message: { content: [{ type: 'text', text: UNIQUE }] } } }],
      },
    })
    assert(a.status === 200, `index a ${a.status} ${a.text}`)
    assert(a.json.session.sessionId === 's-audit-early', 'sessionId a')
    assert(a.json.session.updatedAt === t1, 'updatedAt a')
    assert(!dumpHas(a.json, UNIQUE), 'index 响应带正文')

    const b = await req(base, 'POST', '/internal/sessions/index', {
      token: orgMachineTok,
      body: {
        sessionId: 's-audit-late',
        companyId: orgId,
        accountId: memberId,
        title: '晚会话',
        createdAt: t2,
        updatedAt: t2,
        machineId: deadId,
      },
    })
    assert(b.status === 200, `index b ${b.status} ${b.text}`)

    const listed = await req(base, 'GET', `/orgs/${orgId}/sessions`, { token })
    assert(listed.status === 200, `list ${listed.status} ${listed.text}`)
    assert(Array.isArray(listed.json.sessions) && listed.json.sessions.length >= 2, '应有两条')
    const ids = listed.json.sessions.map((x) => x.sessionId)
    assert(ids.includes('s-audit-early') && ids.includes('s-audit-late'), '缺会话')
    const early = listed.json.sessions.find((x) => x.sessionId === 's-audit-early')
    assert(early.accountId === adminId, 'early account')
    assert(early.accountName, 'accountName')
    assert(early.title === '早会话', 'title')
    assert(early.origin === 'company', 'origin')
    assert(early.remoteId === 'bot-audit', 'remoteId')
    assert(early.messageCount === 3, 'messageCount')
    assert(!dumpHas(listed.json, UNIQUE), 'list 带正文')
    assert(!Object.prototype.hasOwnProperty.call(early, 'events'), 'list 带 events')

    const one = await req(base, 'GET', `/orgs/${orgId}/sessions?accountId=${encodeURIComponent(adminId)}`, { token })
    assert(one.status === 200, `filter account ${one.status}`)
    assert(one.json.sessions.length === 1, `account filter ${one.json.sessions.length}`)
    assert(one.json.sessions[0].sessionId === 's-audit-early', 'account filter id')

    const byBot = await req(base, 'GET', `/orgs/${orgId}/sessions?botId=${encodeURIComponent('bot-audit')}`, { token })
    assert(byBot.status === 200, `filter bot ${byBot.status}`)
    assert(byBot.json.sessions.length === 1 && byBot.json.sessions[0].sessionId === 's-audit-early', 'bot filter')

    const ranged = await req(base, 'GET', `/orgs/${orgId}/sessions?from=${t1 + 1}&to=${t2}`, { token })
    assert(ranged.status === 200, `range ${ranged.status}`)
    assert(ranged.json.sessions.length === 1, `range len ${ranged.json.sessions.length}`)
    assert(ranged.json.sessions[0].sessionId === 's-audit-late', 'range id')

    const denyList = await req(base, 'GET', `/orgs/${orgId}/sessions`, { token: memberTok })
    assert(denyList.status === 403, `member list ${denyList.status} ${denyList.text}`)
    const denyOne = await req(base, 'GET', `/orgs/${orgId}/sessions/s-audit-early`, { token: memberTok })
    assert(denyOne.status === 403, `member get ${denyOne.status}`)

    const missing = await req(base, 'GET', `/orgs/${orgId}/sessions/s-not-here`, { token })
    assert(missing.status === 404, `missing ${missing.status} ${missing.text}`)

    const pulled = await req(base, 'GET', `/orgs/${orgId}/sessions/s-audit-early`, { token })
    assert(pulled.status === 200, `pull offline ${pulled.status} ${pulled.text}`)
    assert(pulled.json.session && pulled.json.session.sessionId === 's-audit-early', 'pull session')
    assert(pulled.json.events === null, 'events should be null')
    assert(pulled.json.pullError === '机器不在线，全文拉不下来', `pullError ${pulled.json.pullError}`)
    assert(!dumpHas(pulled.json, UNIQUE), 'pull 响应编造正文')
    assert(!treeHas(GW_HOME, UNIQUE), 'Gateway home 含正文')

    const audit = await req(base, 'GET', `/orgs/${orgId}/audit`, { token })
    assert(audit.status === 200, `audit after pull ${audit.status}`)
    const pullEv = audit.json.events.find((e) => e.action === 'session.pull')
    assert(pullEv, '缺 session.pull')
    assert(pullEv.detail && pullEv.detail.sessionId === 's-audit-early', 'pull detail sessionId')
    assert(!dumpHas(pullEv, UNIQUE), '审计里有正文')
  })

  await test('行为边界的表态落进审计', async () => {
    const adminMe = await req(base, 'GET', '/me', { token })
    const adminId = adminMe.json.account.id

    const ok = await req(base, 'POST', '/internal/guard-events', {
      token: orgMachineTok,
      body: {
        companyId: orgId,
        accountId: adminId,
        sessionId: 's-audit-early',
        botId: 'bot-audit',
        callId: 'call-1',
        tool: 'mcp_gmail_send_email',
        guard: 'no-external',
        outcome: 'blocked',
        reason: '这个 Bot 没有被授权使用 mcp_gmail_send_email 所在的外部系统',
        at: 1_700_000_200_000,
      },
    })
    assert(ok.status === 200, `guard-events ${ok.status} ${ok.text}`)

    const audit = await req(base, 'GET', `/orgs/${orgId}/audit`, { token })
    const hit = (audit.json.events || []).find((e) => e.action === 'bot.guard.blocked')
    assert(hit, '拦截没进审计')
    // 「拦了什么、哪条边界拦的」是管理员唯一会问的两个问题，两样都得在详情里。
    assert(hit.detail && hit.detail.guard === 'no-external', `guard ${JSON.stringify(hit.detail)}`)
    assert(hit.detail.tool === 'mcp_gmail_send_email', `tool ${JSON.stringify(hit.detail)}`)
    assert(hit.accountId === adminId, `accountId ${hit.accountId}`)

    // action 是按白名单拼的，不是原样收 body——那一栏进检索面，让上报方自己定义
    // 动作名的话，迟早会长出十几种拼写。
    const bogus = await req(base, 'POST', '/internal/guard-events', {
      token: orgMachineTok,
      body: { companyId: orgId, accountId: adminId, guard: '我自己编的', outcome: 'blocked', tool: 'x' },
    })
    assert(bogus.status === 400, `不认识的 guard 拿到 ${bogus.status}`)
    const bogusOutcome = await req(base, 'POST', '/internal/guard-events', {
      token: orgMachineTok,
      body: { companyId: orgId, accountId: adminId, guard: 'pii', outcome: '随便写的', tool: 'x' },
    })
    assert(bogusOutcome.status === 400, `不认识的 outcome 拿到 ${bogusOutcome.status}`)

    /**
     * **席位认识的每一条边界，这边都得收得下。**
     *
     * 两张表分处两个包：席位的 `GuardId`（bot/src/policy/index.ts）和 Gateway 的白名单
     * `GUARD_IDS`（routes/internal.ts）。加一条只改一边的后果不是报错——是席位拦得
     * 好好的、报上来一律 400，而席位的 outbox **没有重试上限**，于是每次拦截都留下
     * 一行永远重发的队列，审计里却一条记录都没有。「只拦不报」正是这条路要防的事。
     *
     * 所以这里**从席位源码里把那个联合类型读出来**逐个试，而不是手抄一份名单——
     * 手抄的那份下次照样会漏（同 bot/e2e-mounted.mjs 的工具名单）。
     */
    const guardSrc = readFileSync(join(botRoot, 'src/policy/index.ts'), 'utf8')
    const guardIds = [...(/export type GuardId =([^\n]+(?:\n\s*\|[^\n]+)*)/.exec(guardSrc)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    assert(guardIds.length >= 4, `没从席位源码里读出 GuardId：${JSON.stringify(guardIds)}`)
    for (const g of guardIds) {
      const r = await req(base, 'POST', '/internal/guard-events', {
        token: orgMachineTok,
        body: { companyId: orgId, accountId: adminId, guard: g, outcome: 'blocked', tool: 'x' },
      })
      assert(r.status === 200, `席位认识的边界「${g}」Gateway 收不下（${r.status} ${r.text}）——两张名单漏了同步`)
    }

    // 别家公司的账号：报不进来。租户边界和会话索引那条是同一套口径。
    const outsider = await req(base, 'POST', '/internal/guard-events', {
      token: orgMachineTok,
      body: {
        companyId: orgId,
        accountId: '00000000-0000-4000-8000-000000000000',
        guard: 'pii',
        outcome: 'blocked',
        tool: 'x',
      },
    })
    assert(outsider.status === 403, `跨公司上报拿到 ${outsider.status}`)
  })

  await test('会话列表翻页：不漏行不重复，同一毫秒也分得开', async () => {
    const adminMe = await req(base, 'GET', '/me', { token })
    const adminId = adminMe.json.account.id
    // 三条 updatedAt 完全相同——只拿 updatedAt 当游标的话，这里要么漏要么无限循环。
    const SAME = 1_700_000_500_000
    const ids = ['s-page-a', 's-page-b', 's-page-c']
    for (const sessionId of ids) {
      const r = await req(base, 'POST', '/internal/sessions/index', {
        token: orgMachineTok,
        body: {
          sessionId,
          companyId: orgId,
          accountId: adminId,
          botId: 'bot-page',
          title: sessionId,
          messageCount: 1,
          createdAt: SAME,
          updatedAt: SAME,
        },
      })
      assert(r.status === 200, `建 ${sessionId} ${r.status} ${r.text}`)
    }

    const seen = []
    let cursor = ''
    let pages = 0
    for (; pages < 10; pages++) {
      const qs = `?botId=bot-page&limit=1${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`
      const r = await req(base, 'GET', `/orgs/${orgId}/sessions${qs}`, { token })
      assert(r.status === 200, `翻页 ${r.status} ${r.text}`)
      assert(r.json.sessions.length <= 1, `limit=1 却回了 ${r.json.sessions.length} 条`)
      seen.push(...r.json.sessions.map((x) => x.sessionId))
      if (!r.json.hasMore) break
      assert(r.json.nextCursor, 'hasMore 为真却没给 nextCursor')
      cursor = r.json.nextCursor
    }
    assert(pages < 10, '翻页没有终点，游标可能没在推进')
    assert(seen.length === ids.length, `应当正好 ${ids.length} 条，实际 ${seen.length}：${seen.join(',')}`)
    assert(new Set(seen).size === seen.length, `翻页翻出重复行：${seen.join(',')}`)
    for (const id of ids) assert(seen.includes(id), `翻页漏了 ${id}`)

    // 不带 cursor 时一次到底，并且明确说「没有更多」。
    const all = await req(base, 'GET', `/orgs/${orgId}/sessions?botId=bot-page`, { token })
    assert(all.status === 200, `整页 ${all.status} ${all.text}`)
    assert(all.json.sessions.length === ids.length, `整页应 ${ids.length} 条，实际 ${all.json.sessions.length}`)
    assert(all.json.hasMore === false, 'hasMore 应为 false')
    assert(all.json.nextCursor === null, 'nextCursor 应为 null')
    assert(typeof all.json.limit === 'number' && all.json.limit > 0, 'limit 应当带回去')
  })

  await test('对话审计：mock 机器在线时按需拉全文，Gateway 不落盘', async () => {
    const HELLO = 'AUDIT-OK-HELLO'
    let liveTok = ''
    const mock = await listenMock((req, res) => {
      // 这个 mock 演的是**管家**：它认 x-satuwork-machine 上的机器票，authorization 上
      // 那把是给 bot 的席位票，原样透传、管家不解读。两个头两把票，不再是同一把。
      if (
        req.url &&
        req.url.startsWith('/internal/sessions/') &&
        req.headers['x-satuwork-machine'] === liveTok &&
        String(req.headers.authorization || '').startsWith('Bearer sat_')
      ) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            events: [{ type: 'user/message', data: { message: { content: [{ type: 'text', text: HELLO }] } } }],
          }),
        )
        return
      }
      res.writeHead(404)
      res.end()
    })
    try {
      const adminMe = await req(base, 'GET', '/me', { token })
      const mach = await req(base, 'POST', '/internal/machines', {
        token: MACHINE_TOK,
        body: { host: mock.url },
      })
      assert(mach.status === 201, `mock machine ${mach.status} ${mach.text}`)
      liveTok = mach.json.machine.token
      assert(typeof liveTok === 'string' && liveTok.startsWith('smt_'), 'live smt_')
      const bind = await req(base, 'POST', `/orgs/${orgId}/machine`, { token, body: { id: mach.json.machine.id } })
      assert(bind.status === 201, `bind live ${bind.status} ${bind.text}`)
      orgMachineTok = liveTok
      const idx = await req(base, 'POST', '/internal/sessions/index', {
        token: liveTok,
        body: {
          sessionId: 's-audit-live',
          companyId: orgId,
          accountId: adminMe.json.account.id,
          machineId: mach.json.machine.id,
          title: '在线会话',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      })
      assert(idx.status === 200, `live index ${idx.status} ${idx.text}`)
      const pulled = await req(base, 'GET', `/orgs/${orgId}/sessions/s-audit-live`, { token })
      assert(pulled.status === 200, `live pull ${pulled.status} ${pulled.text}`)
      assert(Array.isArray(pulled.json.events) && pulled.json.events[0]?.type === 'user/message', 'events')
      assert(dumpHas(pulled.json, HELLO), '缺 AUDIT-OK-HELLO')
      assert(!pulled.json.pullError, '不应有 pullError')
      assert(!treeHas(GW_HOME, HELLO), 'Gateway home 含拉下来的正文')
    } finally {
      await closeServer(mock.server, '审计源替身')
    }
  })

  await test('SPA GET /audit 与 /audit/:id 返回 html', async () => {
    const a = await req(base, 'GET', '/audit')
    assert(a.status === 200, `spa /audit ${a.status}`)
    assert(String(a.text).includes('<!doctype html>') || String(a.text).includes('Satuwork'), 'spa html')
    const b = await req(base, 'GET', '/audit/s-audit-early')
    assert(b.status === 200, `spa /audit/:id ${b.status}`)
    assert(String(b.text).includes('<!doctype html>') || String(b.text).includes('Satuwork'), 'spa detail html')
  })

  await test('SPA GET /chat 与 /a/default 返回 html', async () => {
    const a = await req(base, 'GET', '/chat')
    assert(a.status === 200, `spa /chat ${a.status}`)
    assert(String(a.text).includes('<!doctype html>') || String(a.text).includes('Satuwork'), 'spa /chat html')
    const b = await req(base, 'GET', '/a/default')
    assert(b.status === 200, `spa /a ${b.status}`)
    assert(String(b.text).includes('<!doctype html>') || String(b.text).includes('Satuwork'), 'spa /a html')
  })

  await test('owner GET /runtime/bots → 403；成员无实例 → 200 名册', async () => {
    const owner = await req(base, 'GET', '/runtime/bots', { token: ownerTok })
    assert(owner.status === 403, `owner ${owner.status} ${owner.text}`)
    const member = await req(base, 'GET', '/runtime/bots', { token: memberTok })
    assert(member.status === 200, `member ${member.status} ${member.text}`)
    assert(Array.isArray(member.json.bots), 'bots array')
  })

  await test('GET /v1/models 要登录票或 API Key；目录无 secret', async () => {
    const unauth = await req(base, 'GET', '/v1/models')
    assert(unauth.status === 401, `unauth models ${unauth.status}`)
    const r = await req(base, 'GET', '/v1/models', { token })
    assert(r.status === 200, `models ${r.status} ${r.text}`)
    assert(r.json.object === 'list', 'object list')
    assert(Array.isArray(r.json.data) && r.json.data.length > 0, '空目录')
    assert(r.json.data.some((m) => m.owned_by === 'deepseek' || m.provider === 'deepseek'), '缺 deepseek')
    assert(!dumpHas(r.json, secret), 'models 泄漏 secret')
    assert(!dumpHas(r.json, 'sk-e2e-rotated-never-leak'), 'models 泄漏 rotated')
  })

  await test('建管理员/员工默认有 API Key 和 access token；列表不泄漏；详情 owner 可见', async () => {
    const adminMe = await req(base, 'GET', '/me', { token })
    assert(adminMe.status === 200, `admin me ${adminMe.status}`)
    const adminId = adminMe.json.account.id
    const memberMe = await req(base, 'GET', '/me', { token: memberTok })
    assert(memberMe.status === 200, `member me ${memberMe.status}`)
    const memberId = memberMe.json.account.id

    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'admin@acme.test', password: 'correct-horse' },
    })
    assert(login.status === 200, `relogin ${login.status}`)

    const list = await req(base, 'GET', '/platform/accounts', { token: ownerTok })
    assert(list.status === 200, `list ${list.status} ${list.text}`)
    for (const a of list.json.accounts || []) {
      assert(!Object.prototype.hasOwnProperty.call(a, 'apiKey'), '列表带 apiKey 字段')
      assert(!Object.prototype.hasOwnProperty.call(a, 'accessToken'), '列表带 accessToken 字段')
    }
    const ownerRow = list.json.accounts.find((a) => a.role === 'owner')
    assert(ownerRow && ownerRow.id, '缺 owner')

    const missing = await req(base, 'GET', '/platform/accounts/no-such-account', { token: ownerTok })
    assert(missing.status === 404, `missing ${missing.status}`)

    const adminDetail = await req(base, 'GET', `/platform/accounts/${adminId}`, { token: ownerTok })
    assert(adminDetail.status === 200, `admin detail ${adminDetail.status} ${adminDetail.text}`)
    assert(typeof adminDetail.json.apiKey === 'string' && adminDetail.json.apiKey.startsWith('sk_sw_'), 'admin apiKey')
    assert(typeof adminDetail.json.accessToken === 'string' && adminDetail.json.accessToken.startsWith('sat_'), 'admin accessToken')
    assert(adminDetail.json.account && adminDetail.json.account.id === adminId, 'admin account')
    assert(adminDetail.json.company && adminDetail.json.company.id === orgId, 'admin company')

    const memberDetail = await req(base, 'GET', `/platform/accounts/${memberId}`, { token: ownerTok })
    assert(memberDetail.status === 200, `member detail ${memberDetail.status} ${memberDetail.text}`)
    assert(typeof memberDetail.json.apiKey === 'string' && memberDetail.json.apiKey.startsWith('sk_sw_'), 'member apiKey')
    assert(typeof memberDetail.json.accessToken === 'string' && memberDetail.json.accessToken.startsWith('sat_'), 'member accessToken')

    const ownerDetail = await req(base, 'GET', `/platform/accounts/${ownerRow.id}`, { token: ownerTok })
    assert(ownerDetail.status === 200, `owner detail ${ownerDetail.status} ${ownerDetail.text}`)
    assert(ownerDetail.json.apiKey === null, 'owner apiKey')
    assert(ownerDetail.json.accessToken === null, 'owner accessToken')

    const apiKey = adminDetail.json.apiKey
    const accessToken = adminDetail.json.accessToken
    assert(!dumpHas(list.json, apiKey), '列表泄漏 apiKey')
    assert(!dumpHas(list.json, accessToken), '列表泄漏 accessToken')
    assert(!dumpHas(login.json, apiKey), 'login 泄漏 apiKey')
    assert(!dumpHas(login.json, accessToken), 'login 泄漏 accessToken')
    assert(!dumpHas(adminMe.json, apiKey), '/me 泄漏 apiKey')
    assert(!dumpHas(adminMe.json, accessToken), '/me 泄漏 accessToken')

    const spaUsers = await req(base, 'GET', '/users')
    assert(spaUsers.status === 200, `spa /users ${spaUsers.status}`)
    assert(String(spaUsers.text).includes('<!doctype html>') || String(spaUsers.text).includes('Satuwork'), 'spa /users html')
    const spaDetail = await req(base, 'GET', `/users/${adminId}`)
    assert(spaDetail.status === 200, `spa /users/:id ${spaDetail.status}`)
    assert(String(spaDetail.text).includes('<!doctype html>') || String(spaDetail.text).includes('Satuwork'), 'spa detail html')
    const appJs = uiSource(join(gwRoot, 'ui'))
    assert(appJs.includes('function userDetailPage'), '缺 userDetailPage')
  })

  await test('平台侧改账号状态：停用当场断票，启用回得来，自己改不动', async () => {
    /**
     * 「用户」那一页上的「停用 / 启用」。它**不能**走公司侧那条
     * `/orgs/:id/accounts/:accountId`——那一页列的是全平台的人，包括不属于任何公司的
     * 平台账号，那条路根本够不着。
     *
     * 另起一家公司做这件事：停用会把那个人手上的票当场作废（tokenRevokedAt），拿主用例
     * 里那几个共用账号来试，后面所有用例的票都会跟着死。
     */
    const org = await req(base, 'POST', '/platform/orgs', {
      token: ownerTok,
      body: {
        name: 'UserStatus', slug: 'userstatus', contactName: '钱七',
        contactPhone: '+86 13800000001', contactEmail: 'c@userstatus.test',
        adminEmail: 'admin@userstatus.test', adminPassword: 'correct-horse-2',
      },
    })
    assert(org.status === 201, `建公司 ${org.status} ${org.text}`)
    const orgId2 = org.json.company.id
    const up = await req(base, 'PUT', `/platform/orgs/${orgId2}/plan`, { token: ownerTok, body: { seats: 3 } })
    assert(up.status === 200, `加席位 ${up.status} ${up.text}`)
    /**
     * 要停的是**第二个成员**，不是那家公司唯一的管理员——后者会被「至少要留一个管理员」
     * 挡下（这条规矩两条路共用，公司侧的用例里已经验过）。这条用例问的是另一件事：
     * 平台这条路本身通不通。
     */
    const made = await req(base, 'POST', `/orgs/${orgId2}/accounts`, {
      token: ownerTok,
      body: { email: 'staff@userstatus.test', password: 'correct-horse-3', name: '员工', role: 'member' },
    })
    assert(made.status === 201, `建成员 ${made.status} ${made.text}`)
    const theirAccountId = made.json.account.id
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'staff@userstatus.test', password: 'correct-horse-3' },
    })
    assert(login.status === 200, `登录 ${login.status} ${login.text}`)
    const theirTok = login.json.token

    // 非 owner 碰不到这条路：它是平台那一页的入口，公司管理员不该能改别家公司的人。
    const denied = await req(base, 'PATCH', `/platform/accounts/${theirAccountId}`, {
      token: theirTok,
      body: { status: 'disabled' },
    })
    assert(denied.status === 403, `非 owner 也能改 ${denied.status} ${denied.text}`)

    const off = await req(base, 'PATCH', `/platform/accounts/${theirAccountId}`, {
      token: ownerTok,
      body: { status: 'disabled' },
    })
    assert(off.status === 200 && off.json.account.status === 'disabled', `停用 ${off.status} ${off.text}`)
    // 停用的**当下**就该断，不是等票过期：手上那张 JWT 还没到期，但它必须不好使了。
    const stale = await req(base, 'GET', '/me', { token: theirTok })
    assert(stale.status === 401, `停用之后旧票还能用 ${stale.status}`)
    const reLogin = await req(base, 'POST', '/auth/login', {
      body: { email: 'staff@userstatus.test', password: 'correct-horse-3' },
    })
    assert(reLogin.status !== 200, `停用之后还登得进来 ${reLogin.status} ${reLogin.text}`)

    const on = await req(base, 'PATCH', `/platform/accounts/${theirAccountId}`, {
      token: ownerTok,
      body: { status: 'active' },
    })
    assert(on.status === 200 && on.json.account.status === 'active', `启用 ${on.status} ${on.text}`)
    const backIn = await req(base, 'POST', '/auth/login', {
      body: { email: 'staff@userstatus.test', password: 'correct-horse-3' },
    })
    assert(backIn.status === 200, `启用之后登不回来 ${backIn.status} ${backIn.text}`)

    // 自己改不动：一个人在这一页上把自己停掉，下一次请求就 401，谁也开不回来。
    const ownerRow = (await req(base, 'GET', '/platform/accounts', { token: ownerTok })).json.accounts.find(
      (a) => a.role === 'owner',
    )
    const self = await req(base, 'PATCH', `/platform/accounts/${ownerRow.id}`, {
      token: ownerTok,
      body: { status: 'disabled' },
    })
    assert(self.status === 400, `owner 把自己停掉了 ${self.status} ${self.text}`)

    // 待接受的不能被管理员直接激活——口令得由本人用邀请链接设。规矩和公司侧那条共用
    // 一份（lib/org.ts 的 patchAccount），这里验的是平台这条路也走的是那一份。
    const invited = await req(base, 'POST', `/orgs/${orgId2}/accounts/members`, {
      token: ownerTok,
      body: { email: 'pending@userstatus.test', name: '待接受', role: 'member' },
    })
    assert(invited.status === 201, `邀请 ${invited.status} ${invited.text}`)
    const force = await req(base, 'PATCH', `/platform/accounts/${invited.json.user.id}`, {
      token: ownerTok,
      body: { status: 'active' },
    })
    assert(force.status === 400, `待接受被直接激活了 ${force.status} ${force.text}`)

    const missing = await req(base, 'PATCH', '/platform/accounts/no-such-account', {
      token: ownerTok,
      body: { status: 'disabled' },
    })
    assert(missing.status === 404, `不存在的账号 ${missing.status}`)
  })

  await test('API Key 调 /v1/models；access token 调 /me；交叉 401', async () => {
    const adminMe = await req(base, 'GET', '/me', { token })
    const adminId = adminMe.json.account.id
    const detail = await req(base, 'GET', `/platform/accounts/${adminId}`, { token: ownerTok })
    assert(detail.status === 200, `detail ${detail.status} ${detail.text}`)
    const apiKey = detail.json.apiKey
    const accessToken = detail.json.accessToken
    assert(typeof apiKey === 'string' && apiKey.startsWith('sk_sw_'), 'apiKey')
    assert(typeof accessToken === 'string' && accessToken.startsWith('sat_'), 'accessToken')

    const byBearer = await req(base, 'GET', '/v1/models', { token: apiKey })
    assert(byBearer.status === 200, `apiKey bearer ${byBearer.status} ${byBearer.text}`)
    assert(byBearer.json.object === 'list', 'apiKey list')

    const byHeader = await req(base, 'GET', '/v1/models', { headers: { 'x-api-key': apiKey } })
    assert(byHeader.status === 200, `x-api-key ${byHeader.status} ${byHeader.text}`)
    assert(byHeader.json.object === 'list', 'x-api-key list')

    const satOnV1 = await req(base, 'GET', '/v1/models', { token: accessToken })
    assert(satOnV1.status === 401, `sat /v1 ${satOnV1.status} ${satOnV1.text}`)

    const meSat = await req(base, 'GET', '/me', { token: accessToken })
    assert(meSat.status === 200, `sat /me ${meSat.status} ${meSat.text}`)
    assert(meSat.json.account && meSat.json.account.id === adminId, 'sat /me id')

    const meKey = await req(base, 'GET', '/me', { token: apiKey })
    assert(meKey.status === 401, `apiKey /me ${meKey.status} ${meKey.text}`)

    const jwtModels = await req(base, 'GET', '/v1/models', { token })
    assert(jwtModels.status === 200, `jwt /v1 ${jwtModels.status}`)
    const jwtMe = await req(base, 'GET', '/me', { token })
    assert(jwtMe.status === 200 && jwtMe.json.account.id === adminId, 'jwt /me')

    const catSat = await req(base, 'GET', '/runtime/catalog', { token: accessToken })
    assert(catSat.status === 200, `sat catalog ${catSat.status} ${catSat.text}`)
    const patchSat = await req(base, 'PATCH', '/me', { token: accessToken, body: { name: '不该成功' } })
    assert(patchSat.status === 401, `sat PATCH /me ${patchSat.status}`)
    const depSat = await req(base, 'POST', '/runtime/deploy', { token: accessToken, body: { botId: 'x' } })
    assert(depSat.status === 401, `sat deploy ${depSat.status}`)
    const accSat = await req(base, 'GET', `/orgs/${orgId}/accounts`, { token: accessToken })
    assert(accSat.status === 401, `sat accounts ${accSat.status}`)
    const useSat = await req(base, 'GET', `/orgs/${orgId}/usage`, { token: accessToken })
    assert(useSat.status === 401, `sat usage ${useSat.status}`)
    const dashKey = await req(base, 'GET', `/orgs/${orgId}/accounts`, { token: apiKey })
    assert(dashKey.status === 401, `sk_sw_ dashboard ${dashKey.status}`)
  })

  await test('per-machine ready：未部署 404；跨公司 403；用量上报', async () => {
    const adminMe = await req(base, 'GET', '/me', { token })
    const adminId = adminMe.json.account.id
    const missBot = await req(base, 'POST', `/internal/instances/${adminId}/ready`, {
      token: orgMachineTok,
      body: { host: 'http://127.0.0.1:9' },
    })
    assert(missBot.status === 400, `missing botId ${missBot.status} ${missBot.text}`)
    const never = await req(base, 'POST', `/internal/instances/${adminId}/ready`, {
      token: orgMachineTok,
      body: { host: 'http://127.0.0.1:9', botId: 'never-deployed-bot' },
    })
    assert(never.status === 404, `never deployed ${never.status} ${never.text}`)
    assert(String(never.json.error || never.text).includes('还没有部署'), '404 文案')

    const other = await createCompany(req, base, {
      ownerEmail: 'owner@satuwork.test',
      ownerPassword: 'test-owner-3080',
      email: 'admin@other.test',
      password: 'correct-horse',
      companyName: 'OtherCo',
      slug: 'otherco',
    })
    const otherOrg = other.company.id
    const otherAdminTok = other.token
    const otherMach = await req(base, 'POST', '/internal/machines', { token: MACHINE_TOK, body: {} })
    assert(otherMach.status === 201, `other machine ${otherMach.status}`)
    const otherSmt = otherMach.json.machine.token
    const bindOther = await req(base, 'POST', `/orgs/${otherOrg}/machine`, {
      token: otherAdminTok,
      body: { id: otherMach.json.machine.id },
    })
    assert(bindOther.status === 201, `bind other ${bindOther.status} ${bindOther.text}`)

    const crossReady = await req(base, 'POST', `/internal/instances/${adminId}/ready`, {
      token: otherSmt,
      body: { host: 'http://127.0.0.1:9', botId: 'x' },
    })
    assert(crossReady.status === 403, `cross ready ${crossReady.status} ${crossReady.text}`)

    const crossIdx = await req(base, 'POST', '/internal/sessions/index', {
      token: otherSmt,
      body: { sessionId: 's-cross', companyId: orgId, accountId: adminId },
    })
    assert(crossIdx.status === 403, `cross index ${crossIdx.status} ${crossIdx.text}`)

    // 用量**只在 /v1 代理那一侧记一次**（见 llm-usage 那套）。`/internal/usage` 是
    // 旧版 bot 每轮再报一遍的入口，同一次调用记两遍、账面直接翻倍；它先被改成
    // 「收下不写库」，现在整条拆掉了。这里钉的是「端点真的没了，而且用量不受影响」。
    const before = await req(base, 'GET', `/orgs/${orgId}/usage`, { token })
    assert(before.status === 200, `org usage before ${before.status}`)
    const callsOf = (r) => Number((r.json.stats || []).find((x) => x.label === '任务执行')?.value ?? 0)
    const promptOf = (r) => Number((r.json.stats || []).find((x) => x.label === '输入 Tokens')?.value ?? 0)
    const usage = await req(base, 'POST', '/internal/usage', {
      token: orgMachineTok,
      body: { accountId: adminId, provider: 'deepseek', model: 'deepseek-v4-flash', promptTokens: 11, completionTokens: 7 },
    })
    assert(usage.status === 404, `/internal/usage 应该已经没了，得到 ${usage.status} ${usage.text}`)
    const stats = await req(base, 'GET', `/orgs/${orgId}/usage`, { token })
    assert(stats.status === 200, `org usage after ${stats.status}`)
    assert(callsOf(stats) === callsOf(before), `调用数不该变：${callsOf(before)} → ${callsOf(stats)}`)
    assert(promptOf(stats) === promptOf(before), `输入 tokens 不该变：${promptOf(before)} → ${promptOf(stats)}`)
  })

  await test('POST /v1/chat/completions|/v1/responses|/v1/messages 无票 → 401', async () => {
    const a = await req(base, 'POST', '/v1/chat/completions', { body: { model: 'deepseek/deepseek-v4-flash', messages: [] } })
    assert(a.status === 401, `chat ${a.status}`)
    const b = await req(base, 'POST', '/v1/responses', { body: { model: 'openai/gpt-4o', input: 'hi' } })
    assert(b.status === 401, `responses ${b.status}`)
    const c = await req(base, 'POST', '/v1/messages', { body: { model: 'claude-3-5-sonnet-latest', max_tokens: 16, messages: [] } })
    assert(c.status === 401, `messages ${c.status}`)
  })

  await test('POST /v1/* 未知模型 → 404；无密钥 provider → 402（不打上游）', async () => {
    const miss = await req(base, 'POST', '/v1/chat/completions', {
      token,
      body: { model: 'no-such-provider/no-such-model', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert(miss.status === 404, `unknown ${miss.status} ${miss.text}`)
    const fake = await req(base, 'POST', '/catalog/models', {
      token: PLATFORM_TOK,
      body: { name: 'e2e-missing', definition: { provider: 'e2e-fake', id: 'missing-key' } },
    })
    assert(fake.status === 201, `catalog model ${fake.status} ${fake.text}`)
    const chat = await req(base, 'POST', '/v1/chat/completions', {
      token,
      body: { model: 'e2e-fake/missing-key', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert(chat.status === 402, `chat 402 ${chat.status} ${chat.text}`)
    assert(!String(chat.json.error || '').includes('stack'), 'chat stack')
    /**
     * `/v1/responses` 和 `/v1/messages` 是**厂商原生协议**的透传口。
     *
     * 这里原先钉的是「按 provider 名字夹死成 openai / anthropic，而且要在选密钥之前就
     * 400 掉」——理由是那会儿上游地址写死，不夹的话 Gateway 会把这个 provider 的 key
     * 发到写死的那家去（ANTHROPIC_API_KEY 发给 api.openai.com）。
     *
     * **那条理由已经不成立了**：地址和鉴权头现在都由 upstreamTargetOf 从**同一个**
     * `found` 算出来（gateway/src/v1.ts），错配那条路不存在；而按名字夹会把走 Anthropic
     * 协议却不叫 anthropic 的那九家（minimax、kimi-coding、fireworks…）一律 400。所以
     * 那道闸撤了，判据换成模型的**协议**。
     *
     * 于是这颗没密钥的 `e2e-fake` 在三条路上都停在取密钥那一步：402。这条钉的就是
     * 「取密钥那一步拦得住，一个字节都不打上游」。**协议那道闸单独在 e2e/manager.mjs
     * 的「/v1 的原生协议口按模型的 api 判路」里钉**——那边两家供应商都配了平台密钥，
     * 才走得到协议这一句；没密钥的话它根本轮不到。
     */
    const resp = await req(base, 'POST', '/v1/responses', {
      token,
      body: { model: 'e2e-fake/missing-key', input: 'hi' },
    })
    assert(resp.status === 402, `responses 无密钥应 402，得到 ${resp.status} ${resp.text}`)
    assert(String(resp.json.error || '').includes('e2e-fake'), `responses 文案没说清是哪家没密钥：${resp.text}`)
    const msg = await req(base, 'POST', '/v1/messages', {
      token,
      body: { model: 'e2e-fake/missing-key', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert(msg.status === 402, `messages 无密钥应 402，得到 ${msg.status} ${msg.text}`)
    assert(String(msg.json.error || '').includes('e2e-fake'), `messages 文案没说清是哪家没密钥：${msg.text}`)
  })

  await test('POST /orgs/:id/llm/test：无票 401；成员 403；未设角色 400；无密钥 402；不泄漏 secret', async () => {
    const unauth = await req(base, 'POST', `/orgs/${orgId}/llm/test`, { body: { role: 'daily' } })
    assert(unauth.status === 401, `unauth ${unauth.status}`)
    const deny = await req(base, 'POST', `/orgs/${orgId}/llm/test`, { token: memberTok, body: { role: 'daily' } })
    assert(deny.status === 403, `member ${deny.status}`)
    const unset = await req(base, 'POST', `/orgs/${orgId}/llm/test`, { token, body: { role: 'daily' } })
    assert(unset.status === 400, `unset ${unset.status} ${unset.text}`)
    const fake = await req(base, 'POST', `/orgs/${orgId}/llm/test`, { token, body: { provider: 'e2e-fake' } })
    assert(fake.status === 402, `fake ${fake.status} ${fake.text}`)
    assert(!dumpHas(fake.json, secret), 'test 泄漏 secret')
    assert(!dumpHas(fake.json, 'sk-e2e-rotated-never-leak'), 'test 泄漏 rotated')
  })

  await test('seeded owner GET /me：role owner、company null、settings 对象', async () => {
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'owner@satuwork.test', password: 'test-owner-3080' },
    })
    assert(login.status === 200, `owner login ${login.status} ${login.text}`)
    assert(login.json.account.role === 'owner', 'login role')
    assert(login.json.company === null, 'login company')
    ownerTok = login.json.token
    const me = await req(base, 'GET', '/me', { token: ownerTok })
    assert(me.status === 200, `me ${me.status} ${me.text}`)
    assert(me.json.account.role === 'owner', 'me role')
    assert(me.json.company === null, 'me company')
    assert(me.json.settings && typeof me.json.settings === 'object', 'me settings')
    assert(me.json.settings.daily && me.json.settings.utility, 'me daily/utility')
  })

  await test('owner GET /platform/orgs 看见已注册公司', async () => {
    const r = await req(base, 'GET', '/platform/orgs', { token: ownerTok })
    assert(r.status === 200, `orgs ${r.status} ${r.text}`)
    assert(r.json.orgs.some((c) => c.id === orgId && c.slug === 'acme'), 'missing acme')
  })

  let contosoId
  await test('owner POST /platform/orgs：联系人必填、地址网站可选、席位不在建公司时定', async () => {
    const miss = await req(base, 'POST', '/platform/orgs', {
      token: ownerTok,
      body: { name: 'NoContact', slug: 'nocontact', adminEmail: 'a@nocontact.test', adminPassword: 'correct-horse-1' },
    })
    assert(miss.status === 400, `缺联系人 ${miss.status} ${miss.text}`)

    const badPhone = await req(base, 'POST', '/platform/orgs', {
      token: ownerTok,
      body: {
        name: 'BadPhone',
        slug: 'badphone',
        contactName: '王五',
        contactPhone: '打我电话',
        contactEmail: 'c@badphone.test',
        adminEmail: 'a@badphone.test',
        adminPassword: 'correct-horse-1',
      },
    })
    assert(badPhone.status === 400, `电话 ${badPhone.status} ${badPhone.text}`)

    // 不带国家区号的号码也不收——界面上那个区号下拉不是摆设。
    const noCode = await req(base, 'POST', '/platform/orgs', {
      token: ownerTok,
      body: {
        name: 'NoCode',
        slug: 'nocode',
        contactName: '王五',
        contactPhone: '13800000000',
        contactEmail: 'c@nocode.test',
        adminEmail: 'a@nocode.test',
        adminPassword: 'correct-horse-1',
      },
    })
    assert(noCode.status === 400, `缺区号 ${noCode.status} ${noCode.text}`)

    const r = await req(base, 'POST', '/platform/orgs', {
      token: ownerTok,
      body: {
        name: 'Contoso',
        slug: 'contoso',
        contactName: '张三',
        contactPhone: '+86 138 0000 0000',
        contactEmail: 'zhangsan@contoso.test',
        // 网站不带 scheme，服务端补 https；地址留空就是留空。
        website: 'contoso.test',
        adminEmail: 'admin@contoso.test',
        adminPassword: 'correct-horse-1',
        // 建公司不收席位：给了也不算数，先开一个管理员席位。
        seats: 9,
      },
    })
    assert(r.status === 201, `create ${r.status} ${r.text}`)
    assert(r.json.company.contactName === '张三', `contactName ${r.json.company.contactName}`)
    assert(r.json.company.contactPhone === '+86 138 0000 0000', `contactPhone ${r.json.company.contactPhone}`)
    assert(r.json.company.contactEmail === 'zhangsan@contoso.test', `contactEmail ${r.json.company.contactEmail}`)
    assert(r.json.company.address === '', `address ${r.json.company.address}`)
    assert(r.json.company.website === 'https://contoso.test', `website ${r.json.company.website}`)
    assert(r.json.plan.seats === 1 && r.json.plan.used === 1, `plan ${JSON.stringify(r.json.plan)}`)

    // 席位仍然由套餐接口调整，跟建公司分开。
    const plan = await req(base, 'PUT', `/platform/orgs/${r.json.company.id}/plan`, { token: ownerTok, body: { seats: 4 } })
    assert(plan.status === 200 && plan.json.seats === 4, `plan ${plan.status} ${plan.text}`)

    const patched = await req(base, 'PATCH', `/orgs/${r.json.company.id}`, {
      token: ownerTok,
      body: { contactName: '李四', address: '新加坡 048624', website: '' },
    })
    assert(patched.status === 200, `patch ${patched.status} ${patched.text}`)
    assert(patched.json.company.contactName === '李四', `patch contactName ${patched.json.company.contactName}`)
    assert(patched.json.company.address === '新加坡 048624', `patch address ${patched.json.company.address}`)
    assert(patched.json.company.website === '', `patch website ${patched.json.company.website}`)
    assert(patched.json.company.status === 'active', `新建的公司应是启用态 ${patched.json.company.status}`)
    contosoId = r.json.company.id
  })

  await test('owner 定套餐与到期时间：列表和公司详情都能看到', async () => {
    const skus = await req(base, 'GET', '/platform/plans', { token: ownerTok })
    assert(skus.status === 200, `plans ${skus.status} ${skus.text}`)
    let sku = (skus.json.plans || [])[0]
    if (!sku) {
      const made = await req(base, 'POST', '/platform/plans', {
        token: ownerTok,
        body: { name: '标准版', nameEn: 'Standard', amount: 9.9, seats: 6 },
      })
      assert(made.status === 201, `create sku ${made.status} ${made.text}`)
      sku = made.json.plan
    }

    const bad = await req(base, 'PUT', `/platform/orgs/${contosoId}/plan`, {
      token: ownerTok,
      body: { skuId: sku.id, expiresAt: '不是日期' },
    })
    assert(bad.status === 400, `坏日期 ${bad.status} ${bad.text}`)

    // 只给套餐不给席位：席位跟着套餐走。
    const set = await req(base, 'PUT', `/platform/orgs/${contosoId}/plan`, {
      token: ownerTok,
      body: { skuId: sku.id, expiresAt: '2031-06-30' },
    })
    assert(set.status === 200, `set plan ${set.status} ${set.text}`)
    assert(set.json.skuId === sku.id, `skuId ${set.json.skuId}`)
    assert(set.json.skuName === sku.name, `skuName ${set.json.skuName}`)
    assert(set.json.seats === sku.seats, `seats 应跟着套餐 ${set.json.seats} ≠ ${sku.seats}`)
    assert(new Date(set.json.expiresAt).toISOString().slice(0, 10) === '2031-06-30', `expiresAt ${set.json.expiresAt}`)

    const listed = await req(base, 'GET', '/platform/orgs', { token: ownerTok })
    const row = (listed.json.orgs || []).find((o) => o.id === contosoId)
    assert(row && row.plan && row.plan.skuName === sku.name, `列表缺套餐 ${JSON.stringify(row && row.plan)}`)
    assert(row.plan.expiresAt === set.json.expiresAt, `列表到期时间 ${row.plan.expiresAt}`)
    assert(row.contactName === '李四' && row.contactPhone && row.contactEmail, '列表缺联系人字段')

    const detail = await req(base, 'GET', `/orgs/${contosoId}`, { token: ownerTok })
    assert(detail.json.plan.skuName === sku.name, `详情套餐 ${detail.json.plan.skuName}`)
    assert(detail.json.plan.expiresAt === set.json.expiresAt, `详情到期 ${detail.json.plan.expiresAt}`)

    // 清空：套餐传空串就是不订，到期传空就是不限期。
    const cleared = await req(base, 'PUT', `/platform/orgs/${contosoId}/plan`, {
      token: ownerTok,
      body: { skuId: '', expiresAt: '', seats: 2 },
    })
    assert(cleared.status === 200, `clear ${cleared.status} ${cleared.text}`)
    assert(cleared.json.skuId === null && cleared.json.expiresAt === null, `clear ${JSON.stringify(cleared.json)}`)
    assert(cleared.json.seats === 2, `clear seats ${cleared.json.seats}`)
  })

  await test('停用公司：整家登不进来，启用回来又能进', async () => {
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'admin@contoso.test', password: 'correct-horse-1' },
    })
    assert(login.status === 200, `login ${login.status} ${login.text}`)
    const adminTok = login.json.token

    // 公司管理员不能自己停自己。
    const selfOff = await req(base, 'PATCH', `/orgs/${contosoId}`, { token: adminTok, body: { status: 'disabled' } })
    assert(selfOff.status === 403, `admin 停自己 ${selfOff.status} ${selfOff.text}`)

    const bad = await req(base, 'PATCH', `/orgs/${contosoId}`, { token: ownerTok, body: { status: '停' } })
    assert(bad.status === 400, `坏状态 ${bad.status} ${bad.text}`)

    const off = await req(base, 'PATCH', `/orgs/${contosoId}`, { token: ownerTok, body: { status: 'disabled' } })
    assert(off.status === 200 && off.json.company.status === 'disabled', `disable ${off.status} ${off.text}`)

    // 手上那张票也失效，不用等它过期。
    const withToken = await req(base, 'GET', '/me', { token: adminTok })
    assert(withToken.status === 403, `停用后旧票 ${withToken.status} ${withToken.text}`)
    const reLogin = await req(base, 'POST', '/auth/login', {
      body: { email: 'admin@contoso.test', password: 'correct-horse-1' },
    })
    assert(reLogin.status === 403, `停用后登录 ${reLogin.status} ${reLogin.text}`)

    const on = await req(base, 'PATCH', `/orgs/${contosoId}`, { token: ownerTok, body: { status: 'active' } })
    assert(on.status === 200 && on.json.company.status === 'active', `enable ${on.status} ${on.text}`)
    const back = await req(base, 'POST', '/auth/login', {
      body: { email: 'admin@contoso.test', password: 'correct-horse-1' },
    })
    assert(back.status === 200, `启用后登录 ${back.status} ${back.text}`)
  })

  await test('下单：生成公司订阅 + 一条账单，生效中的那条订单说了算', async () => {
    const skus = await req(base, 'GET', '/platform/plans', { token: ownerTok })
    const sku = (skus.json.plans || [])[0]
    assert(sku, '没有套餐可下单')

    const today = new Date().toISOString().slice(0, 10)
    // 未付款：只开账单，不动公司的订阅。
    const created = await req(base, 'POST', '/platform/orders', {
      token: ownerTok,
      body: { companyId: contosoId, planId: sku.id, startAt: today },
    })
    assert(created.status === 201, `order ${created.status} ${created.text}`)
    const order = created.json.order
    assert(order.payStatus === 'unpaid', `默认应是未付款 ${order.payStatus}`)
    assert(created.json.invoice && created.json.invoice.orderId === order.id, `账单没跟着开 ${created.text}`)
    assert(created.json.invoice.status === 'unpaid' && created.json.invoice.paidAt === null, '未付款不该记付款时间')

    const unpaid = await req(base, 'GET', `/orgs/${contosoId}`, { token: ownerTok })
    assert(unpaid.json.plan.skuId === null, `未付款不该写订阅 ${JSON.stringify(unpaid.json.plan)}`)
    assert(unpaid.json.plan.expiresAt === null, `未付款不该写到期时间 ${unpaid.json.plan.expiresAt}`)
    // 单子在库里，但客户那边的账单只列已付款的：没付的不算成交。
    const unpaidBilling = await req(base, 'GET', `/orgs/${contosoId}/billing`, { token: ownerTok })
    assert(unpaidBilling.json.invoices.length === 0, `未付款不该出现在账单里 ${JSON.stringify(unpaidBilling.json.invoices)}`)
    assert(unpaidBilling.json.plan.status === '未订阅', `未付款订阅状态 ${unpaidBilling.json.plan.status}`)

    // 改成已付款：这时才写公司的订阅。
    const paid = await req(base, 'PUT', `/platform/orders/${order.id}`, { token: ownerTok, body: { payStatus: 'paid' } })
    assert(paid.status === 200 && paid.json.order.payStatus === 'paid', `pay ${paid.status} ${paid.text}`)
    assert(paid.json.invoice.id === created.json.invoice.id, '付款不该再开一张账单')
    assert(paid.json.invoice.status === 'paid' && paid.json.invoice.paidAt, '账单没记付款')

    const detail = await req(base, 'GET', `/orgs/${contosoId}`, { token: ownerTok })
    assert(detail.json.plan.skuId === sku.id, `订阅套餐 ${detail.json.plan.skuId}`)
    assert(detail.json.plan.expiresAt === order.endAt, `到期时间 ${detail.json.plan.expiresAt} ≠ ${order.endAt}`)
    assert(detail.json.plan.seats === order.seats, `席位 ${detail.json.plan.seats} ≠ ${order.seats}`)

    const billing = await req(base, 'GET', `/orgs/${contosoId}/billing`, { token: ownerTok })
    assert(billing.status === 200, `billing ${billing.status} ${billing.text}`)
    assert(billing.json.invoices.length === 1, `账单条数 ${billing.json.invoices.length}`)
    assert(billing.json.invoices[0].status === '已付款', `账单状态 ${billing.json.invoices[0].status}`)
    assert(billing.json.plan.name === sku.name, `账单页套餐 ${billing.json.plan.name}`)

    const bad = await req(base, 'PUT', `/platform/orders/${order.id}`, { token: ownerTok, body: { payStatus: '给钱了' } })
    assert(bad.status === 400, `坏付款状态 ${bad.status} ${bad.text}`)

    // 改回未付款：订阅当场撤掉，账单还在（还是那一张）。
    const moved = await req(base, 'PUT', `/platform/orders/${order.id}`, {
      token: ownerTok,
      body: { startAt: '2031-01-01', payStatus: 'unpaid' },
    })
    assert(moved.status === 200, `move ${moved.status} ${moved.text}`)
    assert(moved.json.invoice.id === created.json.invoice.id, '改单不该再开一张账单')
    assert(moved.json.invoice.status === 'unpaid' && moved.json.invoice.paidAt === null, '账单没跟着改回未付款')

    const after = await req(base, 'GET', `/orgs/${contosoId}`, { token: ownerTok })
    assert(after.json.plan.skuId === null && after.json.plan.expiresAt === null, `订阅没清 ${JSON.stringify(after.json.plan)}`)
    assert(after.json.plan.seats >= after.json.plan.used, '席位不能少于在册人数')

    // 退回未付款：账单那条记录还在库里（还是同一张），但客户端不再列出来。
    const billing2 = await req(base, 'GET', `/orgs/${contosoId}/billing`, { token: ownerTok })
    assert(billing2.json.invoices.length === 0, `退回未付款还列着 ${JSON.stringify(billing2.json.invoices)}`)
  })

  await test('单独充值：不过期，跟套餐赠送分开算', async () => {
    // 起点：没有生效套餐（上一条用例把订单挪到了未来），赠送额度是 0。
    const before = await req(base, 'GET', `/orgs/${contosoId}`, { token: ownerTok })
    assert(before.json.balance, '公司详情缺 balance')
    assert(before.json.balance.planBonusMils === 0, `没生效套餐时赠送应为 0，实际 ${before.json.balance.planBonusMils}`)
    const topupBefore = before.json.balance.topupMils

    const zero = await req(base, 'POST', '/platform/orders', {
      token: ownerTok,
      body: { kind: 'topup', companyId: contosoId, amount: 0 },
    })
    assert(zero.status === 400, `0 元充值 ${zero.status} ${zero.text}`)

    // 未付款的充值单：只有单子，没有充值记录，余额不动。
    const draft = await req(base, 'POST', '/platform/orders', {
      token: ownerTok,
      body: { kind: 'topup', companyId: contosoId, amount: 12.5, note: '线下转账' },
    })
    assert(draft.status === 201, `topup order ${draft.status} ${draft.text}`)
    assert(draft.json.order.kind === 'topup' && draft.json.order.payStatus === 'unpaid', `单据 ${JSON.stringify(draft.json.order)}`)
    assert(draft.json.topup === null, `未付款不该有充值记录 ${JSON.stringify(draft.json.topup)}`)
    assert(draft.json.balance.topupMils === topupBefore, `未付款余额被动了 ${draft.json.balance.topupMils}`)
    const noRecord = await req(base, 'GET', `/orgs/${contosoId}/topups`, { token: ownerTok })
    assert(noRecord.json.topups.length === 0, `未付款不该有记录 ${JSON.stringify(noRecord.json.topups)}`)

    // 改成已付款：这时才开充值记录，余额才涨。
    const made = await req(base, 'PUT', `/platform/orders/${draft.json.order.id}`, {
      token: ownerTok,
      body: { payStatus: 'paid' },
    })
    assert(made.status === 200, `pay topup ${made.status} ${made.text}`)
    assert(made.json.topup && made.json.topup.amountMils === 12500, `充值记录 ${JSON.stringify(made.json.topup)}`)
    assert(made.json.balance.topupMils === topupBefore + 12500, `充值余额 ${made.json.balance.topupMils}`)
    assert(made.json.balance.planBonusMils === 0, '充值不该混进套餐赠送')

    // 充值单也在同一张订单表里，跟套餐单并排列出来。
    const listed = await req(base, 'GET', '/platform/orders', { token: ownerTok })
    assert(listed.status === 200, `list ${listed.status} ${listed.text}`)
    const row = (listed.json.orders || []).find((x) => x.id === draft.json.order.id)
    assert(row && row.kind === 'topup' && row.note === '线下转账', `订单表里的充值单 ${JSON.stringify(row)}`)
    assert((listed.json.orders || []).some((x) => x.kind === 'plan'), '套餐单也该在同一张表里')

    // 退回未付款：记录撤掉，余额掉回去；再付回来记录重新出现。
    const back = await req(base, 'PUT', `/platform/orders/${draft.json.order.id}`, {
      token: ownerTok,
      body: { payStatus: 'unpaid' },
    })
    assert(back.status === 200 && back.json.topup === null, `退回未付款 ${back.text}`)
    assert(back.json.balance.topupMils === topupBefore, `退回后余额 ${back.json.balance.topupMils}`)
    const repaid = await req(base, 'PUT', `/platform/orders/${draft.json.order.id}`, {
      token: ownerTok,
      body: { payStatus: 'paid' },
    })
    assert(repaid.status === 200 && repaid.json.balance.topupMils === topupBefore + 12500, `再付款 ${repaid.text}`)

    // 充值单不是订阅：它不该把公司的套餐顶掉。
    const notPlan = await req(base, 'GET', `/orgs/${contosoId}`, { token: ownerTok })
    assert(notPlan.json.plan.skuId === null, `充值单不该变成订阅 ${JSON.stringify(notPlan.json.plan)}`)

    // 改充值单（界面就是这个形状：不带 kind），改完还得是充值单，记录跟着改。
    const day = new Date().toISOString().slice(0, 10)
    const amend = await req(base, 'PUT', `/platform/orders/${draft.json.order.id}`, {
      token: ownerTok,
      body: { companyId: contosoId, amount: 20, note: '改成 20', startAt: day, payStatus: 'paid' },
    })
    assert(amend.status === 200, `改充值单 ${amend.status} ${amend.text}`)
    assert(amend.json.order.kind === 'topup', `改完变成了 ${amend.json.order.kind}`)
    assert(amend.json.topup.amountMils === 20000 && amend.json.topup.note === '改成 20', `记录没跟着改 ${JSON.stringify(amend.json.topup)}`)
    assert(amend.json.balance.topupMils === topupBefore + 20000, `余额 ${amend.json.balance.topupMils}`)

    // 类型不给改：想换就另开一单。
    const anySku = ((await req(base, 'GET', '/platform/plans', { token: ownerTok })).json.plans || [])[0]
    const swap = await req(base, 'PUT', `/platform/orders/${draft.json.order.id}`, {
      token: ownerTok,
      body: { kind: 'plan', planId: anySku.id },
    })
    assert(swap.status === 400, `类型居然能改 ${swap.status} ${swap.text}`)
    const stillTopup = await req(base, 'GET', `/platform/orders/${draft.json.order.id}`, { token: ownerTok })
    assert(stillTopup.json.order.kind === 'topup', `被改成了 ${stillTopup.json.order.kind}`)

    // 改回 12.5，后面几条断言按这个数来。
    await req(base, 'PUT', `/platform/orders/${draft.json.order.id}`, {
      token: ownerTok,
      body: { companyId: contosoId, amount: 12.5, note: '线下转账', startAt: day, payStatus: 'paid' },
    })

    // 让套餐重新生效并带上赠送额度：赠送出现，充值余额不受影响。
    const today = new Date().toISOString().slice(0, 10)
    const orders = await req(base, 'GET', '/platform/orders', { token: ownerTok })
    const order = (orders.json.orders || []).find((o) => o.companyId === contosoId && o.kind === 'plan')
    assert(order, '缺这家公司的套餐单')
    const paid = await req(base, 'PUT', `/platform/orders/${order.id}`, {
      token: ownerTok,
      body: { startAt: today, payStatus: 'paid', bonusTokens: 5 },
    })
    assert(paid.status === 200, `pay ${paid.status} ${paid.text}`)
    assert(paid.json.order.bonusMils === 5000, `订单赠送额度 ${paid.json.order.bonusMils}`)

    const after = await req(base, 'GET', `/orgs/${contosoId}`, { token: ownerTok })
    assert(after.json.balance.planBonusMils === 5000, `赠送余额 ${after.json.balance.planBonusMils}`)
    assert(after.json.balance.planBonusExpiresAt === paid.json.order.endAt, '赠送余额的到期时间要跟着套餐')
    assert(after.json.balance.topupMils === topupBefore + 12500, `充值余额被套餐动了 ${after.json.balance.topupMils}`)

    // 套餐再次失效：赠送清零，充值仍在。
    const off = await req(base, 'PUT', `/platform/orders/${order.id}`, { token: ownerTok, body: { payStatus: 'unpaid' } })
    assert(off.status === 200, `unpay ${off.status} ${off.text}`)
    const cleared = await req(base, 'GET', `/orgs/${contosoId}`, { token: ownerTok })
    assert(cleared.json.balance.planBonusMils === 0, `套餐失效后赠送要清零 ${cleared.json.balance.planBonusMils}`)
    assert(cleared.json.balance.topupMils === topupBefore + 12500, `充值不该跟着清 ${cleared.json.balance.topupMils}`)

    // 公司管理员看得到自己家的明细，但充值这件事只有 owner 能做。
    const own = await req(base, 'GET', `/orgs/${contosoId}/topups`, { token: ownerTok })
    assert(own.status === 200 && own.json.topups.length >= 1, `明细 ${own.status} ${own.text}`)
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'admin@contoso.test', password: 'correct-horse-1' },
    })
    assert(login.status === 200, `login ${login.status} ${login.text}`)
    const ownDetail = await req(base, 'GET', `/orgs/${contosoId}/topups`, { token: login.json.token })
    assert(ownDetail.status === 200 && ownDetail.json.balance, `管理员看自己家 ${ownDetail.status} ${ownDetail.text}`)
    const notOwner = await req(base, 'POST', '/platform/orders', {
      token: login.json.token,
      body: { kind: 'topup', companyId: contosoId, amount: 1 },
    })
    assert(notOwner.status === 403, `公司管理员不能下单充值 ${notOwner.status}`)

    // 公司管理员的账单页：充值记录看得到，两笔余额分开列。
    const bill = await req(base, 'GET', `/orgs/${contosoId}/billing`, { token: login.json.token })
    assert(bill.status === 200, `billing ${bill.status} ${bill.text}`)
    assert(bill.json.topups.length >= 1, `账单页缺充值记录 ${JSON.stringify(bill.json.topups)}`)
    const t0 = bill.json.topups[0]
    assert(t0.amount === '$12.50' && t0.note === '线下转账' && /^\d{4}-\d{2}-\d{2}$/.test(t0.time), `充值记录 ${JSON.stringify(t0)}`)
    assert(bill.json.balance.topup === '$12.50', `充值余额 ${bill.json.balance.topup}`)
    // 上面刚把订单改回未付款，赠送这时应该是 0，且两笔不混在一起。
    assert(bill.json.balance.planBonus === '$0.00', `赠送余额 ${bill.json.balance.planBonus}`)
    assert(bill.json.balance.amount === '$12.50', `合计 ${bill.json.balance.amount}`)
  })

  await test('激活人数不能超过席位：满了激活失败，加席位或停人之后才放行', async () => {
    const org = await req(base, 'POST', '/platform/orgs', {
      token: ownerTok,
      body: {
        name: 'SeatCap',
        slug: 'seatcap',
        contactName: '赵六',
        contactPhone: '+86 13800000000',
        contactEmail: 'c@seatcap.test',
        adminEmail: 'admin@seatcap.test',
        adminPassword: 'correct-horse-1',
      },
    })
    assert(org.status === 201, `create org ${org.status} ${org.text}`)
    const id = org.json.company.id
    assert(org.json.plan.seats === 1 && org.json.plan.used === 1, `起步 ${JSON.stringify(org.json.plan)}`)

    // 1 个席位已被管理员占满，再邀人应当被挡。
    const overflow = await req(base, 'POST', `/orgs/${id}/accounts/members`, {
      token: ownerTok,
      body: { email: 'm1@seatcap.test', name: '甲', role: 'member' },
    })
    assert(overflow.status === 409, `席位满还能邀人 ${overflow.status} ${overflow.text}`)

    const up = await req(base, 'PUT', `/platform/orgs/${id}/plan`, { token: ownerTok, body: { seats: 2 } })
    assert(up.status === 200 && up.json.seats === 2, `加席位 ${up.status} ${up.text}`)

    const m1 = await req(base, 'POST', `/orgs/${id}/accounts/members`, {
      token: ownerTok,
      body: { email: 'm1@seatcap.test', name: '甲', role: 'member' },
    })
    assert(m1.status === 201, `邀请 ${m1.status} ${m1.text}`)
    const m1Id = m1.json.user.id

    // 待接受也占位：第 3 个人进不来。
    const m2 = await req(base, 'POST', `/orgs/${id}/accounts/members`, {
      token: ownerTok,
      body: { email: 'm2@seatcap.test', name: '乙', role: 'member' },
    })
    assert(m2.status === 409, `超席位还能邀 ${m2.status} ${m2.text}`)

    // 停用之后腾出席位，别人进得来。
    const off = await req(base, 'PATCH', `/orgs/${id}/accounts/${m1Id}`, { token: ownerTok, body: { status: 'disabled' } })
    assert(off.status === 200 && off.json.account.status === 'disabled', `停用 ${off.status} ${off.text}`)
    const m2Again = await req(base, 'POST', `/orgs/${id}/accounts/members`, {
      token: ownerTok,
      body: { email: 'm2@seatcap.test', name: '乙', role: 'member' },
    })
    assert(m2Again.status === 201, `腾了席位还邀不进来 ${m2Again.status} ${m2Again.text}`)

    // 席位又满了：把停用的人激活回来要被挡住。
    const back = await req(base, 'PATCH', `/orgs/${id}/accounts/${m1Id}`, { token: ownerTok, body: { status: 'active' } })
    assert(back.status === 409, `席位满还能激活 ${back.status} ${back.text}`)
    assert(String(back.text).includes('席位'), `报错该提席位 ${back.text}`)
    const still = await req(base, 'GET', `/orgs/${id}/accounts/${m1Id}`, { token: ownerTok })
    assert(still.json.account.status === 'disabled', `没激活成却改了状态 ${still.json.account.status}`)

    // 加席位之后才放行。
    const up3 = await req(base, 'PUT', `/platform/orgs/${id}/plan`, { token: ownerTok, body: { seats: 3 } })
    assert(up3.status === 200, `加到 3 席 ${up3.status} ${up3.text}`)
    const ok = await req(base, 'PATCH', `/orgs/${id}/accounts/${m1Id}`, { token: ownerTok, body: { status: 'active' } })
    assert(ok.status === 200 && ok.json.account.status === 'active', `加了席位还激活不了 ${ok.status} ${ok.text}`)

    const listed = await req(base, 'GET', `/orgs/${id}/accounts`, { token: ownerTok })
    assert(listed.json.seats.used === 3 && listed.json.seats.total === 3, `席位统计 ${JSON.stringify(listed.json.seats)}`)

    // 并发激活不能一起挤进来：先腾出一个席位，两个请求同时抢。
    await req(base, 'PATCH', `/orgs/${id}/accounts/${m1Id}`, { token: ownerTok, body: { status: 'disabled' } })
    const m2Id = m2Again.json.user.id
    await req(base, 'PATCH', `/orgs/${id}/accounts/${m2Id}`, { token: ownerTok, body: { status: 'disabled' } })
    const down = await req(base, 'PUT', `/platform/orgs/${id}/plan`, { token: ownerTok, body: { seats: 2 } })
    assert(down.status === 200, `降到 2 席 ${down.status} ${down.text}`)
    const both = await Promise.all([
      req(base, 'PATCH', `/orgs/${id}/accounts/${m1Id}`, { token: ownerTok, body: { status: 'active' } }),
      req(base, 'PATCH', `/orgs/${id}/accounts/${m2Id}`, { token: ownerTok, body: { status: 'active' } }),
    ])
    const okCount = both.filter((r) => r.status === 200).length
    assert(okCount === 1, `并发激活应只成一个，实际 ${both.map((r) => r.status).join('/')}`)
    const after = await req(base, 'GET', `/orgs/${id}/accounts`, { token: ownerTok })
    assert(after.json.seats.used <= after.json.seats.total, `超卖了 ${JSON.stringify(after.json.seats)}`)
  })

  await test('owner 公司列表弹窗 + 详情 SPA；成员/订阅 API 按 path id', async () => {
    const appJs = uiSource(join(gwRoot, 'ui'))
    assert(appJs.includes('data-act="org-create-open"'), '缺 新建公司 按钮')
    assert(appJs.includes('orgCreateOpen'), '缺 orgCreateOpen')
    assert(appJs.includes('function companyDetailPage'), '缺 companyDetailPage')
    assert(appJs.includes('function companyIdOfPath'), '缺 companyIdOfPath')
    assert(appJs.includes('function orgCreateModal'), '缺 orgCreateModal')
    assert(!/function companiesPage\(\)[\s\S]*?<form id="create-org-form" class="satu-panel"/.test(appJs), '列表页仍有内联新建表单')

    const spa = await req(base, 'GET', '/companies')
    assert(spa.status === 200, `spa /companies ${spa.status}`)
    assert(String(spa.text).includes('<!doctype html>') || String(spa.text).includes('Satuwork'), 'spa /companies html')
    assert(!String(spa.text).includes('<form id="create-org-form"'), 'shell 含静态新建表单')

    const detail = await req(base, 'GET', `/companies/${orgId}`)
    assert(detail.status === 200, `spa /companies/:id ${detail.status}`)
    assert(String(detail.text).includes('<!doctype html>') || String(detail.text).includes('Satuwork'), 'spa detail html')

    const org = await req(base, 'GET', `/orgs/${orgId}`, { token: ownerTok })
    assert(org.status === 200, `owner org ${org.status} ${org.text}`)
    assert(org.json.company && org.json.company.id === orgId, 'company')
    assert(org.json.plan && typeof org.json.plan.seats === 'number', 'plan.seats')

    const acc = await req(base, 'GET', `/orgs/${orgId}/accounts`, { token: ownerTok })
    assert(acc.status === 200, `owner accounts ${acc.status} ${acc.text}`)
    assert(Array.isArray(acc.json.members) && acc.json.members.some((m) => m.email === 'admin@acme.test' && m.role === 'admin'), '缺管理员')

    const bill = await req(base, 'GET', `/orgs/${orgId}/billing`, { token: ownerTok })
    assert(bill.status === 200, `owner billing ${bill.status} ${bill.text}`)
    assert(bill.json.plan && bill.json.plan.seats === `${org.json.plan.seats} 个席位`, `seats ${bill.json.plan && bill.json.plan.seats}`)
    assert(bill.json.plan.used === org.json.plan.used, `used ${bill.json.plan && bill.json.plan.used}`)

    const memberSpa = await req(base, 'GET', '/companies')
    assert(memberSpa.status === 200, `member spa /companies ${memberSpa.status}`)
    assert(String(memberSpa.text).includes('<!doctype html>') || String(memberSpa.text).includes('Satuwork'), 'member spa html')
  })

  await test('公司管理员 PUT /platform/settings → 403', async () => {
    const r = await req(base, 'PUT', '/platform/settings', {
      token,
      body: { daily: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
    })
    assert(r.status === 403, `admin settings ${r.status} ${r.text}`)
  })

  await test('成员 GET /platform/orgs → 403', async () => {
    const r = await req(base, 'GET', '/platform/orgs', { token: memberTok })
    assert(r.status === 403, `member orgs ${r.status} ${r.text}`)
  })

  await test('GET /me 给管理员的 settings 是平台设置', async () => {
    const put = await req(base, 'PUT', '/platform/settings', {
      token: ownerTok,
      body: {
        daily: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
        utility: { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'low' },
      },
    })
    assert(put.status === 200, `owner put ${put.status} ${put.text}`)
    const me = await req(base, 'GET', '/me', { token })
    assert(me.status === 200, `admin me ${me.status}`)
    assert(me.json.settings.daily.provider === 'deepseek', 'daily provider')
    assert(me.json.settings.daily.model === 'deepseek-chat', 'daily model')
    assert(me.json.settings.daily.reasoningEffort === 'high', 'daily reasoning effort')
    assert(me.json.settings.utility.model === 'deepseek-v4-flash', 'utility model')
    assert(me.json.settings.utility.reasoningEffort === 'low', 'utility reasoning effort')

    const bad = await req(base, 'PUT', '/platform/settings', {
      token: ownerTok,
      body: { utility: { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'turbo' } },
    })
    assert(bad.status === 400, `非法推理强度没有被拦：${bad.status} ${bad.text}`)
  })

  let inviteOrg
  let inviteAdminTok
  let inviteAdminId
  let invitedEmail
  let inviteToken
  let invitedId
  let invitedTok

  await test('邀请成员：建号为 invited，返回一次性链接', async () => {
    const reg = await createCompany(req, base, {
      ownerEmail: 'owner@satuwork.test',
      ownerPassword: 'test-owner-3080',
      email: 'boss@invite.test',
      password: 'correct-horse',
      companyName: 'InviteCo',
      slug: 'inviteco',
      seats: 5,
      // 这家专门用来验「没下过单的公司，账单屏上全是真的 0」。充了钱就没得验了。
      topup: 0,
    })
    inviteOrg = reg.company.id
    inviteAdminTok = reg.token
    inviteAdminId = reg.account.id

    const list = await req(base, 'GET', `/orgs/${inviteOrg}/accounts`, { token: inviteAdminTok })
    assert(list.status === 200, `list ${list.status} ${list.text}`)
    assert(Array.isArray(list.json.members), 'members')
    assert(list.json.seats && list.json.seats.total === 5, 'seats.total')
    assert(list.json.seats.used === 1, 'seats.used')
    assert(list.json.me && list.json.me.id === inviteAdminId, 'me')
    assert(!dumpHas(list.json, 'passwordHash'), 'list 泄漏哈希')

    invitedEmail = 'joiner@invite.test'
    const inv = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/members`, {
      token: inviteAdminTok,
      body: { email: invitedEmail, name: '加入者', role: 'member', ttlDays: 7 },
    })
    assert(inv.status === 201, `invite ${inv.status} ${inv.text}`)
    assert(inv.json.user.status === 'invited', 'status invited')
    assert(inv.json.user.email === invitedEmail, 'email')
    assert(inv.json.user.name === '加入者', 'name')
    assert(typeof inv.json.invite.url === 'string' && inv.json.invite.url.includes('/join/'), 'invite url')
    assert(typeof inv.json.invite.expiresAt === 'number', 'expiresAt')
    assert(!dumpHas(inv.json, 'passwordHash'), 'invite 泄漏哈希')
    invitedId = inv.json.user.id
    inviteToken = inv.json.invite.url.split('/join/')[1]
    assert(inviteToken, 'token from url')

    const listed = await req(base, 'GET', `/orgs/${inviteOrg}/accounts`, { token: inviteAdminTok })
    assert(listed.json.members.some((m) => m.id === invitedId && m.status === 'invited'), 'list shows invited')
    assert(listed.json.seats.used === 2, 'invited occupies a seat')
  })

  await test('GET 邀请有效 → 接受 → 成员可登录；待接受不能登录', async () => {
    const blocked = await req(base, 'POST', '/auth/login', {
      body: { email: invitedEmail, password: 'correct-horse' },
    })
    assert(blocked.status === 401 || blocked.status === 403, `invited login ${blocked.status}`)
    assert(String(blocked.json.error).includes('邀请') || String(blocked.json.error).includes('口令'), 'invited 文案')

    const peek = await req(base, 'GET', `/invites/${inviteToken}`)
    assert(peek.status === 200, `peek ${peek.status} ${peek.text}`)
    assert(peek.json.valid === true, 'valid')
    assert(peek.json.email === invitedEmail, 'peek email')
    assert(peek.json.name === '加入者', 'peek name')

    const spa = await req(base, 'GET', `/join/${inviteToken}`)
    assert(spa.status === 200, `spa ${spa.status}`)
    assert(String(spa.text).includes('<!doctype html>') || String(spa.text).includes('Satuwork'), 'spa html')

    const miss = await req(base, 'GET', '/invites/not-a-real-token')
    assert(miss.status === 200 && miss.json.valid === false, 'invalid invite')

    const acc = await req(base, 'POST', `/invites/${inviteToken}/accept`, {
      body: { name: '加入者', password: 'joiner-pass-10' },
    })
    assert(acc.status === 200, `accept ${acc.status} ${acc.text}`)
    assert(typeof acc.json.token === 'string', 'accept jwt')
    assert(acc.json.account.status === 'active', 'active')
    assert(!dumpHas(acc.json, 'passwordHash'), 'accept 泄漏哈希')

    const reuse = await req(base, 'GET', `/invites/${inviteToken}`)
    assert(reuse.status === 200 && reuse.json.valid === false, 'used invite invalid')

    const login = await req(base, 'POST', '/auth/login', {
      body: { email: invitedEmail, password: 'joiner-pass-10' },
    })
    assert(login.status === 200, `member login ${login.status} ${login.text}`)
    invitedTok = login.json.token
  })

  await test('公司账单：SPA + 真席位 + 空发票/充值，不编假钱', async () => {
    const spa = await req(base, 'GET', '/billing')
    assert(spa.status === 200, `spa /billing ${spa.status}`)
    assert(String(spa.text).includes('<!doctype html>') || String(spa.text).includes('Satuwork'), 'spa /billing html')
    const alias = await req(base, 'GET', '/costs')
    assert(alias.status === 200, `spa /costs ${alias.status}`)
    assert(String(alias.text).includes('<!doctype html>') || String(alias.text).includes('Satuwork'), 'spa /costs html')

    const plan = await req(base, 'GET', `/orgs/${inviteOrg}/plan`, { token: inviteAdminTok })
    assert(plan.status === 200, `plan ${plan.status} ${plan.text}`)
    const r = await req(base, 'GET', `/orgs/${inviteOrg}/billing`, { token: inviteAdminTok })
    assert(r.status === 200, `billing ${r.status} ${r.text}`)
    assert(r.json.plan && r.json.plan.name === '席位套餐', 'plan.name')
    // 这家没下过单：订阅状态就是「未订阅」，不假装生效中。
    assert(r.json.plan.status === '未订阅', `plan.status ${r.json.plan.status}`)
    assert(r.json.plan.seats === `${plan.json.seats} 个席位`, `seats ${r.json.plan.seats}`)
    assert(r.json.plan.used === plan.json.used, `used ${r.json.plan.used}`)
    assert(r.json.plan.cycle === '—' && r.json.plan.period === '—' && r.json.plan.renew === '—' && r.json.plan.amount === '—', 'unwired plan fields')
    assert(r.json.plan.autoRenew === false, 'autoRenew')
    assert(Array.isArray(r.json.invoices) && r.json.invoices.length === 0, 'invoices empty')
    assert(Array.isArray(r.json.topups) && r.json.topups.length === 0, 'topups empty')
    // 这家没订单也没充值，两笔额度都是真的 0；已用和预警线还没接，仍是 —。
    assert(r.json.balance && r.json.balance.amount === '$0.00', `balance.amount ${r.json.balance && r.json.balance.amount}`)
    assert(r.json.balance.planBonus === '$0.00' && r.json.balance.planBonusExpires === '—', `planBonus ${r.json.balance.planBonus}`)
    assert(r.json.balance.topup === '$0.00', `topup ${r.json.balance.topup}`)
    // 已扣是真数（一分没花就是 $0.00），余额也是真数。预警线还没有设置项，仍是 —。
    assert(r.json.balance.spentThisPeriod === '$0.00', `spentThisPeriod ${r.json.balance.spentThisPeriod}`)
    assert(r.json.balance.left === '$0.00' && r.json.balance.leftMicros === 0, `left ${r.json.balance.left}`)
    assert(r.json.balance.alertAt === '—', 'alertAt 未接')
    // 余额是 0 而熔断默认开着：这一屏得说得出「调用会被停下来」。
    assert(r.json.balance.enforce === true, `enforce ${r.json.balance.enforce}`)
    assert(r.json.mock !== true, 'mock:true')
    assert(!dumpHas(r.json, '$286'), '$286')
    assert(!dumpHas(r.json, '$1,150'), '$1,150')
    assert(!dumpHas(r.json, 'mock'), 'mock 字样')

    const member = await req(base, 'GET', `/orgs/${inviteOrg}/billing`, { token: invitedTok })
    assert(member.status === 403, `member billing ${member.status} ${member.text}`)

    const unauth = await req(base, 'GET', `/orgs/${inviteOrg}/billing`)
    assert(unauth.status === 401, `unauth billing ${unauth.status}`)
    const miss = await req(base, 'GET', '/orgs/no-such-org/billing', { token: ownerTok })
    assert(miss.status === 404, `missing org ${miss.status} ${miss.text}`)
  })

  await test('公司用量：SPA + 真成员名/席位 + 次数费用为 0/—，不编假数', async () => {
    const spa = await req(base, 'GET', '/usage')
    assert(spa.status === 200, `spa /usage ${spa.status}`)
    assert(String(spa.text).includes('<!doctype html>') || String(spa.text).includes('Satuwork'), 'spa /usage html')

    const r = await req(base, 'GET', `/orgs/${inviteOrg}/usage`, { token: inviteAdminTok })
    assert(r.status === 200, `usage ${r.status} ${r.text}`)
    assert(r.json.mock !== true, 'mock:true')
    assert(!dumpHas(r.json, 'mock'), 'mock 字样')
    const numbers = { stats: r.json.stats, daily: r.json.daily, byAgent: r.json.byAgent, byModel: r.json.byModel, quota: r.json.quota }
    assert(!dumpHas(numbers, '$286'), '$286')
    assert(!dumpHas(numbers, '895'), '895')
    assert(!dumpHas(numbers, '48.2M'), '48.2M')
    assert(Array.isArray(r.json.stats) && r.json.stats.length === 4, 'stats')
    for (const s of r.json.stats) {
      // 「费用」这一格现在是真数了（账本上一分没有就是 $0.00），不再是那个万能的 —。
      const want = s.label === '费用' ? ['$0.00'] : ['0', '—']
      assert(want.includes(s.value), `stat ${s.label}=${s.value}`)
      assert(s.delta === '—' || s.delta == null, `delta ${s.label}=${s.delta}`)
    }
    assert(Array.isArray(r.json.daily) && r.json.daily.length === 0, 'daily empty')
    assert(Array.isArray(r.json.byModel) && r.json.byModel.length === 0, 'byModel empty')
    assert(Array.isArray(r.json.quota) && r.json.quota.length === 0, 'quota empty')
    assert(Array.isArray(r.json.byAgent), 'byAgent array')
    assert(r.json.byAgent.length === 0, 'byAgent 应空，不编 0 次')
    assert(r.json.seats === 5, `seats ${r.json.seats}`)
    assert(Array.isArray(r.json.byMember) && r.json.byMember.length >= 1, 'byMember')
    const joiner = r.json.byMember.find((m) => m.id === invitedId || m.name === '加入者')
    assert(joiner, 'missing employee 加入者')
    assert(joiner.tasks === '0', `tasks ${joiner.tasks}`)
    assert(joiner.tokens === '0', `tokens ${joiner.tokens}`)
    // 「失败率」那一列从来没接过，永远是 —。换成账本上真扣了多少。
    assert(joiner.amount === '$0.00', `amount ${joiner.amount}`)
    assert(joiner.fail === undefined, `fail 该没了：${joiner.fail}`)
    assert(joiner.last === '—', `last ${joiner.last}`)
    assert(joiner.initial === '加', `initial ${joiner.initial}`)

    const member = await req(base, 'GET', `/orgs/${inviteOrg}/usage`, { token: invitedTok })
    assert(member.status === 403, `member usage ${member.status} ${member.text}`)
    const meStats = await req(base, 'GET', '/me/stats', { token: invitedTok })
    assert(meStats.status === 200, `me/stats ${meStats.status} ${meStats.text}`)
    assert(Array.isArray(meStats.json.stats) && meStats.json.stats.length === 4, 'me stats')
    assert(!meStats.json.byMember, 'me/stats 不应带全员 byMember')
    const meTasks = (meStats.json.stats || []).find((x) => x.label === '任务执行')
    assert(meTasks && meTasks.value === '0', `self tasks ${meTasks && meTasks.value}`)
    const adminStats = await req(base, 'GET', '/me/stats', { token: inviteAdminTok })
    assert(adminStats.status === 200, `admin me/stats ${adminStats.status}`)

    const unauth = await req(base, 'GET', `/orgs/${inviteOrg}/usage`)
    assert(unauth.status === 401, `unauth usage ${unauth.status}`)
    const miss = await req(base, 'GET', '/orgs/no-such-org/usage', { token: ownerTok })
    assert(miss.status === 404, `missing org ${miss.status} ${miss.text}`)
  })

  await test('停用成员不能登录；成员不能邀请', async () => {
    const dis = await req(base, 'PATCH', `/orgs/${inviteOrg}/accounts/${invitedId}`, {
      token: inviteAdminTok,
      body: { status: 'disabled' },
    })
    assert(dis.status === 200, `disable ${dis.status} ${dis.text}`)
    assert(dis.json.account.status === 'disabled', 'disabled')

    const login = await req(base, 'POST', '/auth/login', {
      body: { email: invitedEmail, password: 'joiner-pass-10' },
    })
    assert(login.status === 403, `disabled login ${login.status} ${login.text}`)
    assert(String(login.json.error).includes('停用'), '停用文案')

    const still = await req(base, 'GET', `/orgs/${inviteOrg}/accounts`, { token: invitedTok })
    assert(still.status === 401, `revoked jwt ${still.status} ${still.text}`)

    const en = await req(base, 'PATCH', `/orgs/${inviteOrg}/accounts/${invitedId}`, {
      token: inviteAdminTok,
      body: { status: 'active' },
    })
    assert(en.status === 200 && en.json.account.status === 'active', 're-enable')
    const relogin = await req(base, 'POST', '/auth/login', {
      body: { email: invitedEmail, password: 'joiner-pass-10' },
    })
    assert(relogin.status === 200, `relogin ${relogin.status}`)
    invitedTok = relogin.json.token

    const deny = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/members`, {
      token: invitedTok,
      body: { email: 'nope@invite.test', name: 'Nope', role: 'member', ttlDays: 1 },
    })
    assert(deny.status === 403, `member invite ${deny.status} ${deny.text}`)
  })

  await test('不能删除自己', async () => {
    const r = await req(base, 'DELETE', `/orgs/${inviteOrg}/accounts/${inviteAdminId}`, { token: inviteAdminTok })
    assert(r.status === 400 || r.status === 403, `delete self ${r.status} ${r.text}`)
    assert(String(r.json.error).includes('自己'), '自己 文案')
  })

  let groupId

  await test('GET accounts 含 builtin 全体成员（含管理员）', async () => {
    const list = await req(base, 'GET', `/orgs/${inviteOrg}/accounts`, { token: inviteAdminTok })
    assert(list.status === 200, `list ${list.status} ${list.text}`)
    assert(Array.isArray(list.json.groups), 'groups')
    const all = list.json.groups.find((g) => g.id === 'all')
    assert(all && all.builtin === true, 'builtin all')
    assert(all.name === '全体成员', 'name')
    assert(all.icon === 'users', 'icon')
    assert(all.role === null, 'all role')
    assert(Array.isArray(all.members) && all.members.includes(inviteAdminId), 'admin in all')
    assert(all.members.includes(invitedId), 'invited in all')
    assert(Array.isArray(all.agents), 'agents')
  })

  await test('POST group → 201，出现在列表', async () => {
    const r = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/groups`, {
      token: inviteAdminTok,
      body: { name: '客服组', desc: '一线', icon: 'chat', role: 'member', members: [inviteAdminId, invitedId] },
    })
    assert(r.status === 201, `create ${r.status} ${r.text}`)
    assert(r.json.group && r.json.group.builtin === false, 'group')
    assert(r.json.group.name === '客服组', 'name')
    assert(r.json.group.icon === 'chat', 'icon')
    assert(r.json.group.role === 'member', 'role')
    assert(r.json.group.members.includes(inviteAdminId), 'members')
    assert(r.json.group.members.includes(invitedId), 'members invited')
    assert(Array.isArray(r.json.group.agents), 'agents')
    assert(!Object.prototype.hasOwnProperty.call(r.json.group, 'companyId'), 'omit companyId')
    groupId = r.json.group.id
    assert(groupId && groupId !== 'all', 'id')
    const list = await req(base, 'GET', `/orgs/${inviteOrg}/accounts`, { token: inviteAdminTok })
    assert(
      list.json.groups.some((g) => g.id === groupId && g.name === '客服组' && g.builtin === false),
      'list',
    )
  })

  await test('PATCH group 改名和成员', async () => {
    const r = await req(base, 'PATCH', `/orgs/${inviteOrg}/accounts/groups/${groupId}`, {
      token: inviteAdminTok,
      body: { name: '客服组改', members: [invitedId] },
    })
    assert(r.status === 200, `patch ${r.status} ${r.text}`)
    assert(r.json.group.name === '客服组改', 'name')
    assert(r.json.group.members.length === 1 && r.json.group.members[0] === invitedId, 'members')
  })

  await test('不能 PATCH/DELETE all；成员不能 POST；空名 400', async () => {
    const patchAll = await req(base, 'PATCH', `/orgs/${inviteOrg}/accounts/groups/all`, {
      token: inviteAdminTok,
      body: { name: 'x' },
    })
    assert(patchAll.status === 400, `patch all ${patchAll.status} ${patchAll.text}`)
    const delAll = await req(base, 'DELETE', `/orgs/${inviteOrg}/accounts/groups/all`, { token: inviteAdminTok })
    assert(delAll.status === 400, `delete all ${delAll.status} ${delAll.text}`)
    const deny = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/groups`, {
      token: invitedTok,
      body: { name: '不该成功' },
    })
    assert(deny.status === 403, `member post ${deny.status} ${deny.text}`)
    const empty = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/groups`, {
      token: inviteAdminTok,
      body: { name: '   ' },
    })
    assert(empty.status === 400, `empty ${empty.status} ${empty.text}`)
  })

  await test('DELETE group', async () => {
    const r = await req(base, 'DELETE', `/orgs/${inviteOrg}/accounts/groups/${groupId}`, { token: inviteAdminTok })
    assert(r.status === 200 && r.json.ok === true, `delete ${r.status} ${r.text}`)
    const list = await req(base, 'GET', `/orgs/${inviteOrg}/accounts`, { token: inviteAdminTok })
    assert(!list.json.groups.some((g) => g.id === groupId), 'gone')
    assert(list.json.groups.some((g) => g.id === 'all' && g.builtin === true), 'all remains')
  })

  await test('GET /me 含 title/phone/theme/locale', async () => {
    const r = await req(base, 'GET', '/me', { token: inviteAdminTok })
    assert(r.status === 200, `me ${r.status} ${r.text}`)
    const a = r.json.account
    assert(typeof a.title === 'string', 'title')
    assert(typeof a.phone === 'string', 'phone')
    assert(a.theme === 'light' || a.theme === 'dark' || a.theme === 'system', `theme ${a.theme}`)
    assert(a.locale === 'zh' || a.locale === 'en', `locale ${a.locale}`)
  })

  await test('PATCH /me 姓名/职位/手机/外观/语言会落库', async () => {
    const r = await req(base, 'PATCH', '/me', {
      token: inviteAdminTok,
      body: { name: '老板改', title: '运营负责人', phone: '13800000000', theme: 'dark', locale: 'en' },
    })
    assert(r.status === 200, `patch ${r.status} ${r.text}`)
    assert(r.json.account.name === '老板改', 'name')
    assert(r.json.account.title === '运营负责人', 'title')
    assert(r.json.account.phone === '13800000000', 'phone')
    assert(r.json.account.theme === 'dark', 'theme')
    assert(r.json.account.locale === 'en', 'locale')
    assert(!dumpHas(r.json, 'passwordHash'), 'patch 泄漏哈希')
    const me = await req(base, 'GET', '/me', { token: inviteAdminTok })
    assert(me.json.account.name === '老板改', 'persisted name')
    assert(me.json.account.title === '运营负责人', 'persisted title')
    assert(me.json.account.phone === '13800000000', 'persisted phone')
    assert(me.json.account.theme === 'dark', 'persisted theme')
    assert(me.json.account.locale === 'en', 'persisted locale')
  })

  await test('成员也能 PATCH /me（个人设置，不是管理员接口）', async () => {
    const r = await req(base, 'PATCH', '/me', {
      token: invitedTok,
      body: { name: '加入者改', title: '一线客服', phone: '', theme: 'light', locale: 'zh' },
    })
    assert(r.status === 200, `member patch ${r.status} ${r.text}`)
    assert(r.json.account.name === '加入者改', 'member name')
    assert(r.json.account.title === '一线客服', 'member title')
    assert(r.json.account.theme === 'light', 'member theme')
    const me = await req(base, 'GET', '/me', { token: invitedTok })
    assert(me.json.account.title === '一线客服', 'member persisted')
  })

  await test('SPA GET /profile 返回 html', async () => {
    const r = await req(base, 'GET', '/profile')
    assert(r.status === 200, `spa ${r.status}`)
    assert(String(r.text).includes('<!doctype html>') || String(r.text).includes('Satuwork'), 'spa html')
  })

  await test('POST /me/password 当前口令不对 → 400', async () => {
    const r = await req(base, 'POST', '/me/password', {
      token: inviteAdminTok,
      body: { current: 'wrong-horse', next: 'new-password-10' },
    })
    assert(r.status === 400, `wrong ${r.status} ${r.text}`)
    assert(String(r.json.error).includes('当前口令不对'), '文案')
  })

  await test('POST /me/password 新口令与当前相同 → 400', async () => {
    const r = await req(base, 'POST', '/me/password', {
      token: inviteAdminTok,
      body: { current: 'correct-horse', next: 'correct-horse' },
    })
    assert(r.status === 400, `same ${r.status} ${r.text}`)
    assert(String(r.json.error).includes('相同'), '文案')
  })

  await test('POST /me/password 成功 → 新票可用、旧票 401', async () => {
    // iat 只有秒精度：同一秒内签发的旧票不会被 tokenRevokedAt 杀掉（新票也要活）。
    await new Promise((x) => setTimeout(x, 1100))
    const r = await req(base, 'POST', '/me/password', {
      token: inviteAdminTok,
      body: { current: 'correct-horse', next: 'new-horse-10' },
    })
    assert(r.status === 200, `ok ${r.status} ${r.text}`)
    assert(r.json.ok === true, 'ok')
    assert(typeof r.json.token === 'string' && r.json.token.split('.').length === 3, 'new jwt')
    const old = await req(base, 'GET', '/me', { token: inviteAdminTok })
    assert(old.status === 401, `old token ${old.status} ${old.text}`)
    const neu = await req(base, 'GET', '/me', { token: r.json.token })
    assert(neu.status === 200, `new token ${neu.status} ${neu.text}`)
    assert(neu.json.account.id === inviteAdminId, 'same account')
  })

  await test('我的 Bot：创建、改、只进自己的名册、删除、SPA', async () => {
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'boss@invite.test', password: 'new-horse-10' },
    })
    assert(login.status === 200, `relogin ${login.status} ${login.text}`)
    const adminTok = login.json.token

    const empty = await req(base, 'GET', `/orgs/${inviteOrg}/bots`, { token: adminTok })
    assert(empty.status === 200, `list ${empty.status} ${empty.text}`)
    assert(Array.isArray(empty.json.bots) && empty.json.bots.length === 0, 'starts empty')

    const created = await req(base, 'POST', '/runtime/bots', {
      token: adminTok,
      body: { name: '客服助手', description: '客服' },
    })
    assert(created.status === 201, `create ${created.status} ${created.text}`)
    assert(created.json.bot.scope === 'user', 'scope')
    assert(created.json.bot.enabled === true, 'enabled')
    assert(created.json.bot.name === '客服助手', 'name')
    assert(created.json.bot.description === '客服', 'description')
    assert(typeof created.json.bot.provider === 'string' && created.json.bot.provider, 'provider')
    assert(typeof created.json.bot.model === 'string' && created.json.bot.model, 'model')
    const id = created.json.bot.id

    // 自建的**不进**公司管理目录：那一页列的是全局项和停用掉的老公司 Bot。
    const list = await req(base, 'GET', `/orgs/${inviteOrg}/bots`, { token: adminTok })
    assert(!list.json.bots.some((b) => b.id === id), '自建 Bot 漏进了管理目录')
    const mine = await req(base, 'GET', '/runtime/bots', { token: adminTok })
    assert(mine.json.bots.some((b) => b.id === id && b.name === '客服助手'), '自己的名册里没有')
    assert(mine.json.quota && mine.json.quota.max >= 1, `没给配额 ${mine.text}`)

    const patched = await req(base, 'PATCH', `/runtime/bots/${id}`, {
      token: adminTok,
      // 头像改版后键换了一套。老键仍然收，映射到新的那一个存下来。
      body: { greeting: '你好，我是客服。', enabled: false, icon: 'chat' },
    })
    assert(patched.status === 200, `patch ${patched.status} ${patched.text}`)
    assert(patched.json.bot.greeting === '你好，我是客服。', 'greeting')
    assert(patched.json.bot.enabled === false, 'enabled false')
    assert(patched.json.bot.icon === 'c-chat', `icon ${patched.json.bot.icon}`)

    const emptyName = await req(base, 'POST', '/runtime/bots', {
      token: adminTok,
      body: { name: '   ' },
    })
    assert(emptyName.status === 400, `empty ${emptyName.status} ${emptyName.text}`)
    assert(String(emptyName.json.error).includes('助理要有名字'), 'empty name 文案')

    const spaList = await req(base, 'GET', '/bots')
    assert(spaList.status === 200, `spa list ${spaList.status}`)
    assert(String(spaList.text).includes('<!doctype html>') || String(spaList.text).includes('Satuwork'), 'spa html')
    const spaOne = await req(base, 'GET', `/bots/${id}`)
    assert(spaOne.status === 200, `spa one ${spaOne.status}`)
    assert(String(spaOne.text).includes('<!doctype html>') || String(spaOne.text).includes('Satuwork'), 'spa detail html')

    const del = await req(base, 'DELETE', `/runtime/bots/${id}`, { token: adminTok })
    assert(del.status === 200 && del.json.deleted === true && del.json.id === id, 'delete')
    const gone = await req(base, 'GET', `/runtime/bots/${id}`, { token: adminTok })
    assert(gone.status === 404, `gone ${gone.status}`)
    const after = await req(base, 'GET', '/runtime/bots', { token: adminTok })
    assert(!after.json.bots.some((b) => b.id === id), 'list gone')
  })

  await test('模版的行为边界与记忆：存得下、读得回、越界的收口，自建 Bot 跟着走', async () => {
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'boss@invite.test', password: 'new-horse-10' },
    })
    const tok = login.json.token

    const fresh = await req(base, 'GET', `/orgs/${inviteOrg}/bot-template`, { token: tok })
    assert(fresh.status === 200, `模版 ${fresh.status} ${fresh.text}`)
    const tpl = fresh.json.template
    // 新公司就带全套默认，不是 undefined——前端照着画，缺了就得各自兜底。
    assert(tpl.guards && tpl.guards['high-risk'] === true && tpl.guards.pii === true, `默认守卫 ${JSON.stringify(tpl.guards)}`)
    assert(tpl.memory && tpl.memory.on === true && tpl.memory.scope === '所属分组', `默认记忆 ${JSON.stringify(tpl.memory)}`)
    assert(tpl.memory.cap === 20 && tpl.memory.ttl === '90 天', `默认上限/时长 ${JSON.stringify(tpl.memory)}`)
    /**
     * 浏览器**默认关着**，站点清单默认是空的。
     *
     * 和上面那三条守卫的默认值方向相反，这不是笔误：那三条是「要不要收紧」，全开等于
     * 最严；这一条是「要不要放开」，关着才是最严。它握着的是员工本人在那些网站上的
     * 登录态，一次误开等于以他的名义做了一件事。
     */
    assert(tpl.browser && tpl.browser.on === false, `浏览器默认该是关的 ${JSON.stringify(tpl.browser)}`)
    assert(Array.isArray(tpl.browser.sites) && !tpl.browser.sites.length, `站点默认该是空的 ${JSON.stringify(tpl.browser)}`)

    const saved = await req(base, 'PUT', `/orgs/${inviteOrg}/bot-template`, {
      token: tok,
      body: {
        escalate: '连续 3 次说不清就转人工',
        // 只传改动的那一个开关，另外两个不该被带回默认。
        guards: { pii: false },
        // 认不出的记录类型丢掉；注入上限按 5–50 收口。
        memory: { scope: '全公司', kinds: ['流程', '瞎写的'], ttl: '永久保留', cap: 999, confirm: false },
        // 站点这一栏收的是人随手粘进来的东西：整条 URL、带 *. 的写法、大小写混着。
        // 本机和内网地址无论怎么写都不许进——那不是「外部系统」。
        browser: {
          on: true,
          sites: [
            'https://App.Example.com/inbox?x=1',
            '*.foo.cn',
            'erp-*.corp.com',
            // 后缀放开、全局放开：开多宽是管理员的决定，这一层不拦。
            'mycompany.*',
            '*',
            '127.0.0.1',
            'localhost',
            'nas.local',
            'erp',
            'app.example.com',
          ],
        },
      },
    })
    assert(saved.status === 200, `存 ${saved.status} ${saved.text}`)
    assert(saved.json.template.version === tpl.version + 1, `版本号没加一：${saved.json.template.version}`)
    const g = saved.json.template.guards
    assert(g.pii === false && g['high-risk'] === true && g['no-external'] === true, `守卫合并 ${JSON.stringify(g)}`)
    const br = saved.json.template.browser
    assert(br.on === true, `浏览器没开起来 ${JSON.stringify(br)}`)
    assert(br.sites.includes('app.example.com'), `整条 URL 没收成域名 ${JSON.stringify(br.sites)}`)
    /**
     * 通配符**留着**，不再像早先那样把 `*.` 一剥了事。
     *
     * 剥掉的话 `*.foo.cn` 会被悄悄放宽成 `foo.cn`——管理员写 `*` 是想收紧（只要子域，
     * 不要主站），而系统的处理是把它改成更宽的那个意思，界面上还照样显示成他写的样子。
     */
    assert(br.sites.includes('*.foo.cn'), `通配符被剥掉了 ${JSON.stringify(br.sites)}`)
    assert(br.sites.includes('erp-*.corp.com'), `段内通配没收下 ${JSON.stringify(br.sites)}`)
    assert(br.sites.includes('mycompany.*'), `后缀放开没收下 ${JSON.stringify(br.sites)}`)
    /**
     * 单个 `*` 归一到 `*.*`：两种写法是同一个意思，存成一种，界面上和审计里才只有一个
     * 样子——否则同一件事在不同公司的配置里长得不一样，翻记录的人得先认出它们是一回事。
     */
    assert(br.sites.includes('*.*') && !br.sites.includes('*'), `单个 * 没归一到 *.* ${JSON.stringify(br.sites)}`)
    // 重复的只留一条：同一个域名写两遍（一次带协议一次不带）是最常见的粘贴结果。
    assert(br.sites.filter((x) => x === 'app.example.com').length === 1, `没去重 ${JSON.stringify(br.sites)}`)
    for (const bad of ['127.0.0.1', 'localhost', 'nas.local', 'erp']) {
      assert(!br.sites.includes(bad), `${bad} 不该进白名单 ${JSON.stringify(br.sites)}`)
    }
    const m = saved.json.template.memory
    assert(m.scope === '全公司' && m.ttl === '永久保留', `记忆 ${JSON.stringify(m)}`)
    assert(m.kinds.length === 1 && m.kinds[0] === '流程', `认不出的类型没丢 ${JSON.stringify(m.kinds)}`)
    assert(m.cap === 50, `注入上限没收口：${m.cap}`)
    assert(m.confirm === false && m.pii === true, `没传的那几项被带回默认了 ${JSON.stringify(m)}`)

    // 真落库了才算数：回执对、重新拉一次也对。
    const back = await req(base, 'GET', `/orgs/${inviteOrg}/bot-template`, { token: tok })
    assert(back.json.template.escalate.includes('转人工'), `升级条件 ${back.json.template.escalate}`)
    assert(back.json.template.guards.pii === false, '守卫没落库')
    assert(back.json.template.memory.cap === 50 && back.json.template.memory.scope === '全公司', '记忆没落库')
    assert(back.json.template.browser.on === true && back.json.template.browser.sites.includes('*.foo.cn'), '浏览器那两格没落库')

    // 自建的 Bot 不存自己的一份——读出来就是模版这一份。
    const made = await req(base, 'POST', '/runtime/bots', { token: tok, body: { name: '记忆助手' } })
    assert(made.status === 201, `建 ${made.status} ${made.text}`)
    assert(made.json.bot.guards.pii === false, `没继承守卫 ${JSON.stringify(made.json.bot.guards)}`)
    assert(made.json.bot.memory.cap === 50, `没继承记忆 ${JSON.stringify(made.json.bot.memory)}`)
    assert(made.json.bot.escalate.includes('转人工'), '没继承升级条件')
    assert(made.json.bot.browser && made.json.bot.browser.on === true, `没继承浏览器能力 ${JSON.stringify(made.json.bot.browser)}`)
    await req(base, 'DELETE', `/runtime/bots/${made.json.bot.id}`, { token: tok })
  })

  await test('Bot 用平台指定的模型：自己挑不了，平台换了就跟着换', async () => {
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'boss@invite.test', password: 'new-horse-10' },
    })
    const tok = login.json.token

    // 动的是平台设置，后面的用例还要用——先抄一份，走完放回去。
    const before = (await req(base, 'GET', '/platform/settings', { token: ownerTok })).json
    await req(base, 'PUT', '/platform/settings', {
      token: ownerTok,
      body: { daily: { provider: 'e2e-fake', model: 'pinned-one' } },
    })
    const made = await req(base, 'POST', '/runtime/bots', {
      token: tok,
      // 建的时候就想指一个别的，不能得逞。
      body: { name: '挑模型的', provider: 'openai', model: 'gpt-9-ultra' },
    })
    assert(made.status === 201, `create ${made.status} ${made.text}`)
    assert(made.json.bot.model === 'pinned-one', `建出来是 ${made.json.bot.model}`)
    assert(made.json.bot.provider === 'e2e-fake', `建出来的供应商是 ${made.json.bot.provider}`)
    const botId = made.json.bot.id

    const patched = await req(base, 'PATCH', `/runtime/bots/${botId}`, {
      token: tok,
      body: { provider: 'openai', model: 'gpt-9-ultra' },
    })
    assert(patched.json.bot.model === 'pinned-one', `改完变成了 ${patched.json.bot.model}`)

    // 平台换一个：这个 Bot 从头到尾没再被保存过，读出来也得跟着换。
    await req(base, 'PUT', '/platform/settings', {
      token: ownerTok,
      body: { daily: { provider: 'e2e-fake', model: 'pinned-two' } },
    })
    const back = await req(base, 'GET', `/runtime/bots/${botId}`, { token: tok })
    assert(back.json.bot.model === 'pinned-two', `平台换了之后还是 ${back.json.bot.model}`)
    const listed = (await req(base, 'GET', '/runtime/bots', { token: tok })).json.bots.find((b) => b.id === botId)
    assert(listed.model === 'pinned-two', `列表里还是 ${listed.model}`)

    await req(base, 'DELETE', `/runtime/bots/${botId}`, { token: tok })
    await req(base, 'PUT', '/platform/settings', { token: ownerTok, body: { daily: before.daily, utility: before.utility } })
  })

  await test('公司 Skill / MCP：列表、步骤摘要、token 不回传、权限、SPA', async () => {
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'boss@invite.test', password: 'new-horse-10' },
    })
    assert(login.status === 200, `relogin ${login.status} ${login.text}`)
    const adminTok = login.json.token

    const empty = await req(base, 'GET', `/orgs/${inviteOrg}/skills`, { token: adminTok })
    assert(empty.status === 200, `list ${empty.status} ${empty.text}`)
    assert(Array.isArray(empty.json.skills) && empty.json.skills.length === 0, 'skills empty')
    assert(Array.isArray(empty.json.servers) && empty.json.servers.length === 0, 'servers empty')
    assert(Array.isArray(empty.json.tags) && empty.json.tags.includes('客服'), 'default tags')

    const created = await req(base, 'POST', `/orgs/${inviteOrg}/skills`, {
      token: adminTok,
      body: { name: '工单归类', body: '处理工单。\n\n- 读取来信\n- 归类\n- 回复', tags: ['客服'] },
    })
    assert(created.status === 201, `create ${created.status} ${created.text}`)
    assert(created.json.skill.name === '工单归类', 'name')
    assert(created.json.skill.steps === 3, `steps ${created.json.skill.steps}`)
    assert(created.json.skill.summary === '处理工单。', `summary ${created.json.skill.summary}`)
    assert(created.json.skill.enabled === true, 'enabled')
    assert(created.json.skill.source === '手动编写', 'source')
    const skillId = created.json.skill.id

    const patched = await req(base, 'PATCH', `/orgs/${inviteOrg}/skills/${skillId}`, {
      token: adminTok,
      body: { tags: ['客服', '自动化'], enabled: false },
    })
    assert(patched.status === 200, `patch ${patched.status} ${patched.text}`)
    assert(patched.json.skill.enabled === false, 'enabled false')
    assert(patched.json.skill.tags.includes('自动化'), 'tags')

    const one = await req(base, 'GET', `/orgs/${inviteOrg}/skills/${skillId}`, { token: adminTok })
    assert(one.status === 200 && one.json.skill.id === skillId, 'get skill')
    assert(one.json.skill.steps === 3, 'get steps')

    const zip = await req(base, 'POST', `/orgs/${inviteOrg}/skills`, {
      token: adminTok,
      body: {
        name: 'zip-skill',
        source: 'ZIP 包',
        files: [
          { path: 'SKILL.md', text: '从包来。\n\n- 一步\n- 两步' },
          { path: 'bin.dat', base64: 'aaaa' },
        ],
      },
    })
    assert(zip.status === 201, `zip ${zip.status} ${zip.text}`)
    assert(zip.json.skill.body.includes('从包来'), 'zip body from SKILL.md')
    assert(zip.json.skill.steps === 2, 'zip steps')
    assert(zip.json.skill.fileCount === 1, `fileCount ${zip.json.skill.fileCount}`)
    const zipId = zip.json.skill.id

    const mcp = await req(base, 'POST', `/orgs/${inviteOrg}/mcp-servers`, {
      token: adminTok,
      body: {
        name: 'zendesk-mcp',
        kind: 'SSE',
        endpoint: 'https://mcp.example.com/sse',
        perm: '只读',
        token: 'secret-mcp-token',
        env: { API_KEY: 'mcp-env-secret-value' },
      },
    })
    assert(mcp.status === 201, `mcp ${mcp.status} ${mcp.text}`)
    assert(mcp.json.server.name === 'zendesk-mcp', 'mcp name')
    assert(mcp.json.server.hasToken === true, 'hasToken')
    assert(mcp.json.server.hasEnv === true, 'hasEnv')
    assert(!Object.prototype.hasOwnProperty.call(mcp.json.server, 'token'), 'no token field on create')
    assert(!dumpHas(mcp.json, 'secret-mcp-token'), 'create 泄漏 token')
    assert(!dumpHas(mcp.json, 'mcp-env-secret-value'), 'create 泄漏 env')
    if (mcp.json.server.env) {
      for (const v of Object.values(mcp.json.server.env)) assert(v === '', `env value ${v}`)
    }
    const serverId = mcp.json.server.id

    const mcpList = await req(base, 'GET', `/orgs/${inviteOrg}/mcp-servers`, { token: adminTok })
    assert(mcpList.status === 200, `mcp list ${mcpList.status}`)
    assert(!dumpHas(mcpList.json, 'mcp-env-secret-value'), 'list 泄漏 env')
    assert(!dumpHas(mcpList.json, 'secret-mcp-token'), 'list 泄漏 token')

    const mcpGet = await req(base, 'GET', `/orgs/${inviteOrg}/mcp-servers/${serverId}`, { token: adminTok })
    assert(mcpGet.status === 200, `mcp get ${mcpGet.status}`)
    assert(mcpGet.json.server.hasToken === true, 'get hasToken')
    assert(!Object.prototype.hasOwnProperty.call(mcpGet.json.server, 'token'), 'no token field on get')
    assert(!dumpHas(mcpGet.json, 'secret-mcp-token'), 'get 泄漏 token')
    assert(!dumpHas(mcpGet.json, 'mcp-env-secret-value'), 'get 泄漏 env')

    const mcpPatch = await req(base, 'PATCH', `/orgs/${inviteOrg}/mcp-servers/${serverId}`, {
      token: adminTok,
      body: { token: 'rotated-mcp-token' },
    })
    assert(mcpPatch.status === 200, `mcp patch ${mcpPatch.status} ${mcpPatch.text}`)
    assert(mcpPatch.json.server.hasToken === true, 'patch hasToken')
    assert(!Object.prototype.hasOwnProperty.call(mcpPatch.json.server, 'token'), 'no token field on patch')
    assert(!dumpHas(mcpPatch.json, 'rotated-mcp-token'), 'patch 泄漏 token')

    const afterTok = await req(base, 'GET', `/orgs/${inviteOrg}/mcp-servers/${serverId}`, { token: adminTok })
    assert(afterTok.json.server.hasToken === true, 'still hasToken')
    assert(!dumpHas(afterTok.json, 'rotated-mcp-token'), 'later get 泄漏 token')

    const denySkill = await req(base, 'POST', `/orgs/${inviteOrg}/skills`, {
      token: invitedTok,
      body: { name: '不该成功' },
    })
    assert(denySkill.status === 403, `member skill ${denySkill.status}`)
    const denyMcp = await req(base, 'POST', `/orgs/${inviteOrg}/mcp-servers`, {
      token: invitedTok,
      body: { name: '不该成功', endpoint: 'https://x' },
    })
    assert(denyMcp.status === 403, `member mcp ${denyMcp.status}`)

    const emptyName = await req(base, 'POST', `/orgs/${inviteOrg}/skills`, {
      token: adminTok,
      body: { name: '   ' },
    })
    assert(emptyName.status === 400, `empty ${emptyName.status} ${emptyName.text}`)
    assert(String(emptyName.json.error).includes('要有名字'), 'empty name 文案')

    const noEndpoint = await req(base, 'POST', `/orgs/${inviteOrg}/mcp-servers`, {
      token: adminTok,
      body: { name: 'no-url', kind: 'HTTP' },
    })
    assert(noEndpoint.status === 400, `endpoint ${noEndpoint.status}`)
    assert(String(noEndpoint.json.error).includes('要有服务器地址'), 'endpoint 文案')

    const spa = await req(base, 'GET', '/skills')
    assert(spa.status === 200, `spa ${spa.status}`)
    assert(String(spa.text).includes('<!doctype html>') || String(spa.text).includes('Satuwork'), 'spa html')

    const delS = await req(base, 'DELETE', `/orgs/${inviteOrg}/skills/${skillId}`, { token: adminTok })
    assert(delS.status === 200 && delS.json.deleted === true && delS.json.id === skillId, 'delete skill')
    const goneS = await req(base, 'GET', `/orgs/${inviteOrg}/skills/${skillId}`, { token: adminTok })
    assert(goneS.status === 404, `gone skill ${goneS.status}`)
    assert(String(goneS.json.error).includes('没有这个 Skill'), '404 skill 文案')

    const delZ = await req(base, 'DELETE', `/orgs/${inviteOrg}/skills/${zipId}`, { token: adminTok })
    assert(delZ.status === 200 && delZ.json.deleted === true, 'delete zip skill')

    const delM = await req(base, 'DELETE', `/orgs/${inviteOrg}/mcp-servers/${serverId}`, { token: adminTok })
    assert(delM.status === 200 && delM.json.deleted === true && delM.json.id === serverId, 'delete mcp')
    const goneM = await req(base, 'GET', `/orgs/${inviteOrg}/mcp-servers/${serverId}`, { token: adminTok })
    assert(goneM.status === 404, `gone mcp ${goneM.status}`)
    assert(String(goneM.json.error).includes('没有这个 MCP 服务器'), '404 mcp 文案')
  })

  await test('模版持久化 skills/mcps ids；未知 id 忽略；成员改不动', async () => {
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'boss@invite.test', password: 'new-horse-10' },
    })
    assert(login.status === 200, `relogin ${login.status} ${login.text}`)
    const adminTok = login.json.token

    const skill = await req(base, 'POST', `/orgs/${inviteOrg}/skills`, {
      token: adminTok,
      body: { name: '挂载技能', body: '一步' },
    })
    assert(skill.status === 201, `skill ${skill.status} ${skill.text}`)
    const skillId = skill.json.skill.id
    const mcp = await req(base, 'POST', `/orgs/${inviteOrg}/mcp-servers`, {
      token: adminTok,
      body: {
        name: '挂载mcp',
        kind: 'HTTP',
        endpoint: 'http://127.0.0.1:9',
        token: 'bind-secret-token',
        env: { API_KEY: 'mcp-env-runtime-secret' },
      },
    })
    assert(mcp.status === 201, `mcp ${mcp.status} ${mcp.text}`)
    const mcpId = mcp.json.server.id
    assert(!dumpHas(mcp.json, 'bind-secret-token'), 'create 泄漏 token')
    assert(!dumpHas(mcp.json, 'mcp-env-runtime-secret'), 'create 泄漏 env')

    const cat = await req(base, 'GET', '/catalog/mcp', { token: adminTok })
    assert(cat.status === 200, `catalog mcp ${cat.status}`)
    assert(!dumpHas(cat.json, 'bind-secret-token'), 'catalog/mcp 泄漏 token')
    for (const item of cat.json.items || []) {
      assert(!item.definition || item.definition.token == null, 'definition.token')
    }

    // 挂载在**模版**上，不在某一个 Bot 上：认识的收下，不认识的丢掉。
    const created = await req(base, 'PUT', `/orgs/${inviteOrg}/bot-template`, {
      token: adminTok,
      body: { skills: [skillId, 'no-such'], mcps: [mcpId, 'nope'] },
    })
    assert(created.status === 200, `create ${created.status} ${created.text}`)
    assert(JSON.stringify(created.json.template.skills) === JSON.stringify([skillId]), `skills ${JSON.stringify(created.json.template.skills)}`)
    assert(JSON.stringify(created.json.template.mcps) === JSON.stringify([mcpId]), `mcps ${JSON.stringify(created.json.template.mcps)}`)

    const bot = await req(base, 'POST', '/runtime/bots', { token: adminTok, body: { name: '带挂载' } })
    assert(bot.status === 201, `建 ${bot.status} ${bot.text}`)
    assert(bot.json.bot.skillCount === 1, 'skillCount')
    assert(bot.json.bot.mcpCount === 1, 'mcpCount')
    const id = bot.json.bot.id

    const got = await req(base, 'GET', `/runtime/bots/${id}`, { token: adminTok })
    assert(got.status === 200, `get ${got.status}`)
    assert(got.json.bot.skills[0] === skillId && got.json.bot.mcps[0] === mcpId, 'get ids')

    // /runtime/catalog 会带出 MCP 明文 token 与 env，只给席位 sat_，不给浏览器 JWT。
    const rtJwt = await req(base, 'GET', '/runtime/catalog', { token: adminTok })
    assert(rtJwt.status === 401, `runtime 不该收 JWT ${rtJwt.status} ${rtJwt.text}`)
    assert(!dumpHas(rtJwt.json, 'bind-secret-token'), 'JWT 拿到了 MCP token')
    assert(!dumpHas(rtJwt.json, 'mcp-env-runtime-secret'), 'JWT 拿到了 MCP env')
    const orgMcp = await req(base, 'GET', `/orgs/${inviteOrg}/mcp-servers/${mcpId}`, { token: adminTok })
    assert(!dumpHas(orgMcp.json, 'bind-secret-token'), 'org get 泄漏 token')
    assert(!dumpHas(orgMcp.json, 'mcp-env-runtime-secret'), 'org get 泄漏 env')
    const meAdmin = await req(base, 'GET', '/me', { token: adminTok })
    const platAcc = await req(base, 'GET', `/platform/accounts/${meAdmin.json.account.id}`, { token: ownerTok })
    const satRt = await req(base, 'GET', '/runtime/catalog', { token: platAcc.json.accessToken })
    assert(satRt.status === 200, `sat runtime ${satRt.status} ${satRt.text}`)
    const satSrv = (satRt.json.servers || []).find((x) => x.id === mcpId)
    assert(satSrv && satSrv.token === 'bind-secret-token', 'sat runtime 应带 token')
    assert(satSrv.env && satSrv.env.API_KEY === 'mcp-env-runtime-secret', 'sat runtime 应带 env')
    const rtKey = await req(base, 'GET', '/runtime/catalog', { token: platAcc.json.apiKey })
    assert(rtKey.status === 401, `runtime 不该收 sk_sw_ ${rtKey.status}`)

    const patched = await req(base, 'PUT', `/orgs/${inviteOrg}/bot-template`, {
      token: adminTok,
      body: { skills: [], mcps: [mcpId] },
    })
    assert(patched.status === 200, `patch ${patched.status} ${patched.text}`)
    assert(Array.isArray(patched.json.template.skills) && patched.json.template.skills.length === 0, 'cleared skills')
    // 已经建好的那个 Bot 跟着变，不用碰它。
    const after = await req(base, 'GET', `/runtime/bots/${id}`, { token: adminTok })
    assert(after.json.bot.skillCount === 0, `skillCount 0，实际 ${after.json.bot.skillCount}`)
    assert(after.json.bot.mcpCount === 1, 'mcpCount stays')

    const deny = await req(base, 'PUT', `/orgs/${inviteOrg}/bot-template`, {
      token: invitedTok,
      body: { skills: [skillId] },
    })
    assert(deny.status === 403, `member patch ${deny.status}`)

    const opts = await req(base, 'GET', `/orgs/${inviteOrg}/bot-template`, { token: adminTok })
    assert(opts.status === 200, `options ${opts.status}`)
    assert(opts.json.options.skills.some((s) => s.id === skillId && s.name === '挂载技能'), 'options skills')
    assert(opts.json.options.mcps.some((s) => s.id === mcpId && s.name === '挂载mcp'), 'options mcps')
    await req(base, 'DELETE', `/runtime/bots/${id}`, { token: adminTok })
  })

  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 400))
  try {
    child.kill('SIGKILL')
  } catch {}
}

async function runBot() {
  log('\n# bot')
  rmSync(BOT_HOME, { recursive: true, force: true })
  const base = `http://127.0.0.1:${BOT_PORT}`
  const child = start('bot', ['--import', 'tsx', join(botRoot, 'e2e-boot.mjs')], {
    cwd: botRoot,
    env: {
      SATUWORK_HOME: BOT_HOME,
      SATUWORK_PORT: String(BOT_PORT),
      // 本机套件：显式关掉 Gateway，避免继承环境里的 GATEWAY_URL 而不种 default。
      // GATEWAY_TOKEN 要给：它是 bot 现在唯一认的入站凭据。catalog 的 configured
      // 同时要 URL 和 token，URL 空着就仍然不去拉目录，照旧种 default。
      GATEWAY_URL: '',
      GATEWAY_TOKEN: SEAT_TOK,
      GATEWAY_API_KEY: '',
      SATUWORK_BOT_ID: '',
      // 空 key 不删：套件不能因为没配模型就整组失败，但进程环境保持原样。
    },
  })
  await waitHttp(base + '/api/health', { timeout: 45000, child, what: 'bot' })
  assert(!child._exited, 'bot 启动后就退出了')

  let botId
  let sessionId

  await test('未登录 /api/bots → 401（不跳过鉴权）', async () => {
    const r = await req(base, 'GET', '/api/bots')
    assert(r.status === 401, `unauth ${r.status} ${r.text}`)
  })

  await test('GET / → JSON 404，不是 HTML SPA', async () => {
    const r = await req(base, 'GET', '/')
    assert(r.status === 404, `root ${r.status} ${r.text}`)
    assert(r.json && r.json.error, `not json ${String(r.text).slice(0, 120)}`)
    assert(!String(r.text).toLowerCase().includes('<html'), '仍发 html')
  })

  await test('席位票 GET /api/bots', async () => {
    const r = await req(base, 'GET', '/api/bots', { token: SEAT_TOK })
    assert(r.status === 200, `machine ${r.status} ${r.text}`)
    assert(Array.isArray(r.json.bots) && r.json.bots.length >= 1, 'empty')
  })

  await test('大小写和尾斜杠都绕不过 /api 守卫', async () => {
    // 路由是 path-to-regexp 编出来的正则，带 `i` 标志、还允许一个尾斜杠；守卫却是
    // 按原样字符串 startsWith('/api/') 判的。两边口径不一致时 `GET /API/bots` 会两头
    // 落空：守卫认为「不是 /api，放行」，路由照样命中——整个 /api 面未鉴权。
    for (const path of ['/API/bots', '/Api/Bots', '/api/bots/', '/API/bots/']) {
      const anon = await req(base, 'GET', path)
      assert(anon.status === 401, `${path} 无票应 401，得到 ${anon.status} ${anon.text}`)
      const ok = await req(base, 'GET', path, { token: SEAT_TOK })
      assert(ok.status === 200, `${path} 有票应 200，得到 ${ok.status} ${ok.text}`)
    }
  })

  await test('bot 里没有账号体系：/api/auth/* 与 /api/me* 一律不通', async () => {
    // 这套东西（用户、邀请、cookie 会话、口令重置）是 Gateway 出现之前那一版的。
    // 它一个调用方都没有，却仍然在监听：`/api/auth/setup` 当时在公开白名单里，
    // 一个用户都没有时谁都能建出第一个 admin——而席位上的员工在 noVNC 桌面里
    // 正好打得到 127.0.0.1:<botPort>，建完就绕开了席位票。
    //
    // 没票时守卫先答 401，带票时路由不存在答 404。两种都行，唯独不能是 200。
    for (const [method, path] of [
      ['GET', '/api/auth/state'],
      ['POST', '/api/auth/setup'],
      ['POST', '/api/auth/login'],
      ['GET', '/api/me'],
      ['GET', '/api/me/sessions'],
      ['GET', '/api/invites/whatever'],
    ]) {
      const anon = await req(base, method, path, { body: method === 'POST' ? {} : undefined })
      assert(anon.status === 401 || anon.status === 404, `${path} 无票应 401/404，得到 ${anon.status}`)
      const withTok = await req(base, method, path, {
        token: SEAT_TOK,
        body: method === 'POST' ? {} : undefined,
      })
      assert(withTok.status === 404, `${path} 带票应 404（路由已删），得到 ${withTok.status} ${withTok.text}`)
    }
  })

  await test('GET /api/bots 无 mock:true，默认 bot 带 provider+model', async () => {
    const r = await req(base, 'GET', '/api/bots', { token: SEAT_TOK })
    assert(r.status === 200, `bots ${r.status} ${r.text}`)
    assert(r.json.mock !== true, '顶层 mock:true')
    assert(Array.isArray(r.json.bots) && r.json.bots.length >= 1, '空名册')
    assert(
      r.json.bots.every((a) => a.mock !== true),
      '条目带 mock:true',
    )
    const def = r.json.bots.find((a) => a.id === 'default') || r.json.bots[0]
    assert(def && def.id, '没有默认 bot')
    assert(def.provider === 'deepseek', `provider ${def.provider}`)
    assert(typeof def.model === 'string' && def.model, '缺 model')
    botId = def.id
  })

  await test('POST /api/bots → 410（Bot 配置在 Gateway）', async () => {
    const r = await req(base, 'POST', '/api/bots', {
      token: SEAT_TOK,
      body: { name: '测试助理', description: 'e2e', prompt: '只说好' },
    })
    assert(r.status === 410 || r.status === 404, `create ${r.status} ${r.text}`)
    if (r.status === 410) assert(String(r.json.error || r.text).includes('Gateway'), '410 文案')
  })

  await test('GET /api/bots/:id/session 二次调用同一 sessionId', async () => {
    const a = await req(base, 'GET', `/api/bots/${botId}/session`, { token: SEAT_TOK })
    assert(a.status === 200, `session1 ${a.status} ${a.text}`)
    assert(typeof a.json.sessionId === 'string' && a.json.sessionId, 'sessionId')
    const b = await req(base, 'GET', `/api/bots/${botId}/session`, { token: SEAT_TOK })
    assert(b.status === 200, `session2 ${b.status}`)
    assert(b.json.sessionId === a.json.sessionId, 'sessionId 变了')
    sessionId = a.json.sessionId
  })

  await test('POST /api/sessions 缺 botId → 400', async () => {
    const r = await req(base, 'POST', '/api/sessions', { token: SEAT_TOK, body: { title: '无主' } })
    assert(r.status === 400, `sessions ${r.status} ${r.text}`)
  })

  // ── 附件：上传进工作区，再原样取回来。────────────────────────────────
  // workspace-files 那一组钉的是服务层的边界，这里钉的是**HTTP 这一跳**：
  // 文件名怎么过 header、字节有没有在路上被改、预览的响应头对不对。
  let uploadedPath

  await test('上传附件：落进工作区，返回相对路径', async () => {
    const bytes = Buffer.from('列,值\n甲,1\n乙,2\n', 'utf8')
    const r = await req(base, 'POST', `/api/sessions/${sessionId}/files`, {
      token: SEAT_TOK,
      raw: bytes,
      headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('二季度.csv') },
    })
    assert(r.status === 200, `upload ${r.status} ${r.text}`)
    assert(typeof r.json.path === 'string' && r.json.path.startsWith('uploads/'), `落点不对：${r.text}`)
    // 中文名要能穿过 header 活着回来——这正是不用查询串、改用 URL 编码 header 的原因。
    assert(r.json.name === '二季度.csv', `文件名坏了：${r.json.name}`)
    assert(r.json.size === bytes.length, `大小对不上：${r.json.size} ≠ ${bytes.length}`)
    uploadedPath = r.json.path
    const onDisk = join(BOT_HOME, 'work', uploadedPath)
    assert(existsSync(onDisk), `磁盘上没有 ${onDisk}`)
    assert(readFileSync(onDisk, 'utf8') === bytes.toString('utf8'), '落盘内容和传上去的不一样')
  })

  await test('上传到不存在的会话 → 404', async () => {
    const r = await req(base, 'POST', '/api/sessions/no-such-session/files', {
      token: SEAT_TOK,
      raw: Buffer.from('x'),
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'a.txt' },
    })
    assert(r.status === 404, `应该 404，实为 ${r.status} ${r.text}`)
  })

  await test('预览：字节一个不差，响应头挡住嗅探', async () => {
    const r = await req(base, 'GET', `/api/workspace/file?path=${encodeURIComponent(uploadedPath)}`, { token: SEAT_TOK })
    assert(r.status === 200, `preview ${r.status} ${r.text}`)
    assert(r.text === '列,值\n甲,1\n乙,2\n', `内容对不上：${JSON.stringify(r.text)}`)
    assert(String(r.headers.get('content-type')).startsWith('text/plain'), `类型不对：${r.headers.get('content-type')}`)
    assert(r.headers.get('x-content-type-options') === 'nosniff', '少了 nosniff，白名单会被嗅探绕过')
    const cd = String(r.headers.get('content-disposition') || '')
    assert(cd.startsWith('inline'), `csv 该能内联：${cd}`)
    // 中文名两份都要在：ASCII 那份兜底，filename* 带原名。
    assert(cd.includes("filename*=UTF-8''"), `少了 RFC 5987 的那份：${cd}`)
  })

  await test('预览：?download=1 强制另存', async () => {
    const r = await req(base, 'GET', `/api/workspace/file?path=${encodeURIComponent(uploadedPath)}&download=1`, { token: SEAT_TOK })
    assert(r.status === 200, `download ${r.status}`)
    assert(String(r.headers.get('content-disposition')).startsWith('attachment'), '没强制另存')
  })

  await test('预览：能带脚本的类型一律另存，不给内联', async () => {
    const r = await req(base, 'POST', `/api/sessions/${sessionId}/files`, {
      token: SEAT_TOK,
      raw: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'evil.svg' },
    })
    assert(r.status === 200, `upload svg ${r.status} ${r.text}`)
    const g = await req(base, 'GET', `/api/workspace/file?path=${encodeURIComponent(r.json.path)}`, { token: SEAT_TOK })
    assert(g.status === 200, `get svg ${g.status}`)
    // 内联一个带 <script> 的 SVG，等于让上传者在这个源上执行代码。
    assert(String(g.headers.get('content-disposition')).startsWith('attachment'), 'SVG 被允许内联了')
    assert(g.headers.get('content-type') === 'application/octet-stream', `SVG 的 MIME 不该是 image/svg+xml：${g.headers.get('content-type')}`)
  })

  await test('预览：路径越界 → 400，文件不存在 → 404', async () => {
    const bad = await req(base, 'GET', `/api/workspace/file?path=${encodeURIComponent('../../../etc/passwd')}`, { token: SEAT_TOK })
    assert(bad.status === 400, `越界应该 400，实为 ${bad.status} ${bad.text}`)
    const missing = await req(base, 'GET', `/api/workspace/file?path=${encodeURIComponent('nope.txt')}`, { token: SEAT_TOK })
    assert(missing.status === 404, `不存在应该 404，实为 ${missing.status} ${missing.text}`)
    const empty = await req(base, 'GET', '/api/workspace/file', { token: SEAT_TOK })
    assert(empty.status === 400, `缺 path 应该 400，实为 ${empty.status}`)
  })

  await test('附件这两条路一样要过鉴权', async () => {
    const up = await req(base, 'POST', `/api/sessions/${sessionId}/files`, {
      raw: Buffer.from('x'),
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'a.txt' },
    })
    assert(up.status === 401, `未登录上传 ${up.status}`)
    const get = await req(base, 'GET', `/api/workspace/file?path=${encodeURIComponent(uploadedPath)}`)
    assert(get.status === 401, `未登录预览 ${get.status}`)
  })

  // ── 图片：发进消息里，模型是真能看见的那种。────────────────────────
  let shotPath

  await test('带图发消息：图片块落进 JSONL，存的是路径不是字节', async () => {
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
      'hex',
    )
    const up = await req(base, 'POST', `/api/sessions/${sessionId}/files`, {
      token: SEAT_TOK,
      raw: png,
      headers: { 'content-type': 'application/octet-stream', 'x-filename': 'shot.png' },
    })
    assert(up.status === 200, `传图 ${up.status} ${up.text}`)
    shotPath = up.json.path

    const r = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      token: SEAT_TOK,
      body: { text: '这张图里是什么', images: [{ path: shotPath, mime: 'image/png' }] },
    })
    assert(r.status === 200, `带图发消息 ${r.status} ${r.text}`)
    assert(r.json.accepted === true || r.json.steered === true, `既没 accepted 也没 steered：${r.text}`)

    await new Promise((x) => setTimeout(x, 800))
    assert(!child._exited, '带图发消息把进程打挂了')

    const file = join(BOT_HOME, 'sessions', `${sessionId}.jsonl`)
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    const withImage = lines.filter(
      (e) => e.type === 'user/message' && (e.data?.message?.content ?? []).some((c) => c.type === 'image'),
    )
    // steer 的消息不写日志（既有行为），所以这条可能没落下来——落下来了就必须是对的。
    if (withImage.length) {
      const block = withImage[0].data.message.content.find((c) => c.type === 'image')
      assert(block.path === shotPath, `图片块路径不对：${block.path}`)
      assert(block.mime === 'image/png', `图片块 mime 不对：${block.mime}`)
      // 一张 2 MB 的图 base64 之后是 2.7 MB，写进 JSONL 会让这一行没法 grep、没法 tail。
      const raw = JSON.stringify(withImage[0])
      assert(!raw.includes(png.toString('base64')), '图片字节被写进会话日志了')
      assert(raw.length < 2000, `事件行 ${raw.length} 字符，太长了，多半是把字节写进去了`)
    }
  })

  await test('图片路径逃不出工作区，也不能指一个不存在的文件', async () => {
    // 路径是浏览器传上来的。这一层不挡，工作区边界就等于没有。
    const escape = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      token: SEAT_TOK,
      body: { text: 'x', images: [{ path: '../../../etc/passwd', mime: 'image/png' }] },
    })
    assert(escape.status === 400, `越界路径应该 400，实为 ${escape.status} ${escape.text}`)

    const missing = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      token: SEAT_TOK,
      body: { text: 'x', images: [{ path: 'nope.png', mime: 'image/png' }] },
    })
    assert(missing.status === 400, `不存在的图应该 400，实为 ${missing.status} ${missing.text}`)
  })

  await test('模型看不了的图片格式当场拒掉', async () => {
    // 不在白名单里的（TIFF、SVG、HEIC）各家 provider 支持不一，发过去多半换回一个
    // 400——而那个 400 长得像我们自己的 bug，查起来要绕一大圈。
    const bad = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      token: SEAT_TOK,
      body: { text: 'x', images: [{ path: shotPath, mime: 'image/svg+xml' }] },
    })
    assert(bad.status === 400, `svg 应该 400，实为 ${bad.status} ${bad.text}`)
    const nomime = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      token: SEAT_TOK,
      body: { text: 'x', images: [{ path: shotPath }] },
    })
    assert(nomime.status === 400, `缺 mime 应该 400，实为 ${nomime.status}`)
  })

  await test('只有图、没有正文也能发', async () => {
    // 「这张图什么意思」本来就常常只有一张图。
    const r = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      token: SEAT_TOK,
      body: { images: [{ path: shotPath, mime: 'image/png' }] },
    })
    assert(r.status === 200, `只带图 ${r.status} ${r.text}`)
    // 但两样都没有仍然要拒——那是一条空消息。
    const empty = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, { token: SEAT_TOK, body: {} })
    assert(empty.status === 400, `空消息应该 400，实为 ${empty.status}`)
  })

  await test('发消息：无 Gateway 密钥也不准把进程打挂；JSONL 根有 botId+origin', async () => {
    const r = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      token: SEAT_TOK,
      body: { text: 'ping' },
    })
    // 只认 200：这条路（bot/src/web/index.ts 的 /messages）收下就回 accepted / steered，
    // 没配模型是那一轮之后的事，HTTP 这一跳不该因此变成 4xx。以前放到 4xx 的写法
    // 等于「随便回什么都行」，验不出任何东西。
    assert(r.status === 200, `message ${r.status} ${r.text}`)
    assert(r.json.accepted === true || r.json.steered === true, '既没 accepted 也没 steered')
    await new Promise((x) => setTimeout(x, 800))
    assert(!child._exited, `发消息后进程退出 code=${child._exited?.code} sig=${child._exited?.sig}`)
    const health = await req(base, 'GET', '/api/health')
    assert(health.status === 200 && health.json.ok === true, 'health 挂了')
    // 管家换 bot 版本之前要问这条路「你忙不忙」（见 manager/src/seats.ts 的排空）。
    // 少了这两个字段，管家只会当成「问不出来」，然后照旧把跑着的那一轮拦腰重启。
    assert(typeof health.json.busy === 'boolean', `/api/health 不报忙闲：${health.text}`)
    assert(
      typeof health.json.running === 'number' && typeof health.json.queued === 'number',
      `/api/health 的计数少了：${health.text}`,
    )

    const file = join(BOT_HOME, 'sessions', `${sessionId}.jsonl`)
    assert(existsSync(file), `没有 JSONL ${file}`)
    const first = readFileSync(file, 'utf8').split('\n').find((l) => l.trim())
    const ev = JSON.parse(first)
    assert(ev.type === 'session', `首条是 ${ev.type}`)
    assert(ev.data.botId === botId, `botId ${ev.data.botId}`)
    assert(ev.data.origin, '缺 origin')
    skips.push('模型回复：bot 不持有上游 key，只断言接口收了、进程还在、JSONL 根字段在')
  })

  await test('每条流的第一帧自报进程身份：换过版的席位认得出来', async () => {
    /**
     * 换版就是把 bot 换一个进程，而浏览器那头只看得见「流断了」——和网络抖一下长得
     * 一模一样。于是它拿着换版前的游标续传、接着用旧进程攒下来的状态（正在跑的那一
     * 轮、排队的 dock、目录里的工具），没有任何东西会来纠正它。
     *
     * **重启信号只有一个时刻送得出去**：进程死掉那一刻它已经说不了话了，只能在重新
     * 连上的第一帧补说一句「我是谁」。所以这一帧必须排在重放之前——重放可能很长，而
     * 客户端要先知道这批事件是接着看还是全部作废。
     */
    // SSE 不会自己结束（心跳一直在），所以读到第一批帧就掐断——`req` 那个助手会一直
    // 等 text() 收完，在这条路上等于挂死。
    const ac = new AbortController()
    const res = await fetch(`${base}/api/sessions/${sessionId}/events?tail=1`, {
      headers: { authorization: 'Bearer ' + SEAT_TOK, accept: 'text/event-stream' },
      signal: ac.signal,
    })
    assert(res.ok, `开流 ${res.status}`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let raw = ''
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && !raw.includes('replay/done')) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((ok) => setTimeout(() => ok({ done: true, value: undefined }), 1200)),
      ])
      if (done) break
      raw += dec.decode(value, { stream: true })
    }
    ac.abort()
    const frames = raw
      .split('\n\n')
      .map((f) => f.replace(/^data: /, '').trim())
      .filter(Boolean)
      .map((f) => {
        try {
          return JSON.parse(f)
        } catch {
          return null
        }
      })
      .filter(Boolean)
    assert(frames.length > 0, `一帧都没收到：${raw.slice(0, 200)}`)
    const hello = frames[0]
    assert(hello.type === 'runtime/hello', `第一帧不是自报家门，是 ${hello.type}——排在重放后面就晚了`)
    assert(typeof hello.instanceId === 'string' && hello.instanceId.length >= 8, `没给进程身份：${JSON.stringify(hello)}`)
    assert(typeof hello.startedAt === 'number' && hello.startedAt > 0, `没给起来的时刻：${JSON.stringify(hello)}`)
    // health 上那一份必须是同一个：管家排错时两条路对得上才有用。
    const h = await req(base, 'GET', '/api/health')
    assert(h.json.instanceId === hello.instanceId, `两条路报的身份不一样：${h.json.instanceId} vs ${hello.instanceId}`)
  })

  await test('换版静默：落闸之后不接新一轮，放开之后立刻恢复；无票调不动', async () => {
    /**
     * 管家在重启这个进程之前先落这道闸（见 manager/src/seats.ts 的排空）：等到「此刻
     * 没人在跑」之后，到真的 `systemctl restart` 之间还隔着拉包、解包、rsync 那几秒，
     * 不落闸的话人在那几秒里发一句照样被拦腰砍断。
     *
     * 这一条走的是 HTTP 面，钉的正是「开新一轮之前那道闸」——它必须判在真正要开新一轮
     * 的那一刻，而不是请求刚进来时：steering 落空（那一轮正好跑完）会掉回开新一轮的
     * 路上，早判的话那里就是个缝，`accepted: true` 已经回出去了，消息却一个字没跑。
     */
    const anon = await req(base, 'POST', '/api/quiesce', { body: { ttlMs: 60_000 } })
    assert(anon.status === 401, `静默开关无票该 401，实际 ${anon.status} ${anon.text}`)

    const on = await req(base, 'POST', '/api/quiesce', { token: SEAT_TOK, body: { ttlMs: 60_000 } })
    assert(on.status === 200 && on.json.quiesced === true, `落闸失败：${on.status} ${on.text}`)
    const h = await req(base, 'GET', '/api/health')
    assert(h.json.quiesced === true, `health 该自报静默中：${h.text}`)

    const refused = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      token: SEAT_TOK,
      body: { text: '换版这几秒发的' },
    })
    assert(refused.status === 409, `静默期该当场回绝，实际 ${refused.status} ${refused.text}`)
    assert(String(refused.json.error).includes('换新版本'), `回绝的话说不清：${refused.text}`)

    const off = await req(base, 'POST', '/api/quiesce', { token: SEAT_TOK, body: { ttlMs: 0 } })
    assert(off.status === 200 && off.json.quiesced === false, `放开失败：${off.status} ${off.text}`)
    const again = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      token: SEAT_TOK,
      body: { text: 'ping' },
    })
    assert(again.status === 200, `放开之后该照常收下，实际 ${again.status} ${again.text}`)
    assert(!again.json.quiesced, `放开了还说自己在静默：${again.text}`)
  })

  /**
   * 人手改上下文边界：`/compact` 和 `/new`（见 docs/chat-commands.md）。
   *
   * 这里钉的是**HTTP 面**：要票、拒绝要带得出原话、成功要真的落一条事件。边界怎么挑
   * 是纯函数，由 e2e/compact.mjs 那组管。
   */
  await test('POST /api/sessions/:id/{compact,reset} → 要票，拒绝时说得出原因', async () => {
    for (const act of ['compact', 'reset']) {
      const anon = await req(base, 'POST', `/api/sessions/${sessionId}/${act}`)
      assert(anon.status === 401, `${act} 无票该 401，实际 ${anon.status} ${anon.text}`)
    }

    const file = join(BOT_HOME, 'sessions', `${sessionId}.jsonl`)
    const readLines = () =>
      readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    // 上一条用例放开静默之后补发了一句 ping，那一轮此刻多半还在跑——重置撞上去就是
    // 409「这一轮还在跑」，而这条用例要钉的根本不是那件事。等它跑完再动手。
    for (let i = 0; i < 200 && (await req(base, 'GET', '/api/health')).json.busy; i++) {
      await new Promise((x) => setTimeout(x, 50))
    }

    const before = readLines()
    const ends = before.filter((e) => e.type === 'turn/end')

    const r = await req(base, 'POST', `/api/sessions/${sessionId}/reset`, { token: SEAT_TOK })
    if (!ends.length) {
      // 这条会话一轮都没跑完（上游是假的，跑不跑得完不由这里决定）。那就必须是这句话，
      // 不能是 500——「没有要清的上下文」和「它崩了」在界面上得分得开。
      assert(r.status === 409, `一轮都没跑完时该 409，实际 ${r.status} ${r.text}`)
      assert(String(r.json.error || '').includes('没跑成过一轮'), `话说不清：${r.text}`)
      return
    }

    assert(r.status === 200 && r.json.reset === true, `重置失败：${r.status} ${r.text}`)
    const after = readLines()
    const mark = [...after].reverse().find((e) => e.type === 'session/reset')
    assert(mark, '重置成功了，日志里却没有 session/reset')
    assert(mark.data.throughSeq === r.json.throughSeq, `回给前端的 seq 和落盘的对不上：${r.text}`)
    // **边界必须落在 turn/end 上。** 切在轮次中间会留下无主的 tool/result，
    // provider 直接拒收整个请求——而那要等到下一轮真发出去才炸。
    const at = after.find((e) => e.seq === mark.data.throughSeq)
    assert(at?.type === 'turn/end', `边界落在了 ${at?.type} 上，必须是 turn/end`)
    // **日志一条不删**，这是整件事的前提。
    assert(after.length > before.length, `重置之后日志反而短了：${before.length} → ${after.length}`)

    const twice = await req(base, 'POST', `/api/sessions/${sessionId}/reset`, { token: SEAT_TOK })
    assert(twice.status === 409, `连着点两次该 409，实际 ${twice.status} ${twice.text}`)

    // 刚重置完，边界之后一条完整轮次都没有——压不动，而且要说人话。
    const c = await req(base, 'POST', `/api/sessions/${sessionId}/compact`, { token: SEAT_TOK })
    assert(c.status === 409, `刚重置完该压不动，实际 ${c.status} ${c.text}`)
    assert(String(c.json.error || '').includes('太短'), `压不动的理由说不清：${c.text}`)
  })

  await test('GET /api/billing → 404（账单已挪到 Gateway）', async () => {
    const r = await req(base, 'GET', '/api/billing', { token: SEAT_TOK })
    assert(r.status === 404 || r.status === 410, `billing ${r.status} ${r.text}`)
  })

  await test('GET /api/usage → 404（用量统计已挪到 Gateway）', async () => {
    const r = await req(base, 'GET', '/api/usage', { token: SEAT_TOK })
    assert(r.status === 404 || r.status === 410, `usage ${r.status} ${r.text}`)
  })

  await test('GET /api/skills → 404（Skill 配置在 Gateway）', async () => {
    const r = await req(base, 'GET', '/api/skills', { token: SEAT_TOK })
    assert(r.status === 404 || r.status === 410, `skills ${r.status} ${r.text}`)
  })

  await test('GET /api/accounts → 404（账号管理在 Gateway）', async () => {
    const r = await req(base, 'GET', '/api/accounts', { token: SEAT_TOK })
    assert(r.status === 404 || r.status === 410, `accounts ${r.status} ${r.text}`)
  })

  await test('create+session 后 JSONL 首条是当前 version 且带 botId', async () => {
    const file = join(BOT_HOME, 'sessions', `${sessionId}.jsonl`)
    const first = readFileSync(file, 'utf8').split('\n').find((l) => l.trim())
    const ev = JSON.parse(first)
    assert(ev.type === 'session', '首条不是 session')
    assert(ev.data.version === SESSION_FORMAT, `version=${ev.data.version}，当前格式是 ${SESSION_FORMAT}`)
    assert(ev.data.botId === botId, 'botId')
  })

  await test('GET /internal/sessions/:id 席位凭证；错票 404 不暴露', async () => {
    const none = await req(base, 'GET', `/internal/sessions/${sessionId}`)
    assert(none.status === 404, `no token ${none.status} ${none.text}`)
    const bad = await req(base, 'GET', `/internal/sessions/${sessionId}`, { token: 'wrong-token' })
    assert(bad.status === 404, `bad token ${bad.status}`)
    const ok = await req(base, 'GET', `/internal/sessions/${sessionId}`, { token: SEAT_TOK })
    assert(ok.status === 200, `ok ${ok.status} ${ok.text}`)
    assert(Array.isArray(ok.json.events) && ok.json.events[0]?.type === 'session', 'events')
    const miss = await req(base, 'GET', '/internal/sessions/s-no-such', { token: SEAT_TOK })
    assert(miss.status === 404, `missing ${miss.status}`)
  })

  // 并发/原子性在 session-store 那组用探针直接压 SessionService，这里只管真进程里读得通。
  await test('旧格式会话经 /internal/sessions 读一次就地迁到当前版本', async () => {
    // v1 根事件：没有 botId / origin。读一次应就地迁到 v3。
    const legacyId = 's-legacy-v1'
    const file = join(BOT_HOME, 'sessions', `${legacyId}.jsonl`)
    const lines = [
      { seq: 1, time: 1, type: 'session', data: { version: 1, id: legacyId, createdAt: 1, title: '旧会话' } },
      {
        seq: 2,
        time: 2,
        type: 'user/message',
        data: { message: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'LEGACY-OK' }] }, source: { kind: 'user' } },
      },
    ]
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

    const a = await req(base, 'GET', `/internal/sessions/${legacyId}`, { token: SEAT_TOK })
    assert(a.status === 200, `legacy read ${a.status} ${a.text}`)
    assert(a.json.events.length === 2, `事件条数 ${a.json.events.length}`)

    const after = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert(after.length === 2, `迁移后行数 ${after.length}`)
    assert(after[0].data.version === SESSION_FORMAT, `迁移后 version ${after[0].data.version}，当前格式是 ${SESSION_FORMAT}`)
    assert(after[0].data.botId === 'default', `迁移后 botId ${after[0].data.botId}`)
    assert(after[0].data.origin === 'local', `迁移后 origin ${after[0].data.origin}`)
    assert(JSON.stringify(after[1]) === JSON.stringify(lines[1]), '正文事件被改动')
    const strays = readdirSync(join(BOT_HOME, 'sessions')).filter((f) => f.endsWith('.tmp'))
    assert(strays.length === 0, `留下临时文件 ${strays.join(',')}`)
  })

  await test('未登录 GET /api/runtime/status → 401', async () => {
    const r = await req(base, 'GET', '/api/runtime/status')
    assert(r.status === 401, `unauth status ${r.status} ${r.text}`)
  })

  await test('本机无 GATEWAY_URL 仍有 default bot', async () => {
    const r = await req(base, 'GET', '/api/bots', { token: SEAT_TOK })
    assert(r.status === 200, `bots ${r.status} ${r.text}`)
    assert((r.json.bots || []).some((b) => b.id === 'default'), '缺 default')
  })

  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 400))
  try {
    child.kill('SIGKILL')
  } catch {}
}

async function main() {
  GW_PORT = Number(process.env.E2E_GW_PORT) || (await freePort())
  BOT_PORT = Number(process.env.E2E_BOT_PORT) || (await freePort())
  process.on('SIGINT', () => {
    killAll()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    killAll()
    process.exit(143)
  })
  // 任何没接住的崩溃也得先收子进程再退：不然 Gateway / 管家 / detached 的 Chrome 探针
  // 会留在机器上，下一次跑 e2e 端口就被它们占着。
  const crash = (what) => (e) => {
    console.error(`[e2e] ${what}：${e?.stack ?? e}`)
    killAll()
    process.exit(1)
  }
  process.on('uncaughtException', crash('未捕获异常'))
  process.on('unhandledRejection', crash('未处理的 rejection'))
  try {
    await requirePg()
    await suite('gateway', () => runGateway())
    await suite('bot', () => runBot())
    await suite('runtime-path', () =>
      runRuntimePath({
        root,
        gwRoot,
        botRoot,
        test,
        req,
        start,
        waitHttp,
        assert,
        log,
      }))
    await suite('gateway-chat', () =>
      runGatewayChat({
        gwRoot,
        botRoot,
        test,
        req,
        start,
        waitHttp,
        assert,
        log,
        treeHas,
      }))
    await suite('deploy-errors', () => runDeployErrors({ root, test, assert, log }))
    await suite('upgrade-drain', () => runUpgradeDrain({ root, test, assert, log }))
    await suite('proxy-close', () => runProxyClose({ root, test, assert, log }))
    await suite('pairing', () => runPairing({ root, test, assert, log }))
    await suite('machine-deploy', () =>
      runMachineDeploy({
        gwRoot,
        test,
        req,
        start,
        waitHttp,
        assert,
        log,
      }))
    await suite('llm-usage', () =>
      runLlmUsage({
        gwRoot,
        test,
        req,
        start,
        waitHttp,
        assert,
        log,
      }))
    await suite('setup', () => runSetup({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('custom-provider', () => runCustomProvider({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('stats', () => runStats({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('web-tools', () => runWebTools({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('billing', () => runBilling({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('migrate', () => runMigrate({ gwRoot, test, start, waitHttp, assert, log }))
    await suite('global-catalog', () => runGlobalCatalog({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('connectors', () => runConnectors({ root, gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('tool-search', () => runToolSearch({ root, gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('skills', () => runSkills({ root, gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('skills-bot', () => runSkillsBot({ root, test, assert, log }))
    await suite('memory-bot', () => runMemoryBot({ root, test, assert, log }))
    await suite('memory', () => runMemory({ root, gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('conversation-audit', () => runConversationAudit({ root, test, assert, log }))
    await suite('bot-template', () => runBotTemplate({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('manager', () => runManager({ root, gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('manager-confirm', () => runManagerConfirm({ root, test, assert, log }))
    await suite('channels', () => runChannels({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('channel-webhook', () => runChannelWebhook({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('telegram-rich', () => runTelegramRich({ root, test, assert, log }))
    await suite('telegram-channel', () => runTelegramChannel({ root, test, assert, log }))
    await suite('ui-smoke', () => runUiSmoke({ root, gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('ui-files', () => runUiFiles({ root, test, assert, log }))
    await suite('markdown', () => runMarkdown({ root, test, assert, log }))
    await suite('chat-fold', () => runChatFold({ root, test, assert, log }))
    await suite('tool-names', () => runToolNames({ root, test, assert, log }))
    await suite('session-store', () => runSessionStore({ root, test, assert, log }))
    await suite('llm-idle', () => runLlmIdle({ root, test, assert, log }))
    await suite('replay-slice', () => runReplaySlice({ root, test, assert, log }))
    await suite('roster-stream', () => runRosterStream({ test, assert, log }))
    await suite('workspace-files', () => runWorkspaceFiles({ root, test, assert, log }))
    await suite('patch', () => runPatch({ root, test, assert, log }))
    await suite('process', () => runProcess({ root, test, assert, log }))
    await suite('doc-extract', () => runDocExtract({ root, test, assert, log }))
    await suite('web-bot', () => runWebBot({ root, test, assert, log }))
    await suite('vision', () => runVision({ root, test, assert, log }))
    await suite('turn-images', () => runTurnImages({ root, test, assert, log }))
    await suite('mentions', () => runMentions({ root, test, assert, log }))
    await suite('routine-model', () => runRoutineModel({ root, test, assert, log }))
    await suite('routine-tools', () => runRoutineTools({ root, test, assert, log }))
    await suite('history-time', () => runHistoryTime({ root, test, assert, log }))
    await suite('compact', () => runCompact({ root, test, assert, log }))
    await suite('gateway-url', () => runGatewayUrl({ root, test, assert, log }))
    await suite('max-steps', () => runMaxSteps({ root, test, assert, log }))
    await suite('delegate', () => runDelegate({ root, test, assert, log }))
    await suite('toolcalls', () => runToolCalls({ root, test, assert, log }))
    await suite('guards', () => runGuards({ root, test, assert, log }))
    await suite('handoff', () => runHandoff({ root, gwRoot, test, req, start, waitHttp, assert, log, skip }))
    await suite('routine-retry', () => runRoutineRetry({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('routine-worker', () => runRoutineWorker({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('worker', () => runWorker({ root, gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('serverless', () => runServerless({ root, gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('local-routines', () => runLocalRoutines({ root, test, assert, log }))
    await suite('release-blob', () => runReleaseBlob({ gwRoot, test, req, start, waitHttp, assert, log }))
    await suite('browser', () => runBrowser({ root, test, assert, log }))
    await suite('mounted', () => runMounted({ root, test, assert, log }))
    // 关进程那条放在最后：它把 Gateway 起起来又掐掉，后面再挂用例只会跟它抢端口。
    await suite('shutdown', () => runShutdown({ gwRoot, test, start, waitHttp, assert, log }))
  } finally {
    killAll()
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
    try {
      rmSync(BOT_HOME, { recursive: true, force: true })
    } catch {}
  }

  log('')
  log(`# ${passed} passed, ${failed} failed`)
  if (skips.length) {
    for (const s of skips) log(`# skip  ${s}`)
  }
  if (!failed) log('E2E OK')
  /**
   * **全绿的那一轮以前根本回不到命令行。**
   *
   * `killAll()` 之后进程里仍然剩着没释放的句柄——machine-deploy 那个听 8443 的假管家、
   * undici 攒下的连接、探针留下的管道——事件循环空不掉，node 就一直挂在这儿。而失败那
   * 条路上一直有 `process.exit(1)` 兜着，所以这个坑只在「一条都不红」的时候露出来：
   * 屏幕上明明写着 E2E OK，人却等着它结束，一等一个多小时。
   *
   * 结论已经全部打完了，退出码也已经定了。跨五十个套件去追最后一个没关干净的句柄是场
   * 打不赢的仗，这里直接落闸——但要等这几行字先落地，见 `bye`。
   */
  bye(failed ? 1 : 0)
}

/**
 * 打完再走。
 *
 * `process.exit()` **不等** stdout / stderr 把队列写完，而这两条在管道上（CI 就是管道、
 * `| tee` 也是）是异步的。直接 exit 能把最后几行整段吞掉——实测两万行里丢了近四成，
 * 而丢的恰恰是 `# N passed, M failed`、skip 清单和那些 `not ok` 的堆栈：退出码是对的，
 * 日志里却看不出发生了什么。
 *
 * 两条都排空了才走；读的那头要是先撤了、回调永远不来，两秒后照样走。
 */
function bye(code) {
  let left = 2
  const go = () => {
    if (--left === 0) process.exit(code)
  }
  setTimeout(() => process.exit(code), 2000)
  process.stdout.write('', go)
  process.stderr.write('', go)
}

main().catch((e) => {
  console.error(e.stack || e.message)
  killAll()
  bye(1)
})
