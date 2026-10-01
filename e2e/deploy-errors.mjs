/**
 * 部署失败时报回去的那句话。
 *
 * 这一组是补票：一次真实的部署失败在界面上只显示到「Adding new group (1003) .」就断了，
 * 而真正的原因——脚本在哪一步、退出码多少——一个字都没有。两处叠在一起造成的：管家把
 * 退出码藏在只在两流皆空时才用的兜底里，Gateway 又在 JSON.parse 之前把响应体砍到 400 字。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'manager/e2e-deploy-errors.mjs')

export async function runDeployErrors({ root, test, assert, log }) {
  log('\n# deploy-errors')
  const r = await runProbe(root)

  await test('失败的命令一声不吭时，退出码必须还在', async () => {
    // 这就是那次真实故障：脚本非零退出，stderr 空，stdout 里全是无关的正常进度。
    // 原先的取法是 `stderr || stdout || fallback`——stdout 非空，于是兜底里那句
    // 「exited 3」永远轮不上，界面上只剩一堆进度。
    assert(r.silentFailure.includes('exited 3'), `没带退出码：${r.silentFailure}`)
    assert(r.silentFailure.includes('chrome: 已在位'), `没带上走到哪儿了：${r.silentFailure}`)
  })

  await test('两个流都空：至少说得出退出码', async () => {
    assert(r.bothEmpty.includes('exited 137'), `${r.bothEmpty}`)
  })

  await test('stderr 有内容也不丢 stdout——一个说为什么，一个说走到哪儿', async () => {
    assert(r.bothStreams.includes('第 42 行失败'), `丢了 stderr：${r.bothStreams}`)
    assert(r.bothStreams.includes('进度B'), `丢了 stdout：${r.bothStreams}`)
  })

  await test('超长输出留尾不留头', async () => {
    assert(r.longTail.includes('最后一句'), `把结尾截掉了：${r.longTail.slice(0, 80)}…`)
    assert(!r.longTail.includes('OUT-0 '), '把开头留下了，那儿没有原因')
  })

  await test('退出码为 0 时不硬说 exited 0，走兜底', async () => {
    assert(r.code0 === '兜底', `${r.code0}`)
  })

  // ── 安装进度：脚本报的那几行，管家读不读得出来 ──────────────────────
  // 建完 Bot 那一屏上的「第 3 步 / 共 7 步 · 安装浏览器」全靠这条链路：脚本 echo 一行
  // → run() 边跑边按行喂出来 → stepOf 解出来。中间断一处，那一屏就退回到一句不动的
  // 「正在安装…」，而它和「卡死了」长得一模一样。

  await test('一行进度被切成两半发出来，也要拼回原样', async () => {
    // 一次 stdout 事件切在行中间是常态。按 \n 直接切会把「@@st | ep 2/7 …」劈成两条，
    // 于是第二步永远报不出来——而它恰恰是最长的那一步（apt 装桌面栈）。
    assert(r.steps.length === 2, `没读全：${JSON.stringify(r.steps)}`)
    assert(r.steps[0] === '1/7 创建席位账号', `第一步 ${r.steps[0]}`)
    assert(r.steps[1] === '2/7 安装桌面组件', `第二步 ${r.steps[1]}`)
  })

  await test('不是那个形状的行一律不认，不编一个数出来', async () => {
    // 越界（9/7）、坏数（x/7）、零总数都要落空：报进度宁可什么都不说，也不能说一个
    // 编出来的数——那一屏上人正照着它判断「还要等多久」。
    assert(r.stepBad.every((x) => x === null), `认了不该认的：${JSON.stringify(r.stepBad)}`)
  })

  await test('脚本里的步号和 STEPS 对得上', async () => {
    // 加一步却忘了改 STEPS，进度条会在中途走到头然后停住——那正是它要治的病。
    const want = Array.from({ length: r.scriptTotal }, (_, i) => i + 1)
    assert(r.scriptTotal > 0, `deploy-seat.sh 里没有 STEPS：${r.scriptTotal}`)
    assert(
      JSON.stringify(r.scriptNums) === JSON.stringify(want),
      `步号要从 1 连到 ${r.scriptTotal}，实际是 ${JSON.stringify(r.scriptNums)}`,
    )
  })

  // ── 端口被占着时，敢不敢清 ────────────────────────────────────────
  // 现场：席位部署 exited 43，5910 上蹲着一个已经拆掉的席位的 x11vnc——单元停了，
  // 进程从 logind session 里逃了出来（PAMName=login + KillUserProcesses=no）。
  // 四种占口的东西处置完全不同，判错的代价不对称，所以逐种钉住。

  await test('已经不在名册里的席位占着口 → 清掉它，这次部署不该失败', async () => {
    assert(r.orphan.action === 'retire-seat', `${JSON.stringify(r.orphan)}`)
    assert(r.orphan.seatId === 'sw-gone-7bbe', `清错了对象：${r.orphan.seatId}`)
  })

  await test('名册里还挂着、但 Gateway 把槽位给了别人 → 以 Gateway 为准，清掉并标出来', async () => {
    // 结构上不可能是「两个活席位撞了槽位」：seat_runtimes 上有 unique(machineId, slot)。
    // 只可能是本机名册旧了。报错在这儿是个死局——心跳不带席位清单，Gateway 不知道
    // 这个席位存在，界面上没有任何按钮能动它，而这台机器没有 SSH。
    assert(r.staleRoster.action === 'retire-seat', `${JSON.stringify(r.staleRoster)}`)
    assert(r.staleRoster.stale === true, '得标出「名册旧了」，日志里那句话要说得更响')
  })

  await test('清掉的席位要销号，不能留在名册里', async () => {
    // 留着的话，下次撞上同一个口，会把一个已经被停掉的席位当成「活着的」——
    // 判断依据成了一份自己造出来的假象。
    assert(r.pruneChanged === true, 'pruneRetired 没说自己改过名册，调用方于是不落盘')
    assert(!r.pruneLeft.includes('sw-old-0009'), `被停掉的席位还留在名册里：${r.pruneLeft}`)
    assert(r.pruneLeft.includes('sw-me-0001'), `把不该动的席位一起删了：${r.pruneLeft}`)
  })

  await test('清掉的是名册里本来就没有的孤儿 → 不白写一次盘', async () => {
    // 孤儿正是这条路最常见的入口，照着 retired.length 落盘等于每次回收都多写一遍。
    assert(r.pruneNoop === false, '名册没变还说改过了')
  })

  await test('活席位换槽位之前那一代的进程 → 只杀这一个，别按席位杀', async () => {
    // 按席位杀会把它现在正在服务的那一套一起带走。
    assert(r.staleGeneration.action === 'kill-pid', `${JSON.stringify(r.staleGeneration)}`)
  })

  await test('显示号和端口走同一套判断——Xvfb 一个 TCP 口都不占', async () => {
    // 上一个席位只剩 Xvfb 活着时，三个端口全是空的，只有 /tmp/.X10-lock 挡着路；
    // 不查这一格，部署会「成功」而桌面永远黑着。
    assert(r.displayOrphan.action === 'retire-seat', `${JSON.stringify(r.displayOrphan)}`)
    assert(r.displayStaleGeneration.action === 'kill-pid', `${JSON.stringify(r.displayStaleGeneration)}`)
  })

  await test('显示号只认 X 服务器自己的命令行，不认别的进程（DISPLAY 环境变量谁都能写）', async () => {
    assert(JSON.stringify(r.xDisplays) === JSON.stringify([15, 10, null, null, null]), `${JSON.stringify(r.xDisplays)}`)
  })

  await test('不是 satuwork 的进程 → 不动，把话说准', async () => {
    assert(r.foreign.action === 'blocked', `${JSON.stringify(r.foreign)}`)
    assert(r.foreign.reason.includes('不是任何一个 satuwork 席位'), `${r.foreign.reason}`)
  })

  await test('自己上一轮的残留不在这一层清——交给 slim-desktop.sh', async () => {
    // 在部署最前面清掉自己的桌面，后面 apt 一失败，本来还在服务的那一套白死一回。
    assert(r.ownStale.action === 'ours', `${JSON.stringify(r.ownStale)}`)
  })

  // ── 占口的是哪个席位：只认改不了的东西 ────────────────────────────────
  // 以前按进程自报的 XDG_RUNTIME_DIR 认：别的账号带一条伪造的环境蹲在某个席位下一个槽位的
  // 口上，回收就会把那个活着的席位当孤儿停掉。现在是 cgroup / logind 会话加 uid。

  await test('单元 cgroup 里的进程：认得出，而且环境里怎么自报都不算数', async () => {
    assert(r.ownBot === 'sw-a' && r.ownDesktopUnit === 'sw-a', `${r.ownBot} / ${r.ownDesktopUnit}`)
    assert(r.botForgesOther === 'sw-a', `bot 单元里的进程自报成 sw-b 就被认成了 ${r.botForgesOther}`)
  })

  await test('桌面进程在 login 会话的 scope 里：按候选认、核 uid（新老两种运行时目录都认）', async () => {
    assert(r.desktopInScope === 'sw-a', `${r.desktopInScope}`)
    assert(r.desktopLegacyDir === 'sw-a', `老部署的 /tmp/xdg-runtime-* 没认出来：${r.desktopLegacyDir}`)
  })

  await test('伪造的环境一律不认：别的账号、ssh 会话、不在任何会话里', async () => {
    assert(r.otherUserForges === null, `别的账号冒充成功：${r.otherUserForges}`)
    assert(r.sshForges === null, `ssh 会话里冒充成功：${r.sshForges}`)
    assert(r.noScopeForges === null, `不在会话里冒充成功：${r.noScopeForges}`)
    assert(r.unitWrongUid === null && r.unknownSeat === null, `${r.unitWrongUid} / ${r.unknownSeat}`)
  })
  await test('占口的进程查到一半就退了 → 继续等，不判成「被外面的 VNC 占着」', async () => {
    /**
     * 现场：自动跟版重铺一个席位，部署 exited 43——「端口 5910 被 ? 的进程占着，它不是任何
     * 一个 satuwork 席位」。那个进程正是这个席位自己上一代的 x11vnc：ss 抓到它的时候还在，
     * 到去读 /proc 和 ps 的时候已经退了，主人读成空，于是走进了「外面的 VNC」那一支。
     *
     * 直接跑 deploy-seat.sh 里的那个函数（照原样抠出来），外面的命令换成桩：前两轮 ss 报一个
     * 已经不存在的 pid，第三轮报这个席位自己的进程。修好之前第一轮就 exit 43。
     */
    const { readFileSync, mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { spawnSync } = await import('node:child_process')
    const script = readFileSync(join(root, 'manager/src/seat/deploy-seat.sh'), 'utf8')
    const fn = /^verify_seat_listener\(\) \{\n[\s\S]*?^\}\n/m.exec(script)?.[0]
    assert(fn, '在 deploy-seat.sh 里没找到 verify_seat_listener')
    const dir = mkdtempSync(join(tmpdir(), 'satu-port-race-'))
    try {
      const harness = `set -Eeuo pipefail
SEAT_ID=sw-me-0001
LINUX_USER=sw-me
COUNT=${JSON.stringify(join(dir, 'n'))}
echo 0 > "$COUNT"
# 命令替换跑在子 shell 里，计数只能落盘。
ss() {
  local n; n=$(( $(cat "$COUNT") + 1 )); echo "$n" > "$COUNT"
  if [ "$n" -le 2 ]; then pid=999999999; else pid=777; fi
  echo "LISTEN 0 5 127.0.0.1:5910 0.0.0.0:* users:((\"x11vnc\",pid=$pid,fd=5))"
}
seat_of_pid() { if [ "$1" = 777 ]; then printf '%s' "$SEAT_ID"; fi; }
ps() { :; }
sleep() { :; }
${fn}
verify_seat_listener 5910 x11vnc
echo "ok scans=$(cat "$COUNT")"
`
      const out = spawnSync('bash', ['-c', harness], { encoding: 'utf8' })
      assert(out.status === 0, `该等到自己的进程起来，实际退出 ${out.status}：${out.stderr.trim().slice(-300)}`)
      assert(/ok scans=3/.test(out.stdout), `该扫到第三轮认出自己：${out.stdout} ${out.stderr}`)
      assert(!out.stderr.includes('不是任何一个 satuwork 席位'), `还是报成了外面的 VNC：${out.stderr}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
