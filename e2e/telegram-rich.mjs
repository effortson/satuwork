import { runProbe } from './probe.mjs'

export async function runTelegramRich({ root, test, assert, log }) {
  log('\n# telegram-rich')
  const result = await runProbe(root, 'gateway/e2e-telegram-rich.mjs')

  await test('Telegram 处理期间持续显示正在输入，结束后停止续发', async () => {
    assert(result.typingCount >= 3, `正在输入状态只发送了 ${result.typingCount} 次`)
    assert(result.typingValid, 'sendChatAction 没有使用目标私聊和 typing 动作')
    assert(result.typingStopped, '处理结束后仍在续发正在输入状态')
  })

  await test('Telegram 回复原样传入 RichMessage Markdown', async () => {
    assert(result.nativeMethod === 'sendRichMessage', `实际调用 ${result.nativeMethod}`)
    assert(result.nativeMarkdown.includes('# 周报'), '标题 Markdown 丢失')
    assert(result.nativeMarkdown.includes('| 指标 | 值 |'), '表格 Markdown 丢失')
    assert(result.nativeMarkdown.includes('- [x] **已完成**'), '任务项 Markdown 丢失')
    assert(result.nativeThread === '88', '话题 id 没有传给 RichMessage')
  })

  await test('旧 Bot API 不支持 RichMessage 时降级为普通文本', async () => {
    assert(result.fallbackMethods.join(',') === 'sendRichMessage,sendMessage', `调用顺序 ${result.fallbackMethods}`)
    assert(result.fallbackText === '**旧 API 降级**', '降级文本被改写')
  })

  await test('Telegram 用同一个纯文本 draft id 流式展示，避免半截 Markdown 双重请求', async () => {
    assert(result.nativeDraftMethod === 'sendMessageDraft', `实际调用 ${result.nativeDraftMethod}`)
    assert(result.nativeDraftId === 31415, `draft id 变成了 ${result.nativeDraftId}`)
    assert(result.nativeDraftText.includes('## 正在生成'), '草稿文本丢失')
    assert(result.nativeDraftThread === '88', '草稿没有带话题 id')
  })

  await test('流式草稿每帧只调用一次 Telegram API', async () => {
    assert(result.secondDraftMethods.join(',') === 'sendMessageDraft', `调用顺序 ${result.secondDraftMethods}`)
    assert(result.secondDraftText === '**旧 API 草稿**', '草稿文本被改写')
  })

  await test('Telegram 慢请求不会阻塞模型快照，等待帧只保留最新内容', async () => {
    assert(result.enqueueElapsedMs < 15, `入队竟然阻塞了 ${result.enqueueElapsedMs}ms`)
    assert(result.maxActiveDraftSends === 1, `同时有 ${result.maxActiveDraftSends} 个草稿请求`)
    assert(result.pumpedDrafts.length === 2, `没有合并中间帧：${JSON.stringify(result.pumpedDrafts)}`)
    assert(result.pumpedDrafts.at(-1) === '一二三四五六七八九十', `最后快照丢失：${JSON.stringify(result.pumpedDrafts)}`)
    // 只往后长：中间改过的那一帧（老 bot 的工具状态表）不发，接着长的照发。
    assert(JSON.stringify(result.appendOnlyDrafts) === JSON.stringify([
      '第一段',
      '第一段\n\n🔧 工具调用\n⏳ web_search · 调用中',
      '第一段\n\n🔧 工具调用\n⏳ web_search · 调用中\n\n第二段',
    ]), `中间改过的帧被发出去了：${JSON.stringify(result.appendOnlyDrafts)}`)
    // 超长草稿停在开头：两帧一样、不超上限、以原文开头——不再每帧往后滑。
    const [a, b] = result.longDrafts
    assert(a && a === b, '超长草稿两帧不一样（还在往后滑）')
    assert(Array.from(a).length <= 4000 && a.startsWith('长长长') && a.endsWith('…'), `超长草稿没停在开头：${a.slice(0, 20)}… 长 ${Array.from(a).length}`)
  })

  await test('Telegram 审批卡可点击、回调有应答且完成后移除按钮', async () => {
    assert(result.approvalMethod === 'sendRichMessage', `审批卡实际调用 ${result.approvalMethod}`)
    assert(result.approvalButtons.length === 4, `审批按钮数量不对：${result.approvalButtons.length}`)
    assert(result.approvalButtonsFit, '审批 callback_data 超过 Telegram 64 字节限制')
    assert(result.callback?.queryId === 'query-1' && result.callback?.remoteUserId === '456', '审批回调没有正确归一化')
    assert(result.answerMethod === 'answerCallbackQuery' && result.answerId === 'query-1', '点击审批后没有应答 callback query')
    assert(result.clearMethod === 'editMessageReplyMarkup' && result.clearKeyboard.length === 0, '审批完成后没有移除旧按钮')
  })

  await test('Telegram 转人工卡提供四种处理动作，并用原生回复收集结论', async () => {
    assert(result.handoffMethod === 'sendRichMessage', `转人工卡实际调用 ${result.handoffMethod}`)
    assert(result.handoffButtons.length === 4, `转人工按钮数量不对：${result.handoffButtons.length}`)
    assert(result.handoffButtons.every((data) => /^swh:/.test(data)), `转人工按钮数据不对：${result.handoffButtons}`)
    assert(result.handoffButtonsFit, '转人工 callback_data 超过 Telegram 64 字节限制')
    assert(result.handoffPromptMethod === 'sendMessage' && result.handoffForceReply === true, '没有用 ForceReply 收集人工结论')
    assert(result.handoffPromptMarker.includes('[satuwork-handoff:'), '回复提示没有携带可恢复的工单标记')
    assert(result.handoffReplyToText === result.handoffPromptMarker, 'Telegram 回复没有保留工单提示正文')
    assert(result.handoffReplyText === '已经处理，结果正常。', '人工结论正文被改写')
  })

  await test('Telegram 长审批正文完整分段，格式和按钮位置不丢', async () => {
    assert(result.longApprovalParts > 1, '长审批正文没有分段')
    assert(result.longApprovalComplete, '长审批正文结尾丢失')
    assert(result.longApprovalQuoted, '长审批正文分段后丢失引用格式')
    assert(result.longApprovalButtonsOnlyLast, '审批按钮没有只挂在最后一段')
    assert(result.longApprovalMessageIdIsLast, '审批记录没有指向带按钮的最后一段')
  })

  await test('旧 Telegram Bot API 也会完整发送长审批正文', async () => {
    assert(result.fallbackApprovalParts > 1, '旧接口没有拆分长审批正文')
    assert(result.fallbackApprovalComplete, '旧接口降级后正文结尾丢失')
    assert(result.fallbackApprovalButtonsOnlyLast, '旧接口降级后按钮没有只挂在最后一段')
    assert(result.fallbackApprovalMessageIdIsLast, '旧接口降级后没有记录带按钮的最后一段')
  })

  await test('超大代码块拆分后每段仍是完整 Markdown 控件', async () => {
    assert(result.hugeParts > 1, '超限内容没有拆分')
    assert(result.hugePartsValid, '拆分后 fence 不完整或仍超限')
  })

  await test('Telegram 产出文件带网页预览卡和打开按钮，旧 API 会保留按钮降级', async () => {
    assert(result.artifactMethod === 'sendMessage', `文件预览实际调用 ${result.artifactMethod}`)
    assert(result.artifactText.includes('ETH &lt;报告&gt;.html'), '文件名没有按 HTML 安全转义')
    assert(result.artifactButton?.text === '打开预览' && result.artifactButton?.url.includes('/channel-artifacts/'), '缺少预览按钮')
    assert(result.artifactLinkPreview?.is_disabled === false, '链接预览被禁用')
    assert(result.artifactThread === '88', '文件预览没有带话题 id')
    assert(result.artifactFallbackMethods.join(',') === 'sendMessage,sendMessage', '旧 API 没有去掉 link_preview_options 后重试')
    assert(result.artifactFallbackHasButton, '旧 API 降级时丢失预览按钮')
  })
}
