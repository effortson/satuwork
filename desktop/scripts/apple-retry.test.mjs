import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scripts = fileURLToPath(new URL('.', import.meta.url))
function shell(source) {
  return spawnSync('bash', ['-c', `set -euo pipefail\nsource "$RETRY_HELPER"\n${source}`], {
    env: { ...process.env, RETRY_HELPER: join(scripts, 'apple-retry.sh') }, encoding: 'utf8',
  })
}

test('Apple checks recover after more than three disconnects without sleeping after success', () => {
  const r = shell(`
    calls=0
    sleep() { echo "sleep:$1"; }
    check() { calls=$((calls + 1)); [ "$calls" -ge 5 ] || return 68; }
    retry_apple check
    echo "calls:$calls"
  `)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, 'sleep:15\nsleep:30\nsleep:60\nsleep:60\ncalls:5\n')
})

test('persistent Apple failures exhaust bounded backoff and prevent subsequent publication', () => {
  const r = shell(`
    sleep() { echo "sleep:$1"; }
    check() { return 68; }
    retry_apple check
    echo published
  `)
  assert.equal(r.status, 68)
  assert.deepEqual(r.stdout.trim().split('\n'), ['sleep:15', 'sleep:30', ...Array(5).fill('sleep:60')])
  assert.match(r.stderr, /failed after 8 attempts \(exit 68\)/)
  assert(!r.stdout.includes('published'))
})

test('successful checks keep captured output clean and require no retry', () => {
  const r = shell(`
    sleep() { return 99; }
    output=$(retry_apple printf '%s' 'Notarized Developer ID')
    printf '%s' "$output"
  `)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, 'Notarized Developer ID')
  assert.equal(r.stderr, '')
})

function finalize(mode) {
  const root = mkdtempSync(join(tmpdir(), 'satuwork-apple-'))
  const dir = join(root, 'desktop/scripts'), bin = join(root, 'bin'), state = join(root, 'state')
  const bundle = join(root, 'desktop/src-tauri/target/release/bundle')
  const app = join(bundle, 'macos/Satuwork-CN-Beta.app')
  for (const p of [dir, bin, state, app]) mkdirSync(p, { recursive: true })
  for (const file of ['apple-retry.sh', 'finalize-macos.sh']) copyFileSync(join(scripts, file), join(dir, file))
  writeFileSync(join(root, 'desktop/src-tauri/tauri.conf.json'), JSON.stringify({ productName: 'Satuwork-CN-Beta', version: '0.1.16-beta.4' }))
  const executable = (name, source) => writeFileSync(join(bin, name), '#!/bin/bash\nset -euo pipefail\n' + source, { mode: 0o755 })
  executable('sleep', 'echo "sleep $1" >> "$MOCK_STATE/events"\n')
  executable('codesign', ':\n')
  executable('ditto', 'cp -R "$1" "$2"\n')
  executable('hdiutil', 'for arg; do last=$arg; done\ntouch "$last"\n')
  executable('pnpm', 'echo signed >> "$MOCK_STATE/events"\n')
  executable('xcrun', `
    if [ "$1" = notarytool ]; then
      echo submitted >> "$MOCK_STATE/events"
      if [ "$MOCK_MODE" = rejected ]; then
        echo '{"status":"Invalid"}'
      else
        echo '{"status":"Accepted"}'
      fi
      exit 0
    fi
    key="$2-\${3##*.}"
    file="$MOCK_STATE/$key"
    n=0; [ ! -f "$file" ] || n=$(cat "$file")
    n=$((n + 1)); echo "$n" > "$file"
    echo "$key $n" >> "$MOCK_STATE/events"
    if [ "$2" = validate ] && [[ "$3" = *.app ]]; then
      [ -f "$3/ticket" ] || exit 66
      [ "$MOCK_MODE" != unavailable ] || exit 68
      [ "$n" -gt 5 ] || exit 68
    elif [ "$2" = staple ] && [[ "$3" = *.app ]]; then
      touch "$3/ticket"
    elif [[ "$3" = *.dmg ]]; then
      [ "$n" -gt 4 ] || exit 68
    fi
  `)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_STATE: state, MOCK_MODE: mode, RUNNER_TEMP: root }
  for (const key of ['SATUWORK_CODESIGN_IDENTITY', 'SATUWORK_CODESIGN_KEYCHAIN', 'APPLE_API_KEY_PATH', 'APPLE_API_KEY', 'APPLE_API_ISSUER', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD']) env[key] = 'test-placeholder'
  const result = spawnSync('bash', [join(dir, 'finalize-macos.sh'), 'x64'], { env, encoding: 'utf8' })
  return { root, bundle, result, events: readFileSync(join(state, 'events'), 'utf8') }
}

test('finalizer recovers app validation and DMG ticket operations, then signs the ticketed archive', () => {
  const f = finalize('recover')
  try {
    assert.equal(f.result.status, 0, f.result.stderr)
    assert.match(f.events, /validate-app 6/)
    assert.match(f.events, /staple-dmg 5/)
    assert.match(f.events, /validate-dmg 5/)
    assert.equal(f.events.match(/submitted/g).length, 1, 'ticket retries must not resubmit notarization')
    assert.match(f.events, /validate-dmg 5\nsigned\n$/)
    const archive = spawnSync('tar', ['-tzf', join(f.bundle, 'macos/Satuwork-CN-Beta.app.tar.gz')], { encoding: 'utf8' })
    assert.equal(archive.status, 0, archive.stderr)
    assert.match(archive.stdout, /Satuwork-CN-Beta\.app\/ticket/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('finalizer cannot package or sign an updater when Apple validation keeps failing', () => {
  const f = finalize('unavailable')
  try {
    assert.equal(f.result.status, 68, f.result.stderr)
    assert.match(f.result.stderr, /failed after 8 attempts/)
    assert(!f.events.includes('submitted'))
    assert(!f.events.includes('signed'))
    assert(!existsSync(join(f.bundle, 'macos/Satuwork-CN-Beta.app.tar.gz')))
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('rejected notarization still prevents DMG ticketing and updater signing', () => {
  const f = finalize('rejected')
  try {
    assert.notEqual(f.result.status, 0)
    assert.match(f.result.stderr, /Apple notarization status: Invalid/)
    assert(!f.events.includes('staple-dmg'))
    assert(!f.events.includes('signed'))
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
