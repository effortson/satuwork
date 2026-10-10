import { Link, Stack, useFocusEffect, useRouter } from 'expo-router'
import { useCallback, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { api, useSession } from '@/store'
import { C, S } from '@/ui'
import type { RuntimeBot } from '@/chat/useChat'

/**
 * Bot 名单。`GET /runtime/bots` 一次拿全：每行带 runtime（在不在、直连地址）。
 * 名单流（实时的在跑/等人）留到下一步。
 */
export default function Bots() {
  const { t, me } = useSession()
  const router = useRouter()
  const [bots, setBots] = useState<RuntimeBot[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const r = await api('GET', '/runtime/bots')
      setBots(Array.isArray(r?.bots) ? r.bots : [])
      setError('')
    } catch (err: any) {
      setError(err.message || String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  return (
    <View style={st.wrap}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/settings" style={st.headerLink}>
              {t('设置', 'Settings')}
            </Link>
          ),
        }}
      />
      {error ? <Text style={st.error}>{error}</Text> : null}
      <FlatList
        data={bots}
        keyExtractor={(b) => b.id}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={load} />}
        ListEmptyComponent={!busy ? <Text style={st.empty}>{me ? t('还没有 Bot', 'No bots yet') : '…'}</Text> : null}
        renderItem={({ item }) => {
          const local = item.runtimeKind === 'local' || item.runtime?.kind === 'local'
          const direct = Boolean(item.runtime?.streamUrl)
          const status = item.runtime?.status || ''
          return (
            <Pressable style={[st.row, local && st.rowOff]} disabled={local} onPress={() => router.push({ pathname: '/chat/[botId]', params: { botId: item.id } })}>
              <View style={st.avatar}>
                <Text style={st.avatarText}>{(item.name || '?').slice(0, 1)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={st.name}>{item.name}</Text>
                <Text style={st.sub} numberOfLines={1}>
                  {local
                    ? t('本地 Bot，只能在桌面端用', 'Local bot, desktop only')
                    : !item.runtime
                      ? t('还没部署', 'Not deployed')
                      : !direct
                        ? t('没有直连地址，手机上开不了对话流', 'No direct address; chat stream unavailable on mobile')
                        : status || item.description || ''}
                </Text>
              </View>
              {item.channel ? <Text style={st.tag}>{item.channel}</Text> : null}
            </Pressable>
          )
        }}
      />
    </View>
  )
}

const st = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg },
  headerLink: { color: C.accent, fontSize: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, backgroundColor: C.card, paddingHorizontal: S.lg, paddingVertical: S.md, borderBottomWidth: 1, borderBottomColor: C.line },
  rowOff: { opacity: 0.5 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '600' },
  name: { fontSize: 16, color: C.text, fontWeight: '600' },
  sub: { fontSize: 13, color: C.muted, marginTop: 2 },
  tag: { fontSize: 11, color: C.muted, borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  empty: { textAlign: 'center', color: C.muted, marginTop: S.xl },
  error: { color: C.danger, padding: S.md },
})
