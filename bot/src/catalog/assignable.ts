/** 主 Bot 的派活目录。分类与侧栏一致，只描述当前账号能派给的成员。 */
export interface RemoteAssignable {
  id: string
  name: string
  desc: string
  folderId?: string | null
}

export interface RemoteAssignableFolder {
  id: string
  name: string
}

export function assignableOf(raw: unknown): RemoteAssignable[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((x) => {
    if (!x || typeof x !== 'object') return []
    const o = x as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id : ''
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    if (!id || !name) return []
    return [{ id, name, desc: typeof o.desc === 'string' ? o.desc.trim() : '', folderId: typeof o.folderId === 'string' ? o.folderId : null }]
  })
}

export function assignableFoldersOf(raw: unknown): RemoteAssignableFolder[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((x) => {
    if (!x || typeof x !== 'object') return []
    const o = x as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id : ''
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    return id && name ? [{ id, name }] : []
  })
}

/** 提示词和工具说明共用同一份分组，成员能力留在对应 Bot 旁边，便于主 Bot 选人。 */
export function assignableRosterText(
  list: Array<Pick<RemoteAssignable, 'name' | 'desc' | 'folderId'> & { id?: string }>,
  folders: RemoteAssignableFolder[] = [],
): string {
  const member = (b: (typeof list)[number]) => `${b.name}${b.id ? ` [id: ${b.id}]` : ''}${b.desc ? `（${b.desc}）` : ''}`
  if (!folders.length) return list.map(member).join('、') || '（当前没有）'
  const lines = folders.map((f) => {
    const bots = list.filter((b) => b.folderId === f.id)
    return `- 分类「${f.name}」[id: ${f.id}]：${bots.length ? bots.map(member).join('、') : '当前没有可派的 Bot'}`
  })
  const known = new Set(folders.map((f) => f.id))
  const ungrouped = list.filter((b) => !b.folderId || !known.has(b.folderId))
  if (ungrouped.length) lines.push(`- 未分类：${ungrouped.map(member).join('、')}`)
  return lines.join('\n')
}
