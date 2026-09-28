import { waitUntil } from '@vercel/functions'

/**
 * 回完包之后还要接着做完的事。**请求处理里不许再写裸的 `void someAsync()`。**
 *
 * Debian 上的常驻进程里那样写没问题：回完包进程还在，promise 照样跑完。Vercel 上不行——
 * 函数实例回完响应就可能被冻住，冻住之后那段 promise 再也没人跑，而且没有任何报错：
 * 转人工的通知就这么没发出去，席位的部署结局就这么没写回库。waitUntil 让实例撑到它结束
 * （上限是函数自己的 maxDuration）；不在 Vercel 上时它什么都不做，promise 照旧在进程里跑。
 *
 * 顺手把失败收住：没人接着这个 promise，抛出去只会变成一条 unhandled rejection，而那条
 * 日志里看不出是哪件事没做成。
 */
export function afterResponse(label: string, task: Promise<unknown>): void {
  waitUntil(
    task.catch((e) => {
      console.warn(`satuwork-gateway: ${label}没做成：${e instanceof Error ? e.message : String(e)}`)
    }),
  )
}
