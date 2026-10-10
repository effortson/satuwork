import { Link, Stack, useFocusEffect, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { applyRosterEvent, fmtTime, newSum, runEventStream, settleDot, type RosterSum } from '@satuwork/core'
import { session } from '@/gateway'
import { api, useSession } from '@/store'
import { C, S } from '@/ui'
import type { RuntimeBot } from '@/chat/useChat'

/**
 * Bot 名单。`GET /runtime/bots` 一次拿全：每行带 runtime（在不在、直连地址）。
 *
 * 实时的「在跑 / 等人 / 最近说了什么」来自名单流：`rosterStreamUrl` 一条管所有 Bot（只直连
 * 席位机器，Gateway 上没有反代；地址为空就不连）。帧是 `roster/ev`（一条会话事件，只更新
 * 摘要）和 `roster/live`（席位对「在不在跑」的权威表态）。归并规则在 core 的 applyRosterEvent /
 * settleDot，这里只持有每颗 Bot 一份 RosterSum。
 */
export default function Bots() {
  const { t, me } = useSession()
  const router = useRouter()
  const [bots, setBots] = useState<RuntimeBot[]>([])
  const [rosterUrl, setRosterUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const sums = useRef(new Map<string, RosterSum>())
  const [, bump] = useState(0)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const r = await api('GET', '/runtime/bots')
      setBots(Array.isArray(r?.bots) ? r.bots : [])
      setRosterUrl(typeof r?.rosterStreamUrl === 'string' ? r.rosterStreamUrl : '')
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

  // 名单流：地址变了就在新地址上重开；没有地址就不连。
  useEffect(() => {
    if (!rosterUrl) return
    const sumOf = (id: string) => sums.current.get(id) || sums.current.set(id, newSum()).get(id)!
    let paintTimer: ReturnType<typeof setTimeout> | null = null
    const paint = () => {
      if (paintTimer) return
      paintTimer = setTimeout(() => {
        paintTimer = null
        bump((n) => n + 1)
      }, 100)
    }
    const h = runEventStream({
      fetch: (url, init) => session.client.swFetch(url, init),
      url: () => rosterUrl,
      token: () => session.token,
      cursor: () => null,
      onEvent: (msg) => {
        if (!msg || typeof msg !== 'object' || !msg.botId) return
        if (msg.type === 'roster/ev') {
          if (applyRosterEvent(sumOf(msg.botId), msg.ev || {})) paint()
        } else if (msg.type === 'roster/live' && typeof msg.live === 'boolean') {
          const sum = sumOf(msg.botId)
          sum.busy = msg.live
          settleDot(sum)
          paint()
        }
      },
    })
    return () => {
      h.close()
      if (paintTimer) clearTimeout(paintTimer)
    }
  }, [rosterUrl])

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
          const sum = sums.current.get(item.id)
          const dot = !sum ? null : sum.state === 'review' ? C.warn : sum.state === 'busy' ? C.accent : C.ok
          const sub = local
            ? t('本地 Bot，只能在桌面端用', 'Local bot, desktop only')
            : !item.runtime
              ? t('还没部署', 'Not deployed')
              : !direct
                ? t('没有直连地址，手机上开不了对话流', 'No direct address; chat stream unavailable on mobile')
                : sum?.state === 'review'
                  ? sum.need === 'approval'
                    ? t('等你确认', 'Waiting for your approval')
                    : t('待人工处理', 'Waiting for a person')
                  : sum?.state === 'busy'
                    ? t('正在执行', 'Running')
                    : sum?.lastText || item.runtime.status || item.description || ''
          return (
            <Pressable style={[st.row, local && st.rowOff]} disabled={local} onPress={() => router.push({ pathname: '/chat/[botId]', params: { botId: item.id } })}>
              <View style={st.avatar}>
                <Text style={st.avatarText}>{(item.name || '?').slice(0, 1)}</Text>
                {dot ? <View style={[st.dot, { backgroundColor: dot }]} /> : null}
              </View>
              <View style={{ flex: 1 }}>
                <View style={st.nameRow}>
                  <Text style={st.name}>{item.name}</Text>
                  {sum?.lastAt ? <Text style={st.when}>{fmtTime(sum.lastAt).slice(11)}</Text> : null}
                </View>
                <Text style={[st.sub, sum?.state === 'review' && { color: C.warn }]} numberOfLines={1}>
                  {sub}
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
  dot: { position: 'absolute', right: -1, bottom: -1, width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: C.card },
  nameRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  name: { fontSize: 16, color: C.text, fontWeight: '600' },
  when: { fontSize: 12, color: C.muted },
  sub: { fontSize: 13, color: C.muted, marginTop: 2 },
  tag: { fontSize: 11, color: C.muted, borderWidth: 1, borderColor: C.line, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  empty: { textAlign: 'center', color: C.muted, marginTop: S.xl },
  error: { color: C.danger, padding: S.md },
})
