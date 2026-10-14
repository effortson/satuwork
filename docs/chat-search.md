# 对话内查找：在一条会话里找消息和文件

> 一个 Bot 一条长会话，几个月下来几千轮。「上次说到报价是在哪儿」「那份合同草案是哪天传的」
> 这种问题，往上翻是翻不到的。这一页说的是顶栏那颗放大镜背后的东西。

## 1. 人怎么用

- 对话顶栏（Bot 名字那一行）右侧一颗放大镜，或者 ⌘F / Ctrl+F，打开一条浮在消息流右上角的
  查找条。它像浏览器的页内查找，不是另开一屏列表：找到就站在那条消息上接着看上下文。
- 边打边搜（停 250 ms 发一次）。命中之后**直接站到最近的那一条**，不用再按一下。
- Enter / ↑ 往更早走，Shift+Enter / ↓ 往更新走，到头回绕。计数写成 `3 / 17`，
  后面还有没取回来的页就是 `3 / 100+`。
- 第二行说这一站是谁、什么时候、命中处那一小段；带着文件的话列出文件名，点一下开预览。
- 消息流里每一处命中的词都上底色；当前那一站的气泡常亮一圈。Esc 关掉，焦点回输入框。
- **只搜这一个 Bot 的这一条会话。** 换 Bot 查找条一起收掉——命中的位置是会话里的 seq，
  换了会话指不到东西。

## 2. 搜什么、不搜什么

| 算 | 不算 |
|---|---|
| 用户说的话（`user/message` 里真人、渠道、看板 / 日常任务 / 转人工那几种） | 系统提示快照、Skill 目录这类注入（界面上也不画） |
| 助手的正文（`assistant/message` 的 text 块） | 推理块、流式 chunk |
| 文件名：上传的附件、`image` 块、`ref` 文件块、工具报的 `files`、委派任务报的 `files` | 工具原文、工具「看到」的文件（`refs`）、截图 |
| 最近一次 `/clear` 之后的 | `/clear` 之前的（界面上往上翻也看不见） |

多个词用空格隔开是「都要有」，不是「任一」；不区分大小写；普通子串，不是正则。
`/new` 之后的前文**照样搜得到**——界面上往上翻看得见，就该搜得到。这一点和模型自己的
`history_search` 不同（那把到 `/new` 为止，见 docs/chat-commands.md）。

## 3. 为什么匹配在席位上做

浏览器手上只有最近二十轮（`CHAT_TAIL_TURNS`），更早的要一页页翻才有；而几个月的长会话翻到
头要几百页。席位有整份 JSONL（常驻内存，`ctx.sessions.events`），一次扫完回全部命中的位置，
浏览器只负责按位置跳过去。

**分块规则照抄界面的 fold。** 命中要能跳到屏幕上那条气泡，而气泡是按 `core/src/chat/fold.ts`
的规则拼出来的：一条 `user/message` 一个块；之后到下一条 `user/message` 之前的所有助手事件合
成一个块，正文取最后一条有字的 `assistant/message`，壳上的 `data-seq` 是**最后一条**
`assistant/message` 的 seq（fold 的 `msgSeq`）。bot 不依赖 core 包，所以 `bot/src/session/search.ts`
里是一份只保留搜索要用的几样（正文、文件、锚点）的镜像；上传附件那段固定格式的解析
（`splitUploads`）同理。两边的判据必须一样——漂了的表现是「搜到了却说那条消息不在这里」。

## 4. 接口

### 席位 `GET /api/sessions/:id/search?q=&limit=&before=`

| 参数 | 含义 |
|---|---|
| `q` | 关键词，空格分词，最多 8 个词、每词 100 字、整串 200 字。空就是空结果，不是 400 |
| `limit` | 正文命中一页几条，默认 20，上限 100 |
| `before` | 翻下一页：只要 `seq` 小于它的 |

```jsonc
{
  "query": "报价", "terms": ["报价"],
  "hits": [
    // seq：这一块的游标（块里第一条事件的 seq，唯一）；anchor：界面上气泡壳的 data-seq
    { "seq": 812, "anchor": 815, "role": "assistant", "time": 1760000000000, "snippet": "…报价单我看过了…" }
  ],
  "files": [
    { "path": "out/报价单-v2.xlsx", "name": "报价单-v2.xlsx", "anchor": 815, "role": "assistant", "time": 1760000000000 }
  ],
  "total": 4,        // 正文命中总数，不受分页影响
  "fileTotal": 1,    // 文件不分页，最多给 50 个，同一路径只留最近一次
  "hasMore": false,
  "nextBefore": null
}
```

新的在前。助手块里一条 `assistant/message` 都没有（只跑了工具）时，`anchor` 退回到提问那条。

### Gateway `GET /runtime/sessions/:id/search`

授权和历史那条一样走会话索引（`seatTargetForSession`），参数原样递给席位。本地 Bot 走
`core/src/api.ts` 的 `localRoute`，`/runtime/sessions/:sid/*` 那条通配已经覆盖，不用改表。

## 5. 界面（gateway/ui/chat-find.js）

- 状态在 `state.chatFind`；查找条的**存在**由它决定（`chatFindHtml`，跟着整页重绘），
  **内容**由 `paintChatFind` 就地填——每敲一个键都重绘整页的话输入框会丢焦点。
- 正文命中和文件命中按**消息**合并成一条跳转序列（`mergeFindHits`）：同一条消息既有字命中
  又带着命中的文件，是一站，不是两站。
- 跳转走 `jumpToMessage(anchor, { pages })`：引用卡默认只往前补 5 页，查找给 400 页。
- 往更早走到正文命中的尽头而席位说还有更多时，**先续一页再走**（`findStep`）：文件命中是
  一次全给的，可能比已取的正文命中更早，不续的话会跳过中间那些正文命中。
- 命中词高亮用 CSS Custom Highlight API（`CSS.highlights`），只画不改 DOM——消息正文是
  markdown.js 增量渲染的，插 `<mark>` 会让它认不出自己画过的块。不支持的浏览器只有
  当前那条亮一圈。

## 6. 测试

- `e2e/search.mjs`（探针 `bot/e2e-search.mjs`）：分块与锚点、算与不算、文件、多词、分页、
  `/clear` 与 `/new`、摘录。
- `e2e/gateway-chat.mjs`：经 Gateway 那一路（路径、鉴权、anchor 对得上历史里的 seq）。
- `e2e/ui-smoke.mjs`：入口和查找条在、合并规则、高亮先转义。

## 7. 发版

bot 和 gateway/ui 都动了。席位要换 bot 版才有 `/search`（老席位上查找条会报「找不到」）；
桌面端打包了这套 UI，桌面端要随下次桌面发版。
