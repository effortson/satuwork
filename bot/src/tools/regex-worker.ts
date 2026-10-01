import { Worker } from 'node:worker_threads'

/**
 * 在 worker 线程里跑模型给的正则。
 *
 * **不能在主线程上 `re.test`。** 正则是模型给的（提示注入也能给），`(a|aa)+$`、`(\w+\s?)*$`
 * 这类写法碰上一行几十个字符的 `aaaa…`（base64、压缩过的 JS 里随处都是）就是指数级回溯。
 * JS 的正则一旦开跑就打断不了：限行长挡不住，停止信号也只在文件之间才看得到——这个进程的
 * 事件循环整个被占住，所有会话的流、停止按钮、健康检查一起没了响应，管家只能当它死了重启。
 *
 * 放进 worker：主线程只等答复，按文件计时；超时或者人按了停止，整个线程 terminate 掉——
 * 这是唯一能叫停一次正在跑的正则的办法。
 */

/** 一个文件最多给正则多少时间。正常的正则扫 2 MB 远用不了这么久。 */
const PER_FILE_MS = 3_000

const SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const re = new RegExp(workerData.pattern, workerData.flags)
parentPort.on('message', ({ id, lines }) => {
  const hits = []
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0
    if (re.test(lines[i])) hits.push(i)
  }
  parentPort.postMessage({ id, hits })
})
`

/** 正则在某个文件上跑超时了（多半是灾难性回溯）。 */
export class RegexTimeoutError extends Error {}

export interface RegexMatcher {
  /** 这几行里命中的行号（下标）。超时抛 RegexTimeoutError，停止抛 AbortError。 */
  match(lines: string[], signal?: AbortSignal): Promise<number[]>
  close(): void
}

/** `pattern` 已经在主线程上 `new RegExp` 过一次（语法错在那边报），这里不再判。 */
export function regexMatcher(pattern: string, flags: string, perFileMs = PER_FILE_MS): RegexMatcher {
  let worker: Worker | null = null
  let seq = 0
  const spawn = () => {
    const w = new Worker(SOURCE, { eval: true, workerData: { pattern, flags } })
    // 不让一个空闲的匹配线程拖住进程退出。
    w.unref()
    return w
  }
  const close = () => {
    const w = worker
    worker = null
    if (w) void w.terminate()
  }
  return {
    close,
    match(lines, signal) {
      worker ??= spawn()
      const w = worker
      const id = ++seq
      return new Promise<number[]>((resolve, reject) => {
        const done = (fn: () => void) => {
          clearTimeout(timer)
          w.off('message', onMessage)
          w.off('error', onError)
          signal?.removeEventListener('abort', onAbort)
          fn()
        }
        const onMessage = (m: { id: number; hits: number[] }) => {
          if (m.id === id) done(() => resolve(m.hits))
        }
        const onError = (e: Error) => {
          close()
          done(() => reject(e))
        }
        const onAbort = () => {
          close()
          done(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        }
        const timer = setTimeout(() => {
          close()
          done(() => reject(new RegexTimeoutError(`正则在一个文件上跑了 ${perFileMs / 1000} 秒还没完`)))
        }, perFileMs)
        w.on('message', onMessage)
        w.on('error', onError)
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) return onAbort()
        w.postMessage({ id, lines })
      })
    },
  }
}
