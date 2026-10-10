import { Stack, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { Composer } from '@/components/Composer'
import { MessageList } from '@/components/MessageList'
import { useChat, type RuntimeBot } from '@/chat/useChat'
import { api, useSession } from '@/store'
import { C, S } from '@/ui'

/**
 * 对话屏：看历史、看实时流、发消息（带图）、停止、审批、撤掉排队的消息。
 *
 * Bot 对象从名单接口取一次——对话流和上传要的直连地址在它的 runtime 上。
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

  const banner =
    botError ||
    chat.error ||
    (chat.stream?.kind === 'dead' ? chat.stream.message : chat.stream?.kind === 'warming' ? t('实例还没上线，正在重连…', 'Seat is warming up, reconnecting…') : chat.stream?.kind === 'idle' ? t('连接断开，每 30 秒重试', 'Disconnected; retrying every 30s') : '')
  const running = chat.folded.status === 'running'

  async function decide(callId: string, d: 'approve' | 'deny') {
    try {
      await chat.decide(callId, d)
    } catch (err: any) {
      // 409 是「这条早就结束了」——超时、被停止、或者别处先点了。不是错误，但要说出来。
      Alert.alert(t('没能提交这次确认', 'Could not submit that decision'), err?.message || String(err))
    }
  }

  return (
    <KeyboardAvoidingView style={st.wrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 96 : 0}>
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
          onDecide={decide}
          header={
            chat.page.hasMore ? (
              <Pressable style={st.more} onPress={() => void chat.loadOlder()} disabled={Boolean(chat.page.loading)}>
                <Text style={st.moreText}>{chat.page.loading ? '…' : t('加载更早的对话', 'Load earlier messages')}</Text>
              </Pressable>
            ) : null
          }
        />
      )}
      {chat.queue.length ? (
        <View style={st.queue}>
          {chat.queue.map((q) => (
            <View key={q.id} style={st.queueRow}>
              <Text style={st.queueText} numberOfLines={1}>
                {t('排队中', 'Queued')}：{q.text}
              </Text>
              <Pressable onPress={() => void chat.dequeue(q.id).catch(() => {})}>
                <Text style={st.queueCancel}>{t('撤回', 'Cancel')}</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <Composer ready={Boolean(chat.sessionId)} running={running} stopping={chat.stopping} sending={chat.sending} canUpload={chat.canUpload} t={t} onSend={chat.send} onStop={() => void chat.abort()} />
    </KeyboardAvoidingView>
  )
}

const st = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg },
  banner: { backgroundColor: '#fef3c7', paddingHorizontal: S.md, paddingVertical: S.sm },
  bannerBad: { backgroundColor: '#fee2e2' },
  bannerText: { fontSize: 13, color: C.text },
  more: { alignItems: 'center', paddingVertical: S.sm },
  moreText: { color: C.accent, fontSize: 14 },
  queue: { backgroundColor: C.card, borderTopWidth: 1, borderTopColor: C.line, paddingHorizontal: S.md, paddingVertical: S.xs },
  queueRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingVertical: 4 },
  queueText: { flex: 1, fontSize: 13, color: C.muted },
  queueCancel: { fontSize: 13, color: C.accent },
})
