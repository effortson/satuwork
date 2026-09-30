/**
 * 「测试」按钮发出去的推理档（gateway/src/llm.ts 的 probe）。
 *
 * pi-ai 的 openai-responses 在调用方没给档位时，会替推理模型补 `reasoning.effort =
 * thinkingLevelMap.off ?? "none"`。从目录里自动补进来的模型多半没有 thinkingLevelMap，于是
 * 发的就是 `none`——gpt-6.1-sol 只收 low 以上，模型配置页上的「测试」一律 400，而真用的时候
 * （Bot 不带推理字段、Gateway 也不补）是好的。测试和真用发的不一样，这个按钮就没有意义。
 *
 * 这里造一颗「没有 thinkingLevelMap 的推理模型」，指到本地一个假上游，记下 probe 真正发出去
 * 的请求体：
 *   - 档位是 off / 没配：不带 `reasoning`（和真用一样，由上游用默认）；
 *   - 档位是 high：`reasoning.effort` 就是 high；
 *   - 不会推理的模型：不带 `reasoning`。
 *
 * llm.ts 用了参数属性，node 自带的去类型跑不了，所以另起一个 `--import tsx` 的子进程。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'

function upstream() {
  const bodies = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        bodies.push(JSON.parse(raw))
      } catch {
        bodies.push({ unparsable: raw })
      }
      // 只要请求体，不用真的回答：一律回 400，probe 记成不通即可。
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'stub', type: 'invalid_request_error' } }))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, bodies, url: `http://127.0.0.1:${server.address().port}/v1` })))
}

function probeIn(gwRoot, stubUrl, cases) {
  const script = `
    import { Llm } from './src/llm.ts'
    const llm = new Llm({})
    const base = llm.models.getModel('openai', 'gpt-5.1')
    const models = {
      // 像 gpt-6.1-sol 那样从目录补进来、没有档位表的推理模型
      sol: { ...base, id: 'gpt-e2e-sol', baseUrl: ${JSON.stringify(stubUrl)}, thinkingLevelMap: undefined },
      plain: { ...base, id: 'gpt-e2e-plain', baseUrl: ${JSON.stringify(stubUrl)}, reasoning: false, thinkingLevelMap: undefined },
    }
    llm.secret = async () => 'sk-e2e-probe'
    for (const [name, effort] of ${JSON.stringify(cases)}) {
      llm.find = async () => ({ provider: 'openai', id: models[name].id })
      llm.piModel = () => models[name]
      await llm.probe(null, 'openai', models[name].id, effort ?? undefined)
    }
  `
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: gwRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (c) => (err += c))
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`probe 子进程退出 ${code}：${err.slice(-800)}`))))
  })
}

export async function runLlmProbeEffort({ root, test, assert, log }) {
  log('\n# llm-probe-effort')
  await test('「测试」按钮按这一格配置的推理档发：off 不带 reasoning、high 发 high、不会推理的不带', async () => {
    const up = await upstream()
    try {
      await probeIn(join(root, 'gateway'), up.url, [
        ['sol', null],
        ['sol', 'off'],
        ['sol', 'high'],
        ['plain', 'high'],
      ])
      assert(up.bodies.length === 4, `该打 4 次上游，实际 ${up.bodies.length}`)
      const [none, off, high, plain] = up.bodies
      assert(!('reasoning' in none), `没配档位时不该带 reasoning（pi-ai 会补成 none）：${JSON.stringify(none.reasoning)}`)
      assert(!('reasoning' in off), `off 时不该带 reasoning：${JSON.stringify(off.reasoning)}`)
      assert(high.reasoning?.effort === 'high', `high 时该发 high：${JSON.stringify(high.reasoning)}`)
      assert(!('reasoning' in plain), `不会推理的模型不该带 reasoning：${JSON.stringify(plain.reasoning)}`)
    } finally {
      up.server.close()
    }
  })
}
