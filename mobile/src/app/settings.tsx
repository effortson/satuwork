import { useRouter } from 'expo-router'
import { useRef } from 'react'
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useSession } from '@/store'
import { C, S } from '@/ui'

export default function Settings() {
  const { gatewayUrl, setGatewayUrl, locale, setLocale, token, me, logout, t } = useSession()
  // 非受控，理由见 login.tsx。
  const url = useRef(gatewayUrl)
  const router = useRouter()

  async function save() {
    const clean = url.current.trim().replace(/\/$/, '')
    if (!/^https?:\/\//i.test(clean)) return Alert.alert(t('地址要以 http:// 或 https:// 开头', 'Address must start with http:// or https://'))
    await setGatewayUrl(clean)
    router.back()
  }

  return (
    <SafeAreaView style={st.safe} edges={['bottom']}>
      <View style={st.wrap}>
        <Text style={st.label}>{t('Gateway 地址', 'Gateway address')}</Text>
        <TextInput style={st.input} placeholder="https://gateway.example.com" autoCapitalize="none" autoCorrect={false} keyboardType="url" defaultValue={gatewayUrl} onChangeText={(v) => (url.current = v)} />
        <Pressable style={st.btn} onPress={save}>
          <Text style={st.btnText}>{t('保存', 'Save')}</Text>
        </Pressable>

        <Text style={[st.label, { marginTop: S.xl }]}>{t('语言', 'Language')}</Text>
        <View style={st.seg}>
          {(['zh', 'en'] as const).map((l) => (
            <Pressable key={l} style={[st.segItem, locale === l && st.segOn]} onPress={() => void setLocale(l)}>
              <Text style={[st.segText, locale === l && st.segTextOn]}>{l === 'zh' ? '中文' : 'English'}</Text>
            </Pressable>
          ))}
        </View>

        {token ? (
          <>
            <Text style={[st.label, { marginTop: S.xl }]}>{t('账号', 'Account')}</Text>
            <Text style={st.value}>{me ? `${me.account.name || me.account.email}${me.company ? ' · ' + me.company.name : ''}` : '…'}</Text>
            <Pressable style={[st.btn, st.btnDanger]} onPress={() => void logout()}>
              <Text style={st.btnText}>{t('退出登录', 'Sign out')}</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </SafeAreaView>
  )
}

const st = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  wrap: { padding: S.lg, gap: S.sm },
  label: { fontSize: 13, color: C.muted },
  value: { fontSize: 16, color: C.text },
  input: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingHorizontal: S.md, paddingVertical: 12, fontSize: 16, color: C.text },
  btn: { backgroundColor: C.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: S.sm },
  btnDanger: { backgroundColor: C.danger },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  seg: { flexDirection: 'row', backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 10, overflow: 'hidden' },
  segItem: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  segOn: { backgroundColor: C.accent },
  segText: { color: C.text, fontSize: 15 },
  segTextOn: { color: '#fff', fontWeight: '600' },
})
