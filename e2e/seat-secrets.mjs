/**
 * 远程席位的凭据不进环境、不进席位用户读得到的文件。探针在 bot/e2e-seat-secrets.mjs。
 *
 * bot 和它起的子进程（terminal 的 bash、Chrome）是同一个 Linux 用户：子进程读
 * `/proc/$PPID/environ` 就能看到 bot 启动时的环境，读 `$SEAT_DIR/bot.env` 就能看到那个
 * 文件——原先两处都有 `sat_`，拿到它就能自己把审批点掉。现在凭据由 systemd 从 root 的
 * 文件接到 fd 0 上，bot 读完即关。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-seat-secrets.mjs')

export async function runSeatSecrets({ root, test, assert, log }) {
  log('\n# seat-secrets')
  const r = await runProbe(root)
  const n = r.normal

  await test('开关开着：从 fd 0 读到两把凭据，别的行一概不收', () => {
    assert(n.token === 'sat_seat-token-secret', `票没读到：${n.token}`)
    assert(n.apiKey === 'sk_sw_key-secret', `API Key 没读到：${n.apiKey}`)
    // fd 0 不是通用 env 通道：NODE_OPTIONS 混进来就是代码注入。
    assert(n.evil === null && n.nodeOptions === null, `收了不该收的：EVIL=${n.evil} NODE_OPTIONS=${n.nodeOptions}`)
    assert(n.seatMode === true, '没记成远程席位——gateway-url 会往错的地方落盘')
    assert(n.markerLeft === null, '开关变量没摘掉，会一路递给子进程')
  })

  await test('读完 fd 0 换成 /dev/null，子进程从哪儿都拿不到票', () => {
    assert(n.fd0Char && !n.fd0File, 'fd 0 还是那份凭据文件')
    assert(n.grand.envToken === '', '子进程的 env 里有票')
    assert(!n.grand.stdinHasToken, '子进程从继承来的 fd 0 读到了票')
    // 下面两条只在 Linux 上有意义（macOS 没有 /proc，探针给 null）。
    assert(n.grand.environHasToken !== true, '子进程从 /proc/$PPID/environ 读到了票')
    assert(n.grand.fd0HasToken !== true, '子进程从 /proc/$PPID/fd/0 读到了票')
  })

  await test('没开关（本地桌面 bot、开发）：fd 0 一个字节都不碰', () => {
    assert(r.off.keys.length === 0 && r.off.token === '', '没开关也去读了')
    assert(r.off.seatMode === false, '没开关却当成了远程席位')
    assert(r.off.grand.stdinHasToken, 'fd 0 被吃掉了——本地 bot 的标准输入是别人的')
  })

  await test('开关开着却没读到票：当场退出，不带病起来', () => {
    assert(/GATEWAY_TOKEN/.test(r.empty.threw || ''), `空文件没报错：${JSON.stringify(r.empty)}`)
    assert(/GATEWAY_TOKEN/.test(r.noToken.threw || ''), `缺票没报错：${JSON.stringify(r.noToken)}`)
  })

  await test('deploy-seat.sh：凭据和 bot.env 都落在 root 的目录里，单元从那儿读', () => {
    const d = r.deploy
    assert(d.syntax, 'deploy-seat.sh 语法错')
    assert(d.botEnvFound, '没找到写 bot.env 的那段 heredoc')
    assert(!d.botEnvHasSecret, 'bot.env 里还有 GATEWAY_TOKEN / GATEWAY_API_KEY')
    assert(d.secretsToRoot && d.seatEtc, '凭据没写进 /etc/satuwork/seats/<席位>/secrets.env')
    assert(d.umask, '写 root 文件时没有 umask 077，出生那一瞬是 0644')
    // systemd 以 root 读这两个文件：留在席位用户可写的目录里就能被换成符号链接。
    assert(d.dropInEnvFile && !d.dropInOldEnvFile, 'EnvironmentFile 还指着 $SEAT_DIR')
    assert(d.dropInStdin, '单元没用 StandardInput=file: 把凭据接到 fd 0，或没开 SATUWORK_SECRETS_STDIN')
    assert(d.ptrace, '没设 kernel.yama.ptrace_scope——子进程还能读 bot 的内存')
    assert(d.migrate, '老席位 $SEAT_DIR/bot.env 里的凭据没删')
    assert(r.launcher.sigusr1, '启动器没带 --disable-sigusr1——kill -USR1 就能开 inspector')
  })

  await test('bot 程序归 root：子进程改不动代码、也塞不进编译缓存', () => {
    const d = r.deploy
    const l = r.launcher
    // 代码要是席位用户写得动，改一个 .ts 再 kill 一下 bot，重启跑的就是改过的代码，
    // 照样从 fd 0 读到凭据——上面那几条全白做。
    assert(d.appRoot, 'deploy-seat.sh 没把 app 放进 /opt/satuwork/seats/<席位>/app')
    assert(d.appRootOwned, 'app 没改成 root 所有、go-w')
    assert(d.appInSeatDir.length === 0, `deploy-seat.sh 还在往 $SEAT_DIR/app 写：${d.appInSeatDir.join(' | ')}`)
    assert(d.appMigrate, '老席位的 $SEAT_DIR/app 没清')
    assert(l.appRoot && !l.appInSeatDir, '启动器还从 $SEAT_DIR/app 起 bot')
    assert(l.ownerCheck, '启动器没核对 app 归 root')
    assert(l.tsxNoCache, '启动器没关 tsx 的编译缓存（$TMPDIR/tsx-<uid> 归席位用户）')
  })
}
