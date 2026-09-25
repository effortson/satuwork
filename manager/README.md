# satuwork-manager

席位机器上的常驻服务。一台机器一个，root systemd 服务。

取代了原来「Gateway 用 SSH 登进机器」那条路径。Gateway 因此不再持有任何能登录这
台机器的凭据，只有一把可吊销的 `smt_`；席位的 bot 口和 noVNC 口全部收回
`127.0.0.1`，对外只剩管家这一个端口。

## 装

在 Gateway 的公司详情页点「生成配对码」，把那条命令贴到 Debian 上用 root 跑：

```
curl -fsSL https://gw.example.com/install-manager.sh | sudo bash -s -- --code SW-XXXX-XXXX
```

装完就配对好了。这台机器之后**不需要再敲任何命令**——建席位账号、装桌面栈、起
bot、以后自己升级，全归管家。

可重复运行：换过配对码、或者自升级卡住了，重跑一次就是修复手段。

## 打包

**包里带 esbuild 的原生二进制**（tsx 依赖它），而 `pnpm deploy` 只实体化当前平台那
一份。所以**必须在 Linux 上打包**——在 Mac 上打的包解到 Debian 上 tsx 加载不了
esbuild，管家起不来，而那台机器上已经没有 SSH 可以救。`pack.mjs` 会拦住这种包。

架构也要对上：x86_64 的 Debian 要 `linux-x64` 的包，arm 的要 `linux-arm64`。

### 正路：CI

```
git tag manager-v0.1.0 && git push --tags
```

`.github/workflows/manager-release.yml` 在 ubuntu-latest 上打包并 PUT 到
`/platform/manager-releases/:version`。传包本身**不会**立刻改变任何一台机器——除非
「期望版本」是空的（那时跟最新发布走）。

### 本地：过一层 Docker

见 [../docs/local-release.md](../docs/local-release.md)——那里连 bot 一起打，还记了版本号
撞车、传进本地 Gateway、以及**传包会让没 pin 的机器自动升级**这几件事。

## 它管什么

```
PUT    /seats/:seatId      建/更新一个席位          smt_
DELETE /seats/:seatId      拆一个席位              smt_
GET    /seats              名册                    smt_
GET    /health             版本 + 席位状态 + 负载    smt_（配对回拨时走 challenge）
GET    /metrics            机器负载 + 日志占用       smt_
POST   /logs/vacuum        立刻清一次 journal        smt_
ANY    /seats/:id/bot/*    反代到 127.0.0.1:3200+N  smt_
GET+WS /seats/:id/vnc/*    反代到 127.0.0.1:6081+N  Gateway 签的桌面票
GET    /seats/:id/logs      席位 bot 的 journal      smt_；或 Gateway 签的日志票（协议 9）
GET    /logs                管家自己的 journal       smt_；或 Gateway 签的日志票（协议 9）
GET    /seats/:id/stream/*  反代到 bot，换成 sat_    浏览器的登录 JWT（协议 5）
POST   /seats/:id/stream/sessions/:sid/files  上传，同上   浏览器的登录 JWT（协议 9）
GET    /roster/stream       本机这个人的名单流        浏览器的登录 JWT（协议 6）
ANY    /w-local/*           本机工人的中继口          回环地址 + worker.env 里的令牌（协议 7）
ANY    /llm/v1/*            替本机 Bot 调模型         回环地址 + Bot 的 sk_sw_（协议 10；不是回环一律 404）
```

最后两条的「回环地址」不认带 `x-forwarded-for` / `forwarded` / `x-real-ip` 的请求——那是被反代
转进来的，见下面「用 Caddy 给管家配 https」。

bot 那条**原样透传 `authorization`**——bot 自己要验席位票（`sat_`），管家不掺和，
所以用一个自己的头 `x-satuwork-machine`，两层互不干扰。

日志那两条**两种票都收**：Gateway 和 curl 拿 `smt_`（`x-satuwork-machine` 或 `authorization`
都行）；浏览器直连跟日志拿的是 Gateway 签的日志票（`typ: satu-logs`，五分钟，写死了看哪个单元、
哪个席位），`?follow=1` 是 SSE。9 号协议起 Gateway 才把 logs 和上传的直连地址交给前端；在那之前
前一条只认 `smt_`、后一条的 POST 是 405，而前端不再退回 Gateway——号数对不上就是一句报错。

## 席位工人

`satuwork-worker.service`，和管家同一个包、同一份 `current` 软链，**另一个用户**
（`satuwork-worker`，非 root）。它替 Gateway 接下「到点了去敲席位、等这一轮跑完」这段活
（`src/worker/index.ts`；为什么要下沉见 docs/adr-gateway-vercel-neon.md）。

它手上**没有任何凭据**：没有 `smt_`，没有任何席位的 `sat_`。只有一把管家开机时随机出来、
写在 `worker.env` 里的本机令牌，凭它打管家在回环地址上的中继口（`src/relay.ts`）：

```
/w-local/gateway/worker/*      管家带 smt_ 转给 Gateway 的 /worker/*。只有这个前缀，别的不转
/w-local/seats/:id/bot/*       管家换成那个席位的 sat_ 转给本机 bot
```

所以工人被攻破的影响面 = 领本机的日常任务 + 跟本机的 bot 说话；管家的控制面（部署、拆席位、
拉日志）和 Gateway 的别的接口一条都碰不到。

8 号协议起它也接**渠道那一轮**（`src/worker/channels.ts`）：Telegram 消息进来之后「每 100ms 问
席位跑到哪儿了、最长二十分钟」那段在本机跑；草稿的节流（`src/draft-pump.ts`，gateway 那份的
逐字副本）也在这头。它不碰 Telegram 的 token——typing、草稿、审批卡、最终回复都报给 Gateway
（`POST /worker/channels/events/:id/progress` / `finish`）由 Gateway 代发。

自升级时和管家一起重启（`upgrade.ts` 那句 `systemctl restart` 带两个单元）。老机器上没有这个
单元：装脚本重跑一遍会把用户、单元、令牌一起补上；补上之前那台机器的管家仍报 7 号协议——
**这是要小心的一处**：号数是包里写死的，工人单元没起来的机器上，Gateway 会以为任务归工人，
而没人来领，到点只会在流水上留一条「机器没回报」并排补跑。升级到带工人的版本之后要看一眼
每台机器的 `systemctl status satuwork-worker`。

## 模型中继

10 号协议起，席位上的 Bot 调模型不再直打 Gateway 的 `/v1/*`，而是打管家在回环地址上的
`/llm/v1/*`（`src/llm-relay.ts`；bot.env 里多一行 `GATEWAY_LLM_URL=http://127.0.0.1:<管家端口>/llm`，
Bot 拿它当 `/v1` 的基址）。Gateway 搬到 Vercel 之后那种几分钟的生成流留不住，所以调上游这一跳
下沉到席位机器上，Gateway 只留下**授权**和**结算**两件短活：

```
GET  /llm/v1/models             原样转 Gateway 的 /v1/models（带 Bot 的钥匙）
POST /llm/v1/chat/completions   route=chat
POST /llm/v1/messages           route=messages（Bot 的 anthropic-version 头随授权请求一起上报）
POST /llm/v1/responses          route=responses
```

一次调用：读 JSON 体（>32 MB 回 413，没 `model` 回 400）→ `POST {gateway}/worker/llm/grant`（smt_，
把 Bot 的 `sk_sw_` 原样交上去验；Gateway 回 4xx 就**原样**转给 Bot，够不着回 503）→ 按授权里的
**请求体补丁**改 body → 拿授权里的上游地址和头（含供应商密钥，只活在这一次调用的内存里）打供应商，
字节原样流回 Bot，顺手从 `data:` 帧或整块 JSON 里数 usage（`src/llm-usage.ts`，gateway 那份的逐字副本，
账才对得上）→ `POST {gateway}/worker/llm/:callId/settle`，带 usage 和结局（`ok` / `failed`：Bot 先走了
或上游非 2xx / `error` / `timeout`：120 秒没等到响应头）。结算不挡 Bot 的响应，网络层失败隔两秒补一次，
再不行只留一行日志——Gateway 会定期扫没结算的调用。

### 请求体归 Gateway 规范化

授权请求上报 `{apiKey, route, model, provider?, anthropicVersion?, openaiBeta?, stream?, reasoningEffort?}`，
授权答复里除了 `{callId, provider, model, url, headers}` 还有一份补丁：

```
body: { set: Record<string, unknown>, unset: string[] }
```

管家**照单执行**，先 `unset` 后 `set`，自己不再动请求体（以前是管家自己把 `model` 换成正名、把
`provider` 删掉，现在这两件事都在补丁里）。这么摆是因为「哪个模型要补 `stream_options.include_usage`
才会回用量」「哪家的 `reasoning_effort` 要钳到什么档」只有目录那头知道，而且会随目录变——规矩留在
Gateway 一处，机器上几十个管家不各自带一份会过期的判断。补丁是**必给的**（`set.model` 一定是目录里的
正名，`unset` 一定含 `provider`），没有就当答复不成形回 502——给它兜一个空补丁的话，请求体一个字不改
就打了上游，`provider` 原样漏过去、用量收不齐，而表面上一切正常。

### 中继不了的供应商退回 `/v1`

有些家这条中继走不通：Anthropic 协议的模型被打到 chat 路由、压根没有 OpenAI 兼容端点的 API。
Gateway 用 **`409` + 正文里的 `relayable: false`** 说这件事。管家**不把这个 409 转给 Bot**——Bot 没做
错什么，也没有第二条路可换——而是把整通调用原样交回 Gateway 自己的 `/v1`：同一个路径后缀
（`/v1/chat/completions` 等）、Bot 的 `sk_sw_`、**原封不动的请求体**，响应照样流回去。中继出现之前
这些模型走的就是这条路，于是它们继续照旧。这条路**不结算**：没有 grant、没有我们开的那行
`llm_calls`，账是 Gateway 在 `/v1` 里自己记的。journal 里会留一行说明这次退回了以及为什么。

管家不验 `sk_sw_`（那是 Gateway 的事），也不把授权头的名字或值写进日志：**上游报错时**正文里的密钥
先抹成 `[redacted]` 再给 Bot（上游的 4xx 常把请求头回显在正文里）。**成功的答复一个字不动。**

抹哪些值的规矩是**反着列的**：授权里除了 `content-type` / `accept` / `accept-encoding` / `content-length` /
`host` / `user-agent` / `anthropic-version` / `openai-beta` 之外，每个头的值都当密钥看（含去掉 `Bearer `
的裸值），再加一条 8 个字符的下限防自伤。摆成「除了这几个都算秘密」而不是列一张授权头白名单，是因为
自定义供应商的头名字是运营填的——`x-goog-api-key`、`api-key`、干脆叫 `token` 的都有，白名单一定漏，
而漏一个就是密钥顺着错误正文进了 Bot 的日志。

（上一版是「值长到 16 个字符就抹」，且压在成功响应上。`application/json` 正好 16 个字符，于是模型答复里
凡是提到 `Content-Type: application/json` 的地方——教人写 curl 的回答天天有——都变成
`Content-Type: [redacted]`。抹的是模型正文，不是密钥。）

每次调用留一行 info 日志：路由、供应商/模型、结局、四项 token、耗时。

## 落盘

```
/etc/satuwork/manager.env    安装脚本写的启动参数（配对成功后会抹掉配对码）
/etc/satuwork/manager.json   配对结果：machineId、smt_、Gateway 地址与公钥。0600
/etc/satuwork/seats.json     席位名册。反代靠它把 seatId 翻成端口；5 号协议起也存每个席位的 sat_（不外报）
/etc/satuwork/worker.env     管家开机写的工人令牌与本机地址。0640 root:satuwork-worker
/opt/satuwork/manager/
  releases/<version>/        解开的管家包
  current -> releases/X      systemd ExecStart 指这里
  previous -> releases/W     回滚指回它
/opt/satuwork/releases/      bot 发布包，按版本全机共享
```

## Gateway 换了地址

`manager.json` 里的 `gatewayUrl` 是**配对那天写死的**，心跳、拉包、自升级都用它。
Gateway 换了对外地址之后，这一份还指着旧地址，于是心跳打向一个不存在的地方——而且
**一个字都不会报**：打不通那一路是静默重试，journal 里干干净净，平台那一页只有一盏
「失联」灯。

不用上机器改。管家在**带机器票的控制类调用**里会顺带认一下新地址
（`x-satuwork-gateway-url`，见 [src/index.ts](src/index.ts) 的 `adoptGatewayUrl`）：
在平台的机器页上按一下「保存并探活」，或者重铺任意一个席位，它就自己回来了，并当场
按新地址敲一次心跳。

**反代那条路不算**（`/seats/:id/bot/*`、桌面）：它走的是 proxy.ts 自己那道
`machineTokenOk`，根本不经过 `requireMachine`，所以聊天流量再多也不会把地址教给它。
会 adopt 的是 `/health`、`/metrics`、`/logs`、`/seats*` 这几条——也就是「有人在平台上
动了一下这台机器」的那些时刻。

**但那个头照样会被转下去。** `forwardHeaders` 只摘 host / connection /
x-satuwork-machine / cookie，所以反代过去的聊天流量上它还在——链路末端的 bot 自己会认
（见 [bot/README.md](../bot/README.md) 的「Gateway 换了地址」）。席位那份 `GATEWAY_URL`
过期的症状和管家不一样：不是一盏失联灯，是每次模型调用都 `fetch failed`。

- 只有过了 `requireMachine` 才会被读到——说话的人拿得出 `smt_`。
- 形状不对（带路径、不是 http/https）一律不认，保持原样。
- Gateway 那侧只在**明确配过** `GATEWAY_PUBLIC_URL` 时才发这个头：没配时它会回落成
  `GATEWAY_HOST:GATEWAY_PORT`（多半是 `127.0.0.1:3080`），拿那个去教管家等于当场把
  机器打死。

**席位那份是另一回事。** 每个席位的 `<seatDir>/bot.env` 里也冻着一份 `GATEWAY_URL`，
但它不必等重铺：Gateway 反代任意一条通过 `sat_` 验证的 `/api/*` 请求时都会把同一个
`x-satuwork-gateway-url` 头带到 Bot；Bot 先原子写回 `bot.env`，再更新进程内环境，当下就
恢复模型、目录和上报。重铺仍会重写整份部署配置，可作为席位完全收不到入站请求时的兜底。

## 用 Caddy 给管家配 https

管家自己只说 http。要给「管家地址」和「桌面直连地址」配 https（桌面直连**必须**是 https，
见 [../docs/gateway-runtime.md](../docs/gateway-runtime.md) §7），在机器上装一个 Caddy，
整站反到管家：

```
# /etc/caddy/Caddyfile
mgr.example.com {
	# 这两条是给本机进程的：/llm/* 是 Bot 调模型，/w-local/* 是席位工人的中继口。
	# 外面的人不该碰到，也不该知道它们在。
	@local_only path /llm/* /w-local/*
	respond @local_only 404

	reverse_proxy 127.0.0.1:8443 {
		# 保险，不是必需：对话流、名单流、日志 follow 都是 SSE，而 Caddy 对
		# text/event-stream（以及长度未知的响应）本来就逐次立即冲出去，不看这一项。
		# 写上是防哪天某条流的 content-type 没带对——攒住的后果见
		# ../gateway/deploy/Caddyfile.example 里同一行的注释。
		flush_interval -1

		# 不设超时（0 = 不掐）：首次 PUT /seats/:id 要装桌面栈、拉包，十几分钟很正常；
		# SSE 和桌面的 WebSocket 也都是长连接。Caddy 默认本来就是 0，写出来是为了
		# 别让后来的人顺手填个 60s。
		transport http {
			read_timeout 0
			write_timeout 0
		}
	}
}
```

证书 Caddy 自己申请，80/443 要对外开；8443 在最后一步之后就不必再开了。

**为什么要单独挡那两条。** 管家判「本机来的」看的是 socket 的源地址，而 Caddy 转进来的
每一条请求源地址都是 127.0.0.1。管家这边已经兜了一层：带 `x-forwarded-for` /
`forwarded` / `x-real-ip` 的请求一律不算本机（本机的 Bot 和工人直连，从来不带；Caddy
默认会加 `X-Forwarded-For`）——见 [src/http.ts](src/http.ts) 的 `isLoopback`。但那是纵深
防御，**Caddyfile 里这两行照样要写**：别让某个反代配法恰好没加转发头，就把这两条路交给
一张票去守。

`X-Forwarded-Proto` 也要留着（Caddy 默认会带）：桌面落地页按它决定 cookie 是不是
`SameSite=None; Secure`，丢了它桌面在桌面端里会全 401（见 [src/proxy.ts](src/proxy.ts)）。

**然后让管家只听回环**，别再从公网直接进 8443：

```
# /etc/systemd/system/satuwork-manager.service.d/listen-local.conf
[Service]
Environment=SATUWORK_MANAGER_HOST=127.0.0.1
```

```
sudo systemctl daemon-reload && sudo systemctl restart satuwork-manager
```

只能钉 `127.0.0.1`，不能钉某张网卡的地址——Bot 调模型打的是 `127.0.0.1:<端口>/llm`
（见 [src/seats.ts](src/seats.ts) 里 `MANAGER_LLM_URL` 那段注释）。

**顺序不能反：**

1. 装好 Caddy，确认 `https://mgr.example.com/health` 从外面能通（没票是 401，说明到了管家）。
2. 在 Gateway 的机器页把**管家地址**和**桌面直连地址**都改成 `https://mgr.example.com`，
   按「保存并探活」，两条都探活成功。
3. 这时才写上面那个 drop-in、重启管家。

先改只听回环的话，Gateway 手里那条 `http://<ip>:8443` 当场打不通，机器在平台上变成失联；
而改地址、推新席位都要经过管家——那时就只剩上机器把 drop-in 删掉这一条路。

## 还原

平台上「移除机器」是自动的（[src/standdown.ts](src/standdown.ts)）：管家收到心跳里的 `removed: true`
就自己拆席位、清配对状态、停掉自己。**先走这条**。

管家已经起不来、或者机器早就失联，就上去手动跑包里那份：

```
sudo /opt/satuwork/manager/current/src/seat/purge-machine.sh --dry-run
sudo /opt/satuwork/manager/current/src/seat/purge-machine.sh
```

默认只删 satuwork 自己放上去的东西。账号（连 `work/`）、桌面栈、Node 都是装机时顺带
装的、机器上别的东西也可能在用，各要一个显式的开关：`--accounts` / `--packages` /
`--node`。

席位从四个地方找并集——`seats.json`、systemd 单元、drop-in 目录、`/home/*/.satuwork/*`。
任何一处都可能残缺，而**漏认一个席位就会留下一个还占着端口的 x11vnc**，那正是
`deploy-seat.sh` 里 `verify_seat_listener` 后来要挡的那种故障。

Gateway 那侧的机器记录不会因此消失，要在控制台单独移除。

## 负载上报

每 30 秒采一次样，**搭心跳带上去**——机器本来就每 30 秒敲一次门，另开一条定时 POST
只是多一个会失败、会重试、会被防火墙拦住的东西。

CPU、内存、每块盘、出网流量。两件事必须**自己定时采**，不能等请求进来现算：CPU 占用
和出网速率都是「两次之间的差」，现算要么给不出数，要么只能给一个开机以来的平均值
——那个数在一台跑了三个月的机器上永远是 3%。

拿不到的项报 `null`，**不编一个 0**：「取不到」和「是 0」在界面上是完全不同的两件事
（一块读不出来的盘 vs 一块空盘）。同理，CPU 第一次采样只存基准，那一轮报 null。

盘按 `/proc/mounts` 里的真块设备挑，并**按设备去重**：`/` 和 `/home` 常常是同一块，
报两遍会让人以为机器上有两块 80% 的盘。占用按 `df` 的口径算（分母是 used + avail），
所以和人在机器上 `df -h` 看到的是同一个数。

出网只算真网卡——回环、docker、veth、br- 这些的流量不出这台机器。

## 日志清理

**这台机器上的日志只有一个去处：journald。** 三个 systemd 单元都不写日志文件，
`/seats/:id/logs` 和 `/logs` 读的也是它。所以「日志把盘吃满了」等价于「journal 太大
了」，清理也只有一个动作：`journalctl --rotate` 之后 `--vacuum-size`。

先 rotate 再 vacuum：vacuum 只删得掉已归档的文件，而当前正在写的那个（通常也是最大
的那个）不归档就一直留着——少了这一步，一台刚写满的机器上「清理成功、一个字节没
少」，比报错还难查。

量目录树走的是异步 fs：管家这个进程同时是 bot 和 noVNC 的反代，同步走一遍 `/var/log`
会把事件循环占住，那几百毫秒里这台机器上所有人的聊天流和桌面画面一起卡住。

**同一时刻只跑一轮清理。** 手动那条会被人重复点（等得久了就以为没成），自动那条也
可能正好撞上来；后到的搭前一轮的车，拿同一个结果。两个 `journalctl --rotate` 叠着跑
只会更慢，还会把「清理前/清理后」这对数字搅成前一轮的前配后一轮的后。

每 30 分钟查一次，超过上限就清，清到**上限的六成**（清到上限本身的话，下一条日志写
进去就又超了，于是每半小时清一次、每次只腾几兆，而每次都在永久删掉最老的那截）。
两次自动清理之间至少隔 10 分钟。**启动时只量不清**：管家刚起来多半是刚换过版，那时
删日志会把「上一版为什么起不来」的证据一起删掉。

上限的优先级：

1. `SATUWORK_LOG_CAP_MB` —— 机器上的本地钉子，出事时不必等 Gateway
2. Gateway 心跳下发的期望值 —— 和时区、自升级同一条路：**心跳驱动、最终收敛**
3. 默认 1024 MB

`0` = 只报不清。**空不等于 0**：空是「没人指定过」（走默认），0 是「明确别动我的
journal」。心跳响应里也是这样分的——**没带这一格**（老 Gateway）就不动，带了个 `null`
才是回到默认；分不开的话，要么 Gateway 一回滚机器就悄悄放宽了上限，要么界面上写着
「跟默认走」而机器上还钉着旧值。

`/var/log` 里别的文件归 logrotate 管，管家**只报大小不动手**——伸手进去删是在和系统
自己的轮转策略打架。最大的几个非 journal 文件跟着上报，大得离谱时人看得见。

## 时区

Gateway 在心跳响应里带一个期望时区（IANA 名），管家发现和本机不一样就
`timedatectl set-timezone`。部署机器一律是 Debian，这条路只此一种。

和自升级同一个理由用心跳而不是推送：Gateway 没有任何能登录这台机器的凭据。心跳里
同时**自报本机实际时区**（读 `/etc/localtime` 指向哪儿，兜底 `/etc/timezone`）——期望和
实际分两格上报，界面才分得出「指令下了」和「已经改上了」；只报一格的话改失败和改成功
是一个样子。

期望时区为空 = 不管，**不是**改成 UTC。名字先按形状校一遍（这个值来自网络，会变成
`timedatectl` 的参数），再查 `/usr/share/zoneinfo` 里有没有——没有就把原因报回心跳，
而不是让 `timedatectl` 吐一句难懂的错。

**不重启席位。** 已经在跑的桌面和 bot 是在旧时区下起来的，libc 把时区缓存在进程里，
改 `/etc/localtime` 追不上它们；而重启席位会掐断正在进行的会话。要让某个席位跟上，
重新部署它。

## 自升级

心跳驱动，不是 Gateway 推送——推送要求推的那一刻机器在线且可达，心跳驱动只要机器
最终上线就会收敛。心跳响应带 `desiredManagerVersion`，不一样就换。

换版之前先跑一次新版本的 `--selftest`（起一次、答一次 `/health`、退出），挡掉「包
坏了 / 语法错 / 依赖缺失」。Node 版本不够就**不升**，心跳里报出来等人重跑安装脚本
——升到起不来比不升坏得多。

重启由一个瞬态单元发起（`systemd-run --on-active=2s`），不能由管家的子进程直接
`systemctl restart`：那会连自己一起被杀，命令发不出去。

换版 120 秒后 `satuwork-manager-confirm.timer` 检查一次：新管家只有**成功心跳一次**
之后才会写 `confirmedVersion`，没写就指回 `previous` 并重启。这一层是必须的——自检
只能证明「能起来」，证明不了「能跟 Gateway 说上话」，而后者失败就是机器失联。

席位不受影响：`slim-desktop@` / `satuwork-bot@` 是独立的 system unit，不是管家的子
进程，所以管家单元用 `KillMode=process`。

**但正在说的那句话会断**：Gateway 到席位的每一跳（聊天、SSE、桌面、日志）都从管家
身上过。所以换版之前先问一遍所有席位忙不忙（`GET /api/health` 的 `busy`），有人在跑
就等下一轮心跳，最多等 `SATUWORK_UPGRADE_DEFER_MS`（默认 30 分钟）——到点照换，
不然一台天天有人用的机器就永远停在旧版本上了，而升级里往往正躺着修这类问题的补丁。
等的时候 journal 里说一句，`GET /health` 的 `upgradeDeferred` 摊着「在等哪个版本、在等
谁」。**它不进 `lastError`**：等不是错，报成错会让界面给一台好好的机器画一行红字。

## 换席位版本之前也要等

`PUT /seats/:seatId` 打到一个**已经在册**的席位时，先轮询它的 `GET /api/health`，等它
把手上的活干完再重启单元——重启就是把正跑着的那一轮拦腰砍断（日志里那条 `turn/end`
根本没写成，token 照样计费，而人正对着屏幕等回答）。

窗口是 `min(spec.drainMs, SATUWORK_SEAT_DRAIN_MS)`：前者是调用方从**它自己那次请求的
超时**里切出来的预算，后者是这台机器的上限。取小不是讲究——这一跳是同步的，两个数各定
各的就会「等到一半被对面的超时掐断」，那时机器上什么都没坏，库里却记下一条「联系不上
机器管家」，而这边照样把席位重铺了。

等不到就回 `409 {busy:true}` 并且**一个字节都不动**——不是失败，席位还是原来那个版本、
还在好好地跑，Gateway 据此保留原状态，晚点再来一次就是。

`0` 的意思是**一次都不等**（忙就直接 409），不是「关掉排空」。想要「别管忙不忙现在就
重铺」，那是另一个字段：spec 里的 `interrupt: true`，也就是界面上人手工按的那颗「重新
部署」——那条路上要修的往往正是一个卡住的席位。

**先落闸，再等。** 等到空闲之后到真的重启之间还有几秒（拉包、解包、rsync），不落闸的
话人在那几秒里发一句照样被砍断。落闸走席位的 `POST /api/quiesce {ttlMs}`（带席位票，就是
写进 bot.env 的那把 `GATEWAY_TOKEN`）：静默期里它不开新的一轮，但不动正在跑的那一轮。
每一条**没走到重启**的出口都要把闸放开（见 deploySeat 的 finally）；席位那头另有 TTL 兜底。
老席位没有这条路（404）就退回到没有静默的老样子，照换。

问的是名册里记着的 `botPort`（席位**现在**听着的口），不是 spec 里这次要它听的口：
Gateway 重分槽位时后者上面蹲着的是另一个席位。

## 本地跑

```
SATUWORK_MANAGER_HOME=/tmp/mgr \
SATUWORK_MANAGER_DRYRUN=1 \
SATUWORK_MANAGER_HOST=127.0.0.1 SATUWORK_MANAGER_PORT=18443 \
pnpm --filter satuwork-manager dev
```

`SATUWORK_MANAGER_DRYRUN=1` 跳过 `deploy-seat.sh` 和 systemd（那些要 root 和一台
Debian），但 HTTP、配对、鉴权、反代全走真的。`e2e/manager.mjs` 就是靠它在开发机上
盯住整条接缝的。
