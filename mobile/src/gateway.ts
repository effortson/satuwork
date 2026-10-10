/**
 * 把 @satuwork/core 的 Gateway 客户端装配成手机上的那一套：
 * - fetch 用 expo/fetch（支持流式 body，SSE 要它）；
 * - 票、Gateway 地址、语言落在 SecureStore / 内存里；
 * - 401 之后清票，由 store 把人送回登录屏。
 *
 * core 里 TokenStore.get() 是同步的，而 SecureStore 是异步的：启动时先读一次进内存
 * （见 store.tsx 的 bootstrap），之后读内存、写穿到 SecureStore。
 */
import { fetch as expoFetch } from 'expo/fetch'
import * as SecureStore from 'expo-secure-store'
import { createGatewayClient, type GatewayClient, type Locale } from '@satuwork/core'

const TOKEN_KEY = 'satuwork.token'
const GATEWAY_KEY = 'satuwork.gateway'
const LOCALE_KEY = 'satuwork.locale'

type Listener = () => void

/** 这台手机上的登录态与偏好。一个进程一份，store.tsx 把它接到 React 上。 */
export class Session {
  token: string | null = null
  gatewayUrl = ''
  locale: Locale = 'zh'
  readonly client: GatewayClient
  private listeners = new Set<Listener>()

  constructor() {
    this.client = createGatewayClient({
      fetch: (url, init) => expoFetch(url, init as any) as unknown as Promise<Response>,
      baseUrl: () => this.gatewayUrl,
      tokens: {
        get: () => this.token,
        set: (t) => void this.setToken(t),
        clear: () => void this.setToken(null),
      },
      locale: () => this.locale,
      onUnauthorized: () => void this.setToken(null),
    })
  }

  /** 启动时从 SecureStore 把三样东西读进内存。 */
  async load(): Promise<void> {
    const [token, gatewayUrl, locale] = await Promise.all([
      SecureStore.getItemAsync(TOKEN_KEY),
      SecureStore.getItemAsync(GATEWAY_KEY),
      SecureStore.getItemAsync(LOCALE_KEY),
    ])
    this.token = token || null
    this.gatewayUrl = (gatewayUrl || '').replace(/\/$/, '')
    this.locale = locale === 'en' ? 'en' : 'zh'
    this.emit()
  }

  async setToken(t: string | null): Promise<void> {
    if (this.token === t) return
    this.token = t
    this.emit()
    if (t) await SecureStore.setItemAsync(TOKEN_KEY, t)
    else await SecureStore.deleteItemAsync(TOKEN_KEY)
  }

  async setGatewayUrl(url: string): Promise<void> {
    const clean = String(url || '').trim().replace(/\/$/, '')
    this.gatewayUrl = clean
    this.emit()
    await SecureStore.setItemAsync(GATEWAY_KEY, clean)
  }

  async setLocale(l: Locale): Promise<void> {
    this.locale = l
    this.emit()
    await SecureStore.setItemAsync(LOCALE_KEY, l)
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }
}

export const session = new Session()
