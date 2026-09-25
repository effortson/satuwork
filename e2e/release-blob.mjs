/**
 * 发布包走对象存储（gateway/src/releases.ts 的 storeToBlob）。配了 BLOB_READ_WRITE_TOKEN 的 Gateway
 * 不落盘：上传边收边算边传到 Blob，登记的是 Blob 地址；下发时带 token 去取。这里起一个假的 Blob
 * （SDK 认 VERCEL_BLOB_API_URL 这个覆盖项），钉住：传上去了、带了 token、库里是 Blob 地址、磁盘上
 * 没有文件、管家来拉拿到的字节和 sha256 头对得上、sha256 对不上时把刚传的 blob 删掉。
 */
import { createServer } from 'node:http'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { createCompany } from './org.mjs'
import { pairMachine } from './pair.mjs'
import { publishRelease, sha256Of, tarGz } from './release.mjs'
import { closeServer } from './probe.mjs'

const TOKEN = 'vercel_blob_rw_e2estore0001_' + 'x'.repeat(24)

function fakeBlob() {
  const store = new Map()
  const seen = { puts: [], gets: [], deletes: [] }
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url, 'http://blob.test')
      const auth = req.headers.authorization || ''
      const base = `http://127.0.0.1:${server.address().port}`
      if (req.method === 'PUT' && url.pathname === '/') {
        const pathname = url.searchParams.get('pathname') || ''
        const key = `${pathname}-${randomBytes(6).toString('hex')}`
        const body = Buffer.concat(chunks)
        seen.puts.push({ pathname, auth, access: req.headers['x-vercel-blob-access'], suffix: req.headers['x-add-random-suffix'], size: body.length })
        if (auth !== `Bearer ${TOKEN}`) {
          res.writeHead(403, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: { code: 'forbidden', message: 'bad token' } }))
        }
        store.set(key, body)
        const blobUrl = `${base}/blobs/${key}`
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ url: blobUrl, downloadUrl: blobUrl + '?download=1', pathname: key, contentType: 'application/gzip', contentDisposition: 'attachment' }))
      }
      if (req.method === 'GET' && url.pathname.startsWith('/blobs/')) {
        const key = url.pathname.slice('/blobs/'.length)
        seen.gets.push({ key, auth })
        if (auth !== `Bearer ${TOKEN}`) {
          res.writeHead(403)
          return res.end('private')
        }
        const body = store.get(key)
        if (!body) {
          res.writeHead(404)
          return res.end()
        }
        res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': String(body.length) })
        return res.end(body)
      }
      if (req.method === 'POST' && url.pathname === '/delete') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        for (const u of body.urls || []) {
          const key = String(u).split('/blobs/')[1]
          seen.deletes.push(key)
          store.delete(key)
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end('{}')
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'not_found', message: url.pathname } }))
    })
  })
  return { server, store, seen }
}

export async function runReleaseBlob({ gwRoot, test, req, start, waitHttp, assert, log }) {
  log('\n# release-blob')
  const GW_HOME = tmpOf('satuwork-e2e-release-blob')
  const GW_PORT = await freePort()
  const gwBase = `http://127.0.0.1:${GW_PORT}`
  rmSync(GW_HOME, { recursive: true, force: true })
  const blob = fakeBlob()
  await new Promise((r) => blob.server.listen(0, '127.0.0.1', r))
  const blobBase = `http://127.0.0.1:${blob.server.address().port}`

  const gw = start('release-blob-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schemaOf('e2e_release_blob'),
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: 'owner@blob.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-blob',
      SATUWORK_DEPLOY_STUB: '1',
      BLOB_READ_WRITE_TOKEN: TOKEN,
      VERCEL_BLOB_API_URL: blobBase,
    },
  })
  try {
    await waitHttp(`${gwBase}/health`, { child: gw, what: 'release-blob gateway' })
    const reg = await createCompany(req, gwBase, {
      ownerEmail: 'owner@blob.test', ownerPassword: 'test-owner-blob',
      email: 'admin@blob.test', password: 'correct-horse', companyName: 'BlobCo', slug: 'blobco', seats: 1,
    })
    const ownerTok = reg.ownerToken
    let published = null

    await test('上传不落盘：边收边传到 Blob，私有、带随机后缀，登记的是 Blob 地址', async () => {
      published = await publishRelease({ req, gwBase, token: ownerTok, version: '0.9.0', note: 'blob' })
      assert(blob.seen.puts.length === 1, `Blob 该收到 1 次 PUT，收到 ${blob.seen.puts.length}`)
      const p = blob.seen.puts[0]
      assert(p.auth === `Bearer ${TOKEN}` && p.access === 'private' && p.suffix === '1', `PUT 的头不对：${JSON.stringify(p)}`)
      assert(p.size === published.tgz.length, `传上去的字节数 ${p.size} != ${published.tgz.length}`)
      assert(String(published.release.url || '').startsWith(`${blobBase}/blobs/`), `登记的地址不是 Blob：${published.release.url}`)
      // 私有 Blob 取的时候要带 BLOB_READ_WRITE_TOKEN，那把钥匙不能给机器：只能经 Gateway 转发。
      assert(published.release.directUrl === null, `私有 Blob 的包不该让机器直连：${published.release.directUrl}`)
      assert(published.release.sha256 === published.sha256 && published.release.size === published.tgz.length, `登记的大小/摘要不对：${JSON.stringify(published.release)}`)
      const dir = join(GW_HOME, 'releases')
      assert(!existsSync(dir) || readdirSync(dir).length === 0, `磁盘上不该有包：${existsSync(dir) ? readdirSync(dir).join(',') : ''}`)
      // 校验入口时拉过一次，拉的时候带了 token。
      assert(blob.seen.gets.length >= 1 && blob.seen.gets.every((g) => g.auth === `Bearer ${TOKEN}`), `校验那一次拉没带 token：${JSON.stringify(blob.seen.gets)}`)
    })

    await test('管家来拉：Gateway 带 token 从 Blob 取、流式转出，sha256 头跟着走', async () => {
      const machine = await pairMachine({ req, gwBase, ownerTok, orgId: reg.company.id })
      const r = await fetch(`${gwBase}/internal/bot-releases/0.9.0`, { headers: { authorization: `Bearer ${machine.token}` } })
      const bytes = Buffer.from(await r.arrayBuffer())
      assert(r.status === 200, `下发 ${r.status} ${bytes.toString('utf8').slice(0, 200)}`)
      assert(bytes.equals(published.tgz), '拉到的字节和传上去的不一样')
      assert(r.headers.get('x-bot-sha256') === published.sha256, `sha256 头 ${r.headers.get('x-bot-sha256')}`)
      // 前端/机器那头拿到的永远是 Gateway 转出来的字节，Blob 的私有地址不必对外可达。
    })

    await test('sha256 对不上：拒收，并把刚传上去的 blob 删掉，库里不留', async () => {
      const tgz = tarGz([{ name: './bin/satuwork.mjs', data: '#!/usr/bin/env node\n' }, { name: './VERSION', data: '0.9.1\n' }])
      const before = blob.seen.deletes.length
      const r = await req(gwBase, 'PUT', '/platform/bot-releases/0.9.1', { token: ownerTok, raw: tgz, headers: { 'x-bot-sha256': 'f'.repeat(64) } })
      assert(r.status === 400, `该 400：${r.status} ${r.text}`)
      assert(blob.seen.deletes.length === before + 1, '没把坏包从 Blob 删掉')
      const list = await req(gwBase, 'GET', '/platform/bot-releases', { token: ownerTok })
      assert(!(list.json.releases || []).some((x) => x.version === '0.9.1'), '坏包入库了')
      assert(blob.store.size === 1, `Blob 里该只剩 1 个包，有 ${blob.store.size}`)
    })
  } finally {
    gw.kill('SIGTERM')
    await closeServer(blob.server)
  }
}
