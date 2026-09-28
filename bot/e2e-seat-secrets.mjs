/**
 * 席位凭据从 fd 0 读（src/seat-secrets.ts）。探针要 tsx。
 *
 * 外层起几个子进程，把一份凭据文件接到它们的 fd 0 上——和 systemd 的 `StandardInput=file:`
 * 一个形状——子进程里调 loadSeatSecrets，再从「bot 起的子进程」的角度看还拿不拿得到票。
 *
 * 钉的是几件错了都不当场报错的事：
 * 1. 读完没把 fd 0 关掉：子进程照样能从 /proc/<bot>/fd/0 或继承来的 fd 0 读出整份凭据。
 * 2. fd 0 上什么都收：它不是通用的 env 通道，NODE_OPTIONS 之类混进来就是代码注入。
 * 3. 没开关也去读 fd 0：本地桌面 bot 的 fd 0 是别的东西。
 * 4. 开关开着却没读到票还照常起来：界面上只会是一串莫名其妙的 401。
 */
import { spawn, spawnSync } from 'node:child_process'
import { fstatSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const self = fileURLToPath(import.meta.url)

if (process.argv[2] === '--child') {
  // ── 子进程：假装自己是刚被 systemd 拉起来的 bot ──
  const { loadSeatSecrets, isSeatMode } = await import('./src/seat-secrets.ts')
  const { childEnv } = await import('./src/workspace/index.ts')
  let keys
  try {
    keys = loadSeatSecrets()
  } catch (e) {
    console.log('__RESULT__' + JSON.stringify({ threw: String(e.message || e) }))
    process.exit(0)
  }
  const st = fstatSync(0)
  const out = {
    keys,
    seatMode: isSeatMode(),
    token: process.env.GATEWAY_TOKEN || '',
    apiKey: process.env.GATEWAY_API_KEY || '',
    evil: process.env.EVIL ?? null,
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    markerLeft: process.env.SATUWORK_SECRETS_STDIN ?? null,
    fd0Char: st.isCharacterDevice(),
    fd0File: st.isFile(),
  }
  // 「bot 起的子进程」：按 terminal 的方式给 env，fd 0 继承下去（最坏情况），看它能拿到什么。
  const grand = spawnSync(
    process.execPath,
    [
      '-e',
      `const fs = require('fs')
       let stdin = ''
       try { stdin = fs.readFileSync(0, 'utf8') } catch (e) { stdin = 'ERR' }
       let environ = null
       try { environ = fs.readFileSync('/proc/' + process.ppid + '/environ', 'utf8') } catch {}
       let fd0 = null
       try { fd0 = fs.readFileSync('/proc/' + process.ppid + '/fd/0', 'utf8') } catch (e) { fd0 = 'ERR' }
       process.stdout.write(JSON.stringify({ env: process.env.GATEWAY_TOKEN || '', stdin, environ, fd0 }))`,
    ],
    { env: childEnv(), stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8' },
  )
  const g = JSON.parse(grand.stdout || '{}')
  out.grand = {
    envToken: g.env,
    stdinHasToken: String(g.stdin || '').includes('sat_'),
    // /proc 只有 Linux 有；macOS 上是 null，断言那头按 null 放过。
    environHasToken: g.environ === null ? null : g.environ.includes('sat_'),
    fd0HasToken: g.fd0 === null ? null : String(g.fd0).includes('sat_'),
  }
  console.log('__RESULT__' + JSON.stringify(out))
  process.exit(0)
}

// ── 外层 ──
const dir = mkdtempSync(join(tmpdir(), 'satu-secrets-'))
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
})

/** 起一个子进程，fd 0 接到 `body` 那份文件上（`body === null` 时接一条管道）。 */
function child(body, env) {
  return new Promise((resolve, reject) => {
    let stdin = 'pipe'
    let fd = -1
    if (body !== null) {
      const file = join(dir, `s-${Math.random().toString(36).slice(2)}.env`)
      writeFileSync(file, body, { mode: 0o600 })
      fd = openSync(file, 'r')
      stdin = fd
    }
    const base = { ...process.env }
    delete base.GATEWAY_TOKEN
    delete base.GATEWAY_API_KEY
    delete base.SATUWORK_SECRETS_STDIN
    const p = spawn(process.execPath, ['--import', 'tsx', self, '--child'], {
      env: { ...base, ...env },
      stdio: [stdin, 'pipe', 'pipe'],
    })
    if (fd >= 0) closeSync(fd)
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    if (body === null) p.stdin.end('GATEWAY_TOKEN=sat_from_pipe_should_not_be_read\n')
    p.on('error', reject)
    p.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('__RESULT__'))
      if (code !== 0 || !line) return reject(new Error(`子进程退出 ${code}\n${err || out}`))
      resolve(JSON.parse(line.slice('__RESULT__'.length)))
    })
  })
}

const SECRETS = [
  '# 注释行跳过',
  'GATEWAY_TOKEN=sat_seat-token-secret',
  'GATEWAY_API_KEY=sk_sw_key-secret',
  'EVIL=1',
  'NODE_OPTIONS=--require /tmp/x.js',
  '',
].join('\n')

const out = {}
out.normal = await child(SECRETS, { SATUWORK_SECRETS_STDIN: '1' })
out.off = await child(null, {})
out.empty = await child('', { SATUWORK_SECRETS_STDIN: '1' })
out.noToken = await child('GATEWAY_API_KEY=sk_only\n', { SATUWORK_SECRETS_STDIN: '1' })

// deploy-seat.sh 的形状：静态看几处关键写法（真跑要 root + Debian，见 PR 描述）。
const script = readFileSync(join(self, '..', '..', 'manager', 'src', 'seat', 'deploy-seat.sh'), 'utf8')
const syntax = spawnSync('bash', ['-n', join(self, '..', '..', 'manager', 'src', 'seat', 'deploy-seat.sh')])
const heredoc = /write_root_file "\$BOT_ENV_FILE" << EOF_ENV\n([\s\S]*?)\nEOF_ENV/.exec(script)?.[1] ?? ''
out.deploy = {
  syntax: syntax.status === 0,
  botEnvFound: heredoc.includes('GATEWAY_URL=$GATEWAY_URL'),
  botEnvHasSecret: /GATEWAY_TOKEN|GATEWAY_API_KEY/.test(heredoc),
  secretsToRoot: /printf 'GATEWAY_TOKEN=%s\\nGATEWAY_API_KEY=%s\\n' "\$GATEWAY_TOKEN" "\$GATEWAY_API_KEY" \| write_root_file "\$SECRETS_FILE"/.test(script),
  seatEtc: /^SEAT_ETC="\/etc\/satuwork\/seats\/\$SEAT_ID"$/m.test(script),
  dropInEnvFile: /^EnvironmentFile=\$BOT_ENV_FILE$/m.test(script),
  dropInOldEnvFile: /^EnvironmentFile=-?\$SEAT_DIR/m.test(script),
  dropInStdin: /^StandardInput=file:\$SECRETS_FILE$/m.test(script) && /^Environment=SATUWORK_SECRETS_STDIN=1$/m.test(script),
  umask: /\(umask 077; cat > "\$tmp"\)/.test(script),
  ptrace: /kernel\.yama\.ptrace_scope/.test(script) && /\/etc\/sysctl\.d\/60-satuwork-ptrace\.conf/.test(script),
  migrate: /rm -f "\$SEAT_DIR\/bot\.env" "\$SEAT_DIR\/bot\.env\.tmp"/.test(script),
}
const launcher = readFileSync(join(self, '..', '..', 'manager', 'src', 'seat', 'satuwork-bot.sh'), 'utf8')
out.launcher = { sigusr1: launcher.includes('--disable-sigusr1') }

console.log('__RESULT__' + JSON.stringify(out))
