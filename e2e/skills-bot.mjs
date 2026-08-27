/**
 * 席位那一侧的 Skill 工具集（docs/skills.md）。探针在 bot/e2e-skills.mjs。
 *
 * 分两半：
 *
 *  - **分档**。索引装得下就全列、装不下就退到 `skills_list`。判错了不会报错——模型
 *    只会说「没有这方面的方法」，而所有别的信号都是绿的。
 *  - **话术**。找不到、搜不到、改不动公司目录，这三种回答都必须带一条可执行的下一步。
 *    写成一句干巴巴的失败，模型就会转头告诉用户做不到：空结果在它眼里等于「不存在」。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-skills.mjs')

export async function runSkillsBot({ root, test, assert, log }) {
  log('\n# skills-bot')
  let r
  await test('探针跑得起来', async () => {
    r = await runProbe(root)
    assert(r && r.tier0, '探针没给出结果')
  })
  if (!r) return

  await test('常驻的进正文，按需的只进索引', () => {
    assert(JSON.stringify(r.tier0.resident) === JSON.stringify(['回复口径']), `常驻那摞不对：${JSON.stringify(r.tier0.resident)}`)
    assert(r.tier0.onDemand.length === 2, `按需那摞不对：${JSON.stringify(r.tier0.onDemand)}`)
    assert(r.tier0.index.includes('- 退款审核：'), `索引里要有名字和说明：${r.tier0.index}`)
    // 索引里**不许有正文**——那样等于什么都没省。
    assert(!r.tier0.index.includes('的正文'), `索引不该带正文：${r.tier0.index}`)
    // 名字照抄这句不能省：模型很爱把「退款审核（2）」缩成「退款审核」，而那是另一条。
    assert(r.tier0.index.includes('名字照抄'), `索引抬头要交代名字照抄：${r.tier0.index}`)
    assert(r.tier0.listTool === false, '装得下就不该把 skills_list 放进工具表')
  })

  await test('中文索引装不下时退到 skills_list', () => {
    /**
     * **这一条盯的是估长口径。** 120 条中文说明照 `chars / 3` 估会低估到三分之一，
     * 于是「装得下」，第 1 档永远不会发生——而线上的表现只是提示词悄悄变长。
     */
    assert(r.tier1.listTool === true, `120 条中文索引该装不下：${r.tier1.index.length} 字`)
    assert(r.tier1.index.includes('120'), `摘要要说清一共多少条：${r.tier1.index}`)
    assert(!r.tier1.index.includes('- 第3号流程'), '这一档不该再嵌清单')
    assert(r.allResident.index === '' && r.allResident.listTool === false, '一条按需的都没有就不该有索引')
  })

  await test('哪几把进工具表：一条 Skill 都没有时只留 skill_manage', () => {
    const j = (x) => JSON.stringify(x)
    /**
     * `skill_view` 在没有任何 Skill 时唯一可能的结果是「这台席位上一条都没有」——摆着
     * 就是教模型走一条走不到的路。而 `skill_manage` 必须还在：不然这台席位永远迈不出
     * 第一步，记下第一条之后 skill_view 下一轮自己就回来了。
     */
    assert(j(r.tools.empty) === j(['skill_manage']), `一条都没有时该只剩 skill_manage：${j(r.tools.empty)}`)
    assert(j(r.tools.residentOnly) === j(['skill_manage', 'skill_view']), `有常驻的就该给 skill_view：${j(r.tools.residentOnly)}`)
    // 索引装得下就不摆「列出 Skill」那把——它已经在提示词里了，再摆是邀请模型空跑一轮。
    assert(j(r.tools.fits) === j(['skill_manage', 'skill_view']), `装得下时不该有 skills_list：${j(r.tools.fits)}`)
    assert(j(r.tools.tooMany) === j(['skill_manage', 'skill_view', 'skills_list']), `装不下才该有 skills_list：${j(r.tools.tooMany)}`)
    // 模版上关掉「让它自己记 Skill」，读的那两把不受影响。
    assert(j(r.tools.selfSkillsOff) === j(['skill_view']), `关掉之后不该还有 skill_manage：${j(r.tools.selfSkillsOff)}`)
    // off 是退路：三把都不进表，也就是这套东西上线之前的样子。
    assert(j(r.tools.toolsOff) === j([]), `off 那一档该一把都没有：${j(r.tools.toolsOff)}`)
  })

  await test('三把工具的标注：risk 与委派待遇', () => {
    assert(JSON.stringify(r.registered) === JSON.stringify(['skill_view', 'skills_list', 'skill_manage']), `注册的不对：${JSON.stringify(r.registered)}`)
    assert(JSON.stringify(r.risk.view) === JSON.stringify(['read']), `skill_view 该只读：${JSON.stringify(r.risk.view)}`)
    /**
     * **`skill_manage` 不许带 external 位**：带了的话，`no-external` 那道闸一开，
     * Bot 连自己的记忆都写不进去（docs/skills.md §9）。
     */
    assert(JSON.stringify(r.risk.manage) === JSON.stringify(['write']), `skill_manage 只该是 write：${JSON.stringify(r.risk.manage)}`)
    // 子代理读得到 Skill、写不了：一次委派开五个子代理，每个都记一条就是五条私有档。
    assert(r.delegation.manage.mode === 'root-only', `skill_manage 该是 root-only：${JSON.stringify(r.delegation.manage)}`)
    assert(!r.delegation.view.mode, `skill_view 该照常给子代理：${JSON.stringify(r.delegation.view)}`)
  })

  await test('skill_view 展开正文；重名那条按带序号的名字取', () => {
    assert(r.view.startsWith('Skill: 退款审核'), `开头要带名字（摘要模型照抄它）：${r.view}`)
    assert(r.view.includes('500 以内直接退'), `正文没出来：${r.view}`)
    assert(r.viewDup.includes('周报模版（2）') && r.viewDup.includes('重名'), `重名要说清楚：${r.viewDup}`)
  })

  await test('名字对不上不许只回一句失败；同名两条不许猜', () => {
    assert(r.viewMissing.includes('退款审核'), `要给出最像的那几条：${r.viewMissing}`)
    assert(r.viewMissing.includes('一字不差'), `要说清下一步怎么做：${r.viewMissing}`)
    /**
     * 两条同名讲的是不同的做法（否则管理员不会建第二条）。猜中一半的代价是它照着错的
     * 那套把活干完，而没有任何东西会提醒任何人。
     */
    assert(r.viewAmbiguous.includes('分不出'), `两条名字一模一样时要明说分不出：${r.viewAmbiguous}`)
    assert(!r.viewAmbiguous.includes('的正文'), `分不出时不该径直展开某一条：${r.viewAmbiguous}`)
  })

  await test('包文件按需拉、拉过就缓存；包里没有的要报有什么', () => {
    assert(r.viewFiles.includes('references/口径.md'), `要列出它带了哪些文件：${r.viewFiles}`)
    assert(r.viewOneFile.includes('差额在 1 元以内不追'), `文件正文没出来：${r.viewOneFile}`)
    // 绝对路径要给出来：包里的脚本是用 terminal 跑的，而工作区的根在别处。
    assert(r.viewOneFile.includes('/skills/id-zip/'), `要给本机绝对路径：${r.viewOneFile}`)
    assert(r.fileHits === 1, `第二次读同一个文件该走缓存，实际打了 ${r.fileHits} 次 Gateway`)
    assert(r.viewNoSuchFile.includes('它有的是'), `包里没有的要报清单：${r.viewNoSuchFile}`)
  })

  await test('skills_list 搜不到不许回空', () => {
    assert(r.list.includes('退款审核'), `搜得到的要列出来：${r.list}`)
    assert(!r.list.includes('的正文'), `列表不该带正文：${r.list}`)
    assert(/有 \d+ 条 Skill/.test(r.listEmpty), `搜不到要说清一共有多少条：${r.listEmpty}`)
    assert(r.listEmpty.includes('不带 query'), `要给一条可执行的下一步：${r.listEmpty}`)
  })

  await test('写成功要说「下一轮才看得见」，并落一张卡', () => {
    /**
     * 这一句不是客套：这一轮的提示词在开头就定死了，新建的 Skill 不在索引里。不说的话
     * 模型会当场 `skills_list` 一次、找不到，然后告诉用户「好像没保存上」——一次成功
     * 的写入被它自己描述成失败。
     */
    assert(r.create.includes('下一轮'), `要交代索引什么时候跟上：${r.create}`)
    assert(r.create.includes('1 条'), `要报当前条数：${r.create}`)
    assert(r.card.length === 1 && r.card[0].type === 'skill/saved', `要落一张卡：${JSON.stringify(r.card)}`)
    // PII 是席位扫的，结果随写入发上去（Gateway 只存不判，判据不许抄第二份）。
    assert(Array.isArray(r.createSent.pii), `写入要带 PII 扫描结果：${JSON.stringify(r.createSent)}`)
  })

  await test('换版之后：上一版写下的缓存行不许把提示词和工具搞崩', () => {
    /**
     * 上一版的行没有 displayName / description / mode 这几个键，而首次目录同步之前
     * 提示词和三把工具就已经在读它们了。
     */
    assert(!r.legacyRow.split.hasUndefined, `小标题里出现了 undefined：${JSON.stringify(r.legacyRow.split)}`)
    // mode 缺省要落「常驻」：那些行本来就是全文进提示词的，换个默认值就是悄悄改行为。
    assert(r.legacyRow.split.resident.includes('老口径'), `缺 mode 该落常驻：${JSON.stringify(r.legacyRow.split)}`)
    assert(r.legacyRow.list.includes('老口径'), `skills_list 不该在老行上抛：${r.legacyRow.list}`)
    assert(r.legacyRow.view.includes('一律用中文回复'), `skill_view 读不到老行：${r.legacyRow.view}`)
  })

  await test('早发车的那份目录不许剪掉刚写下的那条', () => {
    /**
     * 轮询每分钟一次、`pull()` 又有单飞去重：模型在那次请求**发出之后**写下一条 Skill，
     * 那份不含它的响应落地时不能把它当成「已经被删掉的」剪掉——否则工具刚说完「下一轮
     * 就在索引里」，下一轮却没有，模型会转头告诉用户没保存上。
     */
    assert(r.race.includes('id-fresh'), `刚写下的那条被早发车的目录剪掉了：${JSON.stringify(r.race)}`)
    /**
     * 反过来也要成立：**发车晚于**那次写入的目录里没有它，就是真的没了（管理员删的、
     * 或者晋升搬走了），那一条必须剪掉——否则模型照着索引去读一份已经不存在的东西。
     */
    assert(!r.raceAfter.includes('id-stale'), `晚发车的目录里没有的，就该剪掉：${JSON.stringify(r.raceAfter)}`)
  })

  await test('撞名照 Gateway 的原话说；公司目录里的改不动删不掉', () => {
    assert(r.clash.includes('用 update'), `撞名要指路：${r.clash}`)
    assert(r.updateCompany.includes('管理员'), `改公司目录要指路给管理员：${r.updateCompany}`)
    assert(r.removeCompany.includes('管理员'), `删公司目录同理：${r.removeCompany}`)
    // 拒绝要在**打 Gateway 之前**就发生：删掉的只该有自己那条。
    assert(JSON.stringify(r.deleted) === JSON.stringify(['/runtime/skills/id-mine']), `不该去删别的：${JSON.stringify(r.deleted)}`)
    assert(r.removeMine.includes('已删掉'), `删自己那条要成功：${r.removeMine}`)
  })
}
