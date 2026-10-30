import { runProbe } from './probe.mjs'

export async function runReplyLanguage({ root, test, assert, log }) {
  log('\n# reply-language')
  await test('reply language follows the UI for legacy bots, queued messages and session continuations', async () => {
    const result = await runProbe(root, 'bot/e2e-reply-language.mjs')
    assert(result.passed && result.modelCalls >= 8, 'reply-language regression probe failed')
  })
}
