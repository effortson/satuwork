/**
 * 对话内查找的语义（docs/chat-search.md）。探针在 bot/e2e-search.mjs（纯函数，要 tsx 才 import 得了 .ts）。
 *
 * 钉的是「命中要能跳到屏幕上那条气泡」这一件事背后的几条规矩：分块和锚点照界面的
 * fold 走、工具原文和注入不算、文件只认结构化字段、`/clear` 之前不搜、分页接得上。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-search.mjs')

const allTrue = (obj, skip = []) =>
  Object.entries(obj || {})
    .filter(([k]) => !skip.includes(k))
    .filter(([, v]) => v !== true)
    .map(([k]) => `${k}=${JSON.stringify(v)}`)

export async function runSearch({ root, test, assert, log }) {
  log('\n# search')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.blocks && r.text && r.files && r.query && r.reset && r.snippet, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('分块照界面的 fold：一轮一块、正文取最后一条、锚点是最后一条 assistant/message', () => {
    const bad = allTrue(r.blocks, ['块数'])
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
    // 4 个提问 + 4 个助手块；系统注入那条不成块。
    assert(r.blocks.块数 === 8, `块数该是 8，实为 ${r.blocks.块数}`)
  })

  await test('搜正文：用户和助手的话算，工具原文、推理、注入都不算，新的在前', () => {
    const bad = allTrue(r.text, ['命中数', '词', 'hasMore'])
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
    // 「报价」：第一轮问、第一轮答、第二轮问、第三轮答（第二轮答里没有，第三轮第一条被盖掉）。
    assert(r.text.命中数 === 4, `命中数该是 4，实为 ${r.text.命中数}`)
    assert(r.text.hasMore === false, '一页装得下还说有更多')
  })

  await test('搜文件：上传的附件和工具产出都按名字命中，锚点指向带着它的那条消息', () => {
    const bad = allTrue(r.files, ['fileTotal'])
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
    assert(r.files.fileTotal === 1, `「报价单」该只命中一个文件，实为 ${r.files.fileTotal}`)
  })

  await test('多词是「都要有」；空查询空结果；分页按 seq 接上、总数不变', () => {
    const bad = allTrue(r.query, ['第一页', '词数上限'])
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
    assert(r.query.第一页 === 2, `limit=2 该给 2 条，实为 ${r.query.第一页}`)
    assert(r.query.词数上限 === 8, `关键词最多 8 个，实为 ${r.query.词数上限}`)
  })

  await test('/clear 之前的搜不到（界面上也看不见）；/new 之后的照样搜得到', () => {
    const bad = allTrue(r.reset)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('摘录围着命中词截、两头省略号；上传那段固定格式认得回来', () => {
    const bad = allTrue(r.snippet)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })
}
