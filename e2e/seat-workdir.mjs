/**
 * 席位在 ~/work 底下那一格（manager/src/seat/seat-workdir.sh）。
 *
 * deploy-seat.sh 要 root、要 systemd，e2e 里跑不起来；所以碰员工文件的那一段单独成了一个
 * 脚本，这里在临时目录里直接用 bash 跑它。钉的是：
 * - 建出共享区、这一格、通向共享区的相对链接，和写着 Bot 名字的名牌；
 * - **~/work 根下的老文件一个都不动**——以前部署时把它们挪进 shared/，挪走了还在跑的老席位
 *   脚下的文件；
 * - 重跑是幂等的，名牌跟着 Bot 改名更新；
 * - 人在 shared 那个名字上建了目录就不替换；名字里的换行剔掉；seatId 不像样就拒。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'manager', 'src', 'seat', 'seat-workdir.sh')

const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8' })

export async function runSeatWorkdir({ test, assert, log }) {
  log('\n# seat-workdir')
  const base = mkdtempSync(join(tmpdir(), 'satu-seat-workdir-'))
  const work = join(base, 'work')
  try {
    mkdirSync(join(work, '报表'), { recursive: true })
    writeFileSync(join(work, '报表/二季度.html'), 'v1\n')
    writeFileSync(join(work, 'note.txt'), 'x\n')
    mkdirSync(join(work, '.satuwork/out'), { recursive: true })

    await test('首次：建出共享区、这一格、相对链接和名牌，老文件原地不动', () => {
      const r = run(work, 'sw-abc-123', 'bot-1', '财务助手')
      assert(r.status === 0, `退出码 ${r.status}：${r.stderr}`)
      const cell = join(work, 'bots/sw-abc-123')
      assert(existsSync(join(work, 'shared')), '没有共享区')
      assert(lstatSync(join(cell, 'shared')).isSymbolicLink(), 'shared 不是链接')
      assert(readlinkSync(join(cell, 'shared')) === '../../shared', `链接指向 ${readlinkSync(join(cell, 'shared'))}`)
      assert(realpathSync(join(cell, 'shared')) === realpathSync(join(work, 'shared')), '链接没指到共享区')
      assert(readFileSync(join(cell, '.bot-name'), 'utf8') === '财务助手\nbotId: bot-1\n', `名牌 ${JSON.stringify(readFileSync(join(cell, '.bot-name'), 'utf8'))}`)
      assert(readFileSync(join(work, '报表/二季度.html'), 'utf8') === 'v1\n', '老文件被动了')
      assert(existsSync(join(work, 'note.txt')) && existsSync(join(work, '.satuwork/out')), '根下的老东西被挪走了')
      assert(!existsSync(join(work, 'shared/报表')) && !existsSync(join(work, 'shared/note.txt')), '老文件被收进了共享区')
    })

    await test('重跑幂等：链接还是那条，名牌跟着改名更新，格子里的文件不动', () => {
      const cell = join(work, 'bots/sw-abc-123')
      writeFileSync(join(cell, 'mine.txt'), '自己的\n')
      const r = run(work, 'sw-abc-123', 'bot-1', '财务')
      assert(r.status === 0, `退出码 ${r.status}：${r.stderr}`)
      assert(lstatSync(join(cell, 'shared')).isSymbolicLink(), '重跑之后 shared 不是链接了')
      assert(readFileSync(join(cell, '.bot-name'), 'utf8') === '财务\nbotId: bot-1\n', '名牌没跟着改名')
      assert(readFileSync(join(cell, 'mine.txt'), 'utf8') === '自己的\n', '格子里的文件被动了')
      assert(!existsSync(join(cell, '.bot-name.tmp')), '留下了临时文件')
    })

    await test('人在 shared 那个名字上建了目录：不替换，照样成功', () => {
      const cell = join(work, 'bots/sw-abc-456')
      mkdirSync(join(cell, 'shared'), { recursive: true })
      writeFileSync(join(cell, 'shared/人放的.txt'), 'x\n')
      const r = run(work, 'sw-abc-456', 'bot-2', 'B')
      assert(r.status === 0, `退出码 ${r.status}：${r.stderr}`)
      assert(!lstatSync(join(cell, 'shared')).isSymbolicLink(), '人建的目录被换成了链接')
      assert(existsSync(join(cell, 'shared/人放的.txt')), '人放的文件没了')
      assert(/不是链接/.test(r.stderr), `没说一声：${r.stderr}`)
    })

    await test('名字里的换行和控制字符剔掉；没有名字只写 botId', () => {
      const r1 = run(work, 'sw-abc-789', 'bot-3', '坏\n名字\t')
      assert(r1.status === 0, `退出码 ${r1.status}：${r1.stderr}`)
      assert(readFileSync(join(work, 'bots/sw-abc-789/.bot-name'), 'utf8') === '坏名字\nbotId: bot-3\n', '控制字符没剔掉')
      const r2 = run(work, 'sw-abc-000', 'bot-4')
      assert(r2.status === 0, `退出码 ${r2.status}：${r2.stderr}`)
      assert(readFileSync(join(work, 'bots/sw-abc-000/.bot-name'), 'utf8') === 'botId: bot-4\n', '没名字时名牌不对')
    })

    await test('seatId 不像样就拒，什么都不建', () => {
      const r = run(work, '../evil', 'bot-5', 'x')
      assert(r.status !== 0, '坏 seatId 没被拒')
      assert(!existsSync(join(work, 'evil')) && !existsSync(join(base, 'evil')), '坏 seatId 建出了目录')
    })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}
