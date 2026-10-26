import assert from 'node:assert/strict'
import { test } from 'node:test'
import { desiredManagerRelease } from '../src/lib/machines.ts'
import { installScript } from '../src/install.ts'
import type { Db, Machine } from '../src/db.ts'

test('bootstrap picks requested architecture; paired machines retain their recorded architecture and pins', async () => {
  const rows = ['new-x64', 'new-arm64', 'old-x64', 'old-arm64'].map(version => ({ version }))
  let global = ''
  const db = {
    platformSettings: async () => ({ managerVersion: global }),
    botRelease: async (v: string) => rows.find(r => r.version === v),
    latestBotRelease: async (_: string, arch: string | null) => rows.find(r => r.version === 'new-' + (arch || 'x64')),
  } as unknown as Db
  assert.equal((await desiredManagerRelease(db, undefined, 'arm64'))?.version, 'new-arm64')
  assert.equal((await desiredManagerRelease(db))?.version, 'new-x64', 'legacy clients keep their default')
  global = 'old-x64'
  assert.equal((await desiredManagerRelease(db, undefined, 'arm64'))?.version, 'old-arm64', 'global pin resolves its architecture sibling')
  const machine = { arch: 'x64', desiredManagerVersion: 'new-x64' } as Machine
  assert.equal((await desiredManagerRelease(db, machine, 'arm64'))?.version, 'new-x64', 'bootstrap query cannot override an already paired machine')
})
test('generated installer detects native CPU and includes architecture in first-pair and repair downloads', () => {
  const script = installScript('https://gateway.example.cn')
  assert.match(script, /aarch64\|arm64\) ARCH=arm64/)
  assert.match(script, /x86_64\|amd64\) ARCH=x64/)
  assert.match(script, /manager\/release\?code=\$CODE&arch=\$ARCH/)
  assert.match(script, /manager\/release\?arch=\$ARCH/)
})
