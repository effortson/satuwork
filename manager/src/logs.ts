import { spawn } from 'node:child_process'
import type { ServerResponse } from 'node:http'
import { scrub } from './diag.ts'

/**
 * 席位 bot 的运行日志。
 *
 * 为什么值得单开一条路：没有 SSH 的时候，「bot 到底在干什么」谁也看不见。诊断快照
 * （diag.ts）能回答「它活着吗」——单元 active、端口有人听——但回答不了「它卡在哪
 * 一步」。而这一层最贵的故障恰恰都不报错：进程活着、端口听着、systemd 说 active，
 * 只是那一轮永远不结束。
 *
 * **只读，而且只读这一个单元**：unit 名由 seatId 拼出来，seatId 必须先在名册里查得
 * 到（见 index.ts 的路由），所以拼不出别的单元；spawn 走参数数组，不过 shell。
 *
 * 每一行都过 scrub：journal 里可能有席位票、API key、VNC 口令，而这条路的终点是
 * 浏览器。
 */
export function botUnit(seatId: string): string {
  return `satuwork-bot@${seatId}.service`
}

/** 管家自己那条。平台端排查「机器怎么了」时看的是它，不是某个席位。 */
export const MANAGER_UNIT = 'satuwork-manager.service'

const MAX_LINES = 2000

export function clampLines(raw: string | null, fallback = 200): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_LINES, Math.max(1, Math.floor(n)))
}

/** 最近 N 行。拿不到（没有 journalctl、单元不存在）就是空数组，不抛。 */
export function recentLogs(unit: string, lines: number): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn(
      'journalctl',
      ['-u', unit, '-n', String(lines), '--no-pager', '-o', 'short-iso'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000)
    child.stdout.on('data', (d) => (out += d))
    child.on('error', () => {
      clearTimeout(timer)
      resolve([])
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(
        out
          .split('\n')
          .filter((l) => l.trim())
          .map(scrub),
      )
    })
  })
}

/**
 * 跟着滚。SSE，一行一帧。
 *
 * 返回的 Promise 在流真正结束时才 resolve——路由器靠 `res.writableEnded` 判断要不要
 * 补一个 204，处理函数提前返回的话，那个 204 会直接盖到 SSE 上。
 */
export function followLogs(
  unit: string,
  lines: number,
  res: ServerResponse,
  /** 盖在 SSE 头上的几条（浏览器直连时是 CORS 那几条；Gateway 拿机器票来的不需要）。 */
  extra: Record<string, string> = {},
): Promise<void> {
  return new Promise((resolve) => {
    res.writeHead(200, {
      ...extra,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    /**
     * **头要当场发出去。** writeHead 只是登记，Node 要等第一次 write 才把响应头真的写到
     * socket 上；而一个安静的单元（刚部署、还没写过一行）journalctl -f 可能几十秒不吐
     * 一个字节，浏览器那头连 200 都收不到，fetch 就在等响应头上超时。开发机上没有
     * journalctl，子进程当场报错、当场写了一帧，所以这个坑只在真机上出现。
     */
    res.flushHeaders()
    const child = spawn(
      'journalctl',
      ['-u', unit, '-n', String(lines), '--no-pager', '-f', '-o', 'short-iso'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let buf = ''
    let done = false
    // 心跳。中间那几跳（终结 TLS 的反代、可能还有别的）都会掐掉长时间没字节的连接，
    // 而一个安静的 bot 可以几分钟不写一行日志——那正是最需要盯着它的时候。
    const beat = setInterval(() => res.write(': ping\n\n'), 15000)
    const finish = () => {
      if (done) return
      done = true
      clearInterval(beat)
      try {
        child.kill('SIGKILL')
      } catch {}
      try {
        res.end()
      } catch {}
      resolve()
    }
    child.stdout.on('data', (d) => {
      buf += d
      const parts = buf.split('\n')
      buf = parts.pop() ?? ''
      for (const line of parts) {
        if (!line.trim()) continue
        res.write(`data: ${JSON.stringify({ line: scrub(line) })}\n\n`)
      }
    })
    child.on('error', (e) => {
      res.write(`data: ${JSON.stringify({ error: String(e.message || e) })}\n\n`)
      finish()
    })
    child.on('close', finish)
    // 人关了面板就别让 journalctl -f 一直挂着。
    res.on('close', finish)
  })
}
