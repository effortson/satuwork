/** 席位所在时区。部署时由管家写进环境，本机跑就是本机时区。 */
export function timeZone(): string {
  return (
    process.env.SATUWORK_TZ?.trim() ||
    process.env.TZ?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC'
  )
}

/** `2026年8月19日 星期三 11:30`。给模型看的，所以用中文长格式，别用 ISO。 */
export function humanTime(at: number, tz = timeZone()): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(at))
}
