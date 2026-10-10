/**
 * 输入区：正文、选图、发送 / 停止。
 *
 * 输入框非受控（理由见 login.tsx），正文在 ref 里；发送失败时把草稿原样还回去。
 * 停止按钮只在这一轮在跑时出现；发送中按钮置灰。
 */
import * as ImagePicker from 'expo-image-picker'
import { useRef, useState } from 'react'
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import type { LocalFile } from '../chat/useChat'
import { C, S } from '../ui'

interface Props {
  /** 会话拿到了没有。没拿到之前发送按钮禁掉——点了也只换回一句「会话还没好」。 */
  ready: boolean
  running: boolean
  stopping: boolean
  sending: boolean
  canUpload: boolean
  t: (zh: string, en?: string) => string
  onSend: (text: string, files: LocalFile[]) => Promise<void>
  onStop: () => void
}

export function Composer({ ready, running, stopping, sending, canUpload, t, onSend, onStop }: Props) {
  const draft = useRef('')
  const input = useRef<TextInput>(null)
  const [files, setFiles] = useState<LocalFile[]>([])
  const [, bump] = useState(0)
  /**
   * 发送失败时把草稿还回去。输入框是非受控的，而 setNativeProps 在新架构上不认 text，
   * 所以靠换 key 重挂一次、用 defaultValue 把字塞回去。
   */
  const [seed, setSeed] = useState({ key: 0, text: '' })

  async function pick() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) return Alert.alert(t('没有相册权限', 'No photo library permission'))
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: 4, quality: 0.85 })
    if (r.canceled) return
    const picked = r.assets.map((a, i) => ({
      uri: a.uri,
      name: a.fileName || `photo-${Date.now()}-${i}.jpg`,
      mime: a.mimeType || 'image/jpeg',
    }))
    setFiles((cur) => cur.concat(picked).slice(0, 4))
  }

  async function submit() {
    const text = draft.current
    if (!text.trim() && !files.length) return
    const sent = files
    // 先清输入框再发：人按下回车那一刻框就该空，不然像没发出去。
    input.current?.clear()
    draft.current = ''
    setFiles([])
    try {
      await onSend(text, sent)
    } catch (err: any) {
      // 没发出去：草稿和图片都还回去，不让人重打一遍。
      draft.current = text
      setSeed((s) => ({ key: s.key + 1, text }))
      setFiles(sent)
      Alert.alert(t('没发出去', 'Not sent'), err?.message || String(err))
    }
  }

  return (
    <View style={st.wrap}>
      {files.length ? (
        <View style={st.thumbs}>
          {files.map((f, i) => (
            <Pressable key={f.uri + i} onPress={() => setFiles((cur) => cur.filter((x) => x !== f))}>
              <Image source={{ uri: f.uri }} style={st.thumb} />
            </Pressable>
          ))}
          <Text style={st.thumbHint}>{t('点图片移除', 'Tap to remove')}</Text>
        </View>
      ) : null}
      <View style={st.row}>
        {canUpload ? (
          <Pressable style={st.iconBtn} onPress={pick} disabled={sending}>
            <Text style={st.iconText}>＋</Text>
          </Pressable>
        ) : null}
        <TextInput
          key={seed.key}
          ref={input}
          defaultValue={seed.text}
          style={st.input}
          placeholder={t('说点什么…', 'Say something…')}
          multiline
          onChangeText={(v) => {
            draft.current = v
            bump((n) => n + 1)
          }}
        />
        {running || stopping ? (
          <Pressable style={[st.btn, st.btnStop, stopping && st.btnOff]} onPress={onStop} disabled={stopping}>
            {stopping ? <ActivityIndicator color="#fff" /> : <Text style={st.btnText}>{t('停止', 'Stop')}</Text>}
          </Pressable>
        ) : (
          <Pressable style={[st.btn, (!ready || sending || (!draft.current.trim() && !files.length)) && st.btnOff]} onPress={submit} disabled={!ready || sending}>
            {sending ? <ActivityIndicator color="#fff" /> : <Text style={st.btnText}>{t('发送', 'Send')}</Text>}
          </Pressable>
        )}
      </View>
    </View>
  )
}

const st = StyleSheet.create({
  wrap: { borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.card, paddingHorizontal: S.md, paddingTop: S.sm, paddingBottom: S.md },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: S.sm },
  input: { flex: 1, minHeight: 40, maxHeight: 140, backgroundColor: C.bg, borderRadius: 12, paddingHorizontal: S.md, paddingVertical: 10, fontSize: 16, color: C.text },
  btn: { backgroundColor: C.accent, borderRadius: 12, paddingHorizontal: 16, height: 40, alignItems: 'center', justifyContent: 'center', minWidth: 64 },
  btnStop: { backgroundColor: C.danger },
  btnOff: { opacity: 0.5 },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  iconBtn: { width: 40, height: 40, borderRadius: 12, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: 22, color: C.accent, lineHeight: 26 },
  thumbs: { flexDirection: 'row', alignItems: 'center', gap: S.sm, marginBottom: S.sm },
  thumb: { width: 56, height: 56, borderRadius: 8, backgroundColor: C.line },
  thumbHint: { fontSize: 12, color: C.muted },
})
