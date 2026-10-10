/**
 * 气泡列表。拿 core 折出来的 blocks 画，不自己碰事件。
 *
 * 第一期：正文当纯文本画（流式时先经 healStream 补齐半截记号，免得满屏星号闪）。
 * Markdown 渲染器留到下一步选。
 */
import { memo, useMemo } from 'react'
import { FlatList, StyleSheet, Text, View } from 'react-native'
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
        <Text style={st.text}>{b.text}</Text>
        {b.files.length ? <Text style={st.meta}>{b.files.map((f) => f.name).join('，')}</Text> : null}
        {b.images.length ? <Text style={st.meta}>{b.images.length} 张图片</Text> : null}
        <Text style={st.time}>{b.pending ? '发送中…' : fmtTime(b.time)}</Text>
      </View>
    </View>
  )
})

const AssistantRow = memo(function AssistantRow({ b, streaming }: { b: AssistantBlock; streaming: boolean }) {
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
        {b.approvals?.length ? <Text style={st.meta}>{b.approvals.filter((a) => a.state === 'pending').length ? '等你确认' : ''}</Text> : null}
        {b.handoffs?.length ? <Text style={st.meta}>转人工：{b.handoffs.map((h) => h.state).join('，')}</Text> : null}
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

export function MessageList({ folded, header }: { folded: Folded; header?: React.ReactElement | null }) {
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
        item.kind === 'user' ? <UserRow b={item} /> : item.kind === 'assistant' ? <AssistantRow b={item} streaming={streamingTail && index === 0} /> : <MarkRow b={item} />
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
})
