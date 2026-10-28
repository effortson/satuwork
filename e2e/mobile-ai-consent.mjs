import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

function fixture(root) {
  const saved = new Map()
  const storage = {
    get length() { return saved.size },
    key: (i) => [...saved.keys()][i],
    getItem: (k) => saved.get(k) ?? null,
    setItem: (k, v) => saved.set(k, String(v)),
    removeItem: (k) => saved.delete(k),
  }
  let host
  let requests = 0
  const state = {
    me: { account: { id: 'reviewer' } }, catalog: [{ provider: 'sample-ai' }], settings: {},
    chatDraft: 'Summarize this sample report', chatFiles: [{ file: { name: 'sample.txt' } }],
    chatMentions: [], chatRefs: [], chatSessionId: 'sample-session',
  }
  const button = { focus() {}, getAttribute: () => 'allow' }
  const context = {
    state, localStorage: storage, location: { origin: 'satu://localhost' },
    window: { __SATUWORK_GATEWAY__: 'https://satuwork.example' },
    t: (zh, en) => en || zh, esc: (s) => String(s), svg: () => '',
    mobileShell: () => true, chatBotOf: () => ({ provider: 'sample-ai' }), chatBotIdNow: () => 'sample-bot',
    parseCommand: () => null, flash() {}, render() {},
    api: () => { requests++; throw new Error('Unexpected network request') },
    fetch: () => { requests++; throw new Error('Unexpected file upload') },
    // Observe the first side effect after the permission gate without running the
    // unrelated stream/repaint implementation in this DOM unit fixture.
    reachGate: () => { throw new Error('passed-permission-gate') },
    modalBox: ({ title, body }) => title + body,
    document: {
      activeElement: { isConnected: true, focus() {} },
      body: { appendChild: (el) => { host = el } },
      addEventListener() {}, removeEventListener() {},
      createElement: () => ({
        innerHTML: '', remove() { host = null },
        addEventListener(name, fn) { if (name === 'click') this.click = fn },
        querySelector: () => button, querySelectorAll: () => [button],
      }),
    },
  }
  const source = readFileSync(join(root, 'gateway/ui/chat-composer.js'), 'utf8')
  const api = runInNewContext(source + '\nparseCommand = () => null; clearHeldSend = () => reachGate();\n({sendChat,mobileAiSharingInfo,mobileAiSharingAllowed,requestMobileAiSharing,clearMobileAiConsent})', context)
  function choose(allow) {
    const choice = { getAttribute: () => allow ? 'allow' : 'cancel' }
    host.click({ target: { closest: (s) => s === '[data-ai-choice]' ? choice : null }, preventDefault() {}, stopPropagation() {} })
  }
  return { ...api, state, storage, context, choose, host: () => host, requests: () => requests }
}

export async function runMobileAiConsent({ root, test, assert, log }) {
  log('\n# mobile-ai-consent')
  await test('手机首次发送：拒绝共享时不上传文件、不发请求，并保留草稿', async () => {
    const f = fixture(root)
    const pending = f.sendChat()
    assert(f.host()?.innerHTML.includes('sample-ai'), '没有列出实际配置的服务商')
    assert(f.host().innerHTML.includes('conversation history') && f.host().innerHTML.includes('attachment contents'), '没有说明数据类型')
    f.choose(false)
    await pending
    assert(f.requests() === 0, '拒绝之前已发送网络请求')
    assert(f.state.chatDraft && f.state.chatFiles.length === 1, '拒绝后丢了草稿或文件')
    assert(!f.mobileAiSharingAllowed(f.mobileAiSharingInfo()), '拒绝被记成同意')
  })
  await test('明确同意后才越过发送闸，同一许可范围不重复询问', async () => {
    const f = fixture(root)
    const pending = f.sendChat()
    f.choose(true)
    await pending.then(() => { throw new Error('没有继续发送') }, (e) => assert(e.message === 'passed-permission-gate', e.message))
    assert(f.mobileAiSharingAllowed(f.mobileAiSharingInfo()), '没有保存明确同意')
    await f.sendChat().catch((e) => assert(e.message === 'passed-permission-gate', e.message))
    assert(!f.host(), '缓存的同意仍弹窗')
  })
  await test('切换账号、服务器或新增服务商均重新征求许可', async () => {
    const f = fixture(root)
    const initial = f.mobileAiSharingInfo()
    const pending = f.requestMobileAiSharing(initial)
    f.choose(true)
    assert(await pending, '未接受')
    f.state.me.account.id = 'different-user'
    assert(!f.mobileAiSharingAllowed(f.mobileAiSharingInfo()), '跨账号复用了同意')
    f.state.me.account.id = initial.accountId
    f.context.window.__SATUWORK_GATEWAY__ = 'https://other.example'
    assert(!f.mobileAiSharingAllowed(f.mobileAiSharingInfo()), '跨服务器复用了同意')
    f.context.window.__SATUWORK_GATEWAY__ = 'https://satuwork.example'
    f.state.catalog.push({ provider: 'another-ai' })
    assert(!f.mobileAiSharingAllowed(f.mobileAiSharingInfo()), '新服务商没有重新询问')
  })
  await test('弹窗期间再次发送不会排出第二份；退出登录可撤回待定和已有许可', async () => {
    const f = fixture(root)
    const first = f.sendChat()
    await f.sendChat()
    assert(f.requests() === 0, '重复发送越过了许可')
    f.clearMobileAiConsent()
    await first
    assert(!f.host(), '退出时许可弹窗仍残留')
    const info = f.mobileAiSharingInfo()
    const pending = f.requestMobileAiSharing(info)
    f.choose(true)
    await pending
    f.clearMobileAiConsent()
    assert(!f.mobileAiSharingAllowed(info) && f.storage.length === 0, '许可未清除')
  })
  await test('服务商信息未知时不发送，用户换号后旧弹窗不能授权新账号', async () => {
    const f = fixture(root)
    assert(!await f.requestMobileAiSharing({ accountId: 'reviewer', recipients: [], key: 'unknown' }), '未知接收方仍接受')
    const pending = f.requestMobileAiSharing(f.mobileAiSharingInfo())
    f.state.me.account.id = 'changed-account'
    f.choose(true)
    assert(!await pending, '旧弹窗授权了新账号')
  })
  await test('隐私声明两种语言均有真实主体、删除联系、推送与第三方说明，服务条款保持草稿', async () => {
    for (const english of [false, true]) {
      const context = { t: (zh, en) => english ? en : zh, esc: String, localeMode: english ? 'en' : 'zh' }
      const source = readFileSync(join(root, 'gateway/ui/pages-legal.js'), 'utf8')
      const render = runInNewContext(source + '\nlegalView', context)
      const html = render('privacy')
      for (const value of ['ADIX INTELLIGENCE PTE. LTD.', 'symohpnyprotocol@outlook.com', 'APNs', 'Vercel', 'Neon', '2026-10-28']) assert(html.includes(value), '缺少 ' + value)
      assert(!html.includes('[Legal entity name]') && !html.includes('[公司主体名称]'), '隐私页还含占位主体')
      const terms = render('terms')
      assert(terms.includes(english ? 'placeholders' : '占位'), '发布隐私页误改了服务条款状态')
    }
  })
}
