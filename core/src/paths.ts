/**
 * 从地址里取 id。原先在 gateway/ui/state.js 里；只认字符串，不读 state。
 *
 * 那些要看角色或当前 state 才能答的（isChatPath、chatBotIdOf、pathAllowed）留在 state.js。
 */

function segAfter(p: unknown, prefix: string): string {
  if (typeof p !== 'string' || !p.startsWith(prefix)) return ''
  return decodeURIComponent(p.slice(prefix.length).split('/')[0] || '')
}

export function connectorIdOfPath(p: unknown): string {
  return segAfter(p, '/connectors/')
}

export function botIdOfPath(p: unknown): string {
  return segAfter(p, '/bots/')
}

export function companyIdOfPath(p: unknown): string {
  return segAfter(p, '/companies/')
}

export function machineIdOfPath(p: unknown): string {
  return segAfter(p, '/machines/')
}

export function userIdOfPath(p: unknown): string {
  return segAfter(p, '/users/')
}

/** `/audit/:sessionId`；`/audit/summary/:id` 是另一页（auditItemIdOfPath），这里回空。 */
export function sessionIdOfPath(p: unknown): string {
  if (typeof p === 'string' && p.startsWith('/audit/summary/')) return ''
  return segAfter(p, '/audit/')
}

export function auditItemIdOfPath(p: unknown): string {
  return segAfter(p, '/audit/summary/')
}
