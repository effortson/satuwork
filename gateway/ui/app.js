/**
 * 入口。确认框、挂在 #app 上的那几个事件委托、popstate，最后 boot()。
 *
 * **必须最后一个加载**：这里的顶层语句会立刻跑起来，而它们要用到前面所有文件里的东西。
 * index.html 里那串 `data-app-part` 的顺序就是依赖顺序，别调。
 */
/**
 * 一段文本切成站点数组。换行、逗号、分号、空格都当分隔符——从别处粘一份清单进来时，
 * 那几种混着出现是常态。服务端还会逐条归一化（catalog.ts 的 botSiteOf），这里只管切开。
 */
function sitesOf(text) {
  return String(text || '')
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean)
}

/**
 * 改一个账号的状态。「用户」那一页的行上和账号详情页上按的是同一颗。
 *
 * 改完**两份都刷**：详情页开着的时候，只刷列表会让眼前这一页还显示旧状态；只刷详情
 * 则是退回列表之后看见的是旧的。两条都很便宜，各刷各的比记住「现在在哪一页」可靠。
 */
async function setUserStatus(id, next) {
  state.busy = true
  render()
  try {
    await api('PATCH', `/platform/accounts/${encodeURIComponent(id)}`, { status: next })
    await loadUsers().catch(() => {})
    if (state.userDetail?.account?.id === id) await loadUserDetail(id).catch(() => {})
    flash('ok', next === 'disabled' ? t('已停用这个账号', 'Account disabled') : t('已启用这个账号', 'Account enabled'))
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
  }
  render()
}

async function runConfirm() {
  const c = state.confirm
  if (!c) return
  state.confirm = null
  state.menu = null
  try {
    if (c.kind === 'org-status') {
      await api('PATCH', `/orgs/${encodeURIComponent(c.id)}`, { status: c.next })
      await Promise.all([loadOrgs().catch(() => {}), loadCompanyDetail(c.id)])
      flash('ok', c.next === 'disabled' ? '已停用公司' : '已启用公司')
      render()
      return
    } else if (c.kind === 'user-status') {
      await setUserStatus(c.id, c.next)
      return
    } else if (c.kind === 'memory-lift') {
      /**
       * 升层要确认，和删除那颗按钮正好相反：删错了只影响这一个人，推错了是往本公司
       * 每个人的系统提示词里插了一句话（docs/memory.md §12 ⑤）。
       */
      await api('POST', `/runtime/memories/${encodeURIComponent(c.id)}/lift`, { to: 'company' })
      await loadBotDetail(c.bot)
      flash('ok', t('已推给全公司', 'Shared company-wide'))
      render()
      return
    } else if (c.kind === 'redeploy-bot') {
      render()
      // force 而不是 update：这个按钮的意思是「把席位重铺一遍」，不是「升到新版本」。
      // 两者眼下都能穿过 deploy.ts 里那道「已经 ready 就跳过」的门，但借 update 的名义
      // 是在赌它将来不会变成「只在有新版本时才做」——真那样，重新部署会静悄悄失效，
      // 而它恰恰是机器上出了问题时唯一的自助手段。
      await deployMyRuntime(c.id, { force: true })
      return
    } else if (c.kind === 'machine-seat-redeploy') {
      await redeploySeat(c.org, c.account, c.id)
      return
    } else if (c.kind === 'template-redeploy') {
      state.busy = true
      render()
      try {
        const data = await api('POST', `${catalogBase()}/bot-template/redeploy`, {})
        const bad = (data.failed || []).length
        // 没铺到的（这条请求的时间预算用完了）不算失败：它们照样会自己跟上，得说清楚。
        const left = (data.skipped || []).length
        const tail = left ? t(`，还有 ${left} 个没轮到，它们会自己跟上`, `; ${left} not reached — they will catch up on their own`) : ''
        flash(bad ? 'err' : 'ok', bad
          ? t(`${data.ok}/${data.total} 个席位已重铺，${bad} 个失败`, `${data.ok}/${data.total} seats reinstalled, ${bad} failed`) + tail
          : t(`${data.ok} 个席位已重铺`, `${data.ok} seats reinstalled`) + tail)
      } finally {
        state.busy = false
      }
      render()
      return
    } else if (c.kind === 'remove-machine') {
      await doRemoveMachine(machineTarget(c.scope, c.orgId, c.machineId))
      return
    } else if (c.kind === 'vacuum-logs') {
      await doVacuumLogs(machineTarget(c.scope, c.orgId, c.machineId))
      return
    } else if (c.kind === 'delete-bot') {
      const base = catalogBase()
      const data = await api('DELETE', `${base}/bots/${encodeURIComponent(c.id)}`)
      flashDeletedBot(data)
      go('/bots')
      return
    } else if (c.kind === 'delete-my-bot') {
      // 席位在服务端一起拆（见 routes/runtime.ts）。名册要重拉：侧栏那一行得当场消失。
      const data = await api('DELETE', `/runtime/bots/${encodeURIComponent(c.id)}`)
      state.bot = null
      state.botDraft = null
      await loadRuntimeBots().catch(() => {})
      // 删的正是当前对话的那个 Bot 时，正文、会话、桌面和它的流都得跟着走（见
      // chat.js 的 forgetChatBot）。「终审中、稍后自动删」那种它还在名单上，先留着。
      if (!(state.runtimeBots || []).some((b) => b.id === c.id)) {
        forgetChatBot(c.id)
        if (window.__SATUWORK_LOCAL_BOT__?.stop) void window.__SATUWORK_LOCAL_BOT__.stop(c.id).catch(() => {})
      }
      flashDeletedBot(data)
      go('/')
      return
    } else if (c.kind === 'channel-unbind') {
      await api('DELETE', `/channels/${encodeURIComponent(c.id)}`)
      await loadChannels().catch(() => {})
      flash('ok', t('已解除 Telegram 绑定，Bot 与历史会话已保留', 'Telegram disconnected; the bot and history were kept'))
      render()
      return
    } else if (c.kind === 'channel-pair-reset') {
      await api('POST', `/channels/${encodeURIComponent(c.id)}/pairing-code`, {})
      await loadChannels().catch(() => {})
      flash('ok', t('已生成新配对码，旧 Telegram 身份已解除', 'New pairing code created; the old Telegram identity was revoked'))
      render()
      return
    } else if (c.kind === 'clean-seat') {
      await api('DELETE', `/platform/machines/${encodeURIComponent(c.machineId)}/seats/${encodeURIComponent(c.seatId)}`)
      await loadMachineDetail(c.machineId).catch(() => {})
      flash('ok', '席位已清理')
      render()
      return
    } else if (c.kind === 'ws-del') {
      // 自己管提示与重取（见 chat.js 的 deleteWorkspaceEntry）：删完只重取上一层，
      // 而这里的兜底是整页 render——两者一起做的话，那一屏会先闪一次旧内容。
      await deleteWorkspaceEntry(c.path, c.name)
      return
    } else if (c.kind === 'routine-delete') {
      await deleteRoutineNow(c.id)
      return
    } else if (c.kind === 'delete-skill') {
      const base = catalogBase()
      await api('DELETE', `${base}/skills/${encodeURIComponent(c.id)}`)
      closeSkillDialog()
      await loadSkills()
      render()
      return
    } else if (c.kind === 'promote-skill') {
      const base = catalogBase()
      await api('POST', `${base}/skills/${encodeURIComponent(c.id)}/promote`)
      await loadSkills()
      flash('ok', '已转成公司 Skill')
      render()
      return
    } else if (c.kind === 'delete-mcp') {
      const base = catalogBase()
      await api('DELETE', `${base}/mcp-servers/${encodeURIComponent(c.id)}`)
      closeSkillDialog()
      await loadSkills()
      render()
      return
    } else if (c.kind === 'delete-skill-tag') {
      const base = catalogBase()
      const data = await api('DELETE', `${base}/skills/tags/${encodeURIComponent(c.tag)}`)
      state.skillTags = data.tags || []
      if (state.skillForm) state.skillForm.tags = (state.skillForm.tags || []).filter((x) => x !== c.tag)
      render()
      return
    } else if (c.kind === 'delete-credential') {
      // 公司侧删的是本公司那把（平台共用的那把在这儿删不掉，按钮就是灰的）；删完
      // 若平台配了同一家，列表里它会以「平台共用」的身份回来——那正是回落的意思。
      const path = isOwner() ? '/platform/credentials' : `/orgs/${encodeURIComponent(orgId())}/credentials`
      await api('DELETE', `${path}/${encodeURIComponent(c.id)}`)
      delete state.tests[`provider:${c.id}`]
      await Promise.all([loadCreds(), loadCatalog()])
      flash('ok', '已移除密钥')
      render()
      return
    } else if (c.kind === 'delete-custom-provider') {
      try {
        await api('DELETE', `/platform/providers/${encodeURIComponent(c.id)}`)
      } catch (err) {
        // 409 = 有模型角色正在用它。上面那句确认已经把后果说清楚了，直接带 force 再来一次。
        if (err.status !== 409) throw err
        await api('DELETE', `/platform/providers/${encodeURIComponent(c.id)}?force=1`)
      }
      delete state.tests[`provider:${c.id}`]
      state.modelsFor = ''
      await Promise.all([loadCustomProviders(), loadCreds(), loadCatalog(), loadSettings()])
      flash('ok', '已删除自定义供应商')
      render()
      return
    } else if (c.kind === 'delete') {
      await api('DELETE', orgAccountsPath('/' + encodeURIComponent(c.id)))
    } else if (c.kind === 'delete-group') {
      await api('DELETE', orgAccountsPath('/groups/' + encodeURIComponent(c.id)))
    } else if (c.kind === 'disable') {
      await api('PATCH', orgAccountsPath('/' + encodeURIComponent(c.id)), { status: 'disabled' })
    } else if (c.kind === 'enable') {
      await api('PATCH', orgAccountsPath('/' + encodeURIComponent(c.id)), { status: 'active' })
    }
    await loadAccounts()
  } catch (err) {
    flash('err', err.message)
  }
  render()
}

document.getElementById('app').addEventListener('submit', (e) => {
  const form = e.target
  if (!(form instanceof HTMLFormElement)) return
  if (form.id === 'login-form') return onLogin(e)
  if (form.id === 'setup-form') return onSetup(e)
  if (form.id === 'pw-form') return submitPassword(e)
  if (form.id === 'invite-form') return submitInvite(e)
  if (form.id === 'group-form') return submitGroup(e)
  if (form.id === 'edit-member-form') return submitEdit(e)
  if (form.id === 'join-form') return submitJoin(e)
  if (form.id === 'skill-form') return submitSkill(e)
  if (form.id === 'server-form') return submitServer(e)
  if (form.id === 'company-form') return saveCompany(e)
  if (form.id === 'create-org-form') return createOrg(e)
  if (form.id === 'plan-sku-form') return savePlanSku(e)
  if (form.id === 'order-form') return saveOrder(e)
  if (form.id === 'audit-filter-form') return submitAuditFilter(e)
  if (form.id === 'channel-bind-form') return submitChannelBinding(e)
  if (form.id === 'chat-form') {
    e.preventDefault()
    return sendChat()
  }
  const kb = form.getAttribute('data-act')
  if (form.getAttribute('data-form') === 'org-profile') return saveOrgProfile(e)
  if (form.getAttribute('data-form') === 'machine') return saveMachine(e)
  if (form.getAttribute('data-form') === 'machine-direct') return saveMachineDirectUrl(e)
  if (form.getAttribute('data-form') === 'manager-version') return saveManagerVersion(e)
  if (form.getAttribute('data-form') === 'add-release') return addRelease(e)
  if (form.getAttribute('data-form') === 'machine-capacity') return saveCapacity(e)
  if (form.getAttribute('data-form') === 'machine-timezone') return saveTimezone(e)
  if (form.getAttribute('data-form') === 'machine-log-cap') return saveLogCap(e)
  if (form.getAttribute('data-form') === 'machine-company') return saveMachineCompany(e)
  if (form.getAttribute('data-form') === 'cred') {
    e.preventDefault()
    const provider = form.getAttribute('data-provider')
    const credId = form.getAttribute('data-id')
    const secret = String(new FormData(form).get('secret') || '')
    return saveCred(provider, secret, credId)
  }
  if (form.getAttribute('data-form') === 'web-secret') {
    e.preventDefault()
    return saveWebSecret(form.getAttribute('data-provider'), String(new FormData(form).get('secret') || '').trim())
  }
  if (form.getAttribute('data-form') === 'add-cred') {
    e.preventDefault()
    const fd = new FormData(form)
    const provider = String(fd.get('provider') || '').trim()
    const secret = String(fd.get('secret') || '')
    if (!provider) {
      flash('err', '请选择供应商')
      render()
      return
    }
    if (!secret) {
      flash('err', '密钥不能为空')
      render()
      return
    }
    return saveCred(provider, secret)
  }
})

document.getElementById('app').addEventListener('click', async (e) => {
  // 别叫 t——这个处理器里好几处确认文案要用上面那个文案函数。
  const el = e.target instanceof Element ? e.target : e.target.parentElement
  if (state.menu && el && !el.closest('.satu-menu, [data-menu-toggle]')) {
    state.menu = null
    render()
  }
  // 上下文浮层单独收，且**不走 render()**：整页重绘会把输入框换掉，正在打字的人
  // 会丢焦点。点它自己那颗药丸不算「点外面」，否则一次点击开了又立刻关上。
  if (state.chatCtxOpen && el && !el.closest('.sw-ctx')) {
    state.chatCtxOpen = false
    paintChatCtx()
  }
  const btn = el && el.closest('[data-act]')
  if (!btn) return
  if (btn.classList.contains('gw-modal-backdrop') && e.target !== btn) return
  const act = btn.getAttribute('data-act')
  if (await channelAct(act, btn)) return
  // 连接器那一屏的动作都在 pages-connectors.js 里。这条 if 链已经六百多行了，
  // 再往上堆只会让下一个人更难找。
  if (await connectorAct(act, btn)) return
  // 右栏的日常任务同理，都在 pages-routines.js 里。
  if (await routineAct(act, btn)) return
  if (act === 'go') {
    go(btn.getAttribute('data-href'))
    return
  }
  if (act === 'sessions-more') {
    if (state.sessionsLoadingMore || !state.sessionsHasMore) return
    state.sessionsLoadingMore = true
    render()
    loadSessions(true)
      .catch((err) => flash('err', err.message))
      .finally(() => {
        state.sessionsLoadingMore = false
        render()
      })
    return
  }
  if (act === 'chat-open') {
    const id = btn.getAttribute('data-id')
    if (id) go('/a/' + id)
    return
  }
  if (act === 'chat-abort') {
    await abortChat()
    return
  }
  if (act === 'chat-attach') {
    const picker = document.getElementById('chat-file')
    if (picker) picker.click()
    return
  }
  if (act === 'chat-mention-pick') {
    takeMention(btn.getAttribute('data-id'))
    return
  }
  if (act === 'chat-cmd-pick') {
    await takeCommand(btn.getAttribute('data-name'))
    return
  }
  if (act === 'chat-mention-drop') {
    const i = Number(btn.getAttribute('data-i'))
    state.chatMentions = (state.chatMentions || []).filter((_, idx) => idx !== i)
    paintChatMentions()
    return
  }
  if (act === 'chat-approve') {
    await decideApproval(btn.getAttribute('data-call'), 'approve', btn.getAttribute('data-scope') || 'once')
    return
  }
  if (act === 'chat-deny') {
    // 拒绝也有范围：`once` 是只拒这一次，`turn` 是这一轮别再试（见 chat.js 的 approvalActs）。
    await decideApproval(btn.getAttribute('data-call'), 'deny', btn.getAttribute('data-scope') || 'once')
    return
  }
  if (act === 'chat-task-toggle') {
    // 再点一次收起。一批委派里每条各自开合——三条同时摊开，卡片会长到看不见对话。
    const id = btn.getAttribute('data-id') || ''
    state.taskOpen = state.taskOpen || {}
    if (state.taskOpen[id]) delete state.taskOpen[id]
    else state.taskOpen[id] = true
    render()
    return
  }
  if (act === 'chat-skill-delete') {
    /**
     * 把 Bot 刚记下的那条删掉，就在对话里。
     *
     * 走公司目录那条删除接口（管理员也删得掉私有档）。删完只把这张卡标成「已删掉」，
     * **不重拉整条会话**——那条 Skill 已经不在了，而这一块讲的是当时发生了什么。
     */
    const id = btn.getAttribute('data-id') || ''
    const name = btn.getAttribute('data-name') || ''
    const bot = state.chatBotId || chatBotIdOf(state.path)
    if (!id) return
    if (!bot) {
      // 静默 return 的话，人只会以为自己点漏了，然后反复点。
      flash('err', t('这一屏认不出是哪颗 Bot，去 Skill 页面删它', "Can't tell which bot this is — delete it from the Skills page"))
      return
    }
    try {
      await api('DELETE', `/runtime/bots/${encodeURIComponent(bot)}/skills/${encodeURIComponent(id)}`)
      state.skillNoteGone = { ...(state.skillNoteGone || {}), [id]: true }
      flash('ok', t(`已删掉「${name}」`, `Deleted "${name}"`))
    } catch (err) {
      flash('err', err.message)
    }
    render()
    return
  }
  if (act === 'bot-mem-lift') {
    /**
     * 把一条 `self` 记忆推给全公司。**这一条要确认**——和删除那颗按钮正好相反：
     * 删错了只影响这一个人，推错了是往本公司每个人的系统提示词里插了一句话
     * （docs/memory.md §12 ⑤）。**搬家不是复制**，推上去之后它就不在个人那一层了。
     */
    const id = btn.getAttribute('data-id') || ''
    const bot = state.bot?.id || botIdOfPath(state.path)
    const one = (state.botDraft?.memories || []).find((m) => m.id === id)
    if (!id || !bot) return
    state.confirm = {
      title: t('推给全公司？', 'Share company-wide?'),
      body: t(
        // 确认框正文走 esc()，**不渲染 markdown**——写 `**…**` 只会让人看见两串星号。
        `「${(one?.text || '').slice(0, 60)}」会进入本公司每个人的 Bot 提示词，而且不再留在个人这一层：这是搬家，不是复制。`,
        `"${(one?.text || '').slice(0, 60)}" goes into every colleague's bot prompt and no longer stays at the personal layer — it moves, it isn't copied.`,
      ),
      label: t('推给全公司', 'Share'),
      kind: 'memory-lift',
      id,
      bot,
    }
    render()
    return
  }
  if (act === 'bot-mem-del' || act === 'bot-mem-pin' || act === 'bot-mem-renew') {
    /**
     * Bot 设置那一屏上的记忆增删改。
     *
     * **删不做二次确认**，同对话里那颗按钮：一条记错的记忆每一轮都在影响回答，删它
     * 要极其容易（docs/memory.md §12 ②）。改完重拉这一颗 Bot 的详情——那是一条轻请求,
     * 而就地改 state 会让「服务端到底存成了什么」和屏幕上显示的分家。
     */
    const id = btn.getAttribute('data-id') || ''
    const bot = state.bot?.id || botIdOfPath(state.path)
    if (!id || !bot) return
    const cur = (state.botDraft?.memories || []).find((m) => m.id === id)
    /**
     * **找不到那条就什么都别做。** `!cur?.pinned` 在 cur 缺失时恒为 true——点「取消
     * 钉住」反而会把它钉上，而钉住的不占注入上限。草稿对不上多半是另一处刚重拉过，
     * 重画一次让人看见真实的那一份，比替他猜一个动作强。
     */
    if (!cur && act !== 'bot-mem-del') {
      await loadBotDetail(bot).catch(() => {})
      render()
      return
    }
    try {
      if (act === 'bot-mem-del') {
        await api('DELETE', `/runtime/bots/${encodeURIComponent(bot)}/memories/${encodeURIComponent(id)}`)
        flash('ok', t('已删掉，最多一分钟后在对话里生效', 'Deleted — takes effect in conversations within a minute'))
      } else if (act === 'bot-mem-pin') {
        await api('PATCH', `/runtime/bots/${encodeURIComponent(bot)}/memories/${encodeURIComponent(id)}`, { pinned: !cur.pinned })
      } else {
        await api('PATCH', `/runtime/bots/${encodeURIComponent(bot)}/memories/${encodeURIComponent(id)}`, { renew: true })
        flash('ok', t('已续期', 'Renewed'))
      }
      await loadBotDetail(bot)
    } catch (err) {
      flash('err', err.message)
    }
    render()
    return
  }
  if (act === 'chat-memory-delete') {
    /**
     * 把 Bot 刚记下的那条事实删掉，就在对话里。
     *
     * **不做二次确认**：一条记错的记忆每一轮都在影响回答，删它要极其容易
     * （docs/memory.md §12 ②）。删完只把这张卡标成「已删掉」，不重拉整条会话。
     *
     * 那句「最多一分钟后生效」不是客套：席位按目录探针同步，删掉之后它最多还会带着
     * 那条记忆跑一分钟。不说的话，人删完立刻再问一句、看见它还记得，得到的结论是
     * 「删除没用」（§12 ③）。
     */
    const id = btn.getAttribute('data-id') || ''
    const bot = state.chatBotId || chatBotIdOf(state.path)
    if (!id) return
    if (!bot) {
      flash('err', t('这一屏认不出是哪颗 Bot，去 Bot 设置里删它', "Can't tell which bot this is — delete it from the bot's settings"))
      return
    }
    try {
      await api('DELETE', `/runtime/bots/${encodeURIComponent(bot)}/memories/${encodeURIComponent(id)}`)
      state.memNoteGone = { ...(state.memNoteGone || {}), [id]: true }
      flash('ok', t('已删掉，最多一分钟后在对话里生效', 'Deleted — takes effect in the conversation within a minute'))
    } catch (err) {
      flash('err', err.message)
    }
    render()
    return
  }
  if (act === 'chat-task-trace') {
    // 摊开时**不**顺带把过程也拉下来：那是一跳打到席位的请求，而多数时候人只想看结论。
    await loadTaskTrace(btn.getAttribute('data-child'))
    return
  }
  if (act === 'chat-handoff-claim') {
    await actOnHandoff(btn.getAttribute('data-id'), 'claim')
    return
  }
  if (act === 'chat-handoff-return') {
    // `done` 是「照你说的做完了」，`instructions` 是「我换了个做法，你按这个来」。
    // 两句话对模型的意思完全不同（见 policy/handoff.ts 的 returnMessage）。
    await returnHandoff(btn.getAttribute('data-id'), btn.getAttribute('data-disp') || 'done')
    return
  }
  if (act === 'chat-handoff-cancel') {
    await actOnHandoff(btn.getAttribute('data-id'), 'cancel')
    return
  }
  if (act === 'handoff-claim') {
    await actOnHandoff(btn.getAttribute('data-id'), 'claim')
    return
  }
  if (act === 'handoff-detail') {
    const id = btn.getAttribute('data-id') || ''
    // 再点一次收起。展开时才去拉正文——那是一跳打到席位的请求，不该在列表里挨个拉。
    state.handoffOpenId = state.handoffOpenId === id ? '' : id
    render()
    if (state.handoffOpenId) await loadHandoffDetail(id)
    return
  }
  if (act === 'handoff-open') {
    // 交还要写一句话，而那句话该在对话里写——接手的人得先看见 Bot 已经做到哪一步。
    const bot = btn.getAttribute('data-bot')
    if (bot) go('/a/' + encodeURIComponent(bot))
    return
  }
  if (act === 'handoff-scope') {
    state.handoffScope = btn.getAttribute('data-scope') === 'mine' ? 'mine' : 'all'
    render()
    return
  }
  if (act === 'chat-todo-toggle') {
    // 展开 / 折起待办 dock。就地改，不 render()——重绘整页会把输入框里的草稿冲掉。
    toggleChatTodos()
    return
  }
  if (act === 'chat-todo-hide') {
    // 关掉这一张。清单一变它自己回来（见 chat.js 的 chatTodoHidden）。
    hideChatTodos()
    return
  }
  if (act === 'chat-queue-cancel') {
    await cancelQueued(btn.getAttribute('data-id'))
    return
  }
  if (act === 'chat-file-drop') {
    // 传的过程中不让删：删得掉列表项，删不掉已经在路上的请求。
    if (state.chatUploading) return
    const i = Number(btn.getAttribute('data-i'))
    state.chatFiles = (state.chatFiles || []).filter((_, n) => n !== i)
    paintChatFiles()
    return
  }
  if (act === 'chat-preview') {
    await openPreview(btn.getAttribute('data-path') || '', btn.getAttribute('data-name') || '')
    return
  }
  if (act === 'preview-close') {
    closePreview()
    return
  }
  if (act === 'preview-mode') {
    setPreviewMode(btn.getAttribute('data-mode') || 'view')
    return
  }
  if (act === 'preview-download') {
    await downloadWorkspaceFile(btn.getAttribute('data-path') || '', btn.getAttribute('data-name') || '')
    return
  }
  if (act === 'chat-menu') {
    const rect = btn.getBoundingClientRect()
    state.menuFlip = rect.bottom > innerHeight - 260
    state.menu = state.menu === 'chat' ? null : 'chat'
    render()
    return
  }
  if (act === 'chat-export') {
    const bot = chatBotOf()
    const stamp = new Date().toISOString().slice(0, 10)
    downloadFile(((bot && bot.name) || 'chat') + '-' + stamp + '.md', chatExportText(), 'text/markdown;charset=utf-8')
    state.menu = null
    render()
    return
  }
  if (act === 'chat-copy-all') {
    try {
      await navigator.clipboard.writeText(chatExportText())
      flash('ok', '已复制全文')
    } catch {
      flash('err', '复制失败，浏览器不允许')
    }
    state.menu = null
    render()
    return
  }
  if (act === 'chat-reconnect') {
    // 退避认输之后那句「连接断开」上的按钮。人点它的时候，多半是刚看见席位重新部署
    // 完了——比再等一轮自动重试快，也比让人去刷新整页强（刷新会丢草稿和附件）。
    if (!reviveChatStream(state.chatSessionId, state.chatBotId)) {
      // 流其实还活着（重连已经自己成功了，只是这句话还挂着）。把话撤掉就行。
      state.runtimeError = ''
    }
    render()
    return
  }
  if (act === 'chat-ctx') {
    state.chatCtxOpen = !state.chatCtxOpen
    paintChatCtx()
    return
  }
  if (act === 'chat-jump') {
    const thread = document.getElementById('chat-thread')
    // 这一下是人主动点的，滑过去更容易跟上；流式跟随那一路是瞬时的（见 paintChat），
    // 平滑动画会让 nearBottom 在动画途中判成 false，跟随就断了。
    if (thread) thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' })
    return
  }
  // 提示条右上角那颗 ×。撤法和 10 秒到点那一次是同一条（见 data.js 的 dismissFlash）。
  if (act === 'flash-close') {
    dismissFlash()
    return
  }
  if (act === 'aside-toggle') {
    asidePref.open = !asidePref.open
    saveAside()
    render()
    return
  }
  /**
   * 右栏那两颗切屏。**只管换屏，不管开关**——收起是右边那颗自己的事（aside-toggle）。
   * 栏收着的时候点任意一颗，开的就是刚点的那一屏。
   */
  if (act === 'aside-tab') {
    asidePref.open = true
    asidePref.tab = btn.getAttribute('data-tab') === 'files' ? 'files' : 'env'
    saveAside()
    // 目录内容不在这儿取：重绘那一趟自己会补（见 chat.js 的 ensureWorkspaceTree）。
    render()
    return
  }
  if (act === 'ws-dir') {
    await toggleWorkspaceDir(btn.getAttribute('data-path') || '')
    return
  }
  if (act === 'ws-refresh') {
    await refreshWorkspaceTree()
    return
  }
  /**
   * 树上那颗删除。**先弹框**：工作区没有回收站，删掉就没了，而这颗按钮就贴在
   * 「点开预览」那一行的末尾，指头偏一点就是另一件事。
   *
   * 框里要写全名字和后果——目录那句尤其：人点的是一个文件夹图标，脑子里未必装着
   * 它底下那几十个文件。
   */
  if (act === 'ws-del') {
    const path = btn.getAttribute('data-path') || ''
    const name = btn.getAttribute('data-name') || path
    const dir = Boolean(btn.getAttribute('data-dir'))
    state.confirm = {
      title: dir ? t('删掉这个文件夹？', 'Delete this folder?') : t('删掉这个文件？', 'Delete this file?'),
      body: dir
        ? t(
            `「${name}」连同它底下的所有文件都会从工作区里删掉，删掉就找不回来了。`,
            `"${name}" and everything inside it is removed from the workspace. This cannot be undone.`,
          )
        : t(
            `「${name}」会从工作区里删掉，删掉就找不回来了。对话里提到过它的地方点开会变成「文件不存在」。`,
            `"${name}" is removed from the workspace. This cannot be undone, and links to it in the conversation will stop opening.`,
          ),
      label: '删除',
      kind: 'ws-del',
      path,
      name,
    }
    render()
    return
  }
  if (act === 'runtime-redeploy') {
    const id = btn.getAttribute('data-bot') || ''
    const bot = (state.runtimeBots || []).find((b) => b.id === id)
    state.confirm = {
      title: '重新部署这个 Bot？',
      body: t(
        `会把「${(bot && bot.name) || id}」的席位重装一遍并重启。正在进行的对话会断，开着的桌面会掉线；${'\u007e'}/work 里的文件和会话记录不受影响。`,
        `The seat for "${(bot && bot.name) || id}" is reinstalled and restarted. Ongoing conversations drop and any open desktop disconnects; files in ~/work and session history are unaffected.`,
      ),
      label: '重新部署',
      kind: 'redeploy-bot',
      id,
    }
    render()
    return
  }
  if (act === 'runtime-deploy') {
    await deployMyRuntime(btn.getAttribute('data-bot') || '')
    return
  }
  if (act === 'upgrade-bot') {
    await updateOrgRuntime()
    return
  }
  if (act === 'machine-remove') {
    removeMachine(btn)
    return
  }
  if (act === 'upgrade-manager') {
    await upgradeManager(btn)
    return
  }
  if (act === 'machine-load-tab') {
    await switchMachineLoadTab(btn.getAttribute('data-machine'), btn.getAttribute('data-tab'))
    return
  }
  if (act === 'machine-logs-vacuum') {
    vacuumLogs(btn)
    return
  }
  if (act === 'machine-bot-update') {
    await updateMachineRuntime(btn.getAttribute('data-machine'), btn.getAttribute('data-mode') === 'reflow')
    return
  }
  if (act === 'machine-seat-redeploy') {
    const who = btn.getAttribute('data-who') || ''
    const name = btn.getAttribute('data-name') || ''
    state.confirm = {
      title: '重新部署这个席位？',
      /**
       * **代价要写全**：这一颗走的是带打断的 force（和员工侧那颗「重新部署」同一个
       * 语义），正在跑的那一轮会被掐掉，桌面会掉线。批量那颗不打断（它会排空），
       * 所以两处的说辞不一样，不能共用一句。
       */
      body: t(
        `会把「${who}」名下的「${name}」这个席位重装一遍并重启，顺带把它连的 Gateway 地址刷成当前这一份。正在进行的对话会被打断，开着的桌面会掉线；~/work 里的文件和会话记录不受影响。`,
        `The seat running "${name}" for ${who} is reinstalled and restarted, and its Gateway address is refreshed to the current one. Any turn in flight is interrupted and the desktop disconnects; files in ~/work and session history are unaffected.`,
      ),
      label: '重新部署',
      kind: 'machine-seat-redeploy',
      org: btn.getAttribute('data-org') || '',
      account: btn.getAttribute('data-account') || '',
      id: btn.getAttribute('data-bot') || '',
    }
    render()
    return
  }
  if (act === 'machine-filter') {
    state.machineFilter = btn.getAttribute('data-filter') || ''
    // 换了筛选就是换了一份列表，页码得从头来：留在第 3 页的话，筛完只剩两页时人
    // 看到的是一片空白——而他刚点的那一下明明是「给我看这一档」。
    state.listPage.machines = 1
    render()
    return
  }
  if (act === 'list-page') {
    const key = btn.getAttribute('data-key')
    const page = Number(btn.getAttribute('data-page'))
    if (!key || !Number.isFinite(page)) return
    // 只记下来，夹到合法范围是 pageSlice 的事——它才知道现在一共几页。
    state.listPage[key] = Math.max(1, page)
    render()
    return
  }
  if (act === 'machine-refresh') {
    await refreshMachine(btn.getAttribute('data-id'), btn.getAttribute('data-scope') || '')
    return
  }
  if (act === 'user-status') {
    const id = btn.getAttribute('data-id')
    const next = btn.getAttribute('data-next')
    const name = btn.getAttribute('data-name') || id
    if (!id || !next) return
    // 启用不弹确认：它没有会让人后悔的即时后果（席位满了会被服务端 409 挡回来）。
    if (next === 'active') {
      await setUserStatus(id, next)
      return
    }
    state.confirm = {
      title: '停用这个账号？',
      body: t(
        `${name} 手上的登录票会当场作废，下一次请求就被挡回登录页，也不能再登进来。TA 的会话记录和文件都留着，随时可以再启用。`,
        `${name} is signed out immediately — their tokens are revoked and they cannot sign back in. Session history and files are kept; you can re-enable them at any time.`,
      ),
      label: '停用',
      kind: 'user-status',
      id,
      next,
    }
    render()
    return
  }
  if (act === 'seat-open') {
    const id = btn.getAttribute('data-id')
    const member = (state.accounts || []).find((x) => x.id === id)
    if (!member) return
    state.seatMember = member
    state.seatRuntime = null
    state.seatRuntimes = []
    state.seatReveal = false
    state.seatError = ''
    render()
    const org = state.org && state.org.id
    if (!org) return
    try {
      const data = await api('GET', `/platform/orgs/${encodeURIComponent(org)}/accounts/${encodeURIComponent(id)}/runtime`)
      state.seatRuntimes = Array.isArray(data.runtimes) ? data.runtimes : []
      state.seatRuntime = state.seatRuntimes[0] || null
    } catch (err) {
      state.seatError = err.message || '还没有部署'
    }
    render()
    return
  }
  if (act === 'seat-close') {
    state.seatMember = null
    state.seatRuntime = null
    state.seatRuntimes = []
    state.seatReveal = false
    state.seatError = ''
    render()
    return
  }
  if (act === 'machine-tab') {
    state.machineTab = btn.getAttribute('data-tab') === 'bot' ? 'bot' : 'manager'
    render()
    return
  }
  if (act === 'pairing-code') return makePairingCode(btn.getAttribute('data-id'))
  if (act === 'copy-machine-id') {
    const id = btn.getAttribute('data-machine')
    if (id) {
      // 和 copy-install 同一个理由：剪贴板 API 在非 https 的内网页面上会被拒，
      // 失败必须说话——静默复制失败之后人会照着屏幕上那 8 位去用，那不是完整 id。
      navigator.clipboard?.writeText(id).then(
        () => flash('ok', '已复制机器编号'),
        () => flash('err', '复制失败，请手动选中'),
      )
    }
    return
  }
  if (act === 'copy-install') {
    const cmd = state.pairingCode && state.pairingCode.installCommand
    if (cmd) {
      // 剪贴板 API 在非 https 的内网页面上会被拒，所以失败要说话，不能静默。
      navigator.clipboard?.writeText(cmd).then(
        () => flash('ok', '已复制安装命令'),
        () => flash('err', '复制失败，请手动选中命令'),
      )
    }
    return
  }
  if (act === 'copy-release-url') {
    const url = btn.getAttribute('data-url') || ''
    if (!url) return
    const ok = await copyText(url)
    flash(ok ? 'ok' : 'err', ok ? t('已复制') : t('复制失败，请手动选中复制。'))
    render()
    return
  }
  if (act === 'seat-reveal') {
    state.seatReveal = !state.seatReveal
    render()
    return
  }
  if (act === 'chat-older') {
    void loadOlderChat(state.chatSessionId)
    return
  }
  if (act === 'logs-open') {
    const id = btn.getAttribute('data-bot') || ''
    const bot = (state.runtimeBots || []).find((b) => b.id === id)
    openLogs(`${(bot && bot.name) || id} · ${t('席位上的 bot 服务，跟着滚')}`, [
      { key: 'bot', label: t('Bot 运行时'), direct: '/runtime/logs/direct?botId=' + encodeURIComponent(id) },
    ])
    return
  }
  if (act === 'clean-seat') {
    const machineId = btn.getAttribute('data-machine') || ''
    const seatId = btn.getAttribute('data-seat') || ''
    if (!machineId || !seatId) return
    state.confirm = {
      title: '清理这个席位？',
      body: t(
        `它的 Bot 已经删了，机器上那套单元当时没拆掉——${seatId} 还占着一个槽位和一组端口。清理会再拆一次；机器还没恢复的话会失败，隔一会儿再来即可。`,
        `Its bot is already deleted but the units on the machine were never torn down — ${seatId} still holds a slot and its ports. This retries the teardown; if the machine is still down it fails and you can try again later.`,
      ),
      label: '清理',
      kind: 'clean-seat',
      machineId,
      seatId,
    }
    render()
    return
  }
  if (act === 'machine-logs') {
    // 管家自己 + 这台机器上的每个席位。两者回答的问题不一样——部署失败和升级卡住只
    // 写在管家的 journal 里，某一轮为什么不结束只写在 bot 的。
    //
    // 卡片从哪儿来跟着 scope 走：公司详情页手上是 state.machines 里那张，机器管理的
    // 详情页手上是 state.machineDetail。**不能混着找**——两边装的是不同公司的机器，
    // 找错了会开出一张空的日志源清单。清单本身两边同名同义（seatList）。
    const s = machineScope(btn)
    const seatOnly = btn.getAttribute('data-seat') || ''
    const card =
      s.scope === 'platform'
        ? state.machineDetail
        : (state.machines || []).find((m) => m.machine && m.machine.id === s.machineId)
    // 这里拿的不是日志本身，是「去哪儿领票」：面板先问 Gateway 要一张 5 分钟的票和
    // 机器地址，再直接打那台机器（见 chat.js 的 startLogStream）。
    const base = `${s.base}/logs/direct`
    // 拆过的席位（status=none）机器上已经没有那个单元了，日志只会是空的，别列进来。
    const seatList = ((card && card.seatList) || []).filter((x) => x.status !== 'none')
    // 席位行上那颗「日志」是奔着这一个席位去的，别让它开出一张要再挑一次的清单。
    const rows = seatOnly ? seatList.filter((x) => x.seatId === seatOnly) : seatList
    const sources = seatOnly ? [] : [{ key: 'manager', label: t('机器管家'), direct: base }]
    for (const seat of rows) {
      sources.push({
        key: seat.seatId,
        label: `${t('席位')} ${seat.who} · ${seat.seatId}`,
        direct: `${base}?seatId=${encodeURIComponent(seat.seatId)}`,
      })
    }
    openLogs(`${(card && card.machine && card.machine.host) || s.machineId}`, sources)
    return
  }
  if (act === 'logs-close') {
    // journalctl -f 在机器上跟着跑，关面板必须把流掐掉，不然它一直挂着。
    stopLogStream()
    state.logsOpen = null
    state.logLines = []
    state.logError = ''
    render()
    return
  }
  if (act === 'user-secret-reveal') {
    const kind = btn.getAttribute('data-kind')
    if (kind !== 'apiKey' && kind !== 'accessToken') return
    state.userReveal = { ...state.userReveal, [kind]: !state.userReveal[kind] }
    render()
    return
  }
  if (act === 'user-secret-copy') {
    const kind = btn.getAttribute('data-kind')
    const value = kind === 'apiKey' ? state.userDetail?.apiKey : kind === 'accessToken' ? state.userDetail?.accessToken : ''
    if (!value) return
    const ok = await copyText(value)
    if (!ok) flash('err', '复制失败，请手动选中复制。')
    else flash('ok', '已复制')
    render()
    return
  }
  if (act === 'bot-create') {
    const base = catalogBase()
    if (!base) return
    state.busy = true
    render()
    try {
      const data = await api('POST', `${base}/bots`, { name: '新助理' })
      state.busy = false
      go('/bots/' + data.bot.id)
    } catch (err) {
      flash('err', err.message)
      state.busy = false
      render()
    }
    return
  }
  if (act === 'template-save') {
    const base = catalogBase()
    const a = state.templateDraft
    if (!base || !a) return
    state.busy = true
    render()
    try {
      const data = await api('PUT', `${base}/bot-template`, {
        // if-match：服务端拿它跟当前版本比，对不上就 409。两个管理员同时改这一页时，
        // 后保存的那个不会再不声不响地把前一个的改动盖掉（见 routes/bot-template.ts）。
        version: state.template?.version,
        prompt: a.prompt,
        escalate: a.escalate,
        escalateTo: a.escalateTo,
        skills: a.skills,
        mcps: a.mcps,
        guards: Object.fromEntries((a.guards || []).map((g) => [g.id, !!g.on])),
        browser: { on: !!a.browserOn, sites: sitesOf(a.browserSites) },
        // 「让它自己记 Skill」长在模版上，所以只有这一份要发；每颗 Bot 那一屏是只读的。
        selfSkills: a.selfSkills !== false,
        memory: { on: a.memoryOn, scope: a.scope, kinds: a.kinds, ttl: a.ttl, cap: a.cap, confirm: a.confirmOn, pii: a.piiOn },
      })
      state.template = data.template
      // 按回执重建草稿：被归一化过的字段（越界的注入上限、认不出的选项）当场就看得见。
      state.templateDraft = draftFromTemplate(data.template)
      // 保存这一刻同步状态一定是「0 台跟上」，这正是要立刻显示的：版本号跳到新的一版，
      // 不代表席位已经在跑那一版。
      state.templateSync = data.sync || null
      // 刚保存的这一刻一定有人没跟上，轮询从这里起（跟上了、或者数字连着几轮不动，它
      // 自己会停）。
      tplSyncWake()
      flash('ok', t(`已保存，模版现在是 v${data.template.version}`, `Saved — the template is now v${data.template.version}`))
    } catch (err) {
      /**
       * 409 = 别人刚改过。
       *
       * **手上这份草稿一个字都不动**——那是他刚写的东西，为了一次撞车丢掉它最不能接受。
       * 只把「已经生效的是哪一版」更新掉：版本号那一栏当场变新，他再点一次保存就带上
       * 新版本号过去，也就是「我看到了，确认覆盖」。第一次拦下来是为了让他知道，不是
       * 为了拦住他。
       */
      if (err.status === 409) {
        const fresh = await api('GET', `${base}/bot-template`).catch(() => null)
        if (fresh?.template) state.template = fresh.template
        /**
         * **同步那一格也得跟着换。** 只换 template 的话，页面上的版本号跳到了别人刚存的
         * 那一版，而同步状态还是上一版那份快照——于是它会拿旧的「4/4 已同步」去配新的
         * 版本号，显示成「4/4 在 v6」，而此刻一台跑 v6 的席位都没有。这一格恰恰是给人
         * 判断「要不要按立即下发」用的。
         */
        if (fresh) {
          state.templateSync = fresh.sync || null
          tplSyncWake()
        }
        flash('err', t('别人刚改过这份模版。你写的还在，再点一次「保存模版」就是覆盖他的。', 'Someone just changed this template. Your edits are kept — press Save again to overwrite theirs.'))
      } else {
        flash('err', err.message)
      }
    } finally {
      state.busy = false
      render()
    }
    return
  }
  if (act === 'tpl-sync-refresh') {
    // 自动刷新在数字连着几轮不动之后会停（见 tplSyncWant）。这颗按钮既问一次，也把那个
    // 静默计数清零——等于「再盯两分钟」。
    await refreshTemplateSync()
    tplSyncWake()
    return
  }
  if (act === 'template-redeploy') {
    state.confirm = {
      title: '立即下发到全部席位？',
      body: t('公司里已经部署的每个席位都会重铺一遍并重启，正在进行的对话会断。不按它也会在一分钟内自己跟上。', 'Every deployed seat is reinstalled and restarted; ongoing conversations drop. They would pick the change up within a minute anyway.'),
      label: '下发',
      kind: 'template-redeploy',
    }
    render()
    return
  }
  if (act === 'legacy-bot-delete') {
    const id = btn.getAttribute('data-id')
    const name = btn.getAttribute('data-name') || id
    if (!id) return
    state.confirm = {
      title: '删除这个 Bot？',
      body: t(`「${name}」是改版前的公司 Bot，已经停用。删掉之后它的配置不再保留。`, `"${name}" is a disabled pre-template company bot. Deleting drops its config for good.`),
      label: '删除',
      kind: 'delete-bot',
      id,
    }
    render()
    return
  }
  if (act === 'new-bot') {
    state.newBot = { name: '', description: '', extraPrompt: '', icon: 'c-bot', runtimeKind: 'remote' }
    state.newBotError = ''
    render()
    return
  }
  if (act === 'new-bot-close') {
    state.newBot = null
    state.newBotError = ''
    render()
    return
  }
  if (act === 'new-bot-icon') {
    if (!state.newBot) return
    const icon = btn.getAttribute('data-icon')
    if (!avatarKeysFor('company').includes(icon)) return
    state.newBot = { ...state.newBot, icon }
    render()
    return
  }
  if (act === 'new-bot-save') {
    const f = state.newBot
    if (!f) return
    if (!f.name.trim()) {
      state.newBotError = t('助理要有名字', 'Give it a name')
      render()
      return
    }
    state.busy = true
    state.newBotError = ''
    render()
    try {
      const data = await api('POST', '/runtime/bots', {
        name: f.name.trim(),
        description: f.description.trim(),
        extraPrompt: f.extraPrompt.trim(),
        icon: f.icon,
        runtimeKind: f.runtimeKind === 'local' ? 'local' : 'remote',
      })
      state.newBot = null
      state.busy = false
      /**
       * 建完就在装了（服务端顺手开的，见 routes/runtime.ts 的 POST /runtime/bots），
       * 所以这里把那份进度先摆上——**不等第一轮轮询**。差的那两秒里，屏幕上会是一句
       * 「还没有部署」外加一颗按钮，而机器上已经开工了：人多半会去按它。
       */
      state.deployProgress = data.deploy && data.deploy.started
        ? { botId: data.bot.id, status: 'deploying', phase: 'queued', since: Date.now(), lastError: null, step: null }
        : null
      /**
       * 装不成的理由要说出来，**但不能让建 Bot 这件事看起来失败了**：Bot 建好了，
       * 只是这会儿没机器可装（公司还没配机器、没发布过版本、槽位满了）。那一屏上
       * 「还没有部署」底下的那行小字就是给这句话留的。
       */
      state.deployHint = data.deploy && !data.deploy.started && !data.deploy.local ? data.deploy.error || '' : ''
      if (data.bot.runtimeKind === 'local') {
        try {
          await startDesktopLocalBot(data.bot.id)
        } catch (err) {
          state.deployHint = err instanceof Error ? err.message : String(err || t('本地 Bot 启动失败', 'Could not start the local bot'))
        }
      }
      await loadRuntimeBots().catch(() => {})
      // 直接进它的对话页：装好之后那一页会自己变成对话（见 chat.js 的 ensureDeployWatch）。
      go('/a/' + data.bot.id)
    } catch (err) {
      state.newBotError = err.message
      state.busy = false
      render()
    }
    return
  }
  if (act === 'local-bot-start') {
    const id = btn.getAttribute('data-bot') || chatBotIdOf(state.path)
    if (!id) return
    try {
      const status = await startDesktopLocalBot(id)
      if (!(status && status.runtimeUpdateError)) state.deployHint = ''
      await new Promise((resolve) => setTimeout(resolve, 500))
      await loadRuntimeBots()
      await ensureChatSession(id).catch(() => {})
    } catch (err) {
      state.deployHint = err instanceof Error ? err.message : String(err || t('本地 Bot 启动失败', 'Could not start the local bot'))
    }
    render()
    return
  }
  if (act === 'local-dir-approve') {
    const id = btn.getAttribute('data-bot') || chatBotIdOf(state.path)
    const bridge = window.__SATUWORK_LOCAL_BOT__
    if (!id || !bridge || typeof bridge.approveDirectory !== 'function') return
    try {
      const approved = await bridge.approveDirectory(id)
      if (approved) flash('ok', t(`已批准。Bot 可通过 ${approved.mount} 访问这个文件夹。`, `Approved. The bot can access it at ${approved.mount}.`))
    } catch (err) {
      flash('err', err instanceof Error ? err.message : String(err || t('没有批准这个文件夹', 'The folder was not approved')))
    }
    render()
    return
  }
  if (act === 'bot-list-enabled') {
    const base = catalogBase()
    const botId = btn.getAttribute('data-id')
    const cur = (state.bots || []).find((b) => b.id === botId)
    if (!base || !cur) return
    const enabled = !(cur.enabled !== false)
    try {
      const data = await api('PATCH', `${base}/bots/${encodeURIComponent(botId)}`, { enabled })
      state.bots = (state.bots || []).map((b) => (b.id === botId ? data.bot : b))
    } catch (err) {
      flash('err', err.message)
    }
    render()
    return
  }
  if (act === 'bot-enabled') {
    if (!state.botDraft) return
    state.botDraft = { ...state.botDraft, enabled: !state.botDraft.enabled }
    render()
    return
  }
  if (act === 'bot-icon') {
    if (!state.botDraft) return
    const icon = btn.getAttribute('data-icon')
    if (!avatarKeysFor(draftOrigin()).includes(icon)) return
    state.botDraft = { ...state.botDraft, icon }
    render()
    return
  }
  if (act === 'bot-pick') {
    const d = editingDraft()
    if (!d) return
    const key = btn.getAttribute('data-key')
    const value = btn.getAttribute('data-value')
    const cur = Array.isArray(d[key]) ? d[key] : []
    setEditingDraft({ ...d, [key]: cur.includes(value) ? cur.filter((x) => x !== value) : cur.concat(value) })
    render()
    return
  }
  if (act === 'bot-scope') {
    const d = editingDraft()
    if (!d) return
    setEditingDraft({ ...d, scope: btn.getAttribute('data-value') })
    render()
    return
  }
  if (act === 'bot-guard') {
    const d = editingDraft()
    if (!d) return
    const gid = btn.getAttribute('data-id')
    setEditingDraft({ ...d, guards: (d.guards || []).map((g) => (g.id === gid ? { ...g, on: !g.on } : g)) })
    render()
    return
  }
  if (act === 'bot-memory') {
    const d = editingDraft()
    if (!d) return
    setEditingDraft({ ...d, memoryOn: !d.memoryOn })
    render()
    return
  }
  if (act === 'bot-confirm') {
    const d = editingDraft()
    if (!d) return
    setEditingDraft({ ...d, confirmOn: !d.confirmOn })
    render()
    return
  }
  if (act === 'bot-browser') {
    const d = editingDraft()
    if (!d) return
    setEditingDraft({ ...d, browserOn: !d.browserOn })
    render()
    return
  }
  if (act === 'bot-self-skills') {
    const d = editingDraft()
    if (!d) return
    setEditingDraft({ ...d, selfSkills: d.selfSkills === false })
    render()
    return
  }
  if (act === 'bot-pii') {
    const d = editingDraft()
    if (!d) return
    setEditingDraft({ ...d, piiOn: !d.piiOn })
    render()
    return
  }
  if (act === 'bot-save') {
    const base = catalogBase()
    const bot = state.bot
    const a = state.botDraft
    if (!bot || !a) return
    // 自己建的那种：只发身份那几个字段。人设、边界、能力在公司模版里，服务端也不收。
    if (isMyBot(bot)) {
      state.busy = true
      render()
      try {
        const data = await api('PATCH', `/runtime/bots/${encodeURIComponent(bot.id)}`, {
          name: a.name,
          description: a.description,
          greeting: a.greeting,
          extraPrompt: a.extraPrompt || '',
          enabled: a.enabled,
          icon: a.icon,
        })
        state.bot = data.bot
        state.botDraft = { ...draftFromBot(data.bot), extraPrompt: data.bot.extraPrompt || '' }
        await loadRuntimeBots().catch(() => {})
        flash('ok', '已保存')
      } catch (err) {
        flash('err', err.message)
      } finally {
        state.busy = false
        render()
      }
      return
    }
    if (!base) return
    state.busy = true
    render()
    try {
      // model / provider 不发：模型由平台指定，这里没得挑。
      const data = await api('PATCH', `${base}/bots/${encodeURIComponent(bot.id)}`, {
        name: a.name,
        description: a.description,
        prompt: a.prompt,
        greeting: a.greeting,
        escalate: a.escalate,
        escalateTo: a.escalateTo,
        enabled: a.enabled,
        icon: a.icon,
        skills: a.skills,
        mcps: a.mcps,
        guards: Object.fromEntries((a.guards || []).map((g) => [g.id, !!g.on])),
        browser: { on: !!a.browserOn, sites: sitesOf(a.browserSites) },
        memory: { on: a.memoryOn, scope: a.scope, kinds: a.kinds, ttl: a.ttl, cap: a.cap, confirm: a.confirmOn, pii: a.piiOn },
      })
      state.bot = data.bot
      // 存完整份按服务端的回执重建：谁被归一化过（越界的注入上限、认不出的选项）当场就看得见。
      // groups / kbs 还没有落点，先留住手上这份，别一保存就空掉。
      state.botDraft = { ...draftFromBot(data.bot), groups: a.groups, kbs: a.kbs, memories: a.memories }
      flash('ok', '已保存')
    } catch (err) {
      flash('err', err.message)
    } finally {
      state.busy = false
      render()
    }
    return
  }
  if (act === 'bot-delete') {
    const bot = state.bot
    const a = state.botDraft
    if (!bot) return
    state.confirm = {
      title: '删除这个 Bot？',
      /**
       * **「已存记忆」这个说法太宽了。** 跟着这颗 Bot 走的只有它自己那一层
       * （`layer='bot'`）；`self` 那一层是这个人**所有** Bot 共用的一份，删掉销售助理
       * 不该让数据助理忘了他姓什么（docs/memory.md §12 ④）。照原来那句话理解，人会以为
       * 删一颗 Bot 会把自己的称呼、习惯一起抹掉，于是不敢删。
       */
      body: t(`「${(a && a.name) || bot.name}」会先停止接收新任务并完成删除前终审，随后删除人设、能力配置、以及它自己记下的那些事（跨所有 Bot 的那几条留着）；正在用它的定时任务与渠道会失效，审计总结会保留。`, `“${(a && a.name) || bot.name}” will stop taking new work and complete a final audit before its persona, capabilities, and bot-only memories are deleted. Shared memories stay; schedules and channels stop working, and audit summaries are retained.`),
      label: '删除',
      kind: isMyBot(bot) ? 'delete-my-bot' : 'delete-bot',
      id: bot.id,
    }
    render()
    return
  }
  if (act === 'logout') {
    clearToken()
    // 先掐流再清数据：SSE 还连着的话，下一个人登进来之前就会有上一个人的事件继续往
    // state.chatEvents 里落，然后被画出来。聊天正文、草稿、名册都是上一个账号的东西，
    // 同一个标签页换人登录时一条都不能留。
    stopChatStream()
    // 名单那条通道同理，而且更露骨：它一直在往侧栏送**上一个账号**每个 Bot 的
    // 「最近说了什么」，那是正文摘要。票都清了它还连着的话，下一个人登进来的第一屏
    // 就能读到。
    stopRosterStream()
    // 那几根慢速长跑（流的、会话的）比退避链活得久得多，**必须在这里全撤**：票都清了
    // 还在照着上一个人的席位敲接口，就不只是难看了。开一条新流时只撤它自己那一根
    // （cancelIdleRetry），别的 Bot 断着还得有人去接。
    cancelIdleRetries()
    // 挂着「等会话到了就发」的那条也清掉：同一个标签页换人登进来，绝不能把上一个人
    // 打了一半的话补发出去。
    clearHeldSend()
    chatLive.clear()
    state.chatBotId = ''
    state.chatSessionId = ''
    state.chatEvents = []
    state.chatDraft = ''
    // 按 Bot 存的那份草稿、以及发出去还没回执的那几条，同样是上一个账号的东西。
    // 上面那句「一条都不能留」原先漏了这两个：chatDraft 只是当前这一个输入框，
    // chatDrafts 里躺着他在每一个 Bot 上打了一半的话，chatPending 里是正文连同附件。
    state.chatDrafts = {}
    state.chatPending = []
    state.chatStatus = ''
    // 右栏那棵工作区文件树同理，而且它比草稿更露骨：里面是上一个人工作区里的文件名和
    // 目录名（「二季度裁员名单.xlsx」这一类名字本身就是内容）。`wsSession` 是「这棵树
    // 是给哪条会话取的」，跟着一起归零——不清的话，下一个人打开对话页的**第一帧**画的
    // 就是上一个人的清单：那一帧的 HTML 在 render() 末尾那句 ensureWorkspaceTree 之前
    // 就拼好了，而登出这会儿 state.me 已经空了，它自己压根轮不到跑。
    state.wsDirs = {}
    state.wsOpen = {}
    state.wsSession = ''
    state.runtimeBots = []
    state.runtimeError = ''
    state.runtimeMachine = null
    state.desktopRuntime = null
    // 日常任务同理：它带着上一个人的任务名和运行记录，还有一个每四秒一次的轮询。
    state.routines = []
    state.routinesBotId = ''
    state.routineOpen = ''
    state.routineRuns = []
    state.routineError = ''
    syncRoutinePoll()
    // 模版那一页的同步轮询同理：不清掉的话，登出之后它还在每 15 秒问一次。
    state.templateSync = null
    syncTemplatePoll()
    state.me = null
    state.loginError = ''
    state.profileDraft = null
    state.profileSaved = false
    state.profileError = ''
    state.pwOpen = false
    state.pwForm = { current: '', next: '', confirm: '' }
    state.pwError = ''
    state.notifyOff = []
    // 翻到第几页是上一个人的看法，跟聊天正文一样不能留给下一个登进来的人。
    state.listPage = {}
    history.replaceState({}, '', '/')
    state.path = '/'
    render()
    return
  }
  if (act === 'pw-open') {
    state.pwOpen = true
    state.pwForm = { current: '', next: '', confirm: '' }
    state.pwError = ''
    render()
    return
  }
  if (act === 'pw-close') {
    state.pwOpen = false
    state.pwError = ''
    render()
    return
  }
  if (act === 'profile-cancel') {
    state.profileDraft = null
    state.profileSaved = false
    state.profileError = ''
    render()
    return
  }
  if (act === 'profile-save') {
    await saveProfile()
    return
  }
  if (act === 'profile-theme') {
    const mode = btn.getAttribute('data-mode')
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') return
    setTheme(mode)
    render()
    api('PATCH', '/me', { theme: mode }).catch((err) => {
      state.profileError = err.message
      render()
    })
    return
  }
  if (act === 'profile-locale') {
    const key = btn.getAttribute('data-locale')
    if (key !== 'zh' && key !== 'en') return
    setLocale(key)
    render()
    api('PATCH', '/me', { locale: key }).catch((err) => {
      state.profileError = err.message
      render()
    })
    return
  }
  if (act === 'profile-notify') {
    const key = btn.getAttribute('data-notify')
    if (!key) return
    state.notifyOff = state.notifyOff.includes(key) ? state.notifyOff.filter((x) => x !== key) : state.notifyOff.concat(key)
    render()
    return
  }
  if (act === 'rail') {
    state.rail = !state.rail
    render()
    return
  }
  if (act === 'nav-group-toggle') {
    const key = btn.getAttribute('data-group')
    if (!key) return
    state.navGroupOpen = { ...state.navGroupOpen, [key]: state.navGroupOpen[key] === false }
    render()
    return
  }
  if (act === 'add-dialog') return
  if (act === 'add-open') {
    state.addOpen = true
    render()
    return
  }
  if (act === 'add-close') {
    state.addOpen = false
    render()
    return
  }
  if (act === 'discovery-refresh') {
    state.busy = true
    render()
    try {
      const r = await api('POST', '/platform/models/discovery/refresh')
      // 目录本身要跟着重读：补进去的模型现在就该出现在下面那张表里，让人再刷一次
      // 页面才看得见，等于这颗按钮只做了一半。
      await Promise.all([loadDiscovery(), loadCatalog()])
      flash('ok', t(`模型目录已刷新，补进 ${r.added} 个内置目录里没有的模型`, `Catalog refreshed; ${r.added} models added on top of the built-in catalog`))
    } catch (e) {
      flash('err', e.message || '刷新失败')
    } finally {
      state.busy = false
      render()
    }
    return
  }
  if (act === 'set-role') {
    const role = btn.getAttribute('data-role')
    const provider = btn.getAttribute('data-provider')
    const model = btn.getAttribute('data-model')
    await saveSettings({ [role]: { provider, model, reasoningEffort: 'off' } })
    return
  }
  if (act === 'save-cred') {
    const provider = btn.getAttribute('data-provider')
    const credId = btn.getAttribute('data-id')
    const form = document.querySelector(`form[data-form="cred"][data-provider="${CSS.escape(provider)}"]`)
    const secret = form ? String(new FormData(form).get('secret') || '') : ''
    if (!secret) {
      flash('err', '密钥不能为空')
      render()
      return
    }
    await saveCred(provider, secret, credId)
    return
  }
  if (act === 'test-role') {
    await testLlm('role', { role: btn.getAttribute('data-role') })
    return
  }
  if (act === 'test-provider') {
    await testLlm('provider', { provider: btn.getAttribute('data-provider') })
    return
  }
  if (act === 'stats-range') {
    state.statsRange = btn.getAttribute('data-range')
    if (state.statsRange === 'month' && !state.statsMonth) state.statsMonth = thisMonth()
    // 汇总和底下那张计费明细一起换窗口。只刷汇总的话，同一屏上两张表会各说各的时间段。
    await reloadStatsPage()
    return
  }
  if (act === 'prov-new') {
    state.providerDraft = { editing: false, id: '', name: '', baseUrl: '', api: state.customApis?.[0] || 'openai-completions', error: '' }
    render()
    return
  }
  if (act === 'prov-edit') {
    const p = customProvider(btn.getAttribute('data-provider'))
    if (!p) return
    state.providerDraft = { editing: true, id: p.id, name: p.name || '', baseUrl: p.baseUrl || '', api: p.api || 'openai-completions', error: '' }
    render()
    return
  }
  if (act === 'prov-close') {
    state.providerDraft = null
    render()
    return
  }
  if (act === 'prov-save') {
    await saveCustomProvider()
    return
  }
  if (act === 'prov-models') {
    state.modelsFor = btn.getAttribute('data-provider')
    state.modelDraft = null
    state.providerError = ''
    render()
    return
  }
  if (act === 'prov-models-close') {
    state.modelsFor = ''
    state.modelDraft = null
    render()
    return
  }
  if (act === 'prov-model-new') {
    // 缓存那两项默认空：填 0 和「没填」在服务端是一个意思（回落到输入价），
    // 但摆一个 0 在输入框里会让人以为缓存不要钱。
    state.modelDraft = { editing: false, originalId: '', id: '', name: '', contextWindow: 128000, maxTokens: 8192, costInput: 0, costOutput: 0, costCacheRead: '', costCacheWrite: '', reasoning: false, image: false }
    render()
    return
  }
  if (act === 'prov-model-edit') {
    const p = customProvider(state.modelsFor)
    const model = p?.models?.find((m) => m.id === btn.getAttribute('data-model'))
    if (!model) return
    state.modelDraft = {
      editing: true,
      originalId: model.id,
      id: model.id,
      name: model.name || model.id,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      costInput: model.cost?.input ?? 0,
      costOutput: model.cost?.output ?? 0,
      // 服务端用 0 表示「没有单独配置」，表单里还原为空，和新增时的含义一致。
      costCacheRead: model.cost?.cacheRead || '',
      costCacheWrite: model.cost?.cacheWrite || '',
      reasoning: !!model.reasoning,
      image: Array.isArray(model.input) && model.input.includes('image'),
    }
    render()
    return
  }
  if (act === 'prov-model-cancel') {
    state.modelDraft = null
    render()
    return
  }
  if (act === 'prov-model-save') {
    await saveCustomModel()
    return
  }
  if (act === 'model-price') {
    const provider = btn.getAttribute('data-provider')
    const model = btn.getAttribute('data-model')
    const catalog = (state.catalog.find((p) => p.provider === provider)?.models || []).find((m) => m.id === model)?.cost || {}
    const cur = state.settings?.modelPricing?.[`${provider}/${model}`] || {}
    // 覆盖里没有的项留空，不预填目录价——预填之后一按保存，目录价就被抄成了覆盖，
    // 上游再调价也不会跟着动了。占位符里给的才是目录价。
    state.priceDraft = {
      key: `${provider}/${model}`,
      catalog,
      input: cur.input ?? '',
      output: cur.output ?? '',
      cacheRead: cur.cacheRead ?? '',
      cacheWrite: cur.cacheWrite ?? '',
    }
    state.priceError = ''
    render()
    return
  }
  if (act === 'model-price-close') {
    state.priceDraft = null
    render()
    return
  }
  if (act === 'model-price-save') {
    await saveModelPrice()
    return
  }
  if (act === 'model-price-clear') {
    await saveModelPrice(true)
    return
  }
  if (act === 'charges-kind') {
    const next = btn.getAttribute('data-kind') || ''
    if (next === state.chargesKind) return
    state.chargesKind = next
    // 换筛选回第一页：停在第 3 页时改筛选，筛完只剩两页的话那一下是空的。
    resetChargePaging()
    await loadCharges(btn.getAttribute('data-scope'), btn.getAttribute('data-org') || '')
    return
  }
  if (act === 'charges-next') {
    // 在途闸：上一页还没回来就又点一下，游标栈会被压两次，两份响应谁后到谁赢，
    // 页码和内容对不上。按钮在请求中也禁用了（pages-admin.js），这里是第二道。
    if (state.chargesLoading) return
    const cursor = state.charges?.nextCursor
    if (!cursor) return
    state.chargesCursors.push(cursor)
    await loadCharges(btn.getAttribute('data-scope'), btn.getAttribute('data-org') || '')
    return
  }
  if (act === 'charges-prev') {
    if (state.chargesLoading) return
    if (state.chargesCursors.length <= 1) return
    state.chargesCursors.pop()
    await loadCharges(btn.getAttribute('data-scope'), btn.getAttribute('data-org') || '')
    return
  }
  if (act === 'prov-model-del') {
    await deleteCustomModel(btn.getAttribute('data-model'))
    return
  }
  if (act === 'prov-delete') {
    const provider = btn.getAttribute('data-provider')
    const isCustom = btn.getAttribute('data-custom') === '1'
    state.confirm = isCustom
      ? {
          title: t(`删除自定义供应商「${provider}」？`, `Delete custom provider "${provider}"?`),
          body: t(
            `它的模型定义和密钥会一并删除，正在用它的模型角色会被清空。`,
            `Its model definitions and key are deleted; model roles using it are cleared.`,
          ),
          label: '删除',
          kind: 'delete-custom-provider',
          id: provider,
        }
      : isOwner()
        ? {
            title: t(`移除「${provider}」的密钥？`, `Remove the key for "${provider}"?`),
            body: t(
              `密钥删掉之后这家供应商不再出现在列表里，它的模型也调不通了。重新贴一把密钥就能恢复。`,
              `Without a key this provider leaves the list and its models stop working. Paste a key again to restore it.`,
            ),
            label: '移除密钥',
            kind: 'delete-credential',
            id: provider,
          }
        : {
            title: t(`移除本公司「${provider}」的密钥？`, `Remove this company's key for "${provider}"?`),
            body: t(
              `删掉之后这家供应商回落到平台共用密钥；平台也没配的话，它的模型就调不通了。重新贴一把就能恢复。`,
              `After removal this provider falls back to the platform's shared key; if the platform has none either, its models stop working. Paste a key again to restore it.`,
            ),
            label: '移除密钥',
            kind: 'delete-credential',
            id: provider,
          }
    render()
    return
  }
  if (act === 'invite-open') {
    state.inviteOpen = true
    state.inviteLink = ''
    state.inviteCopied = false
    state.inviteError = ''
    state.inviteForm = { name: '', email: '', role: 'member', ttlDays: 7 }
    state.menu = null
    render()
    return
  }
  if (act === 'invite-close') {
    state.inviteOpen = false
    state.inviteLink = ''
    state.inviteError = ''
    loadAccounts().then(render)
    return
  }
  if (act === 'org-create-open') {
    state.orgCreateOpen = true
    state.orgCreateError = ''
    render()
    return
  }
  if (act === 'org-create-close') {
    state.orgCreateOpen = false
    state.orgCreateError = ''
    render()
    return
  }
  if (act === 'order-new') {
    state.orderEdit = { id: '', kind: btn.getAttribute('data-kind') === 'topup' ? 'topup' : 'plan' }
    state.orderError = ''
    render()
    return
  }
  if (act === 'order-edit') {
    const id = btn.getAttribute('data-id') || ''
    // 类型跟着这张单子走：弹窗里的类型下拉是 disabled，提交时表单不会带它。
    const row = (state.orders || []).find((o) => o.id === id)
    state.orderEdit = { id, kind: row?.kind || 'plan' }
    state.orderError = ''
    render()
    return
  }
  if (act === 'order-close') {
    state.orderEdit = null
    state.orderError = ''
    render()
    return
  }
  if (act === 'plan-sku-new') {
    state.planSkuEdit = { id: '' }
    state.planSkuError = ''
    render()
    return
  }
  if (act === 'plan-sku-edit') {
    state.planSkuEdit = { id: btn.getAttribute('data-id') || '' }
    state.planSkuError = ''
    render()
    return
  }
  if (act === 'plan-sku-close') {
    state.planSkuEdit = null
    state.planSkuError = ''
    render()
    return
  }
  if (act === 'org-open') {
    const id = btn.getAttribute('data-id')
    if (id) go('/companies/' + id)
    return
  }
  if (act === 'accounts-tab') {
    state.accountsTab = btn.getAttribute('data-tab') === 'groups' ? 'groups' : 'members'
    render()
    return
  }
  if (act === 'tools-tab') {
    state.toolsTab = btn.getAttribute('data-tab') || 'web'
    render()
    return
  }
  if (act === 'web-test') {
    await testWebBackend(btn.getAttribute('data-kind') === 'extract' ? 'extract' : 'search')
    return
  }
  if (act === 'audit-filter-clear') {
    state.auditAccountId = ''
    state.auditBotId = ''
    state.auditFrom = ''
    state.auditTo = ''
    loadConversationAudits()
      .catch((err) => flash('err', err.message))
      .finally(() => render())
    return
  }
  if (act === 'audit-model-role') {
    const role = btn.getAttribute('data-role') === 'utility' ? 'utility' : 'daily'
    state.busy = true
    render()
    try {
      await saveConversationAuditRole(role)
      flash('ok', role === 'utility' ? '后续审计将使用 UTILITY 模型' : '后续审计将使用任务模型')
    } catch (err) {
      flash('err', err.message)
    } finally {
      state.busy = false
      render()
    }
    return
  }
  if (act === 'billing-tab') {
    const tab = btn.getAttribute('data-tab')
    state.billingTab = ['topup', 'usage'].includes(tab) ? tab : 'sub'
    render()
    return
  }
  if (act === 'billing-autorenew') {
    const cur = state.billingAutoRenew ?? !!state.billing?.plan?.autoRenew
    state.billingAutoRenew = !cur
    render()
    return
  }
  if (act === 'usage-range') {
    state.usageRange = btn.getAttribute('data-range') || '近 30 天'
    // 明细也跟着换窗口——胶囊写着「近 7 天」而底下列着全时段，是两张表在互相拆台。
    reloadUsagePage()
      .then(() => render())
      .catch((err) => {
        flash('err', err.message)
        render()
      })
    return
  }
  if (act === 'group-open') {
    state.groupDialog = {}
    state.groupForm = emptyGroupForm()
    state.groupError = ''
    state.menu = null
    render()
    return
  }
  if (act === 'group-edit') {
    const g = groupById(btn.getAttribute('data-id'))
    if (!g || g.builtin) return
    state.groupDialog = g
    state.groupForm = {
      name: g.name || '',
      desc: g.desc || '',
      icon: g.icon || 'chat',
      role: g.role === 'admin' ? 'admin' : 'member',
      members: Array.isArray(g.members) ? g.members.slice() : [],
    }
    state.groupError = ''
    state.menu = null
    render()
    return
  }
  if (act === 'group-delete') {
    const g = groupById(btn.getAttribute('data-id'))
    if (!g || g.builtin) return
    state.confirm = {
      title: '删除这个分组？',
      body: t(`「${g.name}」删除后，它授权的 Agent 访问范围随之失效。成员账号不受影响。`, `Deleting "${g.name}" revokes the agent access it granted. Member accounts are unaffected.`),
      label: '删除',
      kind: 'delete-group',
      id: g.id,
    }
    state.menu = null
    render()
    return
  }
  if (act === 'group-close') {
    state.groupDialog = null
    state.groupError = ''
    render()
    return
  }
  if (act === 'group-icon') {
    syncGroupForm()
    state.groupForm.icon = btn.getAttribute('data-icon') || 'chat'
    render()
    return
  }
  if (act === 'group-role') {
    syncGroupForm()
    state.groupForm.role = btn.getAttribute('data-role') === 'admin' ? 'admin' : 'member'
    render()
    return
  }
  if (act === 'group-toggle-member') {
    syncGroupForm()
    const id = btn.getAttribute('data-id')
    const cur = state.groupForm.members || []
    state.groupForm.members = cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat(id)
    render()
    return
  }
  if (act === 'edit-open') {
    const m = memberById(btn.getAttribute('data-id'))
    if (!m) return
    state.editing = m
    state.editForm = { name: m.name || '', role: m.role === 'admin' ? 'admin' : 'member', status: m.status || 'active' }
    state.editLink = ''
    state.editCopied = false
    state.menu = null
    render()
    return
  }
  if (act === 'edit-close') {
    state.editing = null
    state.editLink = ''
    render()
    return
  }
  if (act === 'edit-role') {
    if (state.editing && state.editing.id !== memberMeId()) state.editForm.role = btn.getAttribute('data-role')
    render()
    return
  }
  if (act === 'edit-status') {
    if (state.editing && state.editing.id !== memberMeId()) state.editForm.status = btn.getAttribute('data-status')
    render()
    return
  }
  if (act === 'edit-reset') {
    if (state.editing) await resetMember(state.editing.id, true)
    return
  }
  if (act === 'edit-copy') {
    const ok = await copyText(state.editLink)
    state.editCopied = ok
    if (!ok) flash('err', '复制失败，请手动选中上面的链接复制。')
    render()
    return
  }
  if (act === 'menu-toggle') {
    const id = btn.getAttribute('data-id')
    const rect = btn.getBoundingClientRect()
    state.menuFlip = rect.bottom > innerHeight - 260
    state.menu = state.menu === id ? null : id
    render()
    return
  }
  if (act === 'member-reset') {
    await resetMember(btn.getAttribute('data-id'), false)
    return
  }
  if (act === 'member-disable') {
    const m = memberById(btn.getAttribute('data-id'))
    if (!m) return
    state.confirm = {
      title: '停用这名成员？',
      body: t(`「${m.name}」当前的登录会立即失效，之后也无法再登录。历史记录保留。`, `"${m.name}" is signed out immediately and cannot sign in again. History is kept.`),
      label: '已停用',
      kind: 'disable',
      id: m.id,
    }
    state.menu = null
    render()
    return
  }
  if (act === 'member-enable') {
    const m = memberById(btn.getAttribute('data-id'))
    if (!m) return
    state.confirm = {
      title: '恢复这名成员？',
      body: t(`「${m.name}」将可以重新登录。`, `"${m.name}" will be able to sign in again.`),
      label: '已激活',
      kind: 'enable',
      id: m.id,
    }
    state.menu = null
    render()
    return
  }
  if (act === 'member-delete') {
    const m = memberById(btn.getAttribute('data-id'))
    if (!m) return
    state.confirm = {
      title: '删除这名成员？',
      body: t(`「${m.name}」的账号将被删除，登录立即失效。他创建的会话与定时任务保留但不再执行。`, `The account "${m.name}" is deleted and signed out at once. Sessions and scheduled tasks they created remain but stop running.`),
      label: '删除',
      kind: 'delete',
      id: m.id,
    }
    state.menu = null
    render()
    return
  }
  if (act === 'org-status') {
    const id = btn.getAttribute('data-id')
    const next = btn.getAttribute('data-next') === 'disabled' ? 'disabled' : 'active'
    const name = (state.org && state.org.name) || ''
    state.confirm = next === 'disabled'
      ? {
          title: '停用这家公司？',
          body: t(`「${name}」的所有人当场登不进来，手上的票也立刻失效。资料和数据都保留。`, `Everyone at "${name}" is signed out at once and cannot sign in. Data is kept.`),
          label: '停用',
          kind: 'org-status',
          id,
          next,
        }
      : {
          title: '启用这家公司？',
          body: t(`「${name}」的人可以重新登录。`, `People at "${name}" can sign in again.`),
          label: '启用',
          kind: 'org-status',
          id,
          next,
        }
    render()
    return
  }
  if (act === 'confirm-cancel') {
    state.confirm = null
    render()
    return
  }
  if (act === 'confirm-ok') {
    await runConfirm()
    return
  }
  if (act === 'secret-close') {
    state.secret = null
    state.inviteCopied = false
    render()
    return
  }
  if (act === 'secret-copy') {
    const ok = await copyText(state.secret?.url || '')
    state.inviteCopied = ok
    if (!ok) flash('err', '复制失败，请手动选中上面的链接复制。')
    render()
    return
  }
  if (act === 'join-login') {
    history.replaceState({}, '', '/')
    state.path = '/'
    state.joinError = ''
    render()
    return
  }
  if (act === 'skills-tab') {
    state.skillsTab = btn.getAttribute('data-tab') || 'Skill'
    closeSkillDialog()
    render()
    return
  }
  if (act === 'skill-create') {
    closeSkillDialog()
    state.skillDialog = { type: 'skill', item: null }
    state.skillForm = emptySkillForm(null)
    render()
    return
  }
  if (act === 'mcp-create') {
    closeSkillDialog()
    state.skillDialog = { type: 'server', item: null }
    state.skillForm = emptyServerForm(null)
    render()
    return
  }
  if (act === 'skill-close') {
    closeSkillDialog()
    loadSkills().then(render)
    return
  }
  if (act === 'skill-dismiss') {
    state.skillFailure = ''
    render()
    return
  }
  if (act === 'skill-toggle') {
    const base = catalogBase()
    const skillId = btn.getAttribute('data-id')
    const cur = (state.skills || []).find((x) => x.id === skillId)
    if (!base || !cur) return
    const enabled = !(cur.enabled !== false)
    api('PATCH', `${base}/skills/${encodeURIComponent(skillId)}`, { enabled })
      .then((data) => {
        state.skills = (state.skills || []).map((x) => (x.id === skillId ? data.skill : x))
        render()
      })
      .catch((err) => {
        state.skillFailure = err.message
        render()
      })
    return
  }
  if (act === 'mcp-toggle') {
    const base = catalogBase()
    const serverId = btn.getAttribute('data-id')
    const cur = (state.mcpServers || []).find((x) => x.id === serverId)
    if (!base || !cur) return
    const enabled = !(cur.enabled !== false)
    api('PATCH', `${base}/mcp-servers/${encodeURIComponent(serverId)}`, { enabled })
      .then((data) => {
        state.mcpServers = (state.mcpServers || []).map((x) => (x.id === serverId ? data.server : x))
        render()
      })
      .catch((err) => {
        state.skillFailure = err.message
        render()
      })
    return
  }
  if (act === 'skill-edit') {
    const item = (state.skills || []).find((x) => x.id === btn.getAttribute('data-id'))
    if (!item) return
    closeSkillDialog()
    state.skillDialog = { type: 'skill', item }
    state.skillForm = emptySkillForm(item)
    render()
    /**
     * **包里的文件清单只有单条详情才带**（列表那一屏几十条，每条再挂两百行路径就是
     * 几百 KB）。所以弹窗先用列表那份开出来——人点了要立刻看见——再补一次详情把
     * `files` 贴上去。
     *
     * 拉失败就当没有清单：那一格不显示，比一个转不完的圈好；正文和别的字段列表里都有。
     */
    const base = catalogBase()
    if (!base) return
    try {
      const data = await api('GET', `${base}/skills/${encodeURIComponent(item.id)}`)
      const cur = state.skillDialog
      if (!cur || cur.type !== 'skill' || !cur.item || cur.item.id !== item.id) return
      cur.item = { ...cur.item, ...(data.skill || {}) }
      render()
    } catch {
      /* 没有清单就没有清单 */
    }
    return
  }
  if (act === 'mcp-edit') {
    const item = (state.mcpServers || []).find((x) => x.id === btn.getAttribute('data-id'))
    if (!item) return
    closeSkillDialog()
    state.skillDialog = { type: 'server', item }
    state.skillForm = emptyServerForm(item)
    render()
    return
  }
  if (act === 'skill-source') {
    syncSkillForm()
    state.skillForm.source = btn.getAttribute('data-value')
    state.skillFile = null
    state.skillEntries = null
    render()
    return
  }
  if (act === 'seat-skills-toggle') {
    state.seatSkillsOpen = state.seatSkillsOpen !== true
    render()
    return
  }
  if (act === 'skill-promote') {
    const id = btn.getAttribute('data-id')
    const item = (state.skills || []).find((x) => x.id === id)
    state.confirm = {
      title: t('转成公司 Skill？'),
      body: t(
        `「${item ? item.displayName || item.name : ''}」会从「Bot 自己写的」搬进公司目录：全公司的 Bot 都能用，也只有你们能再改它。`,
        'It moves out of the bot\'s own notes into the company catalog: every bot can use it, and only admins can edit it from then on.',
      ),
      label: '转过去',
      kind: 'promote-skill',
      id,
    }
    render()
    return
  }
  if (act === 'skill-seat-delete') {
    const id = btn.getAttribute('data-id')
    const item = (state.skills || []).find((x) => x.id === id)
    state.confirm = {
      title: t('删掉这条？'),
      body: t(
        `「${item ? item.displayName || item.name : ''}」是 Bot 自己记下的做法，删掉之后它不会再照着做。`,
        'This is something the bot noted down itself; after deleting it will no longer follow it.',
      ),
      label: '删掉',
      kind: 'delete-skill',
      id,
    }
    render()
    return
  }
  if (act === 'skill-mode') {
    syncSkillForm()
    state.skillForm.mode = btn.getAttribute('data-value')
    render()
    return
  }
  if (act === 'mcp-kind') {
    syncSkillForm()
    state.skillForm.kind = btn.getAttribute('data-value')
    render()
    return
  }
  if (act === 'mcp-perm') {
    syncSkillForm()
    state.skillForm.perm = btn.getAttribute('data-value')
    render()
    return
  }
  if (act === 'skill-enabled') {
    syncSkillForm()
    state.skillForm.enabled = !state.skillForm.enabled
    render()
    return
  }
  if (act === 'skill-tag-manage') {
    syncSkillForm()
    state.skillTagManage = !state.skillTagManage
    state.skillTagAdding = false
    render()
    return
  }
  if (act === 'skill-tag-pick') {
    syncSkillForm()
    const tag = btn.getAttribute('data-tag')
    const cur = state.skillForm.tags || []
    state.skillForm.tags = cur.includes(tag) ? cur.filter((x) => x !== tag) : cur.concat(tag)
    render()
    return
  }
  if (act === 'skill-tag-add') {
    syncSkillForm()
    state.skillTagAdding = true
    render()
    const el = document.getElementById('sk-tag-draft')
    if (el) el.focus()
    return
  }
  if (act === 'skill-tag-delete') {
    syncSkillForm()
    const tag = btn.getAttribute('data-tag')
    const used = (state.skills || []).filter((x) => (x.tags || []).includes(tag)).length
    state.confirm = {
      title: t(`删除标签「${tag}」？`, `Delete tag "${tag}"?`),
      body: used > 0 ? t(`${used} 个 Skill 正在用它，它们身上这个标签会一起去掉。`, `${used} skills use it; the tag is removed from them too.`) : t('这个标签会从表里删掉。'),
      label: '删除标签',
      kind: 'delete-skill-tag',
      tag,
    }
    render()
    return
  }
  if (act === 'skill-delete') {
    const item = state.skillDialog && state.skillDialog.item
    if (!item) return
    state.confirm = {
      title: '删除这个 Skill？',
      body: t(`「${item.name}」的定义会被删除，用到它的 Agent 将不再有这项方法。`, `The definition of "${item.name}" is deleted; agents using it lose this method.`),
      label: '删除',
      kind: 'delete-skill',
      id: item.id,
    }
    render()
    return
  }
  if (act === 'mcp-delete') {
    const item = state.skillDialog && state.skillDialog.item
    if (!item) return
    state.confirm = {
      title: '移除这台 MCP 服务器？',
      body: t(`「${item.name}」的连接配置与鉴权 token 一并删除。`, `The connection config and auth token for "${item.name}" are deleted.`),
      label: '移除',
      kind: 'delete-mcp',
      id: item.id,
    }
    render()
    return
  }
})

document.getElementById('app').addEventListener('keydown', (e) => {
  const el = e.target
  if (!(el instanceof HTMLInputElement) || el.id !== 'sk-tag-draft') return
  if (e.key === 'Enter') {
    e.preventDefault()
    createSkillTag(el.value)
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    syncSkillForm()
    state.skillTagAdding = false
    render()
  }
})

document.getElementById('app').addEventListener('focusout', (e) => {
  const el = e.target
  if (!(el instanceof HTMLInputElement) || el.id !== 'sk-tag-draft') return
  createSkillTag(el.value)
})

document.getElementById('app').addEventListener('input', (e) => {
  const el = e.target
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return
  // 两份草稿只存在 state 里，边打边收；不 render，否则每敲一个字都会丢焦点。
  if (el.getAttribute('data-act') === 'conn-field' && state.connectorDraft) {
    state.connectorDraft[el.getAttribute('data-field')] = el.value
    // 搜索只重画候选那一块，不整页 render——否则每敲一个字都会丢焦点。
    if (el.getAttribute('data-field') === 'q') paintConnectorPicks()
    return
  }
  // 插件弹窗的搜索框。同样只重画清单那一块，不整页 render。
  if (el.getAttribute('data-act') === 'plugins-field' && state.plugins) {
    state.plugins.q = el.value
    paintPluginList()
    return
  }
  if (el.getAttribute('data-act') === 'prov-field' && state.providerDraft) {
    state.providerDraft[el.getAttribute('data-field')] = el.value
    return
  }
  if (el.getAttribute('data-act') === 'model-field' && state.modelDraft) {
    const f = el.getAttribute('data-field')
    state.modelDraft[f] = el.type === 'checkbox' ? el.checked : el.value
    return
  }
  if (el.getAttribute('data-act') === 'price-field' && state.priceDraft) {
    state.priceDraft[el.getAttribute('data-field')] = el.value
    return
  }
  const nb = el.getAttribute('data-newbot')
  if (nb && state.newBot) {
    state.newBot = { ...state.newBot, [nb]: el.value }
    // 名字、简介这些文字框不能边输入边重画，否则光标会丢；运行位置是一次性的
    // 单选，边框、圆点和底部动作文案都要在点击这一拍同步切换。
    if (nb === 'runtimeKind') render()
    return
  }
  const botField = el.getAttribute('data-bot')
  if (botField && editingDraft()) {
    const d = editingDraft()
    if (botField === 'cap') {
      setEditingDraft({ ...d, cap: Number(el.value) })
      const label = document.querySelector('[data-bot-cap-label]')
      if (label) label.textContent = t(`注入上限 · ${Number(el.value)} 条`, `Injection cap · ${Number(el.value)}`)
      return
    }
    setEditingDraft({ ...d, [botField]: el.value })
    if (botField === 'prompt') {
      const len = document.querySelector('[data-bot-prompt-len]')
      if (len) len.textContent = t(`${el.value.length} 字 · 每轮随上下文注入`, `${el.value.length} chars · injected each turn`)
    }
    return
  }
  if (!(el instanceof HTMLInputElement)) return
  const field = el.getAttribute('data-profile')
  if (field === 'name' || field === 'title' || field === 'phone') {
    const u = state.me?.account || {}
    const cur = state.profileDraft ?? { name: u.name || '', title: u.title || '', phone: u.phone || '' }
    state.profileDraft = { ...cur, [field]: el.value }
    state.profileSaved = false
    paintProfileActions()
    return
  }
  const pw = el.getAttribute('data-pw')
  if (pw === 'current' || pw === 'next' || pw === 'confirm') {
    state.pwForm = { ...state.pwForm, [pw]: el.value }
  }
})

document.getElementById('app').addEventListener('change', async (e) => {
  const el = e.target
  /**
   * 日常任务的名字、指令与用哪个模型。**收在 change 而不是 input 上**：保存都要 render()
   * （列表里那一行、下一次的时间都跟着变），而 render 会把输入框换掉——边打边存
   * 等于每敲一个字丢一次焦点。change 在失焦时才来，那时人已经不在框里了。
   */
  if (
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) &&
    el.getAttribute('data-routine-field')
  ) {
    const id = state.routineOpen
    const key = el.getAttribute('data-routine-field')
    const row = id ? routineOpenRow() : null
    if (row && row[key] !== el.value) await patchRoutine(id, { [key]: el.value })
    return
  }
  // 触发器那一行的四个控件（频率、周几、几号、几点）走同一条路。
  if (el.getAttribute && el.getAttribute('data-routine-trigger')) {
    if (state.routineOpen) editRoutineTrigger(state.routineOpen, Number(el.getAttribute('data-i')), el.getAttribute('data-routine-trigger'), el.value)
    return
  }
  if (el instanceof HTMLInputElement && el.type === 'file' && el.getAttribute('data-skill-file')) {
    await takeSkillFile(el)
    return
  }
  if (el instanceof HTMLInputElement && el.id === 'chat-file') {
    await takeChatFiles(el)
    return
  }
  // 日期选择器：换一天就是换一份数据，直接去拉。**不走表单提交**——一个日期框旁边
  // 再挂一颗「查询」按钮，是让人多点一下才看得到本该跟手出来的东西。
  if (el instanceof HTMLInputElement && el.getAttribute('data-act') === 'machine-load-date') {
    await switchMachineLoadTab(el.getAttribute('data-machine'), null, el.value)
    return
  }
  if (el instanceof HTMLSelectElement && el.getAttribute('data-act') === 'logs-source') {
    switchLogSource(el.value)
    return
  }
  // 换单据类型要整张表单重画（两种单子字段不一样），所以这里走 render()。
  if (el instanceof HTMLSelectElement && el.getAttribute('data-act') === 'order-kind-pick') {
    const form = el.closest('form')
    const fd = form ? new FormData(form) : null
    state.orderEdit = {
      id: '',
      kind: el.value === 'topup' ? 'topup' : 'plan',
      // 两种单子都有的几项留住，其余按新类型的默认值来。
      draft: null,
      companyId: fd ? String(fd.get('companyId') || '') : '',
    }
    render()
    return
  }
  // 换套餐时把金额/席位/赠送/类型带出来。直接写 DOM 而不是 render()——
  // render 会重建表单，把用户已经填好的其他项冲掉。
  if (el instanceof HTMLSelectElement && el.getAttribute('data-act') === 'order-plan-pick') {
    const sku = (state.planSkus || []).find((p) => p.id === el.value)
    const form = el.closest('form')
    if (sku && form) {
      const set = (name, value) => {
        const f = form.querySelector(`[name="${name}"]`)
        if (f) f.value = value
      }
      set('amount', milsOf(sku, 'amount') / 1000)
      set('bonusTokens', milsOf(sku, 'bonus') / 1000)
      set('seats', sku.seats)
      set('period', sku.period || 'month')
    }
    return
  }
  // 工具配置这三样有 input 也有 select，跟倍率一样得排在「只收 select」那道关卡前面。
  if (el.getAttribute?.('data-act') === 'web-backend') {
    const cap = el.getAttribute('data-cap') === 'extract' ? 'extractBackend' : 'searchBackend'
    await saveWebTools({ [cap]: el.value })
    return
  }
  if (el.getAttribute?.('data-act') === 'web-field') {
    await saveWebTools({ [el.getAttribute('data-field')]: el.value.trim() })
    return
  }
  if (el.getAttribute?.('data-act') === 'web-limit') {
    await saveWebLimit(el.value)
    return
  }
  if (el.getAttribute?.('data-act') === 'web-price') {
    await saveWebPrice(el.getAttribute('data-backend'), el.getAttribute('data-kind'), el.value)
    return
  }
  // 倍率是 input，得在下面那道「只收 select」的关卡之前处理。
  if (el instanceof HTMLInputElement && el.getAttribute('data-act') === 'price-multiplier') {
    await savePriceMultiplier(el.value)
    return
  }
  // 月份选择器和公司下拉都在「只收 select」那道关卡的两边，各自处理。
  if (el.getAttribute?.('data-act') === 'stats-month') {
    state.statsMonth = el.value || thisMonth()
    state.statsRange = 'month'
    await reloadStatsPage()
    return
  }
  if (el.getAttribute?.('data-act') === 'stats-company') {
    state.statsCompany = el.value
    await reloadStatsPage()
    return
  }
  // select 和 checkbox 只发 change，草稿字段在这里也收一次。
  if (el.getAttribute?.('data-act') === 'prov-field' && state.providerDraft) {
    state.providerDraft[el.getAttribute('data-field')] = el.value
    return
  }
  if (el.getAttribute?.('data-act') === 'model-field' && state.modelDraft) {
    const f = el.getAttribute('data-field')
    state.modelDraft[f] = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value
    return
  }
  if (!(el instanceof HTMLSelectElement)) return
  const act = el.getAttribute('data-act')
  if (act === 'select-provider') {
    state.selectedProvider = el.value
    render()
    return
  }
  if (act === 'role-provider') {
    const role = el.getAttribute('data-role')
    const provider = el.value
    const p = state.catalog.find((x) => x.provider === provider)
    const model = p?.models[0]?.id || ''
    state.selectedProvider = provider
    await saveSettings({ [role]: { provider, model, reasoningEffort: 'off' } })
    // saveSettings 里那次 render 在前面，改完 selectedProvider 得自己再画一次，
    // 否则下面那张表还停在上一个供应商。
    render()
    return
  }
  if (act === 'role-model') {
    const role = el.getAttribute('data-role')
    const cur = state.settings[role] || {}
    await saveSettings({ [role]: { provider: cur.provider, model: el.value, reasoningEffort: 'off' } })
    return
  }
  if (act === 'role-reasoning') {
    const role = el.getAttribute('data-role')
    const cur = state.settings[role] || {}
    await saveSettings({ [role]: { provider: cur.provider, model: cur.model, reasoningEffort: el.value } })
    return
  }
  if (act === 'bot-ttl') {
    const d = editingDraft()
    if (!d) return
    setEditingDraft({ ...d, ttl: el.value })
  }
})

document.getElementById('app').addEventListener('input', (e) => {
  const el = e.target
  if (!(el instanceof HTMLTextAreaElement) || el.id !== 'chat-input') return
  state.chatDraft = el.value
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  // 光标前面刚打出来的那截 `@xxx` 决定选单开不开。**不 render**：整页重绘会把输入框
  // 换掉，正在打字的人当场丢焦点。
  const hit = mentionQueryAt(el)
  if (hit) void openMentionPick(hit.q)
  else if (state.mentionPick) closeMentionPick()
  // 斜杠命令那一个同理。两个选单不会同时开：`/` 只认输入框最开头，而 `@` 要求前面
  // 是空白或括号——开头那个位置只有 `/` 认得。
  const cmd = commandQueryAt(el)
  if (cmd) openCmdPick(cmd.q)
  else if (state.cmdPick) closeCmdPick()
})

/**
 * Enter 发送，Shift + Enter 换行。
 *
 * **isComposing 必须挡住。** 中文输入法里回车是「选中候选词」，不挡的话打「你好」按回
 * 车，选词的同时把半截话发出去了。keyCode 229 是同一件事的老写法，有的浏览器只给这个。
 */
document.getElementById('app').addEventListener('keydown', (e) => {
  const el = e.target
  if (!(el instanceof HTMLTextAreaElement) || el.id !== 'chat-input') return
  /**
   * `@` 选单开着时，上下键和回车归它——回车是「选中这一个」，不是「把话发出去」。
   * 这一段必须排在下面的发送之前，否则选到一半按回车就把半句话发走了（和输入法那条
   * 是同一类问题）。
   */
  if (state.mentionPick && state.mentionPick.open) {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeMentionPick()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const box = document.getElementById('chat-mentionpick')
      const n = box ? box.querySelectorAll('[data-act="chat-mention-pick"]').length : 0
      if (n) {
        const cur = state.mentionPick.index || 0
        state.mentionPick.index = (cur + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
        paintMentionPick()
      }
      return
    }
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      const box = document.getElementById('chat-mentionpick')
      const hit = box && box.querySelectorAll('[data-act="chat-mention-pick"]')[state.mentionPick.index || 0]
      if (hit) {
        e.preventDefault()
        takeMention(hit.getAttribute('data-id'))
        return
      }
    }
  }
  /**
   * 命令选单开着时同理：上下键选、回车执行、Esc 关。
   *
   * 回车这一支**可以直接落到下面的发送**——sendChat 第一行就认命令（见那儿的注释），
   * 结果一样。但选单开着时人选的可能不是第一条，那就必须由这里接住。
   */
  if (state.cmdPick && state.cmdPick.open) {
    const box = document.getElementById('chat-cmdpick')
    const items = box ? box.querySelectorAll('[data-act="chat-cmd-pick"]') : []
    if (e.key === 'Escape') {
      e.preventDefault()
      closeCmdPick()
      return
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) {
      e.preventDefault()
      const cur = state.cmdPick.index || 0
      state.cmdPick.index = (cur + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length
      paintCmdPick()
      return
    }
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && items.length) {
      const hit = items[state.cmdPick.index || 0]
      /**
       * **标灰的那条不接，也不吞回车**——让它穿到下面的 sendChat 去。
       *
       * 那儿会 parseCommand 认出这条命令、再撞上 `idleOnly && state.chatStatus`，
       * 弹一句「这一轮还在跑，等它跑完再试」。选单右边那行小字容易被忽略，那句 flash
       * 才是人真正会看到的解释。
       *
       * 原来这里是先 preventDefault 再判 disabled：命令不跑、消息不发、一句提示也没有,
       * 人按下回车，屏幕上什么都不会变。
       */
      if (hit && !hit.disabled) {
        e.preventDefault()
        void takeCommand(hit.getAttribute('data-name'))
        return
      }
    }
  }
  if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return
  if (e.isComposing || e.keyCode === 229) return
  e.preventDefault()
  void sendChat()
})

/* Esc 收起上下文浮层。挂在 document 上而不是 #app：浮层开着时焦点多半还在输入框里，
   而输入框自己的 keydown 只管回车。 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !state.chatCtxOpen) return
  state.chatCtxOpen = false
  paintChatCtx()
})

/* Esc 关预览。排在上一条后面：两者不会同时开着，而预览是盖住整屏的那个，
   人按 Esc 时想关的是它。 */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !state.preview) return
  e.preventDefault()
  closePreview()
})

/**
 * 消息流的滚动。scroll 不冒泡，但捕获阶段到得了 document，所以一个监听器就够——
 * 对话页每次重绘都会换掉那个滚动容器，挂在元素上的话得跟着重挂。
 */
document.addEventListener(
  'scroll',
  (e) => {
    const el = e.target
    if (!(el instanceof Element) || el.id !== 'chat-thread') return
    // 人动过滚动条之后，贴底才开始看「是不是本来就在底部」。在这之前一律贴底，
    // 否则刚进页面、内容还没铺满时会停在顶上。
    el.setAttribute('data-touched', '1')
    const jump = document.getElementById('chat-jump')
    if (jump) jump.hidden = nearBottom(el)
    // 翻到顶就自己往前取一页。按钮留着是给「滚不动」的情况兜底（内容还没铺满一屏时
    // 根本触发不了滚动事件），两者共用同一把闩，不会重复请求。
    if (el.scrollTop < 120) void loadOlderChat(state.chatSessionId)
  },
  true,
)

/**
 * 拖右栏改宽度。
 *
 * **拖动期间不重绘**：整页是 innerHTML 整块换掉的，重绘一次就把正在拖的那个元素连同
 * 鼠标捕获一起换掉了，手感会碎成一段一段。所以直接改 main 上的 grid 列宽，松手才落盘。
 */
document.getElementById('app').addEventListener('mousedown', (e) => {
  const grip = e.target instanceof Element ? e.target.closest('[data-act="aside-grip"]') : null
  if (!grip) return
  e.preventDefault()
  const main = document.getElementById('gw-main')
  if (!main) return
  const startX = e.clientX
  const startW = asidePref.width
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  const onMove = (ev) => {
    // 往左拖变宽：栏在右边，所以是起点减当前。
    const next = Math.min(520, Math.max(200, startW + (startX - ev.clientX)))
    asidePref.width = next
    main.style.gridTemplateColumns = `minmax(0, 1fr) ${next}px`
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    saveAside()
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
})

window.addEventListener('popstate', () => {
  if (location.pathname === '/costs') history.replaceState({}, '', '/billing')
  state.path = pathOf()
  state.addOpen = false
  closeMemberUi()
  if (state.path.startsWith('/join/')) {
    loadInvite().then(render)
    return
  }
  loadPage().then(render)
})

async function boot() {
  if (location.pathname === '/costs') history.replaceState({}, '', '/billing')
  state.path = pathOf()
  if (state.path.startsWith('/join/')) {
    await loadInvite()
    render()
    return
  }
  // **不管手上有没有票都先问一次**。票可能是上一套数据留下的（库换了、账号删了），
  // 那时候拿着废票去 /me 只会掉进登录页——而系统里一个账号都没有，那是个死胡同。
  try {
    const st = await api('GET', '/auth/state')
    state.needsSetup = Boolean(st && st.needsSetup)
  } catch {
    // 问不到就按常规走，别把人挡在门外。
  }
  if (state.needsSetup) {
    clearToken()
    state.me = null
    state.loginError = ''
    render()
    return
  }
  if (!token()) {
    render()
    return
  }
  try {
    await loadMe()
    await loadPage()
  } catch {
    clearToken()
    state.me = null
  }
  render()
}

boot()
