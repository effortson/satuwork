import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { Db } from '../src/db.ts'
import { signJwt, type JwtKeys } from '../src/crypto.ts'
import { Router } from '../src/http.ts'
import { attachKnowledge } from '../src/routes/knowledge.ts'
import type { RouteCtx } from '../src/routes/ctx.ts'

test('knowledge detail counters match its file snapshot during background changes', async t => {
  const db = new Db({
    url: process.env.E2E_DATABASE_URL || 'postgres://satuwork:satuwork@127.0.0.1:5434/satuwork',
    schema: 'sw_kb_snapshot_' + randomUUID().replaceAll('-', ''),
  })
  t.after(async () => {
    await db.dropSchema()
    await db.close()
  })
  await db.init()
  const company = await db.insertCompany({ slug: 'snapshot', name: 'Snapshot test' })
  const account = await db.insertAccount({ companyId: company.id, email: 'admin@snapshot.test', passwordHash: 'unused', role: 'admin', status: 'active' })
  const kb = await db.insertKnowledgeBase({ companyId: company.id, name: 'Handbook', desc: '', share: 'all', createdBy: account.id })
  const file = await db.insertKnowledgeFile({ kbId: kb.id, companyId: company.id, name: 'handbook.md', mime: 'text/markdown', bytes: 100, createdBy: account.id, status: 'processing' })
  await db.updateKnowledgeFile(file.id, { chunkCount: 3, chunkDone: 3 })
  await db.refreshKnowledgeCounters(kb.id)

  // Pause at the actual gap between reading the base row and reading its files.
  // No sleeps: each transition reproduces the inconsistent response deterministically.
  let betweenReads: (() => Promise<void>) | undefined
  const knowledgeFiles = db.knowledgeFiles.bind(db)
  db.knowledgeFiles = async id => {
    const change = betweenReads
    betweenReads = undefined
    if (change) await change()
    return knowledgeFiles(id)
  }
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const keys: JwtKeys = {
    kid: 'snapshot',
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
  const router = new Router()
  attachKnowledge(router, { db, keys } as RouteCtx)
  const server = createServer((req, res) => void router.handle(req, res))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  const token = signJwt(keys, { sub: account.id, accountId: account.id, companyId: company.id, role: account.role }, 3600)
  async function detail() {
    const response = await fetch(`${base}/orgs/${company.id}/knowledge/${kb.id}`, { headers: { authorization: 'Bearer ' + token } })
    const body = await response.json() as any
    assert.equal(response.status, 200)
    return body
  }

  await t.test('ingestion finishes before the stored counters refresh', async () => {
    betweenReads = async () => { await db.updateKnowledgeFile(file.id, { status: 'ready' }) }
    const body = await detail()
    assert.equal(body.files[0].status, 'ready')
    assert.equal(body.knowledge.chunkCount, 3)
    assert.equal(body.knowledge.fileCount, 1)
    assert.equal(body.knowledge.bytesUsed, 100)
  })

  await t.test('retry removes ready chunks from the same response', async () => {
    await db.refreshKnowledgeCounters(kb.id)
    betweenReads = async () => {
      await db.updateKnowledgeFile(file.id, { status: 'queued', chunkDone: 0 })
      await db.refreshKnowledgeCounters(kb.id)
    }
    const body = await detail()
    assert.equal(body.files[0].status, 'queued')
    assert.equal(body.knowledge.chunkCount, 0)
    assert.equal(body.knowledge.bytesUsed, 100)
  })

  await t.test('a newly reserved upload counts its file and bytes but no chunks', async () => {
    betweenReads = async () => {
      await db.insertKnowledgeFile({ kbId: kb.id, companyId: company.id, name: 'new.md', mime: 'text/markdown', bytes: 200, createdBy: account.id })
      await db.refreshKnowledgeCounters(kb.id)
    }
    const body = await detail()
    assert.equal(body.files.length, 2)
    assert.equal(body.knowledge.fileCount, 2)
    assert.equal(body.knowledge.bytesUsed, 300)
    assert.equal(body.knowledge.chunkCount, 0)
  })

  await t.test('deleting the files returns zero counters immediately', async () => {
    betweenReads = async () => {
      for (const item of await knowledgeFiles(kb.id)) await db.deleteKnowledgeFile(item.id)
      await db.refreshKnowledgeCounters(kb.id)
    }
    const body = await detail()
    assert.deepEqual(body.files, [])
    assert.equal(body.knowledge.fileCount, 0)
    assert.equal(body.knowledge.bytesUsed, 0)
    assert.equal(body.knowledge.chunkCount, 0)
  })
})
