/** 外部消息渠道。目前接入 Telegram。 */

async function loadChannels() {
  const data = await api('GET', '/channels')
  state.channels = Array.isArray(data.channels) ? data.channels : []
}

function channelStatus(c) {
  if (!c) return ['未绑定', 'Not connected', 'tag-neutral']
  if (c.status === 'active' && !c.paired) return ['等待配对', 'Pairing required', 'tag-warn']
  if (c.status === 'active' && c.runtime?.status === 'ready') return ['已连接', 'Connected', 'mg-status-ok']
  if (c.status === 'active') return ['等待 Bot 就绪', 'Waiting for bot', 'tag-accent']
  if (c.status === 'binding') return ['绑定中', 'Connecting', 'tag-accent']
  if (c.status === 'paused') return ['已暂停', 'Paused', 'tag-neutral']
  return ['连接异常', 'Connection issue', 'tag-warn']
}

function channelBindModal() {
  if (!state.channelBindOpen) return ''
  return modalBox({ close: 'channel-bind-close', tag: 'form', attrs: 'id="channel-bind-form" class="gw-modal rs-channel-modal" style="max-width:520px" data-stop role="dialog" aria-modal="true" aria-labelledby="channel-bind-title"',
    title: `<span id="channel-bind-title">${t('绑定 Telegram Bot', 'Connect Telegram bot')}</span>`,
    sub: t('先在 Telegram 的 @BotFather 中创建 Bot，再将获得的 token 填入下方。', 'Create a bot with @BotFather in Telegram, then enter its token below.'),
    body: `${state.channelBindError ? `<div class="gw-flash gw-flash-err" role="alert">${esc(state.channelBindError)}</div>` : ''}
      <div class="field"><label for="channel-token">Bot token</label>
        <input class="input" id="channel-token" name="token" type="password" autocomplete="off" placeholder="123456789:AA…" required ${state.busy ? 'readonly' : ''}>
        <span class="mg-help">${t('Token 会加密保存，绑定后不会再次显示。', 'The token is encrypted at rest and is never shown again.')}</span>
      </div>
      <div class="mg-notice">${t('绑定后会创建对应的 Satuwork Bot，并生成一次性配对码。还需在 Telegram 私聊中发送配对码，才能开始对话。', 'Connecting creates a Satuwork bot and a one-time pairing code. Send the code in a private Telegram chat to start messaging.')}</div>
      <div class="rs-modal-actions"><button type="button" class="btn btn-secondary" data-act="channel-bind-close" ${state.busy ? 'disabled' : ''}>${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('绑定中…', 'Connecting…') : t('绑定并创建 Bot', 'Connect and create bot')}</button></div>` })
}

function telegramChannelCard(c) {
  const [zh, en, cls] = channelStatus(c)
  const telegramUrl = c?.externalUsername && /^[A-Za-z0-9_]+$/.test(c.externalUsername) ? 'https://t.me/' + c.externalUsername : ''
  const ready = c?.status === 'active' && c.paired && c.runtime?.status === 'ready'
  return `<section class="satu-panel rs-channel-card">
    <div class="rs-channel-heading"><span class="rs-telegram-icon">${svg(['M21 3 3 10l7 3 3 7 8-17z','m10 13 5-5'], 24)}</span>
      <div><h2>Telegram <span class="tag ${cls}">${t(zh, en)}</span></h2><p>${c ? '@' + esc(c.externalUsername || c.externalBotId) : t('将 Telegram 私聊接入你的 Bot', 'Connect private Telegram messages to your bot')}</p></div>
    </div>
    ${c?.lastError ? `<div class="rs-inline-error" role="alert"><strong>${t('连接需要处理', 'Connection needs attention')}</strong><p>${esc(c.lastError)}</p><span>${t('检查网络与 Bot token，再尝试重新连接。', 'Check the network and bot token, then try reconnecting.')}</span></div>` : ''}
    ${!c ? `<div class="rs-channel-intro"><h3>${t('从 Telegram 随时联系你的 Bot', 'Reach your bot from Telegram')}</h3><p>${t('消息与网页端进入同一条 Bot 对话，可在两端查看上下文与工作进展。', 'Telegram and web messages share the same bot conversation, so you can follow context and progress in either place.')}</p></div>` : ''}
    ${c && !c.paired ? `<div class="rs-pairing"><span class="rs-eyebrow">${t('下一步 · 配对你的账号', 'Next · pair your account')}</span>
      <p>${t('在 Telegram 中私聊这个 Bot，并发送下方一次性配对码。', 'Open a private chat with this bot in Telegram and send the one-time pairing code below.')}</p>
      ${c.pairingCode ? `<div class="rs-pairing-code"><code>${esc(c.pairingCode)}</code><button type="button" class="btn btn-secondary" data-act="channel-copy-code" data-id="${esc(c.id)}">${t('复制配对码', 'Copy code')}</button></div>` : `<p class="mg-help">${t('暂未取得配对码，可重新生成。', 'No pairing code is available. Generate a new one below.')}</p>`}
      <p class="mg-help">${t('配对完成前，任何消息都不会进入 AI。配对码仅可在私聊中使用一次。完成后刷新状态。', 'No message reaches the AI before pairing. The code works once in a private chat. Refresh the status after pairing.')}</p>
      ${telegramUrl ? `<a class="btn btn-primary" href="${esc(telegramUrl)}" target="_blank" rel="noopener noreferrer">${t('打开 Telegram 私聊', 'Open Telegram chat')}${svg(['M7 17 17 7','M7 7h10v10'], 14)}</a>` : ''}
    </div>` : ''}
    ${c ? `<dl class="rs-channel-facts">
      <div><dt>${t('关联 Bot', 'Linked bot')}</dt><dd>${esc(c.bot?.name || 'telegram bot')}</dd></div>
      <div><dt>${t('最近收到消息', 'Last message received')}</dt><dd>${esc(c.lastReceivedAt ? fmtTime(c.lastReceivedAt) : t('暂无消息', 'No messages yet'))}</dd></div>
      <div><dt>${t('已配对账号', 'Paired account')}</dt><dd>${c.pairedIdentity ? `${esc(c.pairedIdentity.externalDisplayName || c.pairedIdentity.externalUserId)}${c.pairedIdentity.externalUsername ? ' · @' + esc(c.pairedIdentity.externalUsername) : ''}` : c.paired ? t('已配对', 'Paired') : t('等待配对', 'Pairing required')}</dd></div>
      <div><dt>${t('使用范围', 'Scope')}</dt><dd>${t('单用户私聊', 'One private user')}</dd></div>
    </dl>` : ''}
    ${c && c.paired && !ready && c.status === 'active' ? `<p class="mg-notice">${t('账号已配对，正在等待 Bot 就绪。可刷新状态，或打开 Bot 查看部署进展。', 'Your account is paired. Waiting for the bot to be ready; refresh the status or open the bot to check deployment.')}</p>` : ''}
    <div class="rs-channel-actions">${!c ? `<button type="button" class="btn btn-primary" data-act="channel-bind-open">${t('绑定 Telegram', 'Connect Telegram')}</button>` : `
      ${c.botId ? `<button type="button" class="btn ${ready ? 'btn-primary' : 'btn-secondary'}" data-act="go" data-href="/a/${esc(encodeURIComponent(c.botId))}">${ready ? t('打开 Bot 对话', 'Open bot chat') : t('查看 Bot', 'View bot')}</button>` : ''}
      ${c.status === 'error' ? `<button type="button" class="btn btn-secondary" data-act="channel-reconnect" data-id="${esc(c.id)}" ${state.busy ? 'disabled' : ''}>${t('重新连接', 'Reconnect')}</button>` : ''}
      <button type="button" class="btn btn-ghost" data-act="channel-pair-reset" data-id="${esc(c.id)}" ${state.busy ? 'disabled' : ''}>${c.paired ? t('更换配对账号', 'Change paired account') : t('重新生成配对码', 'New pairing code')}</button>
      <button type="button" class="btn btn-ghost rs-danger-action" data-act="channel-unbind" data-id="${esc(c.id)}" ${state.busy ? 'disabled' : ''}>${t('解除绑定', 'Disconnect')}</button>`}</div>
  </section>`
}

function channelsPage() {
  const telegram = (state.channels || []).find(c => c.kind === 'telegram')
  const steps = [
    [Boolean(telegram), t('绑定 Bot', 'Connect a bot'), t('使用 @BotFather 提供的 token', 'Use the token from @BotFather')],
    [Boolean(telegram?.paired), t('配对账号', 'Pair your account'), t('在私聊中发送一次性配对码', 'Send the one-time code in private chat')],
    [telegram?.status === 'active' && telegram.paired && telegram.runtime?.status === 'ready', t('开始对话', 'Start messaging'), t('在 Telegram 与网页端继续工作', 'Work from Telegram or the web')],
  ]
  return `<div class="gw-page rs-page"><div class="gw-page-inner">
    ${pageHead(t('渠道', 'Channels'), t('把外部消息接入 Satuwork，随时与你的 Bot 保持联系。', 'Connect messaging channels to stay in touch with your bots.'), `<button type="button" class="btn btn-secondary" data-act="channel-refresh">${t('刷新状态', 'Refresh status')}</button>`)}
    ${flashes()}
    <div class="rs-channel-layout">${telegramChannelCard(telegram)}<aside class="rs-channel-guide">
      <section class="satu-panel"><h2>${t('连接步骤', 'Connection steps')}</h2><ol class="rs-steps">${steps.map(([done,title,note],i)=>`<li${done ? ' data-done="1"' : ''}><span>${done ? svg(['M5 12l5 5L20 7'],14) : i+1}</span><div><strong>${title}</strong><p>${note}</p></div></li>`).join('')}</ol></section>
      <p class="mg-notice">${t('每个 Telegram Bot 同时配对一个用户，仅接收私聊。渠道消息沿用现有的审计与用量规则。', 'Each Telegram bot pairs with one user and accepts private messages only. Existing audit and usage rules apply.')}</p>
    </aside></div>
  </div>${channelBindModal()}</div>`
}

async function submitChannelBinding(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  state.busy = true
  state.channelBindError = ''
  render()
  try {
    const data = await api('POST', '/channels/telegram', {
      token: String(fd.get('token') || '').trim(),
    })
    state.channelBindOpen = false
    await Promise.all([loadChannels(), loadRuntimeBots().catch(() => {})])
    if (data.channel?.status === 'error') flash('err', data.channel.lastError || t('Telegram 长轮询启动失败', 'Telegram polling failed to start'))
    else if (data.deployError) flash('err', t(`渠道已绑定，但 Bot 暂未部署：${data.deployError}`, `Channel connected, but the bot is not deployed yet: ${data.deployError}`))
    else flash('ok', t('Telegram 已绑定，请把页面上的配对码发送给 Bot', 'Telegram connected. Send the pairing code shown on this page to the bot.'))
  } catch (err) {
    state.channelBindError = err.message
  } finally {
    state.busy = false
    render()
  }
}

async function channelAct(act, btn) {
  if (!act || !act.startsWith('channel-')) return false
  if (act === 'channel-refresh') {
    try { await loadChannels() } catch (err) { flash('err', err.message) }
    render(); return true
  }
  if (act === 'channel-copy-code') {
    const c = (state.channels || []).find(c => c.id === btn.getAttribute('data-id'))
    if (!c || c.paired || !c.pairingCode) return true
    const ok = await copyText(c.pairingCode)
    flash(ok ? 'ok' : 'err', ok ? t('配对码已复制，请发送到 Telegram Bot 的私聊。', 'Pairing code copied. Send it in a private chat with your Telegram bot.') : t('复制失败，请选择配对码后手动复制。', 'Copy failed. Select and copy the code manually.'))
    render(); return true
  }
  if (act === 'channel-bind-open') { state.channelBindOpen = true; state.channelBindError = ''; render(); return true }
  if (act === 'channel-bind-close') { state.channelBindOpen = false; state.channelBindError = ''; render(); return true }
  if (act === 'channel-unbind') {
    state.confirm = {
      kind: 'channel-unbind', id: btn.getAttribute('data-id'), title: t('解除 Telegram 绑定？', 'Disconnect Telegram?'),
      body: t('系统会停止长轮询并删除保存的 token；telegram bot 与历史会话会保留。', 'Polling will stop and the saved token will be removed. The Satuwork bot and conversation history stay.'),
      label: t('解除绑定', 'Disconnect'),
    }
    render(); return true
  }
  if (act === 'channel-pair-reset') {
    state.confirm = {
      kind: 'channel-pair-reset', id: btn.getAttribute('data-id'),
      title: t('重新生成配对码？', 'Generate a new pairing code?'),
      body: t('当前已配对的 Telegram 身份会立即失效，必须使用新码重新配对。', 'The currently paired Telegram identity will be revoked immediately and must pair again with the new code.'),
      label: t('生成新配对码', 'Generate new code'),
    }
    render(); return true
  }
  if (act === 'channel-reconnect') {
    state.busy = true; render()
    try {
      await api('POST', `/channels/${encodeURIComponent(btn.getAttribute('data-id'))}/reconnect`, {})
      await loadChannels(); flash('ok', t('Telegram 已重新连接', 'Telegram reconnected'))
    } catch (err) { flash('err', err.message) }
    finally { state.busy = false; render() }
    return true
  }
  return false
}
