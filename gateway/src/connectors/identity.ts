/**
 * 「这一把连接连的是谁」：从供应商给的一坨 JSON 里认出邮箱、登录名之类，只用于显示。
 *
 * 不进鉴权、不进工具名——认错了的代价是界面上写错一个名字，所以这里宁可少认，不硬猜：
 * 只认几个明确表示身份的键，认不出就回空串。
 *
 * 和供应商无关，放在这里给 composio.ts（连接记录）和 lib/connectors.ts（「我是谁」工具
 * 的返回）共用。
 */
import type { ToolDef } from './types.ts'

/** 按优先级排：邮箱最能说明「是哪个账号」，其次是登录名，最后才是显示名。 */
const NAME_KEYS = [
  'emailAddress',
  'email',
  'user_email',
  'mail',
  'userPrincipalName',
  'login',
  'username',
  'user_name',
  'handle',
  'displayName',
  'display_name',
  'real_name',
  'name',
  'user',
]

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function clean(v: unknown): string {
  if (typeof v !== 'string') return ''
  const s = v.trim()
  // 一行、不太长，才像一个名字。多行的多半是正文或报错。
  return s && s.length <= 120 && !/[\r\n]/.test(s) ? s : ''
}

/**
 * 在一坨 JSON 里找最像「这是谁」的字段。**按键的优先级找，每个键在整棵树里广度优先**：
 * Notion 的 about-me 顶层是 `name`，邮箱藏在 `person.email` 里——按层找会先拿到名字。
 * 深度封顶 4 层，数组只看前几项：工具返回的列表（最近的邮件）里也有 `email`，那不是本人。
 */
export function accountNameIn(data: unknown, maxDepth = 4): string {
  const levels: Record<string, unknown>[][] = []
  let cur: Record<string, unknown>[] = []
  const root = asObj(data)
  if (root) cur.push(root)
  for (let d = 0; d <= maxDepth && cur.length; d++) {
    levels.push(cur)
    const next: Record<string, unknown>[] = []
    for (const o of cur) {
      for (const v of Object.values(o)) {
        const child = asObj(v)
        if (child) next.push(child)
      }
    }
    cur = next
  }
  for (const key of NAME_KEYS) {
    for (const level of levels) {
      for (const o of level) {
        const hit = clean(o[key])
        if (hit) return hit
      }
    }
  }
  return ''
}

/** JWT 的 payload。**不验签**——只拿来显示，不拿来认人。 */
function jwtClaims(tok: string): Record<string, unknown> | null {
  const parts = tok.split('.')
  if (parts.length !== 3) return null
  try {
    return asObj(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}

/**
 * 连接记录本身能说明的账号。
 *
 * - OAuth 带了 openid 的（Google 系）会存一份 `id_token`，里面有 `email`
 * - 按实例/店铺鉴权的（Shopify、Zendesk……）存的是域名，那就是「哪一个」
 *
 * **只看这几个白名单键**：这几层里还有 access_token、refresh_token，泛泛地扫一遍
 * 迟早会把一串令牌当成名字显示出来。
 */
export function accountNameOfConnection(body: Record<string, unknown>): string {
  const state = asObj(body.state)
  const sources = [asObj(state?.val), asObj(body.data), asObj(body.params)].filter(Boolean) as Record<string, unknown>[]
  for (const src of sources) {
    const tok = clean(src.id_token)
    const claims = tok ? jwtClaims(tok) : null
    const fromJwt = claims ? clean(claims.email) || clean(claims.preferred_username) || clean(claims.name) : ''
    if (fromJwt) return fromJwt
  }
  for (const key of ['email', 'displayName', 'username', 'shop', 'site_name', 'instanceName', 'subdomain', 'domain']) {
    for (const src of sources) {
      const hit = clean(src[key])
      if (hit) return hit
    }
  }
  return ''
}

/**
 * 工具清单里那把「我是谁」：Gmail 的 GET_PROFILE、Drive 的 GET_ABOUT、GitHub 的
 * GET_THE_AUTHENTICATED_USER、Slack 的 AUTH_TEST……按名字认，而不是逐个供应商写死一张表——
 * 上架的 toolkit 是 owner 随时加的，写死的表永远差一个。
 *
 * **按把握从高到低排**：名字里明说「当前用户」的最可靠，GET_ACCOUNT 这类可能是账单账户，
 * 排最后。只挑**不需要参数**的：要参数的那几个（GET_USER_INFO(user_id)）问的是别人。
 */
const WHOAMI_RANKED = [
  /_(GET_)?(THE_)?(AUTHENTICATED|CURRENT|LOGGED_IN)_USER(_INFO|_PROFILE|_DETAILS)?$/,
  /_(GET_)?(ABOUT_ME|ME|WHO_?AM_?I|MY_PROFILE|MY_INFO|OWN_USER|USERINFO)$/,
  /_(AUTH_TEST|TEST_AUTH)$/,
  /_GET_(USER_)?PROFILE(_INFO)?$/,
  /_GET_ABOUT$/,
  /_(GET|RETRIEVE)_USER_(INFO|PROFILE_INFORMATION)$/,
  /_GET_(CURRENT_)?ACCOUNT(_INFO|_DETAILS)?$/,
]

/** 候选，把握大的在前。最多给两个：每试一个就是一次真的上游调用。 */
export function whoamiTools(tools: ToolDef[]): ToolDef[] {
  const ranked: { tool: ToolDef; rank: number }[] = []
  for (const tool of tools) {
    const rank = WHOAMI_RANKED.findIndex((re) => re.test(tool.slug))
    if (rank < 0) continue
    const req = (tool.inputSchema as { required?: unknown }).required
    if (Array.isArray(req) && req.length) continue
    ranked.push({ tool, rank })
  }
  ranked.sort((a, b) => a.rank - b.rank || a.tool.slug.length - b.tool.slug.length)
  return ranked.slice(0, 2).map((x) => x.tool)
}

/**
 * 有些「我是谁」不给字段就不回身份：Drive 的 GET_ABOUT 不带 `fields` 回的是一堆主题和
 * 格式，`user` 不在里面。这种工具再试一次，`fields` 给 `*`（Google 系都认）。
 */
export function wantsFields(tool: ToolDef): boolean {
  const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties
  return Boolean(props && typeof props === 'object' && 'fields' in props)
}
