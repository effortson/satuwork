/** 渠道事件短租约与 fencing token 探针。由 e2e/channels.mjs 调用。 */
import { randomUUID } from 'node:crypto'
import { Db } from './src/db.ts'

const url = process.env.E2E_DATABASE_URL || 'postgres://satuwork:satuwork@127.0.0.1:5434/satuwork'
const schema = process.env.E2E_CHANNEL_LEASE_SCHEMA || 'e2e_channel_lease'
const db = new Db({ url, schema })

try {
  await db.init()
  const company = await db.insertCompany({ slug: `lease-${randomUUID()}`, name: '渠道租约探针' })
  const account = await db.insertAccount({
    companyId: company.id, email: `lease-${randomUUID()}@example.test`, passwordHash: 'x', role: 'member',
  })
  const bot = await db.insertCatalog({
    kind: 'bot', scope: 'user', companyId: company.id, accountId: account.id, name: 'telegram bot',
  })
  const binding = await db.insertChannelBinding({
    id: randomUUID(), companyId: company.id, accountId: account.id, botId: bot.id,
    kind: 'telegram', status: 'active', externalBotId: `lease-${randomUUID()}`,
    externalUsername: 'lease_probe_bot', credentialCiphertext: 'probe', webhookSecretHash: '',
    publicId: randomUUID(), pairingCodeHash: '', config: { allowGroups: false },
  })
  const inserted = await db.insertChannelEvent({
    bindingId: binding.id, externalEventId: 'update-1', externalConversationId: 'chat-1', text: '你好',
  })
  const id = inserted.event.id
  const base = Date.now()
  const oldToken = randomUUID()
  const newToken = randomUUID()

  const oldClaim = await db.claimChannelEvent(id, base, base + 100, oldToken)
  const oldRenew = await db.renewChannelEventLease(id, oldToken, base + 200)
  const earlyTakeover = await db.claimChannelEvent(id, base + 150, base + 250, newToken)
  const takeover = await db.claimChannelEvent(id, base + 201, base + 301, newToken)
  const staleRenew = await db.renewChannelEventLease(id, oldToken, base + 400)
  const staleCommit = await db.updateClaimedChannelEvent(id, oldToken, {
    status: 'delivered', reply: '旧进程回复', deliveredAt: base + 202,
  })
  const saveReply = await db.updateClaimedChannelEvent(id, newToken, {
    status: 'processing', reply: '接管后的回复', sessionId: 'session-1',
  })
  // 投递进度：只有持有者能推，只增不减，落结果时也不会被抹掉。
  const advance = await db.advanceChannelDelivery(id, newToken, 2, base + 500)
  const staleAdvance = await db.advanceChannelDelivery(id, oldToken, 5, base + 500)
  const backwards = await db.advanceChannelDelivery(id, newToken, 1, base + 500)
  const progress = (await db.channelEvent(id))?.deliveredParts
  const delivered = await db.updateClaimedChannelEvent(id, newToken, {
    status: 'delivered', reply: '接管后的回复', sessionId: 'session-1', deliveredAt: base + 203,
  })
  const row = await db.channelEvent(id)

  console.log('__RESULT__' + JSON.stringify({
    oldClaim, oldRenew, earlyTakeover, takeover, staleRenew, staleCommit, saveReply, delivered,
    advance, staleAdvance, backwards, progress, finalParts: row?.deliveredParts,
    finalStatus: row?.status, finalReply: row?.reply, leaseCleared: row?.leaseUntil === null && row?.leaseToken === '',
  }))
} finally {
  await db.dropSchema().catch(() => {})
  await db.close()
}
