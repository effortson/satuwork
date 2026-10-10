import { Redirect, Stack, usePathname } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { SessionProvider, useSession } from '@/store'

SplashScreen.preventAutoHideAsync()

/**
 * 登录门：没票就只能去登录屏和设置屏（设置屏要先填 Gateway 地址）。
 * 有票就不让停在登录屏。
 */
function Gate() {
  const { ready, token, t } = useSession()
  const path = usePathname()
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync()
  }, [ready])
  if (!ready) return null
  const open = path === '/login' || path === '/settings'
  if (!token && !open) return <Redirect href="/login" />
  if (token && path === '/login') return <Redirect href="/bots" />
  return (
    <Stack screenOptions={{ headerBackTitle: t('返回', 'Back') }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ title: t('登录', 'Sign in'), headerShown: false }} />
      <Stack.Screen name="bots" options={{ title: t('对话', 'Chat') }} />
      <Stack.Screen name="chat/[botId]" options={{ title: '' }} />
      <Stack.Screen name="settings" options={{ title: t('设置', 'Settings'), presentation: 'modal' }} />
    </Stack>
  )
}

export default function RootLayout() {
  return (
    <SessionProvider>
      <StatusBar style="auto" />
      <Gate />
    </SessionProvider>
  )
}
