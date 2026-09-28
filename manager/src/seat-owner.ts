import { readFileSync } from 'node:fs'

/**
 * 「这个进程是哪个席位的」。回收端口（reclaim.ts）、拆席位时杀逃出去的进程、诊断报告里的
 * `mine`（diag.ts）都靠它，判错一次的代价是**停掉别人的席位**或者**把别人的进程认成自己的**。
 *
 * **不能再按进程自报的环境变量认。** 以前的判据是 `XDG_RUNTIME_DIR=/tmp/xdg-runtime-<席位>`
 * （diag 那边是 XDG_CONFIG_HOME），而环境变量是进程自己写的：同机任何一个账号
 * `XDG_RUNTIME_DIR=/tmp/xdg-runtime-<别人的席位> nc -l <那个席位下一个槽位的口>`，下一次部署
 * 的端口回收就会把那个席位当成孤儿停掉；蹲在 RFB 口上还能骗过 slim-desktop.sh 的自证。
 *
 * 现在的判据只认**进程自己改不了的东西**：
 *
 *   1. `/proc/<pid>/cgroup` 落在 `satuwork-bot@<席位>.service` 或 `slim-desktop@<席位>.service`
 *      里——cgroup 是 root（systemd）放的，普通用户挪不进系统单元的 cgroup。bot 和它拉起的
 *      一切（terminal、Chrome）都在这儿。
 *   2. 桌面那一套特殊：单元是 `PAMName=login` 起的，Xvfb / x11vnc / websockify 会被 logind 挪进
 *      `session-<N>.scope`（单元停了它们还活着，正是回收要清的那种）。scope 名里没有席位号，
 *      所以这一路要三样同时成立：
 *        - 那个 logind 会话是 PAM 服务 `login` 开的（/run/systemd/sessions/<N> 的 SERVICE=，
 *          logind 写的、root 的文件）。ssh 登录是 `sshd`、su 是 `su`，普通用户开不出 `login`
 *          的会话——/bin/login 不是 setuid 的；
 *        - 环境里自报的席位（XDG_RUNTIME_DIR，这时它只是一个**候选**）；
 *        - 进程的 uid 等于那个席位的账号——账号从 root 写的 drop-in（`User=`）里读，不从进程
 *          身上读。别的员工（别的 uid）从这一路冒充不了任何席位。
 *   两路最后都核一遍 uid。
 *
 * 剩下的口子：**同一个员工**另一块屏在桌面 session scope 里的进程，能自报成这个员工的另一个
 * 席位。那要求它本来就是这个 uid、本来就在一个 `login` 会话里——等于同一个账号自己跟自己过
 * 不去，影响也只在这个员工自己的席位之间。
 *
 * **bash 那边有同一套**（src/seat/seat-owner.sh，deploy-seat.sh / remove-seat.sh 用），改一处
 * 两处一起改。
 */

const UNIT_RE = /\/(?:slim-desktop|satuwork-bot)@([A-Za-z0-9_-]+)\.service(?:\/|$)/m
const SESSION_RE = /\/session-([A-Za-z0-9]+)\.scope$/m
/** 新的 /run/satuwork/<席位>（root 建的），和老部署留下的 /tmp/xdg-runtime-<席位>。 */
const RUNTIME_RE = /^XDG_RUNTIME_DIR=(?:\/run\/satuwork\/|\/tmp\/xdg-runtime-)([A-Za-z0-9_-]+)$/

/** 从 /proc 读来的、关于一个进程的三样事实。 */
export interface PidFacts {
  cgroup: string
  environ: string[]
  uid: number | null
}

/** 判据要问的两件外部的事。拆出来是为了判断这半边能单独钉住（manager/e2e-deploy-errors.mjs）。 */
export interface OwnerLookup {
  /** logind 会话是哪个 PAM 服务开的。读不到回 null。 */
  sessionService(sessionId: string): string | null
  /** 这个席位的 Linux 账号的 uid。不知道回 null。 */
  seatUid(seatId: string): number | null
}

/** 纯判断：给定事实，这个进程属于哪个席位。认不出来回 null。 */
export function claimSeat(facts: PidFacts, look: OwnerLookup): string | null {
  let seatId: string | null = null
  const unit = UNIT_RE.exec(facts.cgroup)
  if (unit) {
    seatId = unit[1]
  } else {
    const session = SESSION_RE.exec(facts.cgroup)
    if (!session || look.sessionService(session[1]) !== 'login') return null
    for (const kv of facts.environ) {
      const m = RUNTIME_RE.exec(kv)
      if (m) {
        seatId = m[1]
        break
      }
    }
    if (!seatId) return null
  }
  const want = look.seatUid(seatId)
  if (want === null || facts.uid === null || facts.uid !== want) return null
  return seatId
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 读不到 cgroup（进程已经退了、或者 pid 不对）回 null。 */
export function pidFacts(pid: string): PidFacts | null {
  if (!/^\d+$/.test(pid)) return null
  const cgroup = readText(`/proc/${pid}/cgroup`)
  if (cgroup === null) return null
  const status = readText(`/proc/${pid}/status`) ?? ''
  const uid = /^Uid:\s+(\d+)/m.exec(status)
  return {
    cgroup,
    environ: (readText(`/proc/${pid}/environ`) ?? '').split('\0'),
    uid: uid ? Number(uid[1]) : null,
  }
}

/** /etc/passwd 里这个名字的 uid。席位账号是 deploy-seat.sh 用 adduser 建的本地账号。 */
function uidOfUser(name: string): number | null {
  const passwd = readText('/etc/passwd')
  if (!passwd) return null
  for (const line of passwd.split('\n')) {
    const cols = line.split(':')
    if (cols[0] === name && /^\d+$/.test(cols[2] ?? '')) return Number(cols[2])
  }
  return null
}

/** 席位的账号：deploy-seat.sh 写的 drop-in 里那行 `User=`（root 的文件）。 */
function seatUserFromDropIn(seatId: string): string | null {
  for (const unit of ['slim-desktop', 'satuwork-bot']) {
    const conf = readText(`/etc/systemd/system/${unit}@${seatId}.service.d/seat.conf`)
    const m = conf && /^User=([A-Za-z0-9_-]+)\s*$/m.exec(conf)
    if (m) return m[1]
  }
  return null
}

/**
 * 真机上的那一份查法。`user` 给了就用它当席位账号（调用方手里有名册那一行）；没给就读
 * drop-in——端口回收碰上的多半是名册里已经没有的席位。
 */
export function hostLookup(user?: string): OwnerLookup {
  return {
    sessionService(sessionId) {
      const text = readText(`/run/systemd/sessions/${sessionId}`)
      const m = text && /^SERVICE=(.*)$/m.exec(text)
      return m ? m[1] : null
    },
    seatUid(seatId) {
      const name = user ?? seatUserFromDropIn(seatId)
      return name ? uidOfUser(name) : null
    },
  }
}

/** 这个进程属于哪个席位。认不出来（包括进程已经退了）回 null。 */
export function seatOfPid(pid: string, user?: string): string | null {
  const facts = pidFacts(pid)
  return facts ? claimSeat(facts, hostLookup(user)) : null
}
