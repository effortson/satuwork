/**
 * 0044 · 渠道事件记下投递到第几段。
 *
 * 一轮的结果要发好几条：回复切出来的每一段、每张产出文件卡、每张转人工卡。以前没有进度，
 * 第三段上一个 429 或者网络抖一下，整条事件进 retry，下一次从第一段重发——最多重发八遍；
 * 发得慢把租约耗过期，被别人接管，也是全部再来一遍。有了这个数，接着没发的那段往下发。
 */
export const SQL = `
  alter table channel_events
    add column if not exists "deliveredParts" integer not null default 0;
`
