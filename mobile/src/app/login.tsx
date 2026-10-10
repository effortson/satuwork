import { Link } from 'expo-router'
import { useRef, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useSession } from '@/store'
import { C, S } from '@/ui'

export default function Login() {
  const { login, gatewayUrl, t } = useSession()
  /**
   * 两个输入框是**非受控**的：受控（value + setState）在 JS 线程稍慢时会把原生文本回写覆盖，
   * 密码管理器一次灌进来、或打字快一点就丢字。这里只在提交时读。
   */
  /**
   * 开发期预填：`EXPO_PUBLIC_DEV_EMAIL` / `EXPO_PUBLIC_DEV_PASSWORD` 给了就填进去，只在开发包里
   * 生效（`__DEV__`），正式包里这两行是死代码。用途是对着本机临时 Gateway 的测试账号反复进出，
   * 不用每次在模拟器里敲——模拟器的文字注入和焦点切换不同步，敲十次丢三次。
   */
  const devEmail = (__DEV__ && process.env.EXPO_PUBLIC_DEV_EMAIL) || ''
  const devPassword = (__DEV__ && process.env.EXPO_PUBLIC_DEV_PASSWORD) || ''
  const email = useRef(devEmail)
  const password = useRef(devPassword)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    if (!gatewayUrl) return setError(t('先在设置里填 Gateway 地址', 'Set the Gateway address in Settings first'))
    const e = email.current.trim()
    if (!e || !password.current) return
    setBusy(true)
    setError('')
    try {
      await login(e, password.current)
    } catch (err: any) {
      setError(err.message || String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SafeAreaView style={st.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={st.wrap}>
        <Text style={st.title}>Satuwork</Text>
        <Text style={st.sub}>{gatewayUrl || t('还没有填 Gateway 地址', 'No Gateway address yet')}</Text>
        <TextInput style={st.input} placeholder={t('邮箱', 'Email')} autoCapitalize="none" keyboardType="email-address" autoComplete="email" textContentType="username" defaultValue={devEmail} onChangeText={(v) => (email.current = v)} />
        <TextInput style={st.input} placeholder={t('口令', 'Password')} secureTextEntry autoComplete="password" textContentType="password" defaultValue={devPassword} onChangeText={(v) => (password.current = v)} onSubmitEditing={submit} />
        {error ? <Text style={st.error}>{error}</Text> : null}
        <Pressable style={[st.btn, busy && st.btnOff]} onPress={submit} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={st.btnText}>{t('登录', 'Sign in')}</Text>}
        </Pressable>
        <Link href="/settings" style={st.link}>
          {t('设置 Gateway 地址与语言', 'Gateway address & language')}
        </Link>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const st = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  wrap: { flex: 1, justifyContent: 'center', padding: S.xl, gap: S.md },
  title: { fontSize: 28, fontWeight: '700', color: C.text, textAlign: 'center' },
  sub: { fontSize: 13, color: C.muted, textAlign: 'center', marginBottom: S.md },
  input: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingHorizontal: S.md, paddingVertical: 12, fontSize: 16, color: C.text },
  btn: { backgroundColor: C.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: S.sm },
  btnOff: { opacity: 0.6 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { color: C.danger, fontSize: 14 },
  link: { color: C.accent, textAlign: 'center', marginTop: S.lg, fontSize: 14 },
})
