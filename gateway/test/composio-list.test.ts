import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ComposioProvider } from '../src/connectors/composio.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** 按 cursor 吐页的假 Composio，记下每次请求的地址。 */
function fakePages(pages: Record<string, { items: unknown[]; next_cursor?: string | null }>): string[] {
  const seen: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    seen.push(url.pathname + url.search)
    const page = pages[url.searchParams.get('cursor') ?? '']
    return new Response(JSON.stringify(page ?? { items: [] }), { status: 200 })
  }) as typeof fetch
  return seen
}

test('listToolkits follows next_cursor to the last page', async () => {
  const seen = fakePages({
    '': { items: [{ slug: 'googlesheets', name: 'Google Sheets' }], next_cursor: 'p2' },
    p2: { items: [{ slug: 'googleslides', name: 'Google Slides' }], next_cursor: null },
  })
  const kits = await new ComposioProvider('k', 'https://x.test/api/v3').listToolkits()
  assert.deepEqual(kits.map((k) => k.slug), ['googlesheets', 'googleslides'])
  assert.equal(seen.length, 2)
  assert.match(seen[1], /cursor=p2/)
})

test('listTools keeps the toolkit filter on every page', async () => {
  const seen = fakePages({
    '': { items: [{ slug: 'GITHUB_A' }], next_cursor: 'p2' },
    p2: { items: [{ slug: 'GITHUB_B' }] },
  })
  const tools = await new ComposioProvider('k', 'https://x.test/api/v3').listTools('github')
  assert.deepEqual(tools.map((t) => t.slug), ['GITHUB_A', 'GITHUB_B'])
  for (const u of seen) assert.match(u, /toolkit_slug=github/)
})

test('stops when the cursor does not advance', async () => {
  const seen = fakePages({ '': { items: [{ slug: 'a' }], next_cursor: 'same' }, same: { items: [{ slug: 'b' }], next_cursor: 'same' } })
  await new ComposioProvider('k', 'https://x.test/api/v3').listToolkits()
  assert.equal(seen.length, 2)
})
