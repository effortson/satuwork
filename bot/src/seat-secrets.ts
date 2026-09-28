import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'

/**
 * 席位的两把凭据（`GATEWAY_TOKEN` / `GATEWAY_API_KEY`）**不走环境变量**，从标准输入读。
 *
 * ## 为什么不能放在 env 里
 *
 * bot 和它起的子进程（terminal 的 bash、Chrome）跑在**同一个 Linux 用户**名下。
 * `childEnv()` 只管得住「递给子进程的那份 env」，管不住子进程自己去读：
 *
 * - `/proc/$PPID/environ` 是 bot 进程**启动那一刻**的环境。Node 里 `delete process.env.X`
 *   只改 libc 的那份拷贝，这个文件一个字都不会变——同 uid 的进程随时读得到。
 * - 原先凭据写在 `$SEAT_DIR/bot.env` 里，那个文件归席位用户，`cat` 一下就有。
 *
 * 拿到 `sat_` 的脚本能自己轮询 `127.0.0.1:<bot 端口>/api/sessions/<sid>/approvals` 把审批
 * 全点掉，整套审批策略等于没有。
 *
 * ## 现在怎么走
 *
 * deploy-seat.sh 把两把凭据写进 `/etc/satuwork/seat-secrets/<席位>.env`（root、0600，目录
 * 0700），单元用 `StandardInput=file:` 把它接到 bot 的 fd 0 上——文件是 systemd 以 root
 * 身份打开的，席位用户自己打不开它。bot 启动第一件事读完 fd 0、立刻关掉换成 /dev/null：
 * 关掉之后 `/proc/<bot>/fd/0` 也没了，子进程（都在这之后才起）无从下手。
 *
 * 读进来的值放进 `process.env`，消费者（guard、llm/gateway.ts…）一行不用改；这些改动
 * 不会反映到 `/proc/<pid>/environ`，而递给子进程的 env 由 `childEnv()` 剔掉。剩下能摸到
 * 进程内存的路（`/proc/<pid>/mem`、ptrace、SIGUSR1 开 inspector）由 deploy 设的
 * `kernel.yama.ptrace_scope=1` 和启动器的 `--disable-sigusr1` 堵。
 *
 * **只有单元里设了 `SATUWORK_SECRETS_STDIN=1` 才读**：本地桌面 bot、e2e、手工 `node bin/…`
 * 的 fd 0 是别的东西（管道、终端），不能去碰。
 */

/**
 * 这个进程是不是按「远程席位」的方式起的（凭据从 fd 0 读到了）。
 *
 * gateway-url.ts 据此决定新地址往哪儿落盘：席位上 bot.env 已经在 root 的目录里、bot 写
 * 不动，改写的是 `$SATUWORK_HOME/gateway-url`（带 HMAC 的那份）。
 */
let seatMode = false

export function isSeatMode(): boolean {
  return seatMode
}

/** 测试用：不走 fd 0 也能把进程当成席位。 */
export function setSeatModeForTest(on: boolean): void {
  seatMode = on
}

/** 只认这两个名字。fd 0 上多出来的行一律不收——它不是一个通用的 env 通道。 */
const SECRET_KEYS = new Set(['GATEWAY_TOKEN', 'GATEWAY_API_KEY'])

/** `KEY=VALUE` 一行一条；空行和 `#` 开头的跳过。值不做引号处理（deploy 写的就是裸值）。 */
export function parseSeatSecrets(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    const key = t.slice(0, eq).trim()
    const value = t.slice(eq + 1).trim()
    if (SECRET_KEYS.has(key) && value) out[key] = value
  }
  return out
}

/**
 * 读 fd 0 上的凭据，然后把 fd 0 换成 /dev/null。返回读到了哪几个名字（不含值）。
 *
 * 失败就抛：设了 `SATUWORK_SECRETS_STDIN=1` 却读不到票，这个席位进不了 Gateway 的门，
 * 带病起来只会在界面上表现成一串莫名其妙的 401；不如当场退出，让 journal 里写清楚。
 */
export function loadSeatSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  if ((env.SATUWORK_SECRETS_STDIN || '').trim() !== '1') return []
  delete env.SATUWORK_SECRETS_STDIN

  const st = fstatSync(0)
  // 终端或者空文件都说明单元没接上（StandardInput= 没写、文件没铺）。
  if (!st.isFile() && !st.isFIFO()) {
    throw new Error('seat-secrets: 设了 SATUWORK_SECRETS_STDIN=1，但标准输入不是文件——检查单元的 StandardInput=file:')
  }
  const raw = readFileSync(0, 'utf8')
  /**
   * 关掉再开 /dev/null：open 取最小的空号，此刻就是 0。不补上的话，下一个打开的
   * socket/文件会落在 fd 0，谁 `stdio: 'inherit'` 起个子进程就把它递下去了。
   */
  closeSync(0)
  const fd = openSync('/dev/null', 'r')
  if (fd !== 0) closeSync(fd)

  const got = parseSeatSecrets(raw)
  if (!got.GATEWAY_TOKEN) {
    throw new Error('seat-secrets: 标准输入里没有 GATEWAY_TOKEN——凭据文件是空的或形状不对，重新部署这个席位')
  }
  for (const [k, v] of Object.entries(got)) env[k] = v
  seatMode = true
  return Object.keys(got)
}
