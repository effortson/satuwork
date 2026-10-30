/**
 * 子代理委派（docs/delegation.md）。探针在 bot/e2e-delegate.mjs（要 tsx 才 import 得了 .ts）。
 *
 * 为什么值得单开一个套件：这套东西**坏了大半都不报错**。子会话混进侧栏、档位降级没生效、
 * 子代理留下的后台进程成了孤儿、重启后那张卡永远转着——每一种的表现都是「看起来还行」。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-delegate.mjs', { timeout: 60_000 })

/**
 * 把一组「断言名 → 真假」逐条报出来。名字就是断言，红的时候不用回头翻代码。
 *
 * `assert` 要从外面传进来：`test(name, fn)` 调 `fn()` 时不带参数，写成 `(assert) => …`
 * 的话每一条都会以 `assert is not a function` 收场——十四条断言全红，而红的原因和被测
 * 的东西一点关系都没有。
 *
 * 回的是**一串还没跑的函数**，不是一串已经在跑的 promise。直接 `.map(test(…))` 的话
 * 这一组会一次全部起跑，眼下断言体是同步的，微任务恰好按插入顺序排，看着还是顺的；
 * 哪天有人往断言体里加一个 await，行号就开始乱窜，而套件本身一声不响。
 */
const each = (test, assert, group, obj) =>
  Object.entries(obj).map(([k, v]) => () => test(`${group}：${k}`, () => assert(v === true, `${k} 不成立`)))

export async function runDelegate({ root, test, assert, log }) {
  log('\n# delegate')
  /**
   * **探针要包在 test() 里跑**（和 mentions / turn-images / replay-slice 那几套一样）。
   *
   * 探针是另起的进程，它崩掉时 runProbe 会抛。抛在 test() 外面的话，`suite()` 会把它
   * 原样往上扔——**整场跑批就此停住**，排在后面的套件（toolcalls、guards、handoff、
   * routine-retry、browser、mounted、shutdown）一条都跑不到，而 CI 上只看得见一句
   * 「探针退出 1」。这条闸把「探针没跑完」变成一条普通的失败：这一套后面全红，别的
   * 套件照跑。
   *
   * 探针崩过一次就是这么被发现的：它在 `byIndex[0].model` 上解引用，而 byIndex 是空的
   * ——一次行为失败被放大成了「后面八个套件的结果全部看不见」。
   */
  let r = null
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.assert && r.batch && r.model, `结果不完整：${JSON.stringify(r)}`)
  })
  /**
   * 探针没跑完就到此为止。
   *
   * 不能往下走：下面那两行 `each(test, assert, …, r.model)` 是在 test() **外面**读
   * `r.model` 的，`r` 是 null 时当场抛——而抛在 test() 外面就等于把整场跑批带走
   * （正是这次要治的那件事）。往下走也没意义：一条结果都没有，后面十几条全是同一句
   * 「r 是 null」，把真正的那一行（探针为什么退出 1）淹掉。
   */
  if (!r) return

  await test('新增内置工具漏标 delegation：启动就抛，而且点名是哪一把', () => {
    // 这一条是「将来新增工具不会静默走错边」的全部保障（docs/delegation.md §6.1）。
    assert(r.assert.漏标会抛, '没标 delegation 的工具居然注册成功了')
    assert(r.assert.错误里点名了, '抛了，但错误里没说是哪一把工具')
  })

  await test('一批三条：都跑完，结果按 index 回而不是按谁先跑完', () => {
    assert(r.batch.三条都跑了 && r.batch.都收口了, '有子任务没跑完或没收口')
    // 探针里第 3 条最快跑完。按完成顺序排的话，模型说「第一件事」就永远指错。
    assert(r.batch.按index排, '结果按完成顺序回了，不是按 index')
    assert(r.batch.每条都有子会话, '有子任务没开出自己的子会话')
    assert(r.batch.跑之前先报running, '没有先写一条 running——界面上那张卡就永远等不到')
  })

  for (const t of each(test, assert, '档位', r.model)) await t()
  for (const t of each(test, assert, '隔离', r.isolation)) await t()

  await test('子代理留下的东西移交给主代理，而且在结论里点名', () => {
    assert(r.retains.移交跑了, 'retains 的工具没被调到 reassign——子代理留下的会成孤儿')
    // 不点名的话主代理不知道自己接手了什么，而它下一步很可能就要拿那个 id 去调 process。
    assert(r.retains.结论里点名了, '移交了，但结论里没说移交了什么')
  })

  await test('model_role 写错：整次委派不发生，不是当默认值处理', () => {
    assert(r.badRole.说清楚了, '拒绝了，但没说清楚该写什么')
    // 当默认值处理的话，界面、日志、账单上全都显示按 daily 跑，而模型以为自己省了钱。
    assert(r.badRole.整次没发生, '档位写错了，子任务却照样跑了起来')
  })

  await test('已经按了停止：不开子会话，不花一分钱', () => {
    // 已经 aborted 的信号不会再发事件，所以「先挂监听器」接不住它——接不住就是子代理
    // 照跑满 30 步，而屏幕上那颗停止按钮看起来毫无动静。
    assert(r.aborted.当场收口, '信号已经 aborted 了，子任务还是跑了起来')
    assert(r.aborted.没开子会话, '什么都没发生，却开出了一条子会话（界面上会多一张卡）')
    assert(r.aborted.没花钱, '被停止的子任务仍然跑了步数')
  })

  await test('tools 里写了认不出的名字：整次委派不发生，而且点名是哪个', () => {
    // 不校验的话工具表会被过滤成空的，子代理拿着空表只能干说——而没有任何一处会提到
    // 问题出在工具名上。最容易撞的正是刚改掉的那批旧名字。
    assert(r.badTools.点名了是哪个, '拒绝了，但没说是哪个名字认不出')
    assert(r.badTools.整次没发生, '名字认不出，子任务却照样跑了起来')
  })

  // 跑着的时候人得看得见它做到哪了（docs/delegation.md §13）；没做成要说得出为什么。
  for (const t of each(test, assert, '进度', r.progress || {})) await t()
  for (const t of each(test, assert, '失败原因', r.failure || {})) await t()

  await test('重启后没有永远转着的卡：running 补成 lost', () => {
    assert(r.heal.补成了lost, '上个进程留下的委派还停在 running')
    // lost 是诚实的：那件事做没做成，进程死的时候没人知道。写成 failed 是在编。
    assert(r.heal.不是failed, 'lost 被写成了 failed')
  })
}
