/**
 * 对话里的引用（docs/chat-references.md）。探针在 bot/e2e-references.mjs。
 *
 * 守的几条线：
 *
 *   1. **落盘是结构，进模型是话。** JSONL 里是 `ref` 块，模型收到的是
 *      `[引用你 … 的回复] 全文 [引用结束]` / `[引用文件：…]`。
 *   2. **被压缩掉的旧回复照样拿得到全文。** 引用比「上面那条」强就强在这里。
 *   3. **边界各就各位。** 太长截断并指路、不在的文件写明、越界路径拒掉、对不上的 seq 拒掉。
 *   4. **排队、插话两条岔路都带着引用**，漏一条，刷新之后那张卡就没了。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-references.mjs', { env: { GATEWAY_URL: '', GATEWAY_API_KEY: '', SATUWORK_BOT_ID: '' } })

const allTrue = (obj, skip = []) =>
  Object.entries(obj || {})
    .filter(([k]) => !skip.includes(k))
    .filter(([, v]) => v !== true)
    .map(([k]) => k)

export async function runReferences({ root, test, assert, log }) {
  log('\n# references')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.message && r.plain && r.compacted && r.long && r.file && r.validate && r.image && r.paths, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('引用一条回复：校验重算摘录，进模型是全文，落盘是 ref 块', () => {
    assert(!r.message.校验抛了, `校验抛了：${r.message.校验抛了}`)
    const bad = allTrue(r.message, ['版本号', '当前版本'])
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
    assert(r.message.版本号 === r.message.当前版本, `会话版本号该是 v${r.message.当前版本}，实为 v${r.message.版本号}`)
    assert(r.message.当前版本 === 6, `加了 ref 块就该升到 v6，实为 v${r.message.当前版本}`)
  })

  await test('不带引用的那一轮，系统提示词里没有那一段', () => {
    const bad = allTrue(r.plain)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('被压缩掉的旧回复：引用照样拿到全文', () => {
    const bad = allTrue(r.compacted)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('太长的回复截到上限，并告诉模型去 history_read', () => {
    const bad = allTrue(r.long)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('引用文件：只给路径、越界拒掉、不在的写明', () => {
    const bad = allTrue(r.file)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('消息引用的校验：对不上的 seq 拒掉，没 seq 的只认摘录', () => {
    const bad = allTrue(r.validate)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('引用一张图：模型既看到图，也看到那行路径', () => {
    const bad = allTrue(r.image)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('插话与排队都带着引用', () => {
    const bad = allTrue(r.paths)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })
}
