/**
 * 日常模型备选的「事后收口」（docs/model-choice.md §1）。
 *
 * 备选在写入那一刻过一次上架规矩（routes/platform.ts 的 alternatesOr400），但目录之后还会
 * 自己变：自定义供应商改了模型清单、被删掉，自动发现把某个模型按下去或者上游不再收录。
 * 那时备选名单里就躺着一个已经调不通的模型——席位照样把它列进对话框，人挑了它，之后
 * 每一轮都报错，而席位那道「下架退回默认」认的是名单，名单里它明明还在。
 *
 * 所以每个会改目录的地方改完都来这儿过一遍：还上得了架的留着，上不了的拿掉。
 */
import { type Db, modelKey } from '../db.ts'
import type { Llm } from '../llm.ts'

export async function pruneDailyAlternates(db: Db, llm: Llm): Promise<string[]> {
  const s = await db.platformSettings()
  const list = s.dailyAlternates ?? []
  if (!list.length) return []
  // 注册表得是新的：改供应商、刷新发现都是刚落库的，进程内那份还没重建。
  await llm.syncCustomProviders()
  await llm.syncDiscovered()
  const kept: typeof list = []
  const dropped: string[] = []
  for (const r of list) {
    const verdict = await llm.companyModelAllowed(r.provider, r.model, s.enabledModels ?? [])
    if (verdict.ok) kept.push(r)
    else dropped.push(modelKey(r))
  }
  if (dropped.length) await db.putPlatformSettings({ ...s, dailyAlternates: kept })
  return dropped
}
