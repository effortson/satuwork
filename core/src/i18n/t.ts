/**
 * 界面文案的查表。原先在 gateway/ui/prefs.js 里直接读全局 localeMode 和 window.SATU_I18N；
 * 这里把语言当第一个入参，字典用本包的那份。Web 的 prefs.js 包一层把 localeMode 传进来。
 */
import { dict } from './dict.ts'
import type { Locale } from '../format.ts'

/**
 * 两种用法：
 *   t(locale, '保存')              查译表
 *   t(locale, '保存', 'Save')      就地给译文，优先于译表
 * 查不到就原样返回中文——露出一句没翻的，好过显示空白。
 */
export function t(locale: Locale, zh: string, en?: string | null): string {
  if (locale !== 'en') return zh
  if (en != null) return en
  if (dict[zh] != null) return dict[zh]
  // 文案两边的空格是排版用的，不该进译表的键——剥掉再查，查到了再贴回去。
  const trimmed = String(zh).trim()
  const hit = dict[trimmed]
  if (hit == null) return zh
  const lead = zh.slice(0, zh.indexOf(trimmed[0]))
  const tail = zh.slice(zh.indexOf(trimmed[0]) + trimmed.length)
  return `${lead}${hit}${tail}`
}

/**
 * 服务端错误。它只发中文，英文界面下按整句查表。
 * 带变量的（「口令至少 10 位」里的位数）先按模板归一化再查。
 */
export function errText<T>(locale: Locale, msg: T): T | string {
  if (locale !== 'en' || !msg || typeof msg !== 'string') return msg
  if (dict[msg]) return dict[msg]
  const pw = msg.match(/^口令至少 (\d+) 位$/)
  if (pw) return `Password must be at least ${pw[1]} characters`
  // 带数字的那几句进不了字典（键是变的），在这里按模式翻。
  const queued = msg.match(/^还有 (\d+) 条消息排着队，先取消它们再开新对话$/)
  if (queued) return `${queued[1]} message(s) are still queued — cancel them before starting a new conversation.`
  const queuedClear = msg.match(/^还有 (\d+) 条消息排着队，先取消它们再清空$/)
  if (queuedClear) return `${queuedClear[1]} message(s) are still queued — cancel them before clearing.`
  const handoffs = msg.match(/^还有 (\d+) 张转人工的单子没结，先处理掉、或等它交回来再(开新对话|清空)$/)
  if (handoffs) {
    const what = handoffs[2] === '清空' ? 'clearing' : 'starting a new conversation'
    return `${handoffs[1]} human handoff(s) are still open — resolve them or wait for them to come back before ${what}.`
  }
  const throttled = msg.match(/^尝试次数太多，请 (\d+) (秒|分钟)后再试$/)
  if (throttled) return `Too many attempts — try again in ${throttled[1]} ${throttled[2] === '秒' ? 'seconds' : 'minutes'}.`
  return msg
}
