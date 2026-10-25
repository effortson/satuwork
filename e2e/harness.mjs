/**
 * e2e 的骨架：用例 / 套件计数、子进程登记与收尾、HTTP 小助手。
 *
 * 从 run.mjs 里搬出来，好让各套件直接 import，而不是每处都从参数里接一遍。
 * **只能有一份模块实例**：children / passed / failed 都挂在这里，killAll 收的是这一份。
 */
import { spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { killProbes, withDeadline } from './probe.mjs'

const botRoot = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bot')

const children = []
export let failed = 0
export let passed = 0
export const skips = []

export function log(line) {
  console.log(line)
}

/**
 * 记一条「这台机器上跑不了」。**和 test() 是两回事**：跳过的不算 passed，最后的
 * 清单里单列出来——一条静默 return 的用例看着是绿的，实际上什么都没验。
 */
export function skip(reason) {
  skips.push(reason)
  log(`  # skip  ${reason}`)
}

export function assert(cond, msg) {
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

export async function test(name, fn) {
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
export async function suite(name, fn) {
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

export function start(name, args, { cwd, env }) {
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

export function killAll() {
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
export async function waitHttp(url, { timeout = 30000, child, what } = {}) {
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
export async function req(base, method, path, { token, body, raw, headers: extra, timeout = 30000 } = {}) {
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

export function dumpHas(obj, needle) {
  return JSON.stringify(obj).includes(needle)
}

export function treeHas(dir, needle) {
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

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 每 `every` 毫秒问一次 fn，等到它返回真值就把那个值交回来；`timeout` 之内等不到就抛。
 * 报错默认是「{what} 在 {timeout}ms 内没成」，`fail` 给了就原样用它——各套原来的说法不一，
 * 搬过来时照旧，日志里认得出是哪一处。
 */
export async function until(fn, { timeout = 20000, every = 300, what = '条件', fail } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const v = await fn()
    if (v) return v
    await sleep(every)
  }
  throw new Error(fail ?? `${what} 在 ${timeout}ms 内没成`)
}

export function listenMock(handler) {
  const server = createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, port: addr.port, url: `http://127.0.0.1:${addr.port}` })
    })
  })
}
