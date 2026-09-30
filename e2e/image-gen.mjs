/**
 * 生图：平台挑模型 → 下发给席位 → Bot 的 generate_image 打模型那条路 → 按 token 记账。
 *
 * 这里起一个自己的 Gateway，内置 openai 的上游（OPENAI_BASE_URL）指到一个假的 OpenAI Images。
 * 管家中继那条路（/llm/v1/images/generations）在 e2e/manager.mjs 的「模型中继」那一组里；
 * 席位上的工具本身（请求体、答复、落盘）在 bot/e2e-image.mjs 探针里。
 *
 * 盯死四件事：
 * 1. **只有 owner 能挑**，而且只能挑生图表里有的；公司侧的 settings 里没有这一格。
 * 2. **挑了才下发**，下发的带 `api`；改了指纹要变，否则跑着的席位永远拿不到那把工具。
 * 3. **生图和对话各走各的路**：生图模型打 chat 是 400，对话模型打 images 也是 400。
 * 4. **钱按 token 记在 llm 那一类**，单价是生图表里那一份（gpt-image-2：5 / 30）。
 */
import { rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { runProbe as sharedProbe } from './probe.mjs'

const SCHEMA = schemaOf('e2e_imagegen')

export async function runImageGen({ root, gwRoot, test, req, start, waitHttp, assert, log }) {
  log('\n# image-gen')

  // ── 席位这一侧：探针（要 tsx）──────────────────────────────────────
  const p = await sharedProbe(root, 'bot/e2e-image.mjs')

  await test('generate_image 的请求体：默认 JPEG + 流式，透明背景换 PNG，坏参数挡在本地', () => {
    const r = p.request
    assert(r.plain.model === 'openai/gpt-image-2' && r.plain.provider === 'openai', `model/provider：${JSON.stringify(r.plain)}`)
    assert(r.plain.stream === true && r.plain.partial_images === 0 && r.plain.n === 1, `流式那几格不对：${JSON.stringify(r.plain)}`)
    assert(r.plainFormat === 'jpeg' && r.plain.output_format === 'jpeg' && r.plain.output_compression === 90, `默认格式：${JSON.stringify(r.plain)}`)
    assert(r.plain.size === '1024x1024' && r.plain.quality === 'medium' && !('background' in r.plain), `默认尺寸/质量：${JSON.stringify(r.plain)}`)
    assert(r.clearFormat === 'png' && r.clear.background === 'transparent' && !('output_compression' in r.clear), `透明背景：${JSON.stringify(r.clear)}`)
    assert(/不能为空/.test(r.empty) && /透明/.test(r.jpegClear) && /太长/.test(r.tooLong), `校验：${JSON.stringify(r)}`)
    assert(r.badSize === '1024x1024', `认不出的尺寸该回落成默认：${r.badSize}`)
  })

  await test('generate_image 拆答复：流里的 completed 帧、整块 JSON、流里的错', () => {
    const r = p.parse
    assert(r.sse.b64 === 'full' && r.sse.format === 'png', `流：${JSON.stringify(r.sse)}`)
    assert(r.json.b64 === 'blob' && r.json.format === 'webp', `整块：${JSON.stringify(r.json)}`)
    assert(r.err.error === '坏了' && /没等到/.test(r.empty.error), `错：${JSON.stringify(r)}`)
    assert(p.names.given === '封面 v2.jpg' && /^image-\d{8}-\d{6}\.webp$/.test(p.names.none), `文件名：${JSON.stringify(p.names)}`)
  })

  await test('generate_image 整条：打模型那条路，图落进 images/，模型只拿到一行字', () => {
    const h = p.happy
    assert(h.path === '/v1/images/generations' && h.auth === 'Bearer sk_sw_e2e', `打到了 ${h.path}（${h.auth}）`)
    assert(!h.failed && h.file?.path === 'images/猫.jpg' && h.onDisk, `没落盘：${JSON.stringify(h)}`)
    assert(h.text.includes('images/猫.jpg') && !h.text.includes('base64'), `给模型的那行字：${h.text}`)
    assert(p.again === '猫-1.jpg', `同名不该覆盖：${p.again}`)
    assert(!p.json.failed && p.json.name.endsWith('.png'), `整块 JSON 的格式以答复为准：${JSON.stringify(p.json)}`)
  })

  await test('generate_image 接 Gemini：generateContent 的形状，跳过思考草稿，被拦下要说清楚', () => {
    const g = p.gemini
    assert(g.plain.contents[0].parts[0].text === '一只猫' && !('prompt' in g.plain), `请求体：${JSON.stringify(g.plain)}`)
    assert(JSON.stringify(g.plain.generationConfig) === JSON.stringify({ responseModalities: ['IMAGE'], imageConfig: { imageSize: '2K', aspectRatio: '3:2' } }), `generationConfig：${JSON.stringify(g.plain.generationConfig)}`)
    assert(g.editFlag && g.edit.contents[0].parts[0].inlineData.data === 'QUJD' && g.edit.contents[0].parts[1].text === '把猫换成狗', `改图：${JSON.stringify(g.edit)}`)
    assert(!('aspectRatio' in g.edit.generationConfig.imageConfig), '改图默认 auto，该跟原图的比例走')
    assert(/透明背景/.test(g.clear), `透明背景：${g.clear}`)
    assert(g.parse.b64 === 'final' && g.parse.format === 'jpeg', `思考草稿没跳过：${JSON.stringify(g.parse)}`)
    assert(/SAFETY/.test(g.blocked.error) && /IMAGE_SAFETY/.test(g.finish.error), `被拦：${JSON.stringify([g.blocked, g.finish])}`)
    assert(g.jsonArray.b64 === 'w' && g.jsonArray.format === 'webp', `非流式数组：${JSON.stringify(g.jsonArray)}`)
    const c = p.geminiCall
    assert(c.path === '/v1/images/generations' && c.body.provider === 'google', `Gemini 打到了 ${c.path}：${JSON.stringify(c.body)}`)
    assert(c.file?.name === '双子猫.jpg', `格式该以答复的 mimeType 为准：${JSON.stringify(c.file)}`)
  })

  await test('generate_image 改图：原图从工作区读、带进请求、路由换成 edits，原图不动', () => {
    const o = p.openaiEdit
    assert(o.edit && o.body.images[0].image_url === 'data:image/png;base64,QUJD' && o.body.size === 'auto', `OpenAI 改图：${JSON.stringify(o.body)}`)
    const e = p.editCall
    assert(e.path === '/v1/images/edits', `改图打到了 ${e.path}`)
    assert(e.carried && e.urls.join('|') === 'data:image/png;base64,|data:image/jpeg;base64', `原图没带对：${JSON.stringify(e.urls)}`)
    assert(e.originalKept && e.file?.path.startsWith('images/'), `原图被动了，或者没另存：${JSON.stringify(e)}`)
    assert(e.text.includes('uploads/s1/cat.png'), `给模型的那行字没说按哪张改：${e.text}`)
    assert(JSON.stringify(p.paths) === JSON.stringify({ one: ['a.png'], dedup: ['a.png', 'b.png'], none: [] }), `路径：${JSON.stringify(p.paths)}`)
    const f = p.inputFail
    assert(/不是 PNG/.test(f.gif) && /越界/.test(f.escape) && /没有 uploads\/s1\/nope\.png/.test(f.missing), `原图的错：${JSON.stringify(f)}`)
    assert(/最多带 4 张/.test(f.many) && /超过 3 MB/.test(f.huge), `数量 / 大小：${JSON.stringify(f)}`)
    assert(f.hit === false, '原图不合格还打了上游')
    assert(!/var\/folders|\/tmp\//.test(f.missing), `不存在的时候把绝对路径漏给了模型：${f.missing}`)
  })

  await test('generate_image 局部重绘：蒙版挂在 mask 上，PNG / 透明 / 尺寸都在本地挡，Gemini 不收', () => {
    const m = p.mask
    assert(m.body?.image_url === 'data:image/png;base64,TUFTSw==', `mask 没挂上：${JSON.stringify(m.body)}`)
    assert(/和原图一起给/.test(m.alone) && /读不出来/.test(m.gemini), `只给蒙版 / Gemini 读不了的蒙版：${JSON.stringify([m.alone, m.gemini])}`)
    assert(m.ok === null && m.grayAlpha === null, `合格的蒙版被拦了：${JSON.stringify([m.ok, m.grayAlpha])}`)
    assert(/透明通道/.test(m.noAlpha) && /得是 PNG/.test(m.notPng), `格式：${JSON.stringify([m.noAlpha, m.notPng])}`)
    assert(/4×3.*5×3/.test(m.sizeVsPng) && /4×3.*30×20/.test(m.sizeVsJpeg), `尺寸：${JSON.stringify([m.sizeVsPng, m.sizeVsJpeg])}`)
    assert(JSON.stringify(m.jpegDims) === JSON.stringify({ width: 30, height: 20 }) && m.webpDims === null, `imageDims：${JSON.stringify([m.jpegDims, m.webpDims])}`)
    const c = p.maskCall
    assert(c.path === '/v1/images/edits' && c.images === 1 && c.mask?.startsWith('data:image/png;base64,'), `整条：${JSON.stringify(c)}`)
    assert(/局部重绘/.test(c.text) && c.text.includes('uploads/s1/mask-cat.png'), `给模型的那行字：${c.text}`)
    const f = p.maskFail
    assert(/2×2.*1×1/.test(f.big) && /透明通道/.test(f.rgb) && /得是 PNG/.test(f.jpg), `蒙版的错：${JSON.stringify(f)}`)
    assert(f.hit === false, '蒙版不合格还打了上游')
  })

  await test('PNG 读写：五种行过滤器、16 位、调色板 + tRNS 都解得对，黑白蒙版写得对', () => {
    const g = p.png
    assert(g.holeOk, 'RGBA 蒙版的透明区域解错了（五种过滤器轮着用）')
    assert(JSON.stringify(g.ga16) === JSON.stringify([0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255]), `16 位灰度 + 透明：${JSON.stringify(g.ga16)}`)
    assert(JSON.stringify(g.pal) === JSON.stringify([0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255]), `调色板 + tRNS：${JSON.stringify(g.pal)}`)
    assert(/没有 alpha/.test(g.grayNoAlpha) && g.grayType === 0 && /不是 PNG/.test(g.notPng), `灰度图 / 非 PNG：${JSON.stringify([g.grayNoAlpha, g.grayType, g.notPng])}`)
    assert(JSON.stringify(g.grayRaw) === JSON.stringify([0, 0, 255, 0, 0, 255, 0, 255]), `灰度图的像素：${JSON.stringify(g.grayRaw)}`)
    assert(JSON.stringify(g.region) === JSON.stringify({ where: '右下角', x: [67, 100], y: [67, 100], coverage: 11 }), `区域：${JSON.stringify(g.region)}`)
    assert(g.empty === null && g.center.where === '正中间', `空蒙版 / 正中：${JSON.stringify([g.empty, g.center])}`)
  })

  await test('Gemini 局部重绘：原图 + 黑白蒙版 + 写明方位的指令，白色以外不许动', () => {
    const g = p.geminiMask
    assert(g.count === 3 && g.first, `parts：${JSON.stringify(g)}`)
    assert(JSON.stringify(g.bwDims) === JSON.stringify({ width: 90, height: 60 }) && g.bwType === 0 && g.bwOk, `黑白蒙版：${JSON.stringify(g)}`)
    assert(/第二张是和它一样大的黑白蒙版/.test(g.text) && /右下角/.test(g.text) && /横向约 67%–100%/.test(g.text) && /白色以外的部分必须和原图保持一模一样/.test(g.text) && /要改成：换成一只猫/.test(g.text), `指令：${g.text}`)
    const c = p.geminiMaskCall
    assert(c.path === '/v1/images/edits' && c.parts === 3 && /右下角/.test(c.text) && c.file, `整条：${JSON.stringify(c)}`)
    const f = p.geminiMaskFail
    assert(/没有透明的地方/.test(f.solid) && /读不出来/.test(f.unreadable) && f.hit === false, `Gemini 蒙版的错：${JSON.stringify(f)}`)
    assert(/没有透明的地方/.test(p.openaiSolid), `OpenAI 那条也该拦空蒙版：${p.openaiSolid}`)
  })

  await test('手机竖图：蒙版按屏幕方向涂的，按 EXIF 换回文件方向；JPEG 填充字节、IDAT 里的 tRNS 字样不误判', () => {
    const j = p.jpeg
    assert(j.orientation === 6 && j.noExif === 1, `EXIF 方向：${JSON.stringify([j.orientation, j.noExif])}`)
    assert(JSON.stringify(j.dimsWithFill) === JSON.stringify({ width: 30, height: 20 }), `带填充字节的 JPEG 尺寸：${JSON.stringify(j.dimsWithFill)}`)
    assert(JSON.stringify(j.dims6) === JSON.stringify({ width: 4, height: 2 }), `方向 6 的文件尺寸：${JSON.stringify(j.dims6)}`)
    assert(JSON.stringify(j.turned) === JSON.stringify({ w: 4, h: 2, alpha: [0, 255, 255, 255, 255, 255, 255, 255] }), `换回文件方向：${JSON.stringify(j.turned)}`)
    assert(j.storedOk === null, `按文件方向涂的蒙版被拦了：${j.storedOk}`)
    assert(/蒙版是 3×3，原图是 2×4/.test(j.wrong), `尺寸对不上时报屏幕上的尺寸：${j.wrong}`)
    assert(JSON.stringify(j.u8) === JSON.stringify([0, 255, 255, 255, 255, 255, 255, 255]), `方向 8：${JSON.stringify(j.u8)}`)
    assert(JSON.stringify(j.u3) === JSON.stringify([0, 255, 255, 255, 255, 255, 255, 255]), `方向 3：${JSON.stringify(j.u3)}`)
    assert(/没有透明通道/.test(j.trnsBytes), `IDAT 里的 tRNS 字样被当成了透明：${j.trnsBytes}`)
  })

  await test('generate_image 失败都说人话，不留半个文件；平台没开就不打上游', () => {
    const f = p.fail
    assert(f.bad.text === '生图失败：描述违反了内容政策' && f.bad.files === null, `上游 400：${JSON.stringify(f.bad)}`)
    assert(f.broken.text === '生图失败：上游炸了' && f.broken.files === null, `流里报错：${JSON.stringify(f.broken)}`)
    assert(/管家版本太旧/.test(f.gone), `老管家：${f.gone}`)
    assert(/还没有开通生图/.test(p.off.text) && p.off.hit === false, `没开：${JSON.stringify(p.off)}`)
  })

  // ── Gateway 这一侧：自己起一个，上游是假的 OpenAI Images ─────────────
  const GW_HOME = tmpOf('satuwork-e2e-imagegen')
  rmSync(GW_HOME, { recursive: true, force: true })
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`

  /** 假上游收到的每一次请求：{ auth, path, body }。`mode` 决定这一次发流还是发整块。 */
  const seen = []
  let mode = 'sse'
  const USAGE = { total_tokens: 1040, input_tokens: 40, output_tokens: 1000, input_tokens_details: { text_tokens: 40, image_tokens: 0 } }
  const upstream = createServer((r, res) => {
    let buf = ''
    r.on('data', (d) => (buf += d))
    r.on('end', () => {
      let body = null
      try {
        body = JSON.parse(buf)
      } catch {}
      seen.push({ auth: r.headers.authorization, key: r.headers['x-goog-api-key'], path: r.url, body })
      if (r.url.startsWith('/v1beta/models/')) {
        // Gemini：一帧思考、一帧图、一帧用量。用量里图片 1290、文字 10、思考 90。
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const frame = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
        frame({ candidates: [{ content: { parts: [{ text: '想一想', thought: true }] } }], usageMetadata: { promptTokenCount: 20 } })
        frame({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1n' } }] }, finishReason: 'STOP' }] })
        frame({
          usageMetadata: {
            promptTokenCount: 20, candidatesTokenCount: 1300, thoughtsTokenCount: 90, totalTokenCount: 1410,
            candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1290 }, { modality: 'TEXT', tokenCount: 10 }],
          },
        })
        return res.end()
      }
      if (r.url !== '/v1/images/generations' && r.url !== '/v1/images/edits') {
        res.writeHead(404, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'no' } }))
      }
      const done = r.url === '/v1/images/edits' ? 'image_edit.completed' : 'image_generation.completed'
      if (mode === 'json') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ created: 1, data: [{ b64_json: 'aW1n' }], usage: USAGE }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(`event: ${done}\ndata: ${JSON.stringify({ type: done, b64_json: 'aW1n', output_format: 'jpeg', usage: USAGE })}\n\n`)
      res.end()
    })
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  const UP_PORT = upstream.address().port

  const gw = start('imagegen-gw', ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: SCHEMA,
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
      OPENAI_BASE_URL: `http://127.0.0.1:${UP_PORT}`,
      GEMINI_BASE_URL: `http://127.0.0.1:${UP_PORT}`,
      // 走环境变量那一档（llm.secret 的最后一档）：平台表里一把都没配。
      OPENAI_API_KEY: 'env-openai-key',
      GEMINI_API_KEY: 'env-gemini-key',
      // 实测基线不缓存：下面那条造完样本要立刻看到新基线（lib/image-estimate.ts）。
      SATUWORK_IMAGE_BASELINE_CACHE_MS: '0',
    },
  })
  await waitHttp(`${base}/health`, { child: gw, what: 'image-gen gateway' })

  const require = createRequire(`${gwRoot}/package.json`)
  const pg = require('pg')
  const client = new pg.Client({ connectionString: PG_URL })
  await client.connect()
  await client.query(`set search_path to ${SCHEMA}`)

  try {
    let token = ''
    let adminToken = ''
    let seatToken = ''
    let companyId = ''

    await test('种数据：一家公司、一个员工席位、充一笔钱', async () => {
      const setup = await req(base, 'POST', '/auth/setup', { body: { email: 'o@img.test', name: 'o', password: 'correct-horse-1' } })
      assert(setup.status === 201, `setup ${setup.status} ${setup.text}`)
      token = setup.json.token
      const org = await req(base, 'POST', '/platform/orgs', {
        token,
        body: {
          name: 'Acme', slug: 'acme-img',
          contactName: '张三', contactPhone: '+86 138 0000 0000', contactEmail: 'z@img.test',
          adminEmail: 'a@img.test', adminPassword: 'correct-horse-1',
        },
      })
      assert(org.status === 201, `org ${org.status} ${org.text}`)
      companyId = org.json.company.id
      const login = await req(base, 'POST', '/auth/login', { body: { email: 'a@img.test', password: 'correct-horse-1' } })
      assert(login.status === 200, `login ${login.status} ${login.text}`)
      adminToken = login.json.token
      const secrets = await client.query(
        `select s."accessToken" from account_secrets s join accounts a on a.id = s."accountId" where a.email = 'a@img.test'`,
      )
      seatToken = secrets.rows[0].accessToken
      assert(seatToken.startsWith('sat_'), `席位票不对：${seatToken}`)
      const topup = await req(base, 'POST', '/platform/orders', {
        token,
        body: { companyId, kind: 'topup', amount: 10, payStatus: 'paid', note: 'image e2e' },
      })
      assert(topup.status === 201, `topup ${topup.status} ${topup.text}`)
    })

    await test('候选只给 owner：生图表里的模型、单价、密钥配没配', async () => {
      const mine = await req(base, 'GET', '/platform/image-models', { token })
      assert(mine.status === 200, `owner ${mine.status} ${mine.text}`)
      const g2 = mine.json.models.find((m) => m.provider === 'openai' && m.id === 'gpt-image-2')
      assert(g2 && g2.api === 'openai-images' && g2.cost.input === 8 && g2.cost.output === 30, `gpt-image-2：${JSON.stringify(g2)}`)
      assert(g2.configured === true, '环境变量里有 OPENAI_API_KEY，该算配了')
      const nb = mine.json.models.find((m) => m.provider === 'google' && m.id === 'gemini-3.1-flash-image')
      assert(nb && nb.api === 'gemini-images' && nb.configured === true, `Nano Banana 2：${JSON.stringify(nb)}`)
      /**
       * 每张图的预估（微元，倍率 1，没改价）：输入按 1500 token 估，输出按那一档的 token 数。
       *   gpt-image-2       1500×8 + 408×30 / 1584×30 / 6240×30 = 24240 / 59520 / 199200
       *   Nano Banana 2     1500×0.5 + 1117×60 / 1117×60 / 1684×60 = 67770 / 67770 / 101790
       */
      assert(JSON.stringify(g2.estimates) === JSON.stringify({ low: 24240, medium: 59520, high: 199200 }), `gpt-image-2 的预估：${JSON.stringify(g2.estimates)}`)
      assert(JSON.stringify(nb.estimates) === JSON.stringify({ low: 67770, medium: 67770, high: 101790 }), `Nano Banana 2 的预估：${JSON.stringify(nb.estimates)}`)
      assert(!mine.text.includes('env-openai-key'), '密钥回显了')
      const theirs = await req(base, 'GET', '/platform/image-models', { token: adminToken })
      assert(theirs.status === 403, `公司管理员拿到了 ${theirs.status}`)
    })

    let stampOff = ''
    await test('没挑的时候不下发，生图模型也不混进对话目录', async () => {
      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatToken })
      assert(cat.status === 200, `catalog ${cat.status} ${cat.text}`)
      assert(cat.json.models.image === null, `没挑却下发了：${JSON.stringify(cat.json.models.image)}`)
      stampOff = cat.json.stamp
      const models = await req(base, 'GET', '/v1/models', { token: adminToken })
      assert(models.status === 200, `models ${models.status}`)
      assert(!models.json.data.some((m) => /gpt-image/.test(m.id)), '生图模型混进了 /v1/models（会出现在「设为日常」里）')
    })

    await test('挑模型：只有 owner、只能挑生图表里的；公司侧看不到这一格', async () => {
      const bad = await req(base, 'PUT', '/platform/settings', { token, body: { image: { provider: 'openai', model: 'gpt-5.6' } } })
      assert(bad.status === 400 && /不是能用的生图模型/.test(bad.text), `对话模型不该挑得进去：${bad.status} ${bad.text}`)
      const half = await req(base, 'PUT', '/platform/settings', { token, body: { image: { provider: 'openai' } } })
      assert(half.status === 400, `半截的该 400：${half.status} ${half.text}`)
      const ok = await req(base, 'PUT', '/platform/settings', { token, body: { image: { provider: 'openai', model: 'gpt-image-2' } } })
      assert(ok.status === 200, `挑 ${ok.status} ${ok.text}`)
      assert(ok.json.image?.provider === 'openai' && ok.json.image?.model === 'gpt-image-2', `没存上：${JSON.stringify(ok.json.image)}`)
      // 存别的（日常）不能把它冲掉：PUT 是整份重写。
      const other = await req(base, 'PUT', '/platform/settings', { token, body: { priceMultiplier: 1 } })
      assert(other.status === 200 && other.json.image?.model === 'gpt-image-2', `存别的把生图冲掉了：${JSON.stringify(other.json.image)}`)
      const me = await req(base, 'GET', '/me', { token: adminToken })
      assert(me.status === 200 && me.json.settings && !('image' in me.json.settings), `公司侧看到了生图：${JSON.stringify(me.json.settings)}`)
      const theirs = await req(base, 'PUT', '/platform/settings', { token: adminToken, body: { image: null } })
      assert(theirs.status === 403, `公司管理员改得动：${theirs.status}`)
    })

    await test('挑了就下发，带 api；指纹跟着变', async () => {
      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatToken })
      const img = cat.json.models.image
      assert(img && img.provider === 'openai' && img.model === 'gpt-image-2' && img.api === 'openai-images', `下发的：${JSON.stringify(img)}`)
      assert(cat.json.stamp !== stampOff, '挑了生图模型，指纹却没变——跑着的席位不会重拉')
    })

    await test('/v1/images/generations（流式）：透传给 OpenAI Images，删 provider，按 token 记账', async () => {
      seen.length = 0
      const r = await req(base, 'POST', '/v1/images/generations', {
        token: adminToken,
        body: { model: 'openai/gpt-image-2', provider: 'openai', prompt: '一只猫', n: 1, stream: true, partial_images: 0 },
      })
      assert(r.status === 200, `images ${r.status} ${r.text.slice(0, 300)}`)
      assert(r.text.includes('image_generation.completed') && r.text.includes('aW1n'), `流里没有图：${r.text.slice(0, 300)}`)
      assert(!r.text.includes('env-openai-key'), '密钥漏进了响应')
      const up = seen[seen.length - 1]
      assert(seen.length === 1 && up.path === '/v1/images/generations', `上游：${JSON.stringify(seen.map((s) => s.path))}`)
      assert(up.auth === 'Bearer env-openai-key', `上游收到的是 ${up.auth}`)
      assert(up.body.model === 'gpt-image-2' && !('provider' in up.body) && up.body.prompt === '一只猫', `请求体：${JSON.stringify(up.body)}`)
      // withSettle 在响应收尾之后落账，给它一拍。
      await new Promise((res) => setTimeout(res, 300))
      const q = await client.query(
        `select u."amountMicros", u.kind, c.provider, c.model, c."promptTokens", c."completionTokens"
           from usage_charges u join llm_calls c on c.id = u."refId" where c."companyId" = $1 order by c."createdAt"`,
        [companyId],
      )
      assert(q.rowCount === 1, `该有 1 行账，实际 ${q.rowCount}`)
      const row = q.rows[0]
      assert(row.kind === 'llm' && row.provider === 'openai' && row.model === 'gpt-image-2', `账记在哪：${JSON.stringify(row)}`)
      assert(Number(row.promptTokens) === 40 && Number(row.completionTokens) === 1000, `token：${row.promptTokens}/${row.completionTokens}`)
      // 40 × $8 + 1000 × $30（每 100 万 token）= 30320 微元，倍率 1。输入按图片输入那一档（image-models.ts）。
      assert(Number(row.amountMicros) === 30320, `金额：${row.amountMicros}`)
    })

    await test('/v1/images/generations（整块 JSON）也记得上账', async () => {
      mode = 'json'
      const r = await req(base, 'POST', '/v1/images/generations', { token: adminToken, body: { model: 'openai/gpt-image-2', prompt: '一只狗' } })
      mode = 'sse'
      assert(r.status === 200 && r.json?.data?.[0]?.b64_json === 'aW1n', `images ${r.status} ${r.text.slice(0, 200)}`)
      await new Promise((res) => setTimeout(res, 300))
      const q = await client.query(
        `select count(*)::int as n, sum(u."amountMicros")::int as total from usage_charges u join llm_calls c on c.id = u."refId" where c."companyId" = $1`,
        [companyId],
      )
      assert(q.rows[0].n === 2 && q.rows[0].total === 60640, `两次该共 60640 微元：${JSON.stringify(q.rows[0])}`)
    })

    /** 这家公司最新那一行账：金额和 llm_calls 上记的 token。 */
    const lastCharge = async () => {
      await new Promise((res) => setTimeout(res, 300))
      const q = await client.query(
        `select u."amountMicros", c.provider, c.model, c."promptTokens", c."completionTokens"
           from usage_charges u join llm_calls c on c.id = u."refId" where c."companyId" = $1 order by c."createdAt" desc limit 1`,
        [companyId],
      )
      return q.rows[0]
    }

    await test('/v1/images/edits：OpenAI 的改图接口，原图原样带过去，账照记', async () => {
      seen.length = 0
      const images = [{ image_url: 'data:image/png;base64,QUJD' }]
      const r = await req(base, 'POST', '/v1/images/edits', {
        token: adminToken,
        body: { model: 'openai/gpt-image-2', provider: 'openai', prompt: '加顶帽子', images, stream: true },
      })
      assert(r.status === 200 && r.text.includes('image_edit.completed'), `edits ${r.status} ${r.text.slice(0, 200)}`)
      const up = seen[seen.length - 1]
      assert(up.path === '/v1/images/edits' && JSON.stringify(up.body.images) === JSON.stringify(images), `上游：${up.path} ${JSON.stringify(up.body)}`)
      const row = await lastCharge()
      assert(row.model === 'gpt-image-2' && Number(row.amountMicros) === 30320, `改图的账：${JSON.stringify(row)}`)
    })

    await test('Gemini（Nano Banana 2）：streamGenerateContent、x-goog-api-key、请求体里不带 model，按 usageMetadata 折算记账', async () => {
      const pick = await req(base, 'PUT', '/platform/settings', { token, body: { image: { provider: 'google', model: 'gemini-3.1-flash-image' } } })
      assert(pick.status === 200, `挑 ${pick.status} ${pick.text}`)
      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatToken })
      assert(cat.json.models.image?.api === 'gemini-images', `下发的 api：${JSON.stringify(cat.json.models.image)}`)
      seen.length = 0
      const body = {
        model: 'google/gemini-3.1-flash-image',
        provider: 'google',
        contents: [{ role: 'user', parts: [{ text: '一只猫' }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { imageSize: '1K' } },
      }
      // 画和改打的是同一个上游：两条都走一遍。
      for (const path of ['/v1/images/generations', '/v1/images/edits']) {
        const r = await req(base, 'POST', path, { token: adminToken, body })
        assert(r.status === 200 && r.text.includes('"inlineData"'), `${path} ${r.status} ${r.text.slice(0, 200)}`)
        assert(!r.text.includes('env-gemini-key'), '密钥漏进了响应')
      }
      assert(seen.length === 2, `上游该收到 2 次，实际 ${seen.length}`)
      for (const up of seen) {
        assert(up.path === '/v1beta/models/gemini-3.1-flash-image:streamGenerateContent?alt=sse', `上游路径 ${up.path}`)
        assert(up.auth === undefined, 'Gemini 不该带 Authorization')
        assert(up.key === 'env-gemini-key', `x-goog-api-key：${up.key}`)
        assert(!('model' in up.body) && !('provider' in up.body), `请求体里还有 model / provider：${JSON.stringify(Object.keys(up.body))}`)
        assert(up.body.contents?.[0]?.parts?.[0]?.text === '一只猫', `contents 被改坏了：${JSON.stringify(up.body)}`)
      }
      const row = await lastCharge()
      // 输出：图片 1290 + ⌈(文字 10 + 思考 90) / 10⌉ = 1300；20 × $0.5 + 1300 × $60 = 78010 微元。
      assert(row.provider === 'google' && row.model === 'gemini-3.1-flash-image', `账记在哪：${JSON.stringify(row)}`)
      assert(Number(row.promptTokens) === 20 && Number(row.completionTokens) === 1300, `token：${row.promptTokens}/${row.completionTokens}`)
      assert(Number(row.amountMicros) === 78010, `金额：${row.amountMicros}`)
    })

    await test('生图模型也能改价：覆盖按 provider/model 盖在表价上', async () => {
      const cur = await req(base, 'GET', '/platform/settings', { token })
      const put = await req(base, 'PUT', '/platform/settings', {
        token,
        body: { ...cur.json, modelPricing: { 'google/gemini-3.1-flash-image': { output: 30 } } },
      })
      assert(put.status === 200, `改价 ${put.status} ${put.text}`)
      const r = await req(base, 'POST', '/v1/images/generations', {
        token: adminToken,
        body: { model: 'google/gemini-3.1-flash-image', provider: 'google', contents: [{ parts: [{ text: 'x' }] }] },
      })
      assert(r.status === 200, `images ${r.status}`)
      const row = await lastCharge()
      // 20 × $0.5 + 1300 × $30 = 39010。
      assert(Number(row.amountMicros) === 39010, `改价没生效：${row.amountMicros}`)
    })

    await test('余额闸按「够不够这一张」判：还有几分钱也画不了一张两毛的图，说得出差多少', async () => {
      // 另起一家只充了 5 美分的公司。gpt-image-2 最贵那档预估 $0.1992，Nano Banana 2 是 $0.1018。
      const tiny = await req(base, 'POST', '/platform/orgs', {
        token,
        body: {
          name: 'Tiny', slug: 'tiny-img',
          contactName: '李四', contactPhone: '+86 139 0000 0000', contactEmail: 'l@img.test',
          adminEmail: 't@img.test', adminPassword: 'correct-horse-1',
        },
      })
      assert(tiny.status === 201, `org ${tiny.status} ${tiny.text}`)
      const topup = await req(base, 'POST', '/platform/orders', {
        token,
        body: { companyId: tiny.json.company.id, kind: 'topup', amount: 0.05, payStatus: 'paid', note: 'image gate e2e' },
      })
      assert(topup.status === 201, `topup ${topup.status} ${topup.text}`)
      const login = await req(base, 'POST', '/auth/login', { body: { email: 't@img.test', password: 'correct-horse-1' } })
      const tinyToken = login.json.token
      seen.length = 0
      const r = await req(base, 'POST', '/v1/images/generations', {
        token: tinyToken,
        body: { model: 'openai/gpt-image-2', provider: 'openai', prompt: '一只猫', stream: true },
      })
      assert(r.status === 402, `余额不够一张该 402，实际 ${r.status} ${r.text.slice(0, 200)}`)
      assert(/预估 \$0\.20/.test(r.text), `没说差多少：${r.text}`)
      assert(seen.length === 0, '余额不够还打了上游')
      // 充到够一张之后放行。
      const more = await req(base, 'POST', '/platform/orders', {
        token,
        body: { companyId: tiny.json.company.id, kind: 'topup', amount: 0.2, payStatus: 'paid', note: 'image gate e2e 2' },
      })
      assert(more.status === 201, `topup ${more.status} ${more.text}`)
      const ok = await req(base, 'POST', '/v1/images/generations', {
        token: tinyToken,
        body: { model: 'openai/gpt-image-2', provider: 'openai', prompt: '一只猫', stream: true },
      })
      assert(ok.status === 200, `充够之后该放行，实际 ${ok.status} ${ok.text.slice(0, 200)}`)
    })

    await test('实测基线：样本够了就按真实用量的 P95 估，闸门和模型配置页一起跟着变', async () => {
      // 一家只有 3 美分的公司。gpt-image-1-mini 按表里最贵那档估是 1500×2.5 + 6240×8 = 53670 微元，不够。
      const org = await req(base, 'POST', '/platform/orgs', {
        token,
        body: {
          name: 'Tiny2', slug: 'tiny2-img',
          contactName: '王五', contactPhone: '+86 137 0000 0000', contactEmail: 'w@img.test',
          adminEmail: 't2@img.test', adminPassword: 'correct-horse-1',
        },
      })
      assert(org.status === 201, `org ${org.status} ${org.text}`)
      const topup = await req(base, 'POST', '/platform/orders', {
        token,
        body: { companyId: org.json.company.id, kind: 'topup', amount: 0.03, payStatus: 'paid', note: 'baseline e2e' },
      })
      assert(topup.status === 201, `topup ${topup.status} ${topup.text}`)
      const t2 = (await req(base, 'POST', '/auth/login', { body: { email: 't2@img.test', password: 'correct-horse-1' } })).json.token
      const draw = () => req(base, 'POST', '/v1/images/generations', {
        token: t2,
        body: { model: 'openai/gpt-image-1-mini', provider: 'openai', prompt: '一只猫', stream: true },
      })
      const cold = await draw()
      assert(cold.status === 402 && /预估 \$0\.05/.test(cold.text), `冷启动按表里最贵那档该 402：${cold.status} ${cold.text.slice(0, 200)}`)
      const before = (await req(base, 'GET', '/platform/image-models', { token })).json.models.find((m) => m.id === 'gpt-image-1-mini')
      assert(before.measured === null, `没有样本却有实测：${JSON.stringify(before.measured)}`)

      /**
       * 造 25 次真成交过的调用：输入 50、输出 100×i。挂在 owner 名下（companyId 为空），不动任何
       * 公司的余额。P95 按最近秩取第 ⌈0.95×25⌉ = 24 个：2400；平均 1300。
       *   P95 金额  50×2.5 + 2400×8 = 19325 微元；平均 50×2.5 + 1300×8 = 10525 微元。
       */
      const now = Date.now()
      for (let i = 1; i <= 25; i++) {
        const id = `e2e-baseline-${i}`
        await client.query(
          `insert into llm_calls (id, "accountId", "companyId", provider, model, "promptTokens", "completionTokens", "createdAt")
           values ($1, 'e2e-owner', null, 'openai', 'gpt-image-1-mini', 50, $2, $3)`,
          [id, 100 * i, now - i * 1000],
        )
        await client.query(
          `insert into usage_charges (id, "companyId", "accountId", kind, subject, status, "amountMicros", "refId", "createdAt")
           values ($1, null, 'e2e-owner', 'llm', 'openai/gpt-image-1-mini', 'ok', 0, $2, $3)`,
          [`${id}-charge`, id, now - i * 1000],
        )
      }
      // 失败的那种不算：同一颗模型再造一条巨大的、账本上是 failed 的，基线不该被它拽上去。
      await client.query(
        `insert into llm_calls (id, "accountId", "companyId", provider, model, "promptTokens", "completionTokens", "createdAt")
         values ('e2e-baseline-bad', 'e2e-owner', null, 'openai', 'gpt-image-1-mini', 50, 999999, $1)`,
        [now],
      )
      await client.query(
        `insert into usage_charges (id, "companyId", "accountId", kind, subject, status, "amountMicros", "refId", "createdAt")
         values ('e2e-baseline-bad-charge', null, 'e2e-owner', 'llm', 'openai/gpt-image-1-mini', 'failed', 0, 'e2e-baseline-bad', $1)`,
        [now],
      )
      const after = (await req(base, 'GET', '/platform/image-models', { token })).json.models.find((m) => m.id === 'gpt-image-1-mini')
      assert(JSON.stringify(after.measured) === JSON.stringify({ samples: 25, avg: 10525, p95: 19325 }), `实测：${JSON.stringify(after.measured)}`)
      // P95 那一张 $0.019 < 3 美分：这回放行。
      const warm = await draw()
      assert(warm.status === 200, `有了实测基线该放行，实际 ${warm.status} ${warm.text.slice(0, 200)}`)
    })

    await test('走错路：生图模型打 chat、对话模型打 images，都是 400，不开调用行', async () => {
      const before = (await client.query('select count(*)::int as n from llm_calls')).rows[0].n
      const asChat = await req(base, 'POST', '/v1/chat/completions', {
        token: adminToken,
        body: { model: 'openai/gpt-image-2', messages: [{ role: 'user', content: 'hi' }] },
      })
      assert(asChat.status === 400 && /生图模型/.test(asChat.text), `生图模型打 chat：${asChat.status} ${asChat.text}`)
      const asResponses = await req(base, 'POST', '/v1/responses', { token: adminToken, body: { model: 'openai/gpt-image-2', input: 'hi' } })
      assert(asResponses.status === 400 && /生图模型/.test(asResponses.text), `生图模型打 responses：${asResponses.status} ${asResponses.text}`)
      const chatModel = (await req(base, 'GET', '/v1/models', { token: adminToken })).json.data.find((m) => m.provider === 'openai')
      assert(chatModel, '目录里连一颗 openai 的对话模型都没有')
      const asImage = await req(base, 'POST', '/v1/images/generations', { token: adminToken, body: { model: chatModel.id, prompt: 'x' } })
      assert(asImage.status === 400 && /不是生图模型/.test(asImage.text), `对话模型打 images：${asImage.status} ${asImage.text}`)
      const after = (await client.query('select count(*)::int as n from llm_calls')).rows[0].n
      assert(after === before, `走错路的调用不该开 llm_calls 行：${before} → ${after}`)
    })

    await test('关掉：下发回到 null，指纹回到没挑时那一份', async () => {
      const off = await req(base, 'PUT', '/platform/settings', { token, body: { image: null } })
      assert(off.status === 200 && !off.json.image?.model, `关 ${off.status} ${JSON.stringify(off.json.image)}`)
      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatToken })
      assert(cat.json.models.image === null, `关了还在下发：${JSON.stringify(cat.json.models.image)}`)
      assert(cat.json.stamp === stampOff, '关掉之后指纹该回到没挑时那一份')
    })
  } finally {
    await client.end().catch(() => {})
    gw.kill()
    await new Promise((r) => upstream.close(r))
    rmSync(GW_HOME, { recursive: true, force: true })
  }
}
