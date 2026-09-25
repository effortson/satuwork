/**
 * 管家拉 bot 发布包（manager/src/releases.ts 的 ensureRelease）。
 *
 * e2e 里那个管家跑 DRYRUN，seats.ts 在拉包之前就返回了，所以拉包这一段在那儿验不到；
 * 这里直接调函数，两台假主机：一台当 GitHub Release（外部地址），一台当 Gateway。
 *
 * 钉的是协议 11 的约定：
 * - 规格给了直连地址 + sha256 → 去外部地址取，**不带机器票**，按规格里的 sha256 核对；
 * - 对不上不解包、不留半个目录；
 * - 直连地址和 Gateway 同源才带票；
 * - 没给直连地址 → 老路，从 Gateway 拉、带票、校验值看响应头。
 */
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeServer } from './probe.mjs'
import { sha256Of, tarGz } from './release.mjs'

function pkgOf(version) {
  return tarGz([
    { name: './bin/satuwork.mjs', data: '#!/usr/bin/env node\n' },
    { name: './VERSION', data: version + '\n' },
  ])
}

/** 一台记账的假主机。`files` 是路径 → 字节，其余 404。 */
function host(files, extraHeaders = () => ({})) {
  const seen = []
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    seen.push({ path, auth: String(req.headers.authorization || ''), ua: String(req.headers['user-agent'] || '') })
    const body = files.get(path)
    if (!body) {
      res.writeHead(404)
      return res.end('not found')
    }
    res.writeHead(200, { 'content-type': 'application/gzip', ...extraHeaders(path, body) })
    res.end(body)
  })
  return { server, seen }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

export async function runManagerDownload({ test, assert }) {
  const root = mkdtempSync(join(tmpdir(), 'sw-mgr-dl-'))
  const prevRoot = process.env.SATUWORK_RELEASE_ROOT
  process.env.SATUWORK_RELEASE_ROOT = root
  const { ensureRelease, releaseDir, haveRelease } = await import('../manager/src/releases.ts')

  const direct = pkgOf('1.0.0-direct')
  const tampered = pkgOf('1.0.0-tampered')
  const viaGw = pkgOf('1.0.0-gateway')
  const sameOriginPkg = pkgOf('1.0.0-same')

  const ext = host(new Map([
    ['/rel/1.0.0-direct.tgz', direct],
    ['/rel/1.0.0-tampered.tgz', tampered],
  ]))
  const gw = host(
    new Map([
      ['/internal/bot-releases/1.0.0-gateway', viaGw],
      ['/files/1.0.0-same.tgz', sameOriginPkg],
    ]),
    // 走 Gateway 时校验值在响应头里。
    (_path, body) => ({ 'x-bot-sha256': sha256Of(body) }),
  )
  const extBase = `http://127.0.0.1:${await listen(ext.server)}`
  const gwBase = `http://127.0.0.1:${await listen(gw.server)}`
  const token = 'smt_e2e_download'

  try {
    await test('直连：去外部地址取包，不带机器票，按规格里的 sha256 核对', async () => {
      const dir = await ensureRelease('1.0.0-direct', {
        gatewayUrl: gwBase,
        token,
        url: `${extBase}/rel/1.0.0-direct.tgz`,
        sha256: sha256Of(direct),
      })
      assert(dir === releaseDir('1.0.0-direct'), `目录 ${dir}`)
      assert(existsSync(join(dir, 'bin', 'satuwork.mjs')), '包没解开')
      assert(haveRelease('1.0.0-direct'), 'VERSION 标记没写')
      const hit = ext.seen.find((x) => x.path === '/rel/1.0.0-direct.tgz')
      assert(hit, `外部主机没被取：${JSON.stringify(ext.seen)}`)
      assert(!hit.auth, `机器票寄给了外部主机：${hit.auth}`)
      assert(hit.ua.startsWith('satuwork-manager/'), `该报自己是谁：${hit.ua}`)
      assert(!gw.seen.some((x) => x.path.includes('1.0.0-direct')), 'Gateway 不该被绕回去')
    })

    await test('直连：内容和规格里的 sha256 对不上 → 不解包、不留半个目录', async () => {
      let err = ''
      try {
        await ensureRelease('1.0.0-tampered', {
          gatewayUrl: gwBase,
          token,
          url: `${extBase}/rel/1.0.0-tampered.tgz`,
          sha256: 'f'.repeat(64),
        })
      } catch (e) {
        err = String(e?.message || e)
      }
      assert(err.includes('checksum mismatch'), `该报校验不符：${err}`)
      assert(!haveRelease('1.0.0-tampered'), '对不上还是装了')
      assert(!existsSync(releaseDir('1.0.0-tampered')), '留下了半个目录')
    })

    await test('直连地址和 Gateway 同源才带机器票', async () => {
      await ensureRelease('1.0.0-same', {
        gatewayUrl: gwBase,
        token,
        url: `${gwBase}/files/1.0.0-same.tgz`,
        sha256: sha256Of(sameOriginPkg),
      })
      const hit = gw.seen.find((x) => x.path === '/files/1.0.0-same.tgz')
      assert(hit?.auth === `Bearer ${token}`, `同源该带票：${JSON.stringify(hit)}`)
    })

    await test('没有直连地址：从 Gateway 拉、带机器票、校验值看响应头', async () => {
      const dir = await ensureRelease('1.0.0-gateway', { gatewayUrl: gwBase, token })
      assert(existsSync(join(dir, 'bin', 'satuwork.mjs')), '包没解开')
      const hit = gw.seen.find((x) => x.path === '/internal/bot-releases/1.0.0-gateway')
      assert(hit?.auth === `Bearer ${token}`, `走 Gateway 该带票：${JSON.stringify(hit)}`)
      assert(!ext.seen.some((x) => x.path.includes('1.0.0-gateway')), '不该去外部主机')
    })
  } finally {
    await closeServer(ext.server, '外部主机')
    await closeServer(gw.server, '假 Gateway')
    if (prevRoot === undefined) delete process.env.SATUWORK_RELEASE_ROOT
    else process.env.SATUWORK_RELEASE_ROOT = prevRoot
    rmSync(root, { recursive: true, force: true })
  }
}
