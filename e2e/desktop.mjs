/**
 * 席位桌面那两把工具：开终端窗口、开文件管理器。探针在 bot/e2e-desktop.mjs。
 *
 * 真桌面只在席位机器上有，探针在 PATH 里垫了假的 xfce4-terminal / thunar，钉的是
 * 「拉起的参数对不对、命令是不是原样跑进窗口、凭据有没有漏进去、起不来时说不说实话」。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-desktop.mjs', { timeout: 60_000 })

const all = (obj) => Object.entries(obj).filter(([, v]) => v !== true).map(([k]) => k)

export async function runDesktop({ root, test, assert, log }) {
  log('\n# desktop')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.plain && r.command && r.folder, `结果不完整：${JSON.stringify(r)}`)
  })
  for (const [key, name] of [
    ['unregistered', '没有 DISPLAY 就不注册这两把工具'],
    ['noDisplay', '注册后桌面没了：不拉起任何东西，说清楚原因'],
    ['plain', '空终端：开在指定目录，不抢已有实例，凭据不进窗口'],
    ['command', '带命令：原样在窗口里跑，回显命令和退出码'],
    ['escape', '工作区外的目录拒绝，不拉起'],
    ['folder', '文件夹：目录照开，文件开所在目录，不存在的说清楚'],
    ['broken', '程序一启动就退出：报失败，不说已打开'],
    ['missing', '程序没装：说清楚是哪个没装'],
    ['shutdown', '收尾：跑过命令的窗口连命令一起收掉，空终端留给人'],
  ]) {
    await test(name, () => {
      const bad = all(r[key] || {})
      assert(r[key] && !bad.length, `这几条不对：${bad.join('、')}`)
    })
  }
}
