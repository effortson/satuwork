/**
 * 历史重放切片的语义。探针在 bot/e2e-replay.mjs（纯函数，要 tsx 才 import 得了 .ts）。
 *
 * 这一层的错**不会报错**，只会让人少看见几条消息——正是最难发现的那种。所以每条
 * 语义都单独钉一遍，尤其是「什么时候不能丢 chunk」。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-replay.mjs')

export async function runReplaySlice({ root, test, assert, log }) {
  log('\n# replay-slice')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.dropChunks, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('作废的流式 chunk 丢掉，正文一条不少', async () => {
    // 实测一条 8 轮的对话 789 条事件，其中 706 条是 chunk。而客户端 fold 里最终消息是
    // **覆盖**赋值——那些 chunk 收下来只为了被下一行盖掉，纯粹是白推。
    assert(!r.dropChunks.还有chunk, '已经有最终正文的 chunk 还留着')
    assert(r.dropChunks.正文条数 === 3, `正文被丢了：${r.dropChunks.正文条数}/3`)
    assert(r.dropChunks.剩下 < r.dropChunks.原始 / 2, `没瘦下来：${r.dropChunks.原始} → ${r.dropChunks.剩下}`)
  })

  await test('正在跑的那一步：chunk 必须留着', async () => {
    // 它还没有最终消息来盖，丢了就等于把「正在打字」那段正文抹掉。
    assert(r.keepLive.留下的chunk === 1, `把在跑的 chunk 也丢了：${r.keepLive.留下的chunk}`)
  })

  await test('最终消息是空的：盖不住，chunk 还得留', async () => {
    // 模型出错那一轮的最终消息可能没有正文。按「有这条就丢 chunk」来做，正文就没了。
    assert(r.emptyFinal.留下的chunk === 1, `空正文也当成盖住了：${r.emptyFinal.留下的chunk}`)
  })

  await test('只取最近 N 轮，提问跟着它那一轮走', async () => {
    assert(r.tail.轮数 === 3, `该 3 轮，实际 ${r.tail.轮数}`)
    // 提问写在 turn/start 之前。不捎上它，这一页开头就是个没有问题的回答。
    assert(r.tail.第一条 === 'user/message', `这一页开头是 ${r.tail.第一条}，问题被切掉了`)
    assert(r.tail.还有更早的 === true, '前面明明还有 7 轮，却说没有了')
    assert(typeof r.tail.firstSeq === 'number', '没给游标，往前翻就无从翻起')
  })

  await test('往前翻：接着上一页的游标，不重叠也不跳空', async () => {
    assert(r.paging.第二页轮数 === 3, `第二页该 3 轮，实际 ${r.paging.第二页轮数}`)
    assert(r.paging.不重叠, '两页有重叠，翻上去会看到重复的消息')
    assert(r.paging.还有更早的 === true, '第二页之后还有 4 轮')
  })

  await test('SSE：重放期间断开或 cancel，监听器照样摘掉', async () => {
    // close 以前挂在重放之后：慢重放期间断开，close 早已发过，每次重连留一个死监听器。
    const bad = Object.entries(r.sseClose || {}).filter(([, v]) => v !== true).map(([k]) => k)
    assert(r.sseClose && !bad.length, `这几条不对：${bad.join('、') || '没有结果'}（${JSON.stringify(r.sseClose)}）`)
  })

  await test('/clear：清除点之前的不给界面、翻不回去，/new 不受影响', async () => {
    const bad = Object.entries(r.clear || {}).filter(([, v]) => v !== true).map(([k]) => k)
    assert(r.clear && !bad.length, `这几条不对：${bad.join('、') || '没有结果'}（${JSON.stringify(r.clear)}）`)
  })

  await test('翻到头了就说没有了，别让「加载更多」一直挂着', async () => {
    assert(r.exhausted.hasMore === false, 'hasMore 该收敛成 false')
    assert(r.exhausted.轮数 === 2, `要的比有的多时该全给：${r.exhausted.轮数}`)
  })
}
