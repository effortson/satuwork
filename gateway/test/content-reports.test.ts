import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { Db } from '../src/db.ts'
import { Router } from '../src/http.ts'
import { signJwt, type JwtKeys } from '../src/crypto.ts'
import { attachContentReports } from '../src/routes/content-reports.ts'
import type { RouteCtx } from '../src/routes/ctx.ts'
import { attachV1 } from '../src/v1.ts'

test('report API enforces consent, session and role boundaries, rate limits, review persistence and retention', async () => {
  const db = new Db({ url: process.env.E2E_DATABASE_URL || 'postgres://satuwork:satuwork@127.0.0.1:5434/satuwork', schema: 'sw_reports_' + process.pid + '_' + randomUUID().replaceAll('-', '').slice(0, 8) })
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const keys: JwtKeys = { kid: 'test', privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  const router = new Router()
  attachContentReports(router, { db, keys } as RouteCtx)
  attachV1(router, db, keys, { find: async () => undefined } as any, {} as any)
  const server = createServer((req, res) => void router.handle(req, res))
  try {
    await db.init()
    const company = await db.insertCompany({ slug: 'reports-test', name: 'Report test company' })
    const member = await db.insertAccount({ companyId: company.id, email: 'member@example.test', passwordHash: 'unused', role: 'member', status: 'active' })
    const stranger = await db.insertAccount({ companyId: company.id, email: 'stranger@example.test', passwordHash: 'unused', role: 'member', status: 'active' })
    const owner = await db.insertAccount({ companyId: null, email: 'owner@example.test', passwordHash: 'unused', role: 'owner', status: 'active' })
    const bot = await db.insertCatalog({ kind: 'bot', scope: 'user', companyId: company.id, accountId: member.id, name: 'Demo bot' })
    const foreign = await db.insertCatalog({ kind: 'bot', scope: 'user', companyId: company.id, accountId: stranger.id, name: 'Private bot' })
    const token = (a: typeof member) => signJwt(keys, { sub: a.id, accountId: a.id, companyId: a.companyId || '', role: a.role }, 3600)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
    assert.match((await fetch(base + '/content-reports')).headers.get('content-type') || '', /text\/html/)
    const script = await fetch(base + '/content-reports.js')
    assert.match(script.headers.get('content-type') || '', /javascript/)
    assert.match(await script.text(), /function contentReportModal/)
    async function call(path: string, who: typeof member | null, method = 'GET', body?: unknown) {
      const res = await fetch(base + path, { method, headers: { ...(who ? { authorization: 'Bearer ' + token(who) } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: res.status, body: await res.json() as any }
    }
    const body = { botId: bot.id, sessionId: 'demo-new-session', seq: 7, reason: 'violence', excerpt: '<script>untrusted excerpt</script>', note: 'Demo report', consent: true }
    for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses', '/v1/images/generations', '/v1/images/edits']) {
      const prompt = 'Generate pornographic images'
      const rejected = await call(path, member, 'POST', { model: 'demo', prompt, input: prompt, messages: [{ role: 'user', content: prompt }] })
      assert.equal(rejected.status, 400, path)
      assert.match(rejected.body.error, /Satuwork/)
    }
    assert.equal((await call('/me/content-reports', null, 'POST', body)).status, 401)
    assert.equal((await call('/me/content-reports', member, 'POST', { ...body, consent: false })).status, 400)
    assert.equal((await call('/me/content-reports', member, 'POST', { ...body, excerpt: 'x'.repeat(2001) })).status, 400)
    assert.equal((await call('/me/content-reports', member, 'POST', { ...body, botId: foreign.id })).status, 404)
    const saved = await call('/me/content-reports', member, 'POST', body)
    assert.equal(saved.status, 201)
    assert.equal((await call('/platform/content-reports', member)).status, 403)
    const listed = await call('/platform/content-reports', owner)
    assert.equal(listed.body.reports[0].excerpt, body.excerpt)
    assert.equal((await call('/platform/content-reports/' + saved.body.id, member, 'PATCH', { note: 'fake review' })).status, 403)
    assert.equal((await call('/platform/content-reports/' + saved.body.id, owner, 'PATCH', { note: 'Removed unsafe provider; added regression example' })).status, 200)
    assert.equal((await call('/platform/content-reports', owner)).body.reports[0].status, 'reviewed')
    const burst = await Promise.all(Array.from({ length: 22 }, (_, seq) => call('/me/content-reports', member, 'POST', { ...body, seq: seq + 10 })))
    assert.equal(burst.filter(r => r.status === 201).length, 19)
    assert.equal(burst.filter(r => r.status === 429).length, 3)
    await (db as any).run('insert into content_reports (id, "accountId", "botId", "sessionId", seq, reason, excerpt, note, "createdAt") select \'page-\' || n, ?, ?, \'pagination\', n, \'other\', \'demo\', \'demo\', ? from generate_series(1,60) n', [member.id, bot.id, Date.now() + 5])
    const page1 = (await call('/platform/content-reports?before=' + (Date.now() + 1000), owner)).body.reports
    const cursor = page1.at(-1)
    const page2 = (await call('/platform/content-reports?before=' + cursor.createdAt + '&beforeId=' + cursor.id, owner)).body.reports
    assert.equal(new Set([...page1, ...page2].map(r => r.id)).size, 80, 'same-millisecond reports must not be skipped')
    await (db as any).run('update content_reports set "createdAt" = ? where id = ?', [Date.now() - 181 * 86400_000, saved.body.id])
    await db.pruneContentReports()
    assert.equal((await call('/platform/content-reports', owner)).body.reports.some((r: any) => r.id === saved.body.id), false)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await db.dropSchema().catch(() => {})
    await db.close()
  }
})
