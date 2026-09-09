/**
 * 渠道绑定：用本地 Telegram API 验完整控制面，不依赖公网或真实 token。
 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { rmSync } from 'node:fs'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { createCompany } from './org.mjs'
import { closeServer } from './probe.mjs'
import { runProbe } from './probe.mjs'

const TOKEN = '123456789:telegram-e2e-token-never-store-plain'
const APPROVAL_KEY = 'AbCdEfGhIjKlMnOpQrStUv'
const HANDOFF_ID = '12345678-1234-4234-8234-123456789abc'
const APPROVAL_EMAIL_BODY = [
  'Hi,',
  '',
  '这是一封需要完整展示的审批邮件。',
  `详细内容：${'很长但不能省略。'.repeat(80)}`,
  '',
  '- 第一项',
  '- 第二项',
  '',
  '——完整正文结尾——',
].join('\n')

async function mockSeat() {
  const seen = { messages: [], approvals: [], approved: false, successfulApprovals: 0, handoffActions: [] }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch {}
      const requestUrl = new URL(req.url, 'http://seat.test')
      const path = requestUrl.pathname
      res.setHeader('content-type', 'application/json')
      if (req.method === 'GET' && path === '/api/workspace/file') {
        const artifactPath = requestUrl.searchParams.get('path') || ''
        const artifacts = {
          'reports/eth-report.html': {
            type: 'application/octet-stream',
            body: '<!doctype html><html><body><h1>ETH report</h1><script>document.body.dataset.ready="1"</script></body></html>',
          },
          'reports/eth-report.md': { type: 'text/markdown; charset=utf-8', body: '# ETH report\n\n**Markdown preview**' },
          'reports/eth-report.pdf': { type: 'application/pdf', body: '%PDF-1.4\n% Telegram preview fixture\n%%EOF' },
          'reports/eth-report.txt': { type: 'text/plain; charset=utf-8', body: 'plain text report' },
        }
        const artifact = artifacts[artifactPath]
        if (!artifact) {
          res.statusCode = 404
          res.end(JSON.stringify({ error: `unknown artifact ${artifactPath}` }))
          return
        }
        res.setHeader('content-type', artifact.type)
        res.end(artifact.body)
        return
      }
      if (/\/api\/channels\/[^/]+\/messages$/.test(path)) {
        seen.messages.push(body)
        if (!seen.approved) {
          res.statusCode = 202
          res.end(JSON.stringify({
            status: 'approval', sessionId: 'session-telegram',
            approval: {
              key: APPROVAL_KEY, callId: 'tool-call-secret', name: 'mcp_mail_send',
              arguments: JSON.stringify({ to: 'alice@example.test', subject: '测试' }),
              reason: '即将向外部系统发送内容，需要确认。',
              form: { kind: 'email', tool: 'MAIL_SEND', fields: [
                { key: 'to', label: '收件人', value: 'alice@example.test' },
                { key: 'subject', label: '主题', value: '测试', editable: true },
                { key: 'body', label: '正文', value: APPROVAL_EMAIL_BODY, editable: true, multiline: true },
              ] },
            },
          }))
          return
        }
        res.end(JSON.stringify({
          sessionId: 'session-telegram', reply: '审批通过，操作已经完成。',
          files: [
            { path: 'reports/eth-report.html', name: 'eth-report.html' },
            { path: 'reports/eth-report.md', name: 'eth-report.md' },
            { path: 'reports/eth-report.pdf', name: 'eth-report.pdf' },
            { path: 'reports/eth-report.txt', name: 'eth-report.txt' },
          ],
          handoffs: [{
            id: HANDOFF_ID, state: 'open', reason: '需要人工确认业务流程', ask: '确认测试结果并交还',
            summary: '尚未做任何业务处理', blocking: true, repeats: 0, createdAt: Date.now(), updatedAt: Date.now(),
          }],
        }))
        return
      }
      if (/\/api\/channels\/[^/]+\/approvals\/[A-Za-z0-9_-]+$/.test(path)) {
        seen.approvals.push({ path, body })
        if (seen.approved) {
          res.statusCode = 409
          res.end(JSON.stringify({ error: '这条确认已经结束了' }))
          return
        }
        seen.approved = true
        seen.successfulApprovals += 1
        res.end(JSON.stringify({ ok: true, ...body }))
        return
      }
      const handoffAction = new RegExp(`/api/sessions/session-telegram/handoffs/${HANDOFF_ID}/(claim|return|cancel)$`).exec(path)
      if (handoffAction) {
        const action = handoffAction[1]
        seen.handoffActions.push({ action, body })
        res.end(JSON.stringify({
          ok: true,
          handoff: {
            id: HANDOFF_ID,
            state: action === 'claim' ? 'claimed' : action === 'return' ? 'returned' : 'cancelled',
            claimedBy: body.actor,
            repeats: 0,
            updatedAt: Date.now(),
          },
          ...(action === 'return' ? { resumed: true } : {}),
        }))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: `unknown ${path}` }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` }
}

async function mockTelegram() {
  const seen = {
    deleteWebhook: 0, commands: [], leaveChats: [], sent: [], chatActions: [], polls: [], updates: [],
    callbackAnswers: [], callbackAnswerAttempts: [], editedMarkups: [],
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const url = new URL(req.url, 'http://telegram.test')
      const method = url.pathname.replace(`/bot${TOKEN}/`, '')
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch {}
      const send = (result) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result }))
      }
      if (method === 'getMe') return send({ id: 88776655, is_bot: true, first_name: 'E2E', username: 'satuwork_e2e_bot' })
      if (method === 'deleteWebhook') {
        seen.deleteWebhook += 1
        return send(true)
      }
      if (method === 'setMyCommands') {
        seen.commands = body.commands || []
        return send(true)
      }
      if (method === 'sendMessage') {
        seen.sent.push({ method, ...body })
        return send({ message_id: seen.sent.length })
      }
      if (method === 'sendRichMessage') {
        seen.sent.push({ method, ...body })
        return send({ message_id: seen.sent.length })
      }
      if (method === 'sendChatAction') {
        seen.chatActions.push(body)
        return send(true)
      }
      if (method === 'answerCallbackQuery') {
        seen.callbackAnswerAttempts.push(body)
        if (body.callback_query_id === 'callback-expired') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            ok: false,
            error_code: 400,
            description: 'Bad Request: query is too old and response timeout expired or query ID is invalid',
          }))
          return
        }
        seen.callbackAnswers.push(body)
        return send(true)
      }
      if (method === 'editMessageReplyMarkup') {
        seen.editedMarkups.push(body)
        return send({ message_id: body.message_id })
      }
      if (method === 'leaveChat') {
        seen.leaveChats.push(String(body.chat_id))
        return send(true)
      }
      if (method === 'getUpdates') {
        const offset = Number(body.offset || 0)
        seen.polls.push(body)
        return send(seen.updates.filter((u) => Number(u.update_id) >= offset))
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, description: `unknown ${method}` }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` }
}

async function waitFor(check, label, timeout = 6000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`等不到：${label}`)
}

export async function runChannels({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-channels')
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`
  const schema = schemaOf('e2e_channels')
  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# channels')

  const telegram = await mockTelegram()
  const seat = await mockSeat()
  const gw = start('channels-gw', ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schema,
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
      TELEGRAM_API_BASE: telegram.url,
      GATEWAY_CHANNEL_TICK_MS: '600000',
      GATEWAY_CHANNEL_POLL_SCAN_MS: '250',
      GATEWAY_CHANNEL_POLL_TIMEOUT_SECONDS: '1',
    },
  })
  await waitHttp(`${base}/health`, { child: gw, what: 'channels gateway' })

  let token = ''
  let pairingCode = ''
  let bindingId = ''
  let botId = ''
  try {
    await test('短租约到期后可接管，旧 Gateway 不能续租或覆盖新结果', async () => {
      const result = await runProbe(new URL('..', import.meta.url).pathname, 'gateway/e2e-channel-event-lease.mjs', {
        env: {
          E2E_DATABASE_URL: PG_URL,
          E2E_CHANNEL_LEASE_SCHEMA: schemaOf('e2e_channel_lease'),
          GATEWAY_PG_RESET: '1',
        },
      })
      assert(result.oldClaim && result.oldRenew, `旧进程没有正常认领/续租：${JSON.stringify(result)}`)
      assert(result.earlyTakeover === false, `租约有效期内被提前接管：${JSON.stringify(result)}`)
      assert(result.takeover, `租约到期后没有接管：${JSON.stringify(result)}`)
      assert(result.staleRenew === false && result.staleCommit === false, `旧进程还能续租或回写：${JSON.stringify(result)}`)
      assert(result.saveReply && result.delivered, `接管者没有完成落盘与投递：${JSON.stringify(result)}`)
      assert(result.finalStatus === 'delivered' && result.finalReply === '接管后的回复' && result.leaseCleared,
        `最终状态不对：${JSON.stringify(result)}`)
    })

    await test('绑定 Telegram 时自动创建固定名称 Bot 和一次性配对码，token 不回显', async () => {
      const setup = await req(base, 'POST', '/auth/setup', {
        body: { email: 'owner@channels.test', name: 'owner', password: 'correct-horse-1' },
      })
      assert(setup.status === 201, `setup ${setup.status} ${setup.text}`)
      const company = await createCompany(req, base, {
        ownerToken: setup.json.token,
        email: 'admin@channels.test', password: 'correct-horse-2',
        companyName: 'Channels', slug: 'channels-co', topup: 0,
      })
      token = company.token

      const bound = await req(base, 'POST', '/channels/telegram', {
        token, body: { token: TOKEN, allowGroups: true },
      })
      assert(bound.status === 201, `bind ${bound.status} ${bound.text}`)
      assert(bound.json.channel.status === 'active', `status ${bound.text}`)
      assert(bound.json.channel.bot?.name === 'telegram bot', `Bot 名不对：${bound.text}`)
      assert(bound.json.channel.allowGroups === false, '即使客户端传 allowGroups 也不得开启群聊')
      assert(bound.json.channel.paired === false, '刚绑定不应已经配对')
      assert(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(bound.json.pairingCode), `配对码格式不对：${bound.text}`)
      assert(!bound.text.includes(TOKEN), '响应回显了 Telegram token')
      bindingId = bound.json.channel.id
      botId = bound.json.channel.botId
      pairingCode = bound.json.pairingCode

      assert(telegram.seen.deleteWebhook === 1, '绑定时没有清掉旧 Webhook')
      assert(telegram.seen.commands.map((c) => c.command).join(',') === 'new,tasks,mentions', 'Telegram 私聊命令菜单没有注册完整')
      await waitFor(() => telegram.seen.polls.length > 0, 'Gateway 发起 getUpdates')
      assert(telegram.seen.polls.every((p) => Array.isArray(p.allowed_updates)
        && p.allowed_updates.join(',') === 'message,callback_query,my_chat_member'), '长轮询没有订阅消息、审批回调和 Bot 成员状态')

      const bots = await req(base, 'GET', '/runtime/bots', { token })
      assert(bots.status === 200, `bots ${bots.status} ${bots.text}`)
      assert(bots.json.bots.some((b) => b.id === botId && b.name === 'telegram bot'), '自动创建的 Bot 不在名册里')
      assert(bots.json.bots.find((b) => b.id === botId)?.channel === 'telegram', '名册没有标明 Telegram 渠道归属')

      const require = createRequire(new URL('../gateway/package.json', import.meta.url))
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      try {
        const stored = await client.query(`select "credentialCiphertext","pairingCodeHash" from "${schema}".channel_bindings where id = $1`, [bindingId])
        assert(stored.rowCount === 1, '数据库里没有渠道绑定')
        assert(!stored.rows[0].credentialCiphertext.includes(TOKEN), '数据库明文保存了 Telegram token')
        assert(!stored.rows[0].credentialCiphertext.includes(pairingCode), '数据库明文保存了配对码')
        assert(stored.rows[0].pairingCodeHash !== pairingCode, '配对码摘要列保存了明文')
      } finally { await client.end() }
    })

    await test('未配对消息不入队；私聊输入正确配对码后只接受该 Telegram 身份', async () => {
      const require = createRequire(new URL('../gateway/package.json', import.meta.url))
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      const ownership = await client.query(`select "accountId","companyId" from "${schema}".channel_bindings where id = $1`, [bindingId])
      assert(ownership.rowCount === 1, '找不到渠道所属账号')
      await client.query(
        `insert into "${schema}".instances ("accountId","botId","companyId",host,"lastReadyAt") values ($1,$2,$3,$4,$5)
         on conflict ("accountId","botId") do update set host=excluded.host,"lastReadyAt"=excluded."lastReadyAt"`,
        [ownership.rows[0].accountId, botId, ownership.rows[0].companyId, seat.url, Date.now()],
      )
      telegram.seen.updates.push(
        // 正确码发在群里也不能配对，避免一次性口令被公开。
        { update_id: 9001, message: { message_id: 1, chat: { id: -100, type: 'supergroup', title: '团队群' }, from: { id: 456, is_bot: false, first_name: 'Alice' }, text: pairingCode } },
        { update_id: 9002, message: { message_id: 2, chat: { id: 999, type: 'private' }, from: { id: 999, is_bot: false, first_name: 'Mallory' }, text: '猜错了' } },
        { update_id: 9003, message: { message_id: 3, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false, first_name: 'Alice', username: 'alice' }, text: pairingCode.toLowerCase() } },
      )
      await waitFor(async () => {
        const channels = await req(base, 'GET', '/channels', { token })
        return channels.json.channels?.[0]?.paired === true
      }, 'Telegram 身份完成配对')
      await waitFor(() => telegram.seen.leaveChats.includes('-100'), '私人 Bot 自动退出群聊')

      // 同一个 update 放两次，队列里仍只能有一条；陌生用户和群聊也不能进。
      const hello = { update_id: 9004, message: { message_id: 4, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false, first_name: 'Alice', username: 'alice' }, text: '你好' } }
      telegram.seen.updates.push(hello, hello,
        { update_id: 9005, message: { message_id: 5, chat: { id: 999, type: 'private' }, from: { id: 999, is_bot: false, first_name: 'Mallory' }, text: '盗用' } },
        { update_id: 9006, message: { message_id: 6, message_thread_id: 88, chat: { id: -100, type: 'supergroup', title: '团队群' }, from: { id: 456, is_bot: false, first_name: 'Alice', username: 'alice' }, text: '群里的问题' } },
      )
      try {
        await waitFor(async () => {
          const events = await client.query(`select count(*)::int as n from "${schema}".channel_events where "bindingId" = $1`, [bindingId])
          return events.rows[0].n === 1
        }, '配对后的私聊消息进入队列')
        const events = await client.query(`select "externalConversationId" from "${schema}".channel_events where "bindingId" = $1 order by "externalEventId"`, [bindingId])
        assert(events.rowCount === 1, `重复、陌生用户或群聊 update 入队后共有 ${events.rowCount} 条`)
        assert(events.rows[0].externalConversationId === '456', '私聊会话 id 不对')
        const identities = await client.query(`select * from "${schema}".channel_identities where "bindingId" = $1`, [bindingId])
        assert(identities.rowCount === 1 && identities.rows[0].externalUserId === '456', '配对身份没有正确保存')
      } finally { await client.end() }
      const pairedReply = telegram.seen.sent.find((m) => String(m.rich_message?.markdown || m.text).includes('配对成功'))
      assert(pairedReply, 'Telegram 没收到配对成功提示')
      assert(pairedReply.method === 'sendRichMessage', '出站回复没有使用 Telegram RichMessage')
      assert(typeof pairedReply.rich_message?.markdown === 'string', 'RichMessage 没有传 markdown 内容')
      await waitFor(() => telegram.seen.chatActions.length > 0, 'Telegram 显示正在处理状态')
      assert(telegram.seen.chatActions.some((a) => String(a.chat_id) === '456' && a.action === 'typing'),
        '渠道消息进入处理时没有发送 typing chat action')
    })

    await test('配对用户可在 Telegram 审批，陌生用户不能批，重复点击不会重复执行', async () => {
      const prompt = await waitFor(
        () => telegram.seen.sent.find((m) => String(m.rich_message?.markdown || m.text).includes('需要你的批准')),
        'Telegram 收到审批卡',
      )
      assert(prompt.method === 'sendRichMessage', '审批卡没有使用 RichMessage')
      const promptMarkdown = String(prompt.rich_message?.markdown || '')
      assert(promptMarkdown.includes('### 邮件内容') && promptMarkdown.includes('### 正文'), '邮件审批没有按邮件结构排版')
      assert(promptMarkdown.includes('> Hi,') && promptMarkdown.includes('> - 第一项'), '邮件正文没有保留段落和列表格式')
      assert(promptMarkdown.includes('——完整正文结尾——'), '邮件正文仍被截断')
      assert(!promptMarkdown.includes("'''text"), '邮件正文的 Markdown 围栏仍被破坏')
      const buttons = prompt.reply_markup?.inline_keyboard?.flat() || []
      assert(buttons.length === 4, `审批按钮不是四个：${buttons.length}`)
      assert(buttons.every((b) => Buffer.byteLength(b.callback_data, 'utf8') <= 64), '审批按钮 callback_data 超过 64 字节')

      telegram.seen.updates.push({
        update_id: 9007,
        callback_query: {
          id: 'callback-unauthorized', data: `swa:${APPROVAL_KEY}:a1`, from: { id: 999 },
          message: { message_id: prompt.message_id || 1, chat: { id: 999, type: 'private' } },
        },
      })
      await waitFor(() => telegram.seen.callbackAnswers.find((a) => a.callback_query_id === 'callback-unauthorized'), '陌生用户审批被应答')
      assert(seat.seen.approvals.length === 0, '陌生 Telegram 用户触发了席位审批')

      telegram.seen.updates.push({
        update_id: 9008,
        callback_query: {
          id: 'callback-approved', data: `swa:${APPROVAL_KEY}:a1`, from: { id: 456 },
          message: { message_id: prompt.message_id || 1, chat: { id: 456, type: 'private' } },
        },
      })
      await waitFor(() => seat.seen.successfulApprovals === 1, '席位收到 Telegram 批准')
      await waitFor(() => telegram.seen.sent.some((m) => String(m.rich_message?.markdown || m.text).includes('审批通过，操作已经完成')), '审批后原轮次完成并回复')
      const previewMessages = await waitFor(() => {
        const cards = telegram.seen.sent.filter((m) => m.reply_markup?.inline_keyboard?.[0]?.[0]?.text === '打开预览')
        return cards.length >= 4 ? cards.slice(-4) : null
      }, 'Telegram 收到四种产出文件预览卡')
      for (const card of previewMessages) {
        const url = card.reply_markup.inline_keyboard[0][0].url
        assert(card.link_preview_options?.url === url, '链接预览与按钮不是同一个地址')
      }
      assert(previewMessages.some((m) => String(m.text).includes('eth-report.html')), 'HTML 预览卡没有文件名')
      assert(previewMessages.some((m) => String(m.text).includes('eth-report.md')), 'Markdown 预览卡没有文件名')
      assert(previewMessages.some((m) => String(m.text).includes('eth-report.pdf')), 'PDF 预览卡没有文件名')
      assert(previewMessages.some((m) => String(m.text).includes('eth-report.txt')), 'TXT 预览卡没有文件名')

      // 模拟 Bot 正常上报的会话索引，使签名链接能沿会话归属找到同一席位。
      const require = createRequire(new URL('../gateway/package.json', import.meta.url))
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      try {
        const binding = await client.query(
          `select "accountId","companyId","botId" from "${schema}".channel_bindings where id=$1`,
          [bindingId],
        )
        const owner = binding.rows[0]
        await client.query(
          `insert into "${schema}".session_index
           ("sessionId","companyId","accountId","botId",origin,"messageCount",title,"createdAt","updatedAt")
           values ($1,$2,$3,$4,'user',1,'Telegram',$5,$5)
           on conflict ("sessionId") do nothing`,
          ['session-telegram', owner.companyId, owner.accountId, owner.botId, Date.now()],
        )
      } finally { await client.end() }

      const previews = new Map()
      for (const message of previewMessages) {
        const previewUrl = message.reply_markup.inline_keyboard[0][0].url
        const filename = String(message.text).match(/eth-report\.(?:html|md|pdf|txt)/)?.[0]
        assert(filename, `预览卡文件名无法识别：${message.text}`)
        const preview = await fetch(previewUrl, { headers: { accept: 'text/html' } })
        const previewHtml = await preview.text()
        assert(preview.status === 200, `预览链接 ${preview.status} ${previewHtml}`)
        assert(previewHtml.includes('class="gw-modal sw-preview sw-channel-preview"'), `${filename} 没有使用系统预览窗口`)
        assert(previewHtml.includes('/channel-preview.js') && previewHtml.includes('/markdown.js'), `${filename} 没有加载预览运行时`)
        assert(preview.headers.get('referrer-policy') === 'no-referrer', `${filename} 没有阻止签名票随 referrer 外泄`)
        assert(String(preview.headers.get('content-security-policy')).includes("frame-src blob:"), `${filename} 没有限制预览 frame 来源`)
        previews.set(filename, { url: previewUrl, html: previewHtml })
      }

      assert(previews.get('eth-report.html')?.html.includes('data-kind="html"'), 'HTML 预览类型不对')
      assert(previews.get('eth-report.md')?.html.includes('data-kind="markdown"'), 'Markdown 预览类型不对')
      assert(previews.get('eth-report.pdf')?.html.includes('data-kind="pdf"'), 'PDF 预览类型不对')
      assert(previews.get('eth-report.txt')?.html.includes('data-kind="text"'), 'TXT 预览类型不对')
      assert((previews.get('eth-report.md')?.html.match(/data-mode=/g) || []).length === 2, 'Markdown 没有预览/原文双模式')

      const expectedRaw = new Map([
        ['eth-report.html', '<h1>ETH report</h1>'],
        ['eth-report.md', '**Markdown preview**'],
        ['eth-report.pdf', '%PDF-1.4'],
        ['eth-report.txt', 'plain text report'],
      ])
      for (const [filename, expected] of expectedRaw) {
        const raw = await fetch(`${previews.get(filename).url}?raw=1`)
        const rawBody = await raw.text()
        assert(raw.status === 200 && rawBody.includes(expected), `${filename} 原始文件读取失败：${raw.status} ${rawBody}`)
        if (filename.endsWith('.pdf')) assert(raw.headers.get('content-type') === 'application/pdf', 'PDF 原始响应类型不对')
      }

      const previewRuntime = await fetch(`${base}/channel-preview.js`)
      const previewRuntimeJs = await previewRuntime.text()
      assert(previewRuntime.status === 200 && previewRuntimeJs.includes("kind === 'markdown'"), '独立预览运行时没有发布')
      assert(previewRuntimeJs.includes("iframe.setAttribute('sandbox', '')"), 'HTML 预览没有放进无权限 sandbox')

      const parsedPreview = new URL(previews.get('eth-report.html').url)
      const pieces = parsedPreview.pathname.split('/')
      const signatureAt = pieces[2].lastIndexOf('.') + 1
      const signatureHead = pieces[2][signatureAt]
      pieces[2] = `${pieces[2].slice(0, signatureAt)}${signatureHead === 'a' ? 'b' : 'a'}${pieces[2].slice(signatureAt + 1)}`
      parsedPreview.pathname = pieces.join('/')
      const tampered = await fetch(parsedPreview)
      assert(tampered.status === 404, `篡改后的预览票仍拿到 ${tampered.status}`)
      assert(seat.seen.approvals[0].body.decision === 'approve' && seat.seen.approvals[0].body.scope === 'once', '批准范围传错')
      assert(telegram.seen.callbackAnswers.some((a) => a.callback_query_id === 'callback-approved' && String(a.text).includes('已批准')), '批准回调没有应答')
      assert(telegram.seen.editedMarkups.some((m) => Array.isArray(m.reply_markup?.inline_keyboard) && m.reply_markup.inline_keyboard.length === 0), '审批完成后没有移除按钮')

      telegram.seen.updates.push({
        update_id: 9009,
        callback_query: {
          id: 'callback-duplicate', data: `swa:${APPROVAL_KEY}:a1`, from: { id: 456 },
          message: { message_id: prompt.message_id || 1, chat: { id: 456, type: 'private' } },
        },
      })
      await waitFor(() => telegram.seen.callbackAnswers.find((a) => a.callback_query_id === 'callback-duplicate'), '重复审批被应答')
      assert(seat.seen.successfulApprovals === 1, '重复点击导致二次批准')
      assert(telegram.seen.callbackAnswers.some((a) => a.callback_query_id === 'callback-duplicate' && String(a.text).includes('已经结束')), '重复点击没有提示审批已结束')
    })

    await test('Telegram 转人工卡可接手，并通过回复输入把结论交还原工单', async () => {
      const card = await waitFor(
        () => telegram.seen.sent.find((m) => m.reply_markup?.inline_keyboard?.flat()
          ?.some((button) => String(button.callback_data).startsWith(`swh:${HANDOFF_ID}:`))),
        'Telegram 收到转人工卡',
      )
      const cardButtons = card.reply_markup.inline_keyboard.flat()
      assert(cardButtons.length === 4, `转人工卡不是四个动作：${JSON.stringify(cardButtons)}`)
      assert(String(card.rich_message?.markdown || card.text).includes('确认测试结果并交还'), '转人工卡没有显示要人工做的事')
      const cardMessageId = telegram.seen.sent.indexOf(card) + 1

      // 生产里这行由席位 handoff outbox 上报；mock 席位不会主动推，所以在此补齐事实索引。
      const require = createRequire(new URL('../gateway/package.json', import.meta.url))
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      try {
        const binding = await client.query(
          `select "accountId","companyId","botId" from "${schema}".channel_bindings where id=$1`,
          [bindingId],
        )
        const owner = binding.rows[0]
        const now = Date.now()
        await client.query(
          `insert into "${schema}".handoffs
           (id,"sessionId","botId","accountId","companyId","machineId",state,assignee,"claimedBy",blocking,repeats,reason,ask,"notifyStep","createdAt","claimedAt","returnedAt","closedAt","updatedAt")
           values ($1,'session-telegram',$2,$3,$4,null,'open',$3,null,true,0,$5,$6,0,$7,null,null,null,$7)`,
          [HANDOFF_ID, owner.botId, owner.accountId, owner.companyId, '需要人工确认业务流程', '确认测试结果并交还', now],
        )
      } finally { await client.end() }

      telegram.seen.updates.push({
        update_id: 9010,
        callback_query: {
          id: 'handoff-claim', data: `swh:${HANDOFF_ID}:c`, from: { id: 456 },
          message: { message_id: cardMessageId, chat: { id: 456, type: 'private' } },
        },
      })
      await waitFor(() => seat.seen.handoffActions.some((row) => row.action === 'claim'), '席位收到接手动作')
      assert(telegram.seen.callbackAnswers.some((a) => a.callback_query_id === 'handoff-claim' && String(a.text).includes('已由你接手')),
        '接手回调没有得到明确应答')

      telegram.seen.updates.push({
        update_id: 9011,
        callback_query: {
          id: 'handoff-done', data: `swh:${HANDOFF_ID}:d`, from: { id: 456 },
          message: { message_id: cardMessageId, chat: { id: 456, type: 'private' } },
        },
      })
      const prompt = await waitFor(
        () => telegram.seen.sent.find((m) => String(m.text || '').includes(`[satuwork-handoff:${HANDOFF_ID}:done:${cardMessageId}]`)),
        'Telegram 弹出人工结论回复框',
      )
      assert(prompt.reply_markup?.force_reply === true, '处理完了没有使用 Telegram ForceReply')
      const ordinaryMessagesBefore = seat.seen.messages.length
      telegram.seen.updates.push({
        update_id: 9012,
        message: {
          message_id: 12, chat: { id: 456, type: 'private' },
          from: { id: 456, is_bot: false, first_name: 'Alice', username: 'alice' },
          text: '已经确认测试结果正常，可以继续。',
          reply_to_message: { message_id: telegram.seen.sent.indexOf(prompt) + 1, text: prompt.text },
        },
      })
      const returned = await waitFor(
        () => seat.seen.handoffActions.find((row) => row.action === 'return'),
        '人工结论交还席位',
      )
      assert(returned.body.disposition === 'done' && returned.body.text === '已经确认测试结果正常，可以继续。',
        `交还内容不对：${JSON.stringify(returned)}`)
      assert(seat.seen.messages.length === ordinaryMessagesBefore, '人工结论又作为普通消息触发了第二轮')
      /**
       * 这两样都要**等**，不能在 return 落到席位的那一刻直接断言。
       *
       * 上面那个 waitFor 等的是「结论交还给席位」，而移除按钮和回一句确认是之后才发生的
       * 两件事——本机跑得快，两者几乎同时到，在 CI 上就成了随机红。这条用例在 CI 上正是
       * 挂在最后那句提示上，而前面几条全绿：交还确实成功了，只是话还没说出口。
       */
      await waitFor(
        () => telegram.seen.editedMarkups.find((m) => Number(m.message_id) === cardMessageId
          && m.reply_markup?.inline_keyboard?.length === 0),
        '交还后移除原转人工按钮',
      )
      await waitFor(
        () => telegram.seen.sent.find((m) => String(m.rich_message?.markdown || m.text).includes('已把处理结论交还给 Bot')),
        '交还成功后在 Telegram 明确提示',
      )
    })

    await test('过期审批回调不能毒死长轮询，后续私聊继续入队', async () => {
      const before = seat.seen.messages.length
      telegram.seen.updates.push(
        {
          update_id: 9020,
          callback_query: {
            id: 'callback-expired', data: `swa:${APPROVAL_KEY}:a1`, from: { id: 456 },
            message: { message_id: 1, chat: { id: 456, type: 'private' } },
          },
        },
        {
          update_id: 9021,
          message: {
            message_id: 11, chat: { id: 456, type: 'private' },
            from: { id: 456, is_bot: false, first_name: 'Alice', username: 'alice' },
            text: '过期按钮后面的正常消息',
          },
        },
      )
      await waitFor(() => telegram.seen.callbackAnswerAttempts.some((a) => a.callback_query_id === 'callback-expired'), '过期审批回调被处理')
      await waitFor(() => seat.seen.messages.length > before, '过期回调之后的正常消息送到席位')

      const require = createRequire(new URL('../gateway/package.json', import.meta.url))
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      try {
        const row = await waitFor(async () => {
          const result = await client.query(
            `select "pollOffset","pollLastError",status from "${schema}".channel_bindings where id=$1`,
            [bindingId],
          )
          return Number(result.rows[0]?.pollOffset) >= 9022 ? result.rows[0] : null
        }, '长轮询游标越过毒消息')
        assert(Number(row.pollOffset) >= 9022, `游标仍卡在 ${row.pollOffset}`)
        assert(row.status === 'active', `过期回调把整个渠道标成了 ${row.status}`)
        assert(row.pollLastError == null, `成功处理后仍留着轮询错误：${row.pollLastError}`)
      } finally { await client.end() }
    })

    await test('重新生成配对码会撤销旧身份', async () => {
      const reset = await req(base, 'POST', `/channels/${bindingId}/pairing-code`, { token, body: {} })
      assert(reset.status === 200, `reset pairing ${reset.status} ${reset.text}`)
      assert(reset.json.pairingCode !== pairingCode, '重新生成后配对码没有变化')
      assert(reset.json.channel.paired === false, '旧身份没有解除')
      assert(reset.json.channel.pairingCode === reset.json.pairingCode, '页面接口拿不到新配对码')
    })

    await test('同一账号不能重复绑定；解绑清渠道但保留 Bot', async () => {
      const duplicate = await req(base, 'POST', '/channels/telegram', { token, body: { token: TOKEN } })
      assert(duplicate.status === 409, `重复绑定拿到 ${duplicate.status} ${duplicate.text}`)

      const removed = await req(base, 'DELETE', `/channels/${bindingId}`, { token })
      assert(removed.status === 200, `unbind ${removed.status} ${removed.text}`)
      const channels = await req(base, 'GET', '/channels', { token })
      assert(channels.status === 200 && channels.json.channels.length === 0, `渠道没清掉：${channels.text}`)
      const bots = await req(base, 'GET', '/runtime/bots', { token })
      assert(bots.json.bots.some((b) => b.id === botId), '解绑不应顺手删除历史 Bot')
    })
  } finally {
    gw.kill()
    await closeServer(telegram.server, 'telegram mock')
    await closeServer(seat.server, 'seat mock')
    // 自己的数据目录自己收。
    rmSync(GW_HOME, { recursive: true, force: true })
  }
}
