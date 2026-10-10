/**
 * 把 gateway.ts 的 Session 接到 React 上：谁登录了、Gateway 在哪、语言是什么。
 * 屏幕只读这里，不自己碰 SecureStore。
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { t as coreT, type Locale } from '@satuwork/core'
import { session } from './gateway'

export interface Me {
  account: { id: string; email: string; name?: string; role?: string }
  company: { id: string; name: string } | null
}

interface SessionState {
  /** SecureStore 读完了没有。没读完之前什么都别画，免得先闪一下登录屏。 */
  ready: boolean
  token: string | null
  gatewayUrl: string
  locale: Locale
  me: Me | null
  meError: string
}

interface SessionApi extends SessionState {
  t: (zh: string, en?: string) => string
  login(email: string, password: string): Promise<void>
  logout(): Promise<void>
  setGatewayUrl(url: string): Promise<void>
  setLocale(l: Locale): Promise<void>
  reloadMe(): Promise<void>
}

const Ctx = createContext<SessionApi | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ ready: false, token: null, gatewayUrl: '', locale: 'zh', me: null, meError: '' })

  useEffect(() => {
    const sync = () => setState((s) => ({ ...s, token: session.token, gatewayUrl: session.gatewayUrl, locale: session.locale }))
    const off = session.subscribe(sync)
    void session.load().then(() => setState((s) => ({ ...s, ready: true, token: session.token, gatewayUrl: session.gatewayUrl, locale: session.locale })))
    return off
  }, [])

  // 票变了就重新问一次「我是谁」：登录、退出、401 都走这一条。
  useEffect(() => {
    if (!state.ready) return
    if (!state.token) {
      setState((s) => ({ ...s, me: null, meError: '' }))
      return
    }
    let gone = false
    session.client
      .api('GET', '/me')
      .then((me: Me) => !gone && setState((s) => ({ ...s, me, meError: '' })))
      .catch((err: Error) => !gone && setState((s) => ({ ...s, me: null, meError: err.message })))
    return () => {
      gone = true
    }
  }, [state.ready, state.token, state.gatewayUrl])

  const api = useMemo<SessionApi>(
    () => ({
      ...state,
      t: (zh, en) => coreT(state.locale, zh, en),
      async login(email, password) {
        const r = await session.client.api('POST', '/auth/login', { email, password })
        await session.setToken(String(r.token))
      },
      async logout() {
        await session.setToken(null)
      },
      setGatewayUrl: (url) => session.setGatewayUrl(url),
      setLocale: (l) => session.setLocale(l),
      async reloadMe() {
        const me: Me = await session.client.api('GET', '/me')
        setState((s) => ({ ...s, me, meError: '' }))
      },
    }),
    [state],
  )

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

export function useSession(): SessionApi {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSession 要在 SessionProvider 里用')
  return v
}

/** 直接拿 core 的客户端发请求。屏幕里的一次性请求用它，长期状态走 store。 */
export const api = (method: string, path: string, body?: unknown) => session.client.api(method, path, body)
