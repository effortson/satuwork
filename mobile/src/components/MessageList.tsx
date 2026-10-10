/**
 * 气泡列表。拿 core 折出来的 blocks 画，不自己碰事件。
 *
 * 第一期：正文当纯文本画（流式时先经 healStream 补齐半截记号，免得满屏星号闪）。
 * Markdown 渲染器留到之后选。
 */
import { memo, useMemo } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { createMarkdown, fmtTime, type AssistantBlock, type Block, type Folded, type UserBlock } from '@satuwork/core'
import { C, S } from '../ui'

const md = createMarkdown()

function toolLabel(name: string) {
  return name.length > 24 ? name.slice(0, 22) + '…' : name
}

const UserRow = memo(function UserRow({ b }: { b: UserBlock }) {
  return (
    <View style={[st.row, st.rowUser]}>
      <View style={[st.bubble, st.bubbleUser]}>
        {b.refs.length ? <Text style={st.meta}>{b.refs.map((r) => (r.kind === 'file' ? r.name : `「${r.excerpt.slice(0, 20)}」`)).join('，')}</Text> : null}
        {b.mentions.length ? <Text style={st.meta}>{b.mentions.map((m) => '@' + m.label).join(' ')}</Text> : null}
        {b.text ? <Text style={st.text}>{b.text}</Text> : null}
        {b.files.length ? <Text style={st.meta}>{b.files.map((f) => f.name).join('，')}</Text> : null}
        {b.images.length ? <Text style={st.meta}>{b.images.length} 张图片</Text> : null}
        <Text style={st.time}>{b.pending ? '发送中…' : fmtTime(b.time)}</Text>
      </View>
    </View>
  )
})

/** 高风险确认卡：pending 的给两个按钮，落定的只写结果。 */
function ApprovalCard({ a, onDecide }: { a: any; onDecide?: (callId: string, d: 'approve' | 'deny') => void }) {
  const pending = a.state === 'pending'
  const label = pending ? '等你确认' : a.state === 'approved' ? '已同意' : a.state === 'denied' ? '已拒绝' : a.state === 'expired' ? '已超时' : String(a.state || '')
  return (
    <View style={[st.card, pending && st.cardPending]}>
      <Text style={st.cardTitle}>
        {toolLabel(a.name || 'tool')} · {label}
      </Text>
      {a.reason ? <Text style={st.cardBody}>{a.reason}</Text> : null}
      {a.args ? (
        <Text style={st.cardArgs} numberOfLines={4}>
          {a.args}
        </Text>
      ) : null}
      {pending && onDecide ? (
        <View style={st.cardBtns}>
          <Pressable style={[st.cardBtn, st.cardBtnOk]} onPress={() => onDecide(a.callId, 'approve')}>
            <Text style={st.cardBtnText}>同意</Text>
          </Pressable>
          <Pressable style={[st.cardBtn, st.cardBtnNo]} onPress={() => onDecide(a.callId, 'deny')}>
            <Text style={st.cardBtnText}>拒绝</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  )
}

const AssistantRow = memo(function AssistantRow({ b, streaming, onDecide }: { b: AssistantBlock; streaming: boolean; onDecide?: (callId: string, d: 'approve' | 'deny') => void }) {
  const text = streaming ? md.healStream(b.text) : b.text
  return (
    <View style={[st.row, st.rowBot]}>
      <View style={[st.bubble, st.bubbleBot]}>
        {b.tools.length ? (
          <View style={st.tools}>
            {b.tools.map((t, i) => (
              <Text key={t.callId || i} style={[st.pill, t.result == null ? st.pillRunning : t.failed ? st.pillFailed : null]}>
                {toolLabel(t.name)}
                {t.result == null ? ' …' : t.failed ? ' ✕' : ''}
              </Text>
            ))}
          </View>
        ) : null}
        {b.approvals?.map((a: any) => <ApprovalCard key={a.callId} a={a} onDecide={onDecide} />)}
        {b.handoffs?.map((h: any) => (
          <View key={h.id} style={st.card}>
            <Text style={st.cardTitle}>转人工 · {h.state === 'open' ? '等人接手' : h.state === 'claimed' ? `${h.claimedBy || ''} 已接手` : h.state}</Text>
            {h.ask ? <Text style={st.cardBody}>{h.ask}</Text> : null}
          </View>
        ))}
        {text ? <Text style={st.text}>{text}</Text> : streaming ? <Text style={st.muted}>正在想…</Text> : null}
        <Text style={st.time}>{fmtTime(b.endTime || b.time)}</Text>
      </View>
    </View>
  )
})

function MarkRow({ b }: { b: Block & { kind: 'mark' } }) {
  const label =
    b.mark === 'clear' ? '已清空' : b.mark === 'reset' ? '新对话' : b.mark === 'model' ? `模型切到 ${b.label || b.key || ''}` : `已压缩上下文${b.dropped ? `（折掉 ${b.dropped} 条）` : ''}`
  return (
    <View style={st.mark}>
      <Text style={st.markText}>{label}</Text>
    </View>
  )
}

export function MessageList({ folded, header, onDecide }: { folded: Folded; header?: React.ReactElement | null; onDecide?: (callId: string, d: 'approve' | 'deny') => void }) {
  // 倒着画：FlatList inverted 让最新一条贴底，初始就在底部，不用滚。
  const data = useMemo(() => folded.blocks.slice().reverse(), [folded.blocks])
  const last = folded.blocks[folded.blocks.length - 1]
  const streamingTail = Boolean(folded.status) && last?.kind === 'assistant'
  return (
    <FlatList
      inverted
      data={data}
      keyExtractor={(b, i) => (b.seq != null ? 'm' + b.seq : 'p' + i)}
      renderItem={({ item, index }) =>
        item.kind === 'user' ? <UserRow b={item} /> : item.kind === 'assistant' ? <AssistantRow b={item} streaming={streamingTail && index === 0} onDecide={onDecide} /> : <MarkRow b={item} />
      }
      ListHeaderComponent={
        folded.status && last?.kind !== 'assistant' ? (
          <View style={[st.row, st.rowBot]}>
            <View style={[st.bubble, st.bubbleBot]}>
              <Text style={st.muted}>{folded.status === 'sending' ? '发送中…' : '正在想…'}</Text>
            </View>
          </View>
        ) : null
      }
      ListFooterComponent={header || null}
      contentContainerStyle={{ padding: S.md }}
      keyboardShouldPersistTaps="handled"
    />
  )
}

const st = StyleSheet.create({
  row: { flexDirection: 'row', marginVertical: S.xs },
  rowUser: { justifyContent: 'flex-end' },
  rowBot: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '86%', borderRadius: 14, paddingHorizontal: S.md, paddingVertical: S.sm },
  bubbleUser: { backgroundColor: C.userBubble },
  bubbleBot: { backgroundColor: C.botBubble, borderWidth: 1, borderColor: C.line },
  text: { fontSize: 16, lineHeight: 22, color: C.text },
  muted: { fontSize: 15, color: C.muted },
  meta: { fontSize: 12, color: C.muted, marginBottom: 2 },
  time: { fontSize: 11, color: C.muted, marginTop: 4, alignSelf: 'flex-end' },
  tools: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 4 },
  pill: { fontSize: 12, color: C.muted, backgroundColor: C.bg, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  pillRunning: { color: C.accent },
  pillFailed: { color: C.danger },
  mark: { alignItems: 'center', marginVertical: S.sm },
  markText: { fontSize: 12, color: C.muted },
  card: { borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: S.sm, marginVertical: S.xs, backgroundColor: C.bg },
  cardPending: { borderColor: C.warn },
  cardTitle: { fontSize: 13, fontWeight: '600', color: C.text },
  cardBody: { fontSize: 13, color: C.text, marginTop: 2 },
  cardArgs: { fontSize: 12, color: C.muted, marginTop: 2, fontFamily: 'Menlo' },
  cardBtns: { flexDirection: 'row', gap: S.sm, marginTop: S.sm },
  cardBtn: { flex: 1, borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  cardBtnOk: { backgroundColor: C.ok },
  cardBtnNo: { backgroundColor: C.danger },
  cardBtnText: { color: '#fff', fontWeight: '600' },
})
