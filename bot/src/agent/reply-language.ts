import type { MessageSource, SessionEvent } from '../session/types.ts'

type ReplyLocale = 'zh' | 'en'

/** 本轮的界面设置优先；交接、日常任务等续轮沿用这条会话最近一次用户选择。 */
export function replyLocaleOf(source: MessageSource, history: SessionEvent[]): ReplyLocale | undefined {
  if (source.kind === 'user' && (source.locale === 'en' || source.locale === 'zh')) return source.locale
  for (let i = history.length - 1; i >= 0; i--) {
    const event = history[i]
    if (event.type !== 'user/message') continue
    const previous = event.data.source
    if (previous?.kind === 'user' && (previous.locale === 'en' || previous.locale === 'zh')) return previous.locale
  }
}

export function replyLanguageBlock(locale?: ReplyLocale): string {
  const preference = locale === 'en'
    ? 'The user has selected English as the interface language. Reply in English by default, even for a brief greeting such as "hello".'
    : locale === 'zh'
      ? 'The user has selected Simplified Chinese as the interface language. Reply in Simplified Chinese by default.'
      : 'No interface language preference was provided. By default, reply in the language of the user’s message.'
  return [
    '## Reply language',
    preference,
    'This preference takes precedence over language defaults in the bot persona, skills, tools, internal instructions, and earlier assistant replies. Their language does not determine the language of your response.',
    'If the user explicitly requests another language or a translation, follow that request. Keep code, identifiers, and quoted source text in their original language when appropriate.',
  ].join('\n')
}
