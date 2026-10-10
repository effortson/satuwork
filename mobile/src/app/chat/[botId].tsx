import { Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { MessageList } from '@/components/MessageList'
import { useChat, type RuntimeBot } from '@/chat/useChat'
import { api, useSession } from '@/store'
import { C, S } from '@/ui'

/**
 * 对话屏（第一期只读：看历史、看实时流）。发消息、中止、审批在下一步。
 *
 * Bot 对象从名单接口取一次——对话流要的直连地址在它的 runtime 上。
 */
export default function Chat() {
  const { botId } = useLocalSearchParams<{ botId: string }>()
  const { t } = useSession()
  const [bot, setBot] = useState<RuntimeBot | null>(null)
  const [botError, setBotError] = useState('')

  useEffect(() => {
    let gone = false
    api('GET', '/runtime/bots')
      .then((r) => {
        if (gone) return
        const hit = (Array.isArray(r?.bots) ? r.bots : []).find((b: RuntimeBot) => b.id === botId) || null
        if (!hit) setBotError(t('名单里没有这颗 Bot', 'This bot is not in your list'))
        setBot(hit)
      })
      .catch((err) => !gone && setBotError(err.message || String(err)))
    return () => {
      gone = true
    }
  }, [botId, t])

  const chat = useChat(bot)

  const banner = botError || chat.error || (chat.stream?.kind === 'dead' ? chat.stream.message : chat.stream?.kind === 'warming' ? t('实例还没上线，正在重连…', 'Seat is warming up, reconnecting…') : chat.stream?.kind === 'idle' ? t('连接断开，每 30 秒重试', 'Disconnected; retrying every 30s') : '')

  return (
    <View style={st.wrap}>
      <Stack.Screen options={{ title: bot?.name || '' }} />
      {banner ? (
        <View style={[st.banner, (botError || chat.error || chat.stream?.kind === 'dead') && st.bannerBad]}>
          <Text style={st.bannerText}>{banner}</Text>
        </View>
      ) : null}
      {chat.loading ? (
        <ActivityIndicator style={{ marginTop: S.xl }} />
      ) : (
        <MessageList
          folded={chat.folded}
          header={
            chat.page.hasMore ? (
              <Pressable style={st.more} onPress={() => void chat.loadOlder()} disabled={Boolean(chat.page.loading)}>
                <Text style={st.moreText}>{chat.page.loading ? '…' : t('加载更早的对话', 'Load earlier messages')}</Text>
              </Pressable>
            ) : null
          }
        />
      )}
      <View style={st.composer}>
        <Text style={st.composerText}>{t('发消息在下一步接上', 'Sending comes in the next step')}</Text>
      </View>
    </View>
  )
}

const st = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg },
  banner: { backgroundColor: '#fef3c7', paddingHorizontal: S.md, paddingVertical: S.sm },
  bannerBad: { backgroundColor: '#fee2e2' },
  bannerText: { fontSize: 13, color: C.text },
  more: { alignItems: 'center', paddingVertical: S.sm },
  moreText: { color: C.accent, fontSize: 14 },
  composer: { borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.card, padding: S.md, alignItems: 'center' },
  composerText: { color: C.muted, fontSize: 13 },
})
