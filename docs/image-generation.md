# 生图：Bot 的 generate_image

Bot 能按一段描述画一张图，也能拿工作区里已有的图（包括用户发来的）改一张新的。图存进工作区
`images/`，对话里直接显示缩略图。用哪颗生图模型由平台挑，按 token 计费，和对话模型记在同一本账上。

## 1. 为什么是一把工具

「原生出图」（Responses API 的 `image_generation`、Gemini 的图像模型）绑死在当时那颗对话模型上：
平台的日常模型是 DeepSeek 或 Claude 时就画不了，而且 pi-agent-core 得学会解析那几种输出块。
做成工具之后，谁当对话模型都能画；用哪颗生图模型由平台决定。

## 2. 模型从哪来

`gateway/src/image-models.ts` 里一张写死的小表：

| 模型 | `api` | 输入 / 输出（$ / 1M tok） |
|---|---|---|
| `openai/gpt-image-2` | `openai-images` | 8 / 30 |
| `openai/gpt-image-1-mini` | `openai-images` | 2.5 / 8 |
| `google/gemini-3.1-flash-image`（Nano Banana 2） | `gemini-images` | 0.5 / 60 |
| `google/gemini-3-pro-image`（Nano Banana Pro） | `gemini-images` | 2 / 120 |

- **不从 pi-ai 的目录里来**：那份是对话模型的目录，gpt-image 不在里面；models.dev 的自动发现也
  只收能调工具的模型。
- **不进 `Llm.catalog()`**：那份目录是日常 / utility / 备选挑模型的来源，也是 `/v1/models`
  下发给席位的那份。生图模型混进去，就会出现在「设为日常」的列表里。反过来，表里的模型要是被
  pi-ai 或自动发现当成对话模型收了进来，`catalog()` 也会把它剔掉。
- **`Llm.find` 的最后一档会认它们**：授权、结算、清扫、`/v1` 都靠 find 认模型、拿单价。
  走错路由（生图模型打 chat、对话模型打 images）由 `upstreamTargetOf` 挡成 400。

平台在模型配置页「生图模型」那一块挑（owner 可见，候选来自 `GET /platform/image-models`），存在
`PlatformSettings.image`。只能挑表里有的；不挑就是没开。那一块上也有「改价」，和对话模型共用
同一个改价弹层（`modelPricing`，以 `provider/model` 为键）。

## 3. 下发与工具表

`/runtime/catalog` 的 `models.image` 是 `{ provider, model, api }`，没开或者挑的那颗已经不在表里
了就是 `null`。它进目录指纹（`modelStamp`），开、关、换都会让席位重拉。没开时指纹和加这一格
之前一字不差。

席位上 `generate_image` 总是注册，但 `models.image` 为空时不进工具表（agent 的 `toolSchemasFor`）；
模型照着历史里的名字调过来，工具会回一句「平台还没有开通生图」。policy 的 no-external 守卫放行它，
理由同网页工具：出口和密钥都不在席位上。风险标 `external + read`，不弹确认卡，因为它不改任何已有
的东西：改图也是另存一张新的，原图不动；重名不覆盖。

## 4. 调用走哪条路

和对话一样走 `llmBaseUrl()`，画走 `generations`，改走 `edits`：

| 谁 | 打哪 | 谁拿密钥 |
|---|---|---|
| 席位 Bot | 本机管家 `/llm/v1/images/{generations,edits}` | 管家向 `/worker/llm/grant` 要授权（`route: 'images'` / `'image-edits'`），直接打供应商 |
| 桌面本地 Bot | Gateway `/v1/images/{generations,edits}` | Gateway |

请求体由 Bot 按模型的 `api` 拼成供应商的原生形状（`bot/src/tools/image.ts` 的 `imageRequest`）。
上游地址和补丁在 `llm.ts` 的 `imageTargetOf`：

| `api` | 上游 | 鉴权 | 补丁 |
|---|---|---|---|
| `openai-images` | `{OPENAI_BASE_URL}/v1/images/generations` 或 `/edits` | `Authorization: Bearer` | `model` 换正名，删 `provider` |
| `gemini-images` | `{GEMINI_BASE_URL}/v1beta/models/{id}:streamGenerateContent?alt=sse`（画和改同一个） | `x-goog-api-key` | `model` 和 `provider` 都删：模型在地址里 |

**请求一律是流式的**（OpenAI 是 `stream: true`，Gemini 是 `streamGenerateContent`）。不是为了看半成品：

- 非流式要等整张图画完才给响应头，高质量的大图常常超过一两分钟；管家和 Gateway 都只等响应头 120 秒。
- 图的 base64 是几 MB 的一整块。Gateway 在 Vercel 上时，非流式响应体有 4.5 MB 的上限。

拆答复：

- **OpenAI**：图在 `image_generation.completed` / `image_edit.completed` 那一帧；也认整块 JSON
  （`data[0].b64_json`），中间有代理把流攒成一块时就是那个形状。
- **Gemini**：图在 `candidates[0].content.parts[].inlineData`。**`thought: true` 的草稿不要**：
  Gemini 3 的生图模型会先画几张草稿当思考过程，结果是最后一张不带这个标记的。一张图都没有时多半
  是被安全策略拦了，把 `promptFeedback.blockReason` / `finishReason` 照实报给模型。

## 5. 改图

`generate_image` 的 `images` 参数收工作区里的路径（PNG / JPEG / WebP，最多 4 张）。Bot 从工作区读
原图，OpenAI 放进 `images: [{ image_url: data URL }]`，Gemini 放进 `contents` 的 `inlineData`。
越界、格式不认、文件不存在、太大，都是业务失败，写成一句话给模型，不打上游。

**原图总量有上限**：席位走管家时 20 MB（管家收 32 MB 的请求体，base64 要乘 4/3）；桌面本地 Bot
直连 Gateway 时只有 3 MB，因为 Vercel 的请求体上限是 4.5 MB。

**用户发来的图要有名字**：模型看得见图，却不知道它在工作区叫什么。所以每张真带上了字节的附图后面，
agent 会跟一行 `[附图 uploads/…]`（`userContentFor`）。

### 局部重绘（蒙版）

`mask` 参数收一张工作区里的 PNG：和第一张原图一样大，**透明的地方重画**，其余不动（OpenAI 的约定，
原样放进 `mask: { image_url }`）。Bot 在本地先查三件事（`maskProblem`）：是不是 PNG、有没有透明通道
（IHDR 颜色类型 4 / 6，或者带 tRNS 块）、尺寸和第一张原图对不对得上（PNG 和 JPEG 读得出尺寸，别的
格式跳过这一项）。这三样都是 OpenAI 的硬要求，不在这儿挡的话，上游回的是一句英文的 400。

**Gemini 不收透明蒙版**，它只按指令改图——官方文档里改图的做法就是「多张图 + 一段文字」。所以对它
（`geminiMaskParts`）：

1. 把蒙版的像素解开（`bot/src/tools/png.ts`，不引图像库），换成一张同样大的**黑白图**：白色 = 要重画；
2. 算出涂抹区域的外接框，落在九宫格哪一格、横向纵向各占百分之几、占画面多少（`maskRegion`）；
3. 发过去的是：原图、黑白蒙版、（其余参考图）、一段写明「第二张是蒙版，只改白色区域，白色以外必须和原图
   一模一样，尺寸构图不变」和方位范围的指令。

这比不上 OpenAI 的像素级蒙版，Gemini 可能会顺手动一点白色以外的东西；但人涂的那一块真的传到了，比只靠
文字说「改左下角那只杯子」准得多。这条路要读得出像素：蒙版得是非隔行的 8 / 16 位 RGBA、灰度 + 透明，
或者带 tRNS 的调色板图；界面上涂出来的都是 8 位 RGBA。

两家都会先拦「一个透明的地方都没有」的蒙版：那等于什么都不改，发出去也是白花钱。

**蒙版由人涂，不由模型做**：模型多半看不见图，看得见也说不准坐标。对话里的图片预览上有「局部重绘」，
人用笔刷涂出要改的那一块，点「用这块重绘」之后：

1. 按原图尺寸出一张蒙版：先整张涂成不透明，再把笔画挖掉（`destination-out`）；
2. 蒙版作为附件挂到输入框上（`mask-<原图名>.png`），随消息传进工作区；
3. 输入框预填一句「按蒙版 mask-x.png 局部重绘 images/x.png，涂掉的那块改成：」，人接着写要改成什么。

笔画按**原图像素**坐标存在 `state.preview.paint` 里，不只画在画布上：任何一次无关的 `render()` 都会把
弹层整个换掉，画布重新挂上来时（`mountPainter`，render.js 每次 render 之后调）照着重画一遍。

## 6. 计费

两家都按 token 计费，账记在 `llm` 那一类，单价取自生图表里的 `cost`。平台倍率、按模型改价、
兜底价都照常生效，不需要新的计费类别，也没有迁移。

- **OpenAI**：答复里的 `usage` 和 Responses API 一个形状，`llm-usage.ts` 现成就认。**`input` 取的是
  图片输入价**，不是文字输入价：usage 里文字和图片 token 只拿得到合计，按文字价收，改图就一直少收；
  按图片价收，多收的只是提示词那几十个文字 token。两害相权取高估。
- **Gemini**：`usageMetadata` 在 `llm-usage.ts` 的 `geminiUsage` 里单独解析（Gateway 和管家那两份
  逐字相同）。它对图片输出和文字 / 思考输出收两档价，差 10–20 倍，而我们一次调用只有一个输出单价。
  单价按图片那档定，文字和思考的 token 折成图片 token：除以 10，对 Pro 正好，对 Flash 多收一倍，
  而思考那几百个 token 在 Flash 上多收不到半分钱。只有 `candidatesTokensDetails` 里真有 IMAGE 时
  才折，纯文字的答复照合计记。

### 预估

真收钱按答复里的 token，事后结算。但一张图的价钱大体是定的，所以闸门事先要估一个数。

**先看自己实测的，没有才看表**（`gateway/src/lib/image-estimate.ts`）。一张图用多少 token 随画面内容变，
OpenAI 也明说 gpt-image-2 没有固定的表（同一档质量下大图的 token 可能反而比小图少）。所以：

- **实测基线**：这颗模型最近 30 天真成交过 20 张以上（账本上是 `ok`、有输出），就取最近 200 张输入、
  输出各自的 **P95**。用 P95，是因为按平均估一半的调用都比它贵，按最大值又会被一两张离群的大图拽高。
  实测天然反映了这家平台上人们实际在用的质量档，比「一律按最贵那档」贴近得多。查询走迁移 0048 的
  `llm_calls (provider, model, "createdAt")` 索引，结果缓存 10 分钟。
- **冷启动**：样本不够时用生图表里的 `outputTokens`（按质量档，取最大尺寸），输入按 1500 token 估。
  OpenAI 借它公布的前几代 gpt-image 每张 token 数（低 408、中 1584、高 6240）；Gemini 由定价页的每张价格
  折回 token（Nano Banana 2 的 1K / 2K 是 1117 / 1684，Pro 是 1117）。

预估金额和真收钱用同一套单价（改价、兜底、倍率都算进去，`meter.estimate`），用在两处：

- **余额闸门**：生图模型按「够不够这一张」判，不只是「还有没有余额」（`GateSubject.estimate`）：有实测
  按实测的 P95，冷启动按表里最贵那档。管家和 Gateway 都不拆请求体，不知道这一次要的是哪一档，所以冷启动
  只能按最贵的估。还有余额、只是不够时，拒绝的原话里带上预估金额。
- **模型配置页**：生图那一块显示按档的「每张约 $x / $y / $z」，以及实测的「最近 N 张：平均 $a，P95 $b；
  余额闸门按 P95 判」（没样本时说明闸门先按高质量那档判）。数据来自 `/platform/image-models` 的
  `estimates` 和 `measured`，改价、改倍率之后重取。

## 7. 格式与界面

- OpenAI 默认 JPEG（压缩 90）。同一张 1024² 的图，PNG 两三 MB，JPEG 几百 KB，而界面上的缩略图只
  自动拉 2 MB 以内的（`chat.js` 的 `SHOT_AUTO_MAX`）。要透明背景时默认 PNG，也可以选 WebP。
- Gemini 选不了格式（多半出 PNG），也画不了透明背景；要透明背景时直接回一句「这颗模型画不了」。
  尺寸映射成宽高比（`1:1` / `3:2` / `2:3`），`quality: high` 给 2K，其余 1K。
- 画新图默认方图；改图默认 `auto`，跟原图的比例走。
- 图作为 `files` 报出来：Telegram 那边照常把它当产出文件发；Web 端的消息底下把**产出的位图**摆成
  240px 的缩略图（最多 8 张，多的照旧是药丸）。这条规则对所有工具的产出图片都生效，脚本画的图表
  也直接看得到。
- 给模型的只有一行「画好了，存在哪」。图不进上下文：对话模型多半没有视觉，几 MB 的 base64 只会把
  上下文撑爆。

## 8. 发版顺序

1. **Gateway 先上**。老席位不认 `models.image`，照旧没有这把工具。
2. **再推管家**。老管家没有 `/llm/v1/images/*`，回 404 `not found`，工具会说「管家版本太旧」。
3. **最后推 `bot-v*`**。桌面端跟着发版，本地 Bot 直连 Gateway 的 `/v1/images/*`，不经管家。

## 9. 上线前要做的

以上都只对着假上游测过。上线前用真 key 各走一遍：

- gpt-image-2：画一张、改一张、带蒙版局部重绘一张。OpenAI 改图文档里列的模型没有 gpt-image-2。
- Nano Banana 2 / Pro：画一张、改一张、局部重绘一张。确认 `imageConfig` 的字段名和白色以外保持不变的效果。
- 看账本上这几笔的 token 和金额，和两家后台的用量对得上。
