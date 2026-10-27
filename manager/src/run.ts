import { spawn } from 'node:child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * 跑一个外部命令，把两股输出都收齐。
 *
 * 输出**截断在 64 KiB**：`apt-get install` 一次能刷出几兆，全留着只会把内存和上报给
 * Gateway 的错误信息一起撑爆。出错时有用的永远是最后几行，所以留尾不留头。
 */
export function run(
  file: string,
  args: string[],
  opts: {
    env?: NodeJS.ProcessEnv
    timeout?: number
    cwd?: string
    /**
     * stdout 每满一行就叫一次，**跑的过程中**，不是跑完之后。
     *
     * 唯一的用处是进度：`deploy-seat.sh` 边跑边报「第几步」，而这条命令一跑十几分钟，
     * 等它 resolve 再看输出，那份进度早就没人要了（见 seats.ts 的 stepOf）。
     *
     * 抛出来的异常吞掉：一个画进度的回调没有任何理由把部署带倒。
     */
    onLine?: (line: string) => void
  } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // 自成一个进程组：超时时要杀的是整棵树（deploy-seat.sh 下面的 apt-get、tar、
      // runuser……），只 SIGKILL 那个 bash 会留下一堆孤儿继续占着端口和锁。正常路径不受
      // 影响：stdio 还是管道，这边照旧等 close，也没有 unref。
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    const cap = (s: string, chunk: string) => (s + chunk).slice(-65536)
    // 半行留着：一次 data 事件切在一行中间是常态，直接按 \n 切会把那一行劈成两半，
    // 而进度那条恰恰是整行才有意义的。
    let pending = ''
    child.stdout.on('data', (d) => {
      const chunk = String(d)
      stdout = cap(stdout, chunk)
      if (!opts.onLine) return
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      // 一直不换行的输出（进度条那种 \r 刷新）不许把这半行攒成一片内存。留尾不留头，
      // 和上面 stdout 的 64 KiB 一个道理——要认的那行标记也只可能在尾巴上。
      if (pending.length > 65536) pending = pending.slice(-4096)
      for (const line of lines) {
        try {
          opts.onLine(line)
        } catch {}
      }
    })
    child.stderr.on('data', (d) => {
      stderr = cap(stderr, String(d))
    })
    const timer = setTimeout(
      () => {
        // 负的 pid = 整个进程组（detached 让 child.pid 就是组长）。组杀不动再退回只杀它自己。
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
          else child.kill('SIGKILL')
        } catch {
          try {
            child.kill('SIGKILL')
          } catch {}
        }
        stderr = cap(stderr, `\n[manager] ${file} timed out`)
      },
      opts.timeout ?? 600_000,
    )
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: cap(stderr, String(e instanceof Error ? e.message : e)) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * 出错信息压成一行，给 Gateway 看。保留尾部——报错都在最后。
 *
 * 两处是踩过坑之后改的：
 *
 * **退出码永远带上。** 原先它藏在 `fallback` 里，而 `fallback` 只在两个流都空的时候
 * 才用得上。可失败的那条命令**很可能什么都不打印**（mkdir、chown、systemctl 都是这
 * 样），偏偏前面又有一堆正常的进度输出——于是消息里全是无关的话，唯一有用的「exited
 * 几」被挤掉了。
 *
 * **stdout 也留一段。** stderr 优先没错，但这个脚本的进度打在 stdout 上；出错那一步
 * 静默时，stdout 的末尾就是「走到哪儿了」，那是唯一的线索。
 */
export function tailError(r: RunResult, fallback: string): string {
  const one = (s: string) => (s || '').replace(/\s+/g, ' ').trim()
  const err = one(r.stderr)
  const out = one(r.stdout)
  const head = typeof r.code === 'number' && r.code !== 0 ? `exited ${r.code}` : fallback
  const body = [err && `stderr: ${err.slice(-400)}`, out && `stdout: ${out.slice(-400)}`].filter(Boolean).join(' | ')
  return body ? `${head} — ${body}` : head || fallback
}

/**
 * 2 秒后重启这几个 systemd 服务，由一个**分离的**瞬态单元发起。
 *
 * 管家的子进程去 `systemctl restart` 会连自己一起被杀（同一个 cgroup），命令根本发不出去，所以
 * 要跳到瞬态单元里。`--collect`：瞬态单元失败了 systemd 默认把它留在 failed 态，同名的下一次
 * systemd-run 会以「单元已存在」被拒——从此再也发不出重启。前面的 reset-failed 给老机器兜底（没带
 * --collect 的旧版本留下的残骸）；单元不存在时它只是报一句，不算错。
 *
 * 自升级（upgrade.ts）和改监听（https.ts）都走这一条，单元名各用各的，互不顶掉。
 */
export async function scheduleRestart(unit: string, services: string[]): Promise<RunResult> {
  await run('systemctl', ['reset-failed', `${unit}.service`], { timeout: 10_000 }).catch(() => {})
  return run('systemd-run', ['--on-active=2s', '--collect', `--unit=${unit}`, 'systemctl', 'restart', ...services], { timeout: 15_000 })
}

/**
 * 跑一遍，只要 stdout；非零和抛异常都当「什么都没看到」。
 *
 * 「看一眼现场」这类活儿（诊断、回收端口）不该因为少一个工具就整件挂掉——老镜像
 * 上没有 ss、没有 journalctl 是常事，而那正是最需要看现场的时候。
 */
export async function tryRun(file: string, args: string[], timeout = 8000): Promise<string> {
  try {
    const r = await run(file, args, { timeout })
    return r.code === 0 ? r.stdout : ''
  } catch {
    return ''
  }
}
