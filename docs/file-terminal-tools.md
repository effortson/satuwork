# Satuwork：把内置工具换成 file + terminal 两个工具集

换之前，席位上干活的那套手是 `read / write / edit / ls / find / grep / bash` 七把，形状
照 Claude Code 抄的。本文把它换成 Hermes Agent 的两个工具集：

| 工具集 | 工具 |
| --- | --- |
| `file` | `patch` / `read_file` / `search_files` / `write_file` |
| `terminal` | `terminal` / `process` |

七把变六把，`now` / `history_*` / `web_*` / `browser_*` / `escalate_to_human` 一律不动。

上游口径见 <https://hermes-agent.nousresearch.com/docs/zh-Hans/reference/tools-reference>；
本文里凡是和上游不一致的地方都单独标了**为什么**——那几处是有意的，不是抄漏了。

---

## 1. 为什么要换

**一、七把工具里有四把在讲同一件事。** `ls`、`find`、`grep` 是「在文件系统里找东西」的
三种问法，模型每次都要先决定问哪一个；而 `bash` 又能把这三件事全干了，于是它常常直接
`bash ls -la`——那正是我们花了一整个 `SKIPPED_DIRS` 和输出上限想避免的路。合成
`search_files` 之后只有一个入口，`target` 决定是搜内容还是找文件。

**二、`edit` 太脆。** 它要求 `old_string` 与文件里的内容**逐字相同**，缩进差一格就
`没找到那段文本`。模型于是回去重读、重试，一次编辑烧掉两三步。`patch` 的模糊匹配把
这一类失败整个消掉。

**三、`bash` 只有前台一条路。** 起一个开发服务器、跑一次十分钟的构建，今天只有两个
结局：撞超时被杀，或者用 `nohup … &` 甩出去然后彻底失联（进程组还在，端口占着，没有
任何东西管得到它）。`terminal(background=true)` + `process` 把这一段收进注册表。

**不为什么换：** 不是因为 Hermes 那套更「标准」。工具名和描述越接近模型见过的约定，
调用就越准——这条理由和当初照 Claude Code 抄是同一条，只是我们换了一个更值得抄的对象。

---

## 2. 目标与非目标

**做成：**

1. 六把新工具在席位上跑起来，覆盖今天七把的**全部**用法，一个都不少
2. `patch` 带模糊匹配，返回统一差异格式
3. `terminal` 支持后台进程，`process` 管它们的一生，进程不会活过换版
4. 边界一样不少：路径越界、命令扫描、审批、审计流水，全部照旧生效
5. 界面零改动——`ToolResult` 的 `files` / `refs` / `shot` 三个字段不动，气泡和药丸认的
   是这几个字段，不是工具名（[chat.js:6043](../gateway/ui/chat.js:6043)）

**先不做：**

- **V4A 多文件补丁**（`patch(mode='patch')`）。它是另一套解析器和另一套失败模式，而
  单文件替换覆盖了模型实际会写的绝大多数编辑。schema 里**连 `mode` 参数都不出现**——
  给模型看一个它调不通的取值，它就会去调（这条道理在
  [agent/index.ts:1270](../bot/src/agent/index.ts:1270) 那段注释里已经写过一遍）。
  将来要加，默认值就是 `replace`，向后兼容
- **相似度匹配的那两条策略**（`block_anchor` / `context_aware`）。见 §3.3
- **PTY**（`terminal(pty=true)`）。需要 `node-pty`，那是个原生模块——发布包只在 Linux
  arm64 上打，`@esbuild/*` 那一个架构相关的依赖已经要在出包检查里单独 `grep` 一遍
  （[local-release.md:129](./local-release.md:129)），再加一个不值得。席位上也没有
  「让模型开一个交互式 REPL」的场景
- **`watch_patterns`**（后台输出里蹲关键字）。限流、自动禁用、回落到退出通知，是它自己
  的一整份复杂度；`notify_on_complete` 覆盖了九成半
- **`process` 的 `write` / `submit` / `close`**。没有 PTY，往管道里喂 stdin 只对少数程序
  有意义，而那少数程序模型也判断不出来
- **写入后自动跑语法检查。** Hermes 的 `write_file` / `patch` 会对 `.py`/`.json`/`.yaml`
  跑一遍 lint。席位是员工的办公桌，不是开发机——工作区里多半是文档和表格，而机器上
  也不保证有那些工具链
- **改名的兼容壳。** 见 §6

---

## 3. file 工具集

四把都注册在新的 `bot/src/tools/file.ts`，`inject: ['tools', 'workspace']`，根目录与
越界检查仍然只有 `ctx.workspace` 那一份（[workspace/index.ts:47](../bot/src/workspace/index.ts:47)）。
原先 `tools/workspace.ts` 里那些上限常量（`MAX_READ_LINES`、`MAX_LINE_CHARS`、
`SKIPPED_DIRS` …）原样搬过去，它们和工具名没有关系。

### 3.1 `read_file`

```jsonc
{
  "name": "read_file",
  "risk": ["read"],
  "parameters": {
    "path":   { "type": "string" },              // 必填，相对工作区根，也收工作区内的绝对路径
    "offset": { "type": "integer", "minimum": 1, "default": 1 },
    "limit":  { "type": "integer", "maximum": 2000, "default": 2000 }
  }
}
```

和今天的 `read` 只有两处不同：

**一、输出格式从 `行号 \t 内容` 改成 `行号|内容`。** 上游的描述里写死了这个格式，照它
写模型才认得出来。代价是模型偶尔会把 `123|` 一起抄进 `patch` 的 `old_string`——所以
`patch` 那边要剥前缀，见 §3.3。

**二、加 `next_offset`。** 一次读到 ~100K 字符就在行边界上停，末尾那句从
「还有 N 行，用 offset 继续读」改成带上确切的下一个 `offset`。今天那句话让模型自己算
起始行，它算错过。

PDF / Word / Excel 先转文本再按行分页这条**不动**——`docKindOf` / `extractDocument`
（[workspace/extract.ts](../bot/src/workspace/extract.ts)）照旧，那正是上游 `read_file`
也在做的事。二进制、空文件、目录三种情况的提示语照搬，只把「用 ls 列它的内容」改成
「用 search_files 列它的内容」。

`refs` 照旧报自己这一个文件。理由见 [tools/index.ts](../bot/src/tools/index.ts) 里
`ToolResult.refs` 那段：模型读完常常只说「已读取《某某报告》」，用的是文档标题不是
文件名，界面拿正文一个字也接不上。

### 3.2 `write_file`

```jsonc
{
  "name": "write_file",
  "risk": ["write"],
  "parameters": {
    "path":    { "type": "string" },   // 必填
    "content": { "type": "string" }    // 必填
  }
}
```

就是今天的 `write` 换个名字。父目录自动建、已存在就覆盖、返回行数与大小、`files` 报
自己这一个产出——全部照旧。

上游的 `cross_profile` 不要：那是 Hermes 的多 profile 概念，我们没有。

上游描述末尾那句「结果里的 `verified:true` 表示磁盘内容哈希已核对，**不要**再读一遍
文件去确认写没写进去」值得抄进描述——那一次多余的 `read_file` 是纯粹的上下文浪费，
而模型不被明确告知就会去读。我们不做哈希，只在文本里把「已写入」说死。

**参数缺失要单独报。** 上游对 `content` 缺失专门写了一句「这几乎总是上下文压力下的
掉参数 bug，把完整内容重发一遍」。我们照做：今天的 `缺少 content 参数` 说不清该怎么办。

### 3.3 `patch`

```jsonc
{
  "name": "patch",
  "risk": ["write"],
  "parameters": {
    "path":        { "type": "string" },   // 必填
    "old_string":  { "type": "string" },   // 必填
    "new_string":  { "type": "string" },   // 必填，空串表示删除
    "replace_all": { "type": "boolean", "default": false }
  }
}
```

参数形状和今天的 `edit` 一模一样，差别全在匹配上。

**模糊匹配按顺序试这五条，命中即停：**

| # | 策略 | 放宽了什么 |
| --- | --- | --- |
| 1 | `exact` | — |
| 2 | `line_trimmed` | 每行首尾空白 |
| 3 | `whitespace_normalized` | 连续空格/制表符压成一个 |
| 4 | `escape_normalized` | 字面量 `\n` 当成真换行 |
| 5 | `unicode_normalized` | 弯引号、破折号、省略号、以及**整个 Zs 空格族**（含全角空格 `　`）|

**第 5 条对我们比对上游更重要。** 工作区里是中文文档：全角空格、中文引号、`——`
到处都是，而模型写 `old_string` 时打的是 ASCII。少这一条，中文文档的每一次编辑都要
靠模型逐字复刻排版字符。替换时**保留文件原来的那些字符**，不要把文件里的全角空格
换成半角——那是静默的排版破坏。

> 破折号折成**一个** `-`，不是上游那个 `--`。归一化是两边一起做的，要的是「两种写法
> 能撞上」：中文里的破折号是 `——`（两个 U+2014），折成 `--` 正好接住模型打的 ASCII；
> 折成 `--` 的话它会变成 `----`，谁也撞不上。

**上游列了九条，我们只留五条，砍掉的四条分两类。**

第一类是按相似度猜位置的两条：`block_anchor`（只对齐首尾行，中间按相似度）和
`context_aware`（50% 行相似度阈值）。它们的失败是**静默的**：匹配到了、改下去了、
返回成功，只是改错了地方。留下的五条要么命中要么不命中，不命中就让模型重读一遍文件
再来——多一步，换一个不会悄悄改坏文件的编辑工具。这和 `edit` 今天的姿态一致，只是把
「空白差一格就失败」那一类真失败去掉了。

第二类是**死代码**：`indentation_flexible`（只剥行首空白）和 `trimmed_boundary`
（只放宽首尾两行）。`line_trimmed` 排在它们前面，而且严格更宽——凡是它俩能命中的，
上一条已经命中了，两条分支一次都执行不到。上游那份链条里它们同样跑不到。留着的唯一
效果是让人以为多了两层保险，所以不留；e2e 里每条策略都断言**命中的策略名**，就是为了
让下一个人加策略时当场看见这件事。

**剥行号前缀。** `old_string` 的每一行都形如 `^\s*\d+\|`、**而且行号是连着的**时，整体
剥掉再匹配。模型从 `read_file` 的输出里复制粘贴是常态，而带着 `123|` 的 `old_string` 在
文件里永远找不到，报出来的却是「没找到那段文本」——最难自己走出来的一类失败。

「连着」那一条不是锦上添花：只看「每行都是数字加竖线」的话，一张首列是编号的表
（`1001|甲`、`1005|乙`）会被当成行号砍掉首列——那是把用户的数据当成显示格式扔了。真正的
行号一定是 n、n+1、n+2。

**只剥 `old_string`，不剥 `new_string`，而且两边都带前缀时当场拒。** `new_string` 是要写
进文件的字节，谁也不敢替模型决定 `12|` 是显示格式还是正文。但「整块复制下来、改一行、
两个参数都贴回去」是模型最自然的动作，照着写下去就是把 `12|const a = 1` 落进文件**并且
报成功**——文件被改坏了，没有任何东西会提醒任何人。所以那种形状直接拦下，并说清楚是
哪一侧的问题。

**返回统一差异格式**（`--- a/path` / `+++ b/path` / `@@`），命中的策略名写在末尾一行。
差异比今天那句「已修改 X（替换 1 处）」有用得多：模型能当场看出自己改的是不是想改的
那一段，界面上悬浮窗里也直接可读。`files` 照旧报这一个文件。

`old_string === new_string`、命中多处而没置 `replace_all`、一处都没命中，三种情况的
提示语照搬今天 `edit` 的，只把「先用 read」改成「先用 read_file」。

### 3.4 `search_files`

```jsonc
{
  "name": "search_files",
  "risk": ["read"],
  "parameters": {
    "pattern":     { "type": "string" },                                    // 必填
    "target":      { "enum": ["content", "files"], "default": "content" },
    "path":        { "type": "string", "default": "." },
    "file_glob":   { "type": "string" },                                    // 仅 content 模式
    "output_mode": { "enum": ["content", "files_only", "count"], "default": "content" },
    "context":     { "type": "integer", "default": 0 },                     // 仅 content 模式
    "limit":       { "type": "integer", "default": 50 },
    "offset":      { "type": "integer", "default": 0 }
  }
}
```

一把顶掉 `ls` / `find` / `grep` 三把：

- `target='content'` = 今天的 `grep`。`pattern` 是正则，`file_glob` 限定文件类型，
  `output_mode` 三选一（`content` 带行号的匹配行 / `files_only` 只列文件 / `count` 每个
  文件的命中数），`context` 是前后各带几行——这一项今天没有，而它恰恰能省掉「grep 命中
  之后再 read 一遍看上下文」那一步
- `target='files'` = 今天的 `find`。glob 匹配，按 mtime 从新到旧
- `offset` 是新的：分页，配 `limit` 用。今天撞到上限只能缩小范围重来

**不引 ripgrep。** 上游是 rg 打底，我们继续用今天 `walkFiles` / `globMatcher` 那套
纯 JS 实现。理由是发布包：席位机器上没有 rg，塞一个进 tarball 就多一个架构相关的
二进制（见 §2 里 `node-pty` 那条同样的账）。工作区是员工的办公目录，不是几十万文件的
代码仓库，`SKIPPED_DIRS` 已经把最大的那几个坑跳掉了。真到了扫不动的那天再说。

**`ls` 那半个用途要补回来。** `target='files'` 只返回**文件**，而 `ls` 今天还回答另一个
问题：这层底下有哪些**目录**。少了它，模型看不见空目录，也不知道该往哪一层钻。补法
很小：`target='files'` 的输出末尾附一行 `path` 那一层的子目录名（带 `/` 后缀）。一行的
成本，`ls` 的那半个用途就回来了。

**隐藏项默认不列。** 以 `.` 开头的文件和目录一律跳过，除非模式本身以点开头
（`.env`、`src/.*`）。`ls` 一直是这个口径（它有个默认关着的 `all`），ripgrep 也是；
而今天的 `find` 不是——它会把 `.DS_Store` 和员工的 `.` 配置一起摆进结果，把真正的文件
挤下去。合成一把之后按更常用的那个口径来。

`refs` 照旧报命中的文件（上限 `MAX_REF_FILES`）。界面靠它把正文里出现的文件名接成能
点开的链接，这条链路一个字也别动。

---

## 4. terminal 工具集

注册在新的 `bot/src/tools/terminal.ts`。

### 4.1 `terminal`

```jsonc
{
  "name": "terminal",
  "risk": ["write", "destructive", "external"],
  "parameters": {
    "command":            { "type": "string" },                    // 必填
    "background":         { "type": "boolean", "default": false },
    "timeout":            { "type": "integer", "minimum": 1 },     // 秒
    "workdir":            { "type": "string" },
    "notify_on_complete": { "type": "boolean", "default": false }
  }
}
```

`risk` 三样照旧全占，理由见 [workspace.ts:590](../bot/src/tools/workspace.ts:590)：它是
席位上唯一一把什么都做得到的工具。

和今天的 `bash` 的差异：

| | 今天 | 换之后 |
| --- | --- | --- |
| 名字 | `bash` | `terminal` |
| 工作目录参数 | `cwd` | `workdir` |
| `timeout` 单位 | **毫秒**（默认 120000，上限 600000） | **秒**（默认 120，前台上限 600） |
| 长命令 | 只能撞超时 | `background=true` |

**单位换成秒**是有意的：模型写 `timeout: 600` 是自然的，写 `600000` 要先想一下——而它
想错的方向是写成 `600`，得到一个 0.6 秒的超时。改名之后没有历史调用会撞上这个改动
（旧名字进不了新 schema），是换单位最便宜的一个时机。

**描述里要写死三件事**（照抄上游，它们每一条都对应一个真实的踩坑）：

1. 别用 `cat`/`head`/`tail`（用 `read_file`）、别用 `grep`/`rg`/`find`/`ls`
   （用 `search_files`）、别用 `sed`/`awk`（用 `patch`）、别用 `echo`/heredoc 写文件
   （用 `write_file`）。`terminal` 留给构建、安装、git、进程、脚本、包管理器
2. **绝不要把构建/测试命令管道给 `tail`/`head`**（`cargo build | tail -20`）：输出本来
   就会自动截断，而管道会让退出码变成管道里**最后一条**命令的（`tail` 的 0），真失败
   被盖掉。`cmd || echo failed` 同理
3. 非交互执行，不要跑需要输入或者永不退出的程序——后者用 `background=true`，不要用
   `nohup` / `setsid` / 结尾 `&`（那样起的进程 `process` 管不到）

**输出超限要留全文。** 今天超过 `MAX_OUTPUT_CHARS`（30 000）就直接截断，只在末尾说
一句「共 N」。这和上面第 2 条自相矛盾：既然禁止模型自己 `| tail`，就得给它一条把全文
捞回来的路。改成：截断的同时把完整输出落进 `<工作区>/.satuwork/out/<callId>.log`，
末尾那句话里带上这个路径，模型用 `read_file` 分页看。

`.satuwork` 要加进 `SKIPPED_DIRS`，并且不进 `files` / `refs`——它是过程痕迹，不是产出，
摆进界面那一排药丸里会把真正的产出挤掉（和截图另摆一条是同一个道理）。落在工作区里
而不是 `$SATUWORK_HOME` 底下，是因为模型得读得到它；按天清理。

**文件名要洗过再拼。** 落盘那一步用的是 `callId`，而它是 provider 在响应里给的，一路
透传到这儿，没有任何一层校验过它长什么样：带一个 `/` 就写不进去（只建了那一层目录），
带 `..` 就写出工作区。上传文件名和 sessionId 早就走 `safeName` / `safeSegment` 了
（[workspace/index.ts](../bot/src/workspace/index.ts)，e2e 里有一整组断言盯着），这条新路
不该是例外——洗完再过一遍 `resolve` 兜越界。

**输出一律用 `StringDecoder` 解码，不是一块一块 `toString('utf8')`。** 一个汉字三个字节，
而 chunk 的边界落在哪儿只看内核什么时候把数据递上来；切在字符中间时两半各自解码，出来
的是两个 `�`。前台那次调用最多是屏幕上花一下，后台那份还会**落进 `proc/<id>.log`**，
原字节再也捞不回来——而这个产品的命令输出以中文为主。

**不做**上游的「cwd 在调用之间保持」。那需要一份不在事件日志里的隐式状态，而
**不变量 7**（[gateway-runtime.md:862](./gateway-runtime.md:862)：进入模型的内容必须能从
该实例的 JSONL 重建）不允许——重放时那份 cwd 复现不出来，同一条命令会在另一个目录里
执行。`workdir` 是显式的、写在参数里、跟着 `tool/call` 落盘，重放一致。

中止信号照旧接：`call.signal` 一到就杀整个进程组（`detached: true` 起的那个组）。
理由见 [tools/index.ts](../bot/src/tools/index.ts) 里 `ToolCall.signal` 那段——界面上
那颗停止按钮在最需要它的时候不能是失效的。

**命令产出的文件也要进 `files`。** `write_file` / `patch` 报得出自己写了哪个文件，一条
shell 命令报不出——而模型照样会用 `terminal` 造东西：跑一个生成报表的脚本、`curl -O` 下
一个附件、`ffmpeg` 转一段音频。这些产出以前一颗药丸都没有，于是模型只能在正文里写一句
「文件在工作区根目录，双击打开」，而用户面前只有一个网页上的对话框。

做法是命令跑完扫一遍工作区，按 **mtime ≥ 命令起跑的时刻**认出这一条命令期间落地的文件
（`producedSince`）。**不解析命令行去猜重定向目标**（`> a.html`、`-o b.pdf`）——那正是
`ToolResult.files` 当初存在的理由：措辞一改就散架的猜测不如让文件系统直接回答。

**但 mtime 只回答「什么时候被改的」，不回答「谁改的」，而这个工作区不止一个写入方。**
成系统的那几个整个排除掉（`FOREIGN_DIRS`，只在工作区第一层生效）：

| 目录 | 谁在写 | 它自己怎么报 |
|---|---|---|
| `uploads/` | 用户从对话里传上来的附件 | 挂在那条**用户消息**底下 |
| `web/` | `web_extract(save=true)` 落的网页原文 | 那次调用自己的 `files` |
| `browser/` | 浏览器工具的下载与过程截图 | 那次调用的 `files` / `shot` |

不排除的话，一条跑二十秒的命令期间用户传了张发票，发票就会挂到那条命令底下，还跟着
`details.files` 进会话日志，重放一次错一次。

剩下两种写入方在这一层拿不到任何信号：上一条 `background=true` 起的进程，以及 `cd` 进来
硬写的别的 Bot（工作区一个 Bot 一格之后这已经不是常态；共享区那条 `shared` 链接扫描本来就不跟）。要真分得清得是 fanotify / ptrace 那个
层面的东西，一次 stat 给不了——**这是已知的不精确，不是漏掉的一个 case**。

四条闸：

| 闸 | 值 | 为什么 |
|---|---|---|
| `BULK_CHANGES` | 超过 24 个改动就**一个都不报**，并在结果文本里说一句 | `pnpm install` / `git checkout` / 一次构建动辄改上百个文件，那是过程不是产出。但闷声不报也不行：一条真生成了三十份文件的命令，界面上跟「什么都没产出」长得一样，所以话要说给模型听 |
| `OUT_WALK_BUDGET` | 4000 个文件 | 每次跑命令都白扫一遍，不能像 `search_files` 那样给两万 |
| `OUT_SCAN_MS` | 400ms | 预算按文件数卡，真会卡住的是慢盘和网络挂载——四千次 stat 在本地是几十毫秒，在 NFS 上能是几秒，而这几秒加在**每一条**命令后面 |
| `OUT_STAT_BATCH` | 64 | 串行 `await stat()` 四千次是四千个来回；成批交给 libuv 线程池快一个量级 |

后两条闸踩到时**不报，也不往结果文本里说**——那是席位的状况不是这条命令的结果，而它会
出现在每一条命令后面，说了就是背景噪音。改走 `ctx.logger.warn`，**整个进程只说一次**，
给运维看：这个功能在这台席位上是关着的，而它关得悄无声息。

跳过的目录和 `search_files` 共用一份 `SKIPPED_DIRS`（挪进了 `tools/common.ts`）：两边跳
的是同一批东西，各写一份迟早有一边漏。`.satuwork` 在里面，所以落盘的命令输出不会混进产出。

**「走满预算」和「没走完」差一个文件。** `walkFiles` 是要 yield 之前先减，所以正好走满的
那一趟以 `left === 0` 干干净净地结束。按 `left <= 0` 判截断会把一份完整的结果丢掉——静默
地丢，而这个功能本来就长得像「这次没产出」。所以截断由 `WalkBudget.truncated` 说了算，
它只在**还有下一个条目要看却看不了**时才置（`bot/e2e-workspace.mjs` 的 `walkBudget` 那组
钉的就是这一条）。

超时、被中止、退出码非零的命令**同样扫**——跑到一半留下了什么，恰恰是那几种情况下人最
想看的东西。后台命令（`background=true`）不扫：它的产出落在哪一轮说不清，`process` 那几
个动作也不是「这条命令刚跑完」的时刻。

界面那头药丸认的是 `files` 字段不是工具名，所以不用改——但**摆不下的那几颗要说一声**：
产出药丸在 `MAX_OUT_CHIPS`（8）之后收成一行「还有 N 个」，和过程截图、读过的文件同一个
写法。摆八颗然后什么都不说，人会以为一共就这八个。

模型那头要配一段系统提示（`fileOutBlock`，见
[context-assembly.md](./context-assembly.md#2-systemprompt七段顺序固定)）——路通了但模型
不知道，它还是会去教用户双击。那一段的闸按「**谁会报 `files`**」开：`write_file` / `patch` /
`terminal` / `web_extract` / `browser_snapshot`，五条路进的是同一个字段。少写后两条的代价
是一个只挂了 `web_search` + `web_extract` 的调研 Bot 永远拿不到这段话，而它恰恰是最常
生成文件的那种。

### 4.2 后台进程注册表

`background=true` 时立刻返回一个 `session_id`（形如 `proc_4dae56ca`），命令在后台继续跑。

注册表在内存里，一条记录含：`id`、`sessionId`（哪条会话起的）、`pid`（进程组）、
`command`、`workdir`、`startedAt`、`exitCode`、以及一段**环形输出缓冲**（上限 256 KB，
超出的部分滚进 `$SATUWORK_HOME/proc/<id>.log`）。

**日志落在 `$SATUWORK_HOME` 而不是工作区**，和 §4.1 那份截断全文正相反：那一份是模型
要读的，这一份是 `process(action='log')` 替它读的。会话侧的运行数据不该出现在员工
看得见的工作区里。

四条硬约束：

1. **一条会话同时最多 8 个后台进程。** 满了就拒，并把当前这份清单摆出来——让模型看见
   是自己起了八个服务器，而不是收到一句没有出路的失败
2. **单个进程最长活 24 小时**，到点 SIGKILL 并记一条。忘掉的 `pnpm dev` 不能占着端口
   过周末
3. **进程退出后记录再留 30 分钟**，之后连同日志一起清掉。`poll` 得到「已退出，退出码 N」
   要有一段窗口期，不能进程一没就查无此事。另外**起来时扫一遍 `proc/`**，删掉三天前的：
   上面那 30 分钟只管干净退出那条路，进程被换版杀掉时定时器跟着内存一起没，日志就成了
   没主人的文件
4. **进程不属于「这一轮」。** 停止按钮掐的是当前轮，**不杀**后台进程——它存在的意义
   就是活过这次调用。要杀走 `process(action='kill')`，这一点要写进 `terminal` 的描述里，
   否则模型会以为点了停止就干净了。反过来，**模型自己杀掉的那个不发结束通知**：结果它
   从 `kill` 的返回值里已经拿到了，再通知一次会在那一轮收口之后**单独开一轮**，用户看到
   一条没来由的消息，账上还多一次模型调用

**换版和关机时全部杀掉，然后自己退出。** 管家重启这个进程之前会先让它静默、排空
（[agent/index.ts:180](../bot/src/agent/index.ts:180) 那段，以及 `manager/src/seats.ts`
的 `drainSeat`）。排空只等模型那一轮跑完，**管不到后台进程**——不在 SIGTERM 上把注册表
里每个进程组都杀一遍，换一次版就在席位上漏一批孤儿，端口和内存一起留着，而下一个版本
的进程起来时那个端口已经被占了。

**杀完必须把信号重新发给自己。** Node 的规矩是：一旦给 SIGTERM / SIGINT 装了监听器，它
的默认行为（结束进程）就被摘掉了。这个进程在这之前**一个信号监听器都没有**，靠的正是那
个默认行为退出；只挂一个不退出的监听器，`systemctl restart` 之后进程会一直活着，直到
systemd 等满 `DefaultTimeoutStopSec`（90 秒，单元里没另设）再 SIGKILL——每次换版白等一分
半，排空那条路还可能直接超时。做法是摘掉自己的监听器再 `process.kill(pid, sig)`。

这两件事都要有 e2e 钉住，而且**必须拿真信号打一个真进程**：`process.emit('SIGTERM')` 只
叫监听器、不走信号投递，「默认退出被摘掉了」在它下面完全看不出来。

### 4.3 `process`

```jsonc
{
  "name": "process",
  "risk": ["write"],
  "parameters": {
    "action":     { "enum": ["list", "poll", "log", "wait", "kill"] },  // 必填
    "session_id": { "type": "string" },   // 除 list 外必填；唯一前缀也认
    "timeout":    { "type": "integer", "minimum": 1 },   // wait，秒
    "offset":     { "type": "integer" },                 // log，默认最后 200 行
    "limit":      { "type": "integer", "minimum": 1 }    // log
  }
}
```

- `list` — 这条会话的全部后台进程：id、命令、状态、跑了多久
- `poll` — 状态 + **上次看过之后的新输出**（这是它和 `log` 的区别，也是轮询该用的那个）
- `log` — 完整输出，带分页
- `wait` — 阻塞到结束或超时，超时返回已有的输出。**同样要接 `call.signal`**
- `kill` — 杀整个进程组

`session_id` 收唯一前缀（`4dae` 能指到 `proc_4dae56ca`）：模型抄长 id 会抄错，而抄错
之后那句「没有这个进程」它排查不出来。

**risk 是 `['write']`，不要审批。** 后台进程会不会干坏事，在 `terminal` 起它的那一刻
就已经按同一条命令扫过一遍了（§5）——`process` 只是在管自己起的那几个，再判一次只会
让每一次 `poll` 都弹一张卡片，那不是收紧边界，是让人学会闭眼点批准。

### 4.4 `notify_on_complete` 怎么回到会话里

`background=true` + `notify_on_complete=true` 时，进程退出要主动通知，不能让模型去轮询。

路子现成：**`agents.steer()`**（[agent/index.ts:415](../bot/src/agent/index.ts:415)），
交接单交还走的就是它（[web/index.ts:51](../bot/src/web/index.ts:51)）。

- 那一轮**还在跑** → `steer` 插一条进去。pi 的 steering 在工具跑到一半时也插得进
- 那一轮**已经结束** → 照 `deliver` 那条路开新的一轮

两种情况都落成一条 `user/message`，`source` 写成 `{ kind: 'plugin', plugin: 'process' }`
——**不变量 7**：进入模型的那句话必须在 JSONL 里，重放才对得上。界面上它长得和交接单
交还是同一类东西，不是用户打的字。

正文要短，且必须够模型直接决定下一步：

```
[后台进程 proc_4dae56ca 已结束] pnpm build · 退出码 0 · 用时 3 分 12 秒
最后 20 行输出：
…
```

退出码非零时把最后几十行一起带上——不带的话模型的下一步一定是 `process(action='log')`，
白花一步。

---

## 5. 边界与策略

**三处硬编码的 `'bash'` 要改成 `'terminal'`：**

| 位置 | 干什么的 |
| --- | --- |
| [policy/index.ts:117](../bot/src/policy/index.ts:117) | `needsApproval`：`bash` 按命令判，不按 risk 并集判 |
| [policy/index.ts:405](../bot/src/policy/index.ts:405) | 「禁止访问未授权的外部系统」：扫命令里的联网动作 |
| [policy/index.ts:721](../bot/src/policy/index.ts:721) | `outboundOf`：这次调用算不算对外 |

`networkCommand` / `destructiveCommand`（[policy/shell.ts](../bot/src/policy/shell.ts)）
本身**一个字都不用改**——它们读的是参数里的 `command` 字段，那个名字没变。

**后台命令走同一条扫描。** `terminal(background=true, command='curl …')` 仍然是
`terminal` 的一次调用，`tools/pre-execute` 照常短路。加后台这条路**没有**开出新的口子，
这一点要在实现时验一遍（e2e：后台起一条 `curl` 应当被拦）。

**已经在跑的后台进程不受开关变化影响。** 公司模版上的边界开关是在调用那一刻判的；一个
在开关打开之前起来的后台进程会继续跑。这不是 bug，但要写下来——不写下来，第一个发现的
人会当成越权。真要收紧，`process(action='kill')` 是那个动作。

`process` 的 risk 见 §4.3。四把 file 工具的 risk 和今天一一对应：`read_file` /
`search_files` 是 `['read']`，`write_file` / `patch` 是 `['write']`，都不触发审批
——工作区里的读写是 Bot 干活的常态，审批那条线说的是**对外**那一侧。

---

## 6. 改名的代价

**一、历史里全是旧名字。** 一个 Bot 一条长会话、只增不减，而每一轮都把历史重建成一次
模型请求（[context-assembly.md](./context-assembly.md)）。换版之后，模型会在自己的历史
里看见几百次对 `bash` / `read` 的调用，然后照着再调一次。

**不留兼容壳。** 注册八把转发用的旧名字工具，等于工具表长一倍：上下文多花是小事，
**模型在更长的表里选得更差**才是要害（这条在
[agent/index.ts:1370](../bot/src/agent/index.ts:1370) 里已经写过——工具表越长，模型越
容易在前几个里选）。

改在别处：`ToolService.execute` 的「未知工具」分支上挂一张**改名表**。

```ts
const RENAMED: Record<string, string> = {
  bash: 'terminal', read: 'read_file', write: 'write_file',
  edit: 'patch', ls: 'search_files', find: 'search_files', grep: 'search_files',
}
```

```
未知工具 bash。它已经改名为 terminal，参数同名，直接用新名字重调一次。
```

零工具表成本，只在真的调错时才花一次，而且那一次的失败文本里就带着出路。改名表在
两三个版本之后可以删掉——那时历史里的旧调用早被摘要压掉了。

**二、提示缓存整体作废一次。** 工具表进的是每一次请求的前缀，它一变，全公司所有会话的
提示缓存都要重建一次。这是一次性的多花，口径见 [billing.md](./billing.md)。发布时机
上，别和别的会动系统提示词的改动挤在同一天——两笔账混在一起就查不清了。

**三、`request/header` 里的工具表变了。** 链路视图的 SYSTEM 段读的是这条
（[agent/index.ts:1456](../bot/src/agent/index.ts:1456) 附近）。旧会话翻出来看，那一段
是旧工具表——这是对的，它记的就是当时真的发出去了什么，不要回填。

---

## 7. 要动的文件

**代码**

| 文件 | 怎么动 |
| --- | --- |
| `bot/src/tools/workspace.ts` | 拆成下面两个（`git mv` 成了 terminal.ts） |
| `bot/src/tools/file.ts` | 新增：`read_file` / `write_file` / `patch` / `search_files` |
| `bot/src/tools/terminal.ts` | 新增：`terminal` / `process` + 后台进程注册表 |
| `bot/src/tools/fuzzy.ts` | 新增：五条匹配策略 + 统一差异格式输出 |
| `bot/src/tools/common.ts` | 新增：`ToolFailure` / `registerTool` 等两边共用的那点东西。**「什么算业务失败」必须只有一个口径** |
| `bot/src/tools/index.ts` | `execute()` 的未知工具分支加改名表（§6） |
| `bot/cordis.yml:51` | 换成两行，注释里那句「read / write / edit / ls / find / grep / bash」跟着改 |
| `bot/src/policy/index.ts` | 三处 `'bash'` → `'terminal'`（§5），以及注释里的举例 |
| `bot/src/tools/web.ts` | :106 :173 :217 :221 描述与提示里的 `read` / `grep` / `bash` |
| `bot/src/workspace/extract.ts` | :9 :60 :95 提示里的 `bash` |
| `bot/src/web/index.ts` | :584 注释里的 `read/bash` |
| SIGTERM / SIGINT 处理 | **换之前整个 bot 一处都没有**（`grep -rn SIGTERM bot/src` 是空的）。后台进程需要它：挂在 `tools/terminal.ts` 里，同时用 `ctx.effect` 兜插件卸载那一路，两条都要（systemd 重启走的是信号，不是卸载） |

**e2e**

| 文件 | 怎么动 |
| --- | --- |
| `bot/e2e-mounted.mjs:48` | 工具清单换成六把新的 |
| `bot/e2e-workspace.mjs` | 那几条 `call('ls'…)` / `call('read'…)` 换名字；`refs`/`files` 的断言不变 |
| `bot/e2e-guards.mjs` | `tool('bash', …)` → `tool('terminal', …)`；`out.bash` 那一组照原样跑一遍 |
| **新增** `bot/e2e-patch.mjs` + `e2e/patch.mjs` | 五条策略各一例（连**命中的策略名**一起断言，见 §3.3 里死代码那段）、排版字符不被换掉、缩进跟着文件走、剥行号前缀、`replace_all`、以及**改错地方要能被发现**（内容对不上时必须失败，不许兜底） |
| **新增** `bot/e2e-process.mjs` + `e2e/process.mjs` | 起→`poll`→`wait`→`kill`；并发上限连清单一起；`poll` 只给新输出；停止按钮停得掉 `wait` 但停不掉进程；通知落成 `user/message`；**SIGTERM 之后没有孤儿**。每一条「杀掉了」都是拿 `kill(pid, 0)` 问操作系统问出来的，不读我们自己那本账 |
| `e2e/guards.mjs` | 跟着探针改断言 |
| `e2e/ui-files.mjs` / `ui-smoke.mjs` / `chat-fold.mjs` | 夹具里的工具名（只是好看，界面不认名字） |
| ~~`e2e/upgrade-drain.mjs`~~ | 不用动：孤儿那一条钉在 `e2e/process.mjs` 里，直接给进程发 SIGTERM，比起一整套换版流程更直接也更快 |

**文档**

`gateway-runtime.md:414,416`、`context-assembly.md:272,273,290`、
`browser-tools.md:404,410,420,503`、`connectors.md:410`、`web-tools.md:18,43,153,166,194,198`、
`delegation.md:48,152,155,352`——全部是拿 `bash` / `grep` / `read` 举例的散文和表格。
`delegation.md` 那份还没进仓库，它的子 agent 工具表（§152）要照本文重写。

---

## 8. 里程碑

**M1 — file 工具集**（已做完）
四把新工具 + 改名表上线，`bash` 暂时**留着不动**（名字也不改）。这一档单独可发：编辑
从此不再因为缩进失败，而 shell 那一侧一点风险都没引入。

**M2 — terminal 改名**（已做完）
`bash` → `terminal`，`cwd` → `workdir`，超时换成秒，输出超限落盘。policy 三处跟着改。
后台还没有。

**M3 — 后台进程**（已做完）
`background` / `process` / `notify_on_complete`、注册表、关机清理。这一档是新代码最多、
也最容易在生产上留下痕迹（孤儿进程、占住的端口）的一档，单独发、单独盯。

三档之间没有互相依赖的顺序要求，但**不要合并**：M1 是纯收益，M3 是纯新风险，混在
一次发布里，出了问题分不清是哪一半。

---

## 9. 验收

**M1**

- 工作区里放一个缩进被改过的文件，`patch` 一次命中（今天的 `edit` 会失败）
- `read_file` 输出里复制整段（带 `123|` 前缀）直接喂 `patch`，命中
- 中文文档里把「全角空格 + 中文引号」那一行用 ASCII 写法 `patch`，命中，**且文件里的
  全角空格没有被换成半角**
- 编一段文件里根本没有的文本，`patch` 失败——不许有任何一条策略把它兜到别处
- `search_files(target='files', pattern='*')` 的输出末尾能看见子目录，而 `.` 开头的
  条目一个都不在里面；换成 `pattern='.*'` 它们才出来
- 一条 `read` 调用返回「已改名为 read_file」，而工具表里确实没有 `read`；`bash` 这一档
  还在，照旧能调

**M2**

- `terminal(command='rm -rf /tmp/x')` 停在审批卡上；`terminal(command='ls')` 不停
- `terminal(command='curl …')` 被「禁止访问未授权的外部系统」挡下
- `timeout: 3` 是三秒，不是三毫秒
- 一条 `bash` 调用返回「已改名为 terminal」，工具表里没有 `bash`
- 一条吐十万字的命令：模型看到截断提示 + 一个 `.satuwork/out/*.log` 路径，`read_file`
  读得到全文；那个文件**不出现**在界面的文件药丸里
- 点停止，正在跑的命令当场停（进程组一起没）

**M3**

- `terminal(background=true, notify_on_complete=true)` 起一条三十秒的命令，人什么都不做，
  三十秒后对话里自己多出一条结束通知
- 那条通知在 JSONL 里是一条 `user/message`，`source.plugin === 'process'`
- 起九个后台进程，第九个被拒，并且拒绝文本里列着前八个
- `process(action='kill')` 之后 `ps` 里那一族全没了
- 席位换版（静默 → 排空 → 重启）之后，机器上没有属于旧进程的孤儿
- 后台起一条 `curl`，照样被边界挡下
