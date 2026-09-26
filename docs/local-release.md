# 本地出包（bot / manager / Desktop local-bot）

生产环境不走这条路。**生产是 CI 打包**（推 `bot-v*` / `manager-v*` / `local-bot-v*`
tag），见最后一节。

这份文档记的是**本地测试包**怎么出：改了代码想在自己的机器上验一遍，不想为此推一个 tag。

---

## 为什么不能在 Mac 上直接 `node bot/pack.mjs`

包里带 esbuild 的**原生二进制**（tsx 依赖它），而 `pnpm deploy` 只实体化当前平台那一份。
在 Mac 上打的包解到 Debian 上，tsx 加载不了 esbuild，进程起不来——而那台机器上已经没有
SSH 可以救。`pack.mjs` 会拦住这种包：

```
pack: 这个包带的是 darwin-arm64 的 esbuild，拿到席位机器上起不来。
```

**架构也要对上**：x86_64 的 Debian 要 `linux-x64` 的包，arm 的要 `linux-arm64`。
`pack.mjs` 只检查「是不是 linux-」，**不检查是哪个 linux**——在 Apple Silicon 上过
Docker 默认出的是 arm64，拿到 x86_64 机器上照样起不来，而且这一层没有任何提示。

## 出包

两个包一次装齐依赖，比分两次快得多：

```bash
SHA=$(git rev-parse --short HEAD)
BOT_V="0.1.1+${SHA}-arm64"      # 版本号规则见下一节，不能照抄
MGR_V="0.1.2+${SHA}-arm64"

mkdir -p dist
docker run --rm -v "$PWD":/src:ro -v "$PWD/dist":/out \
  -e BOT_V="$BOT_V" -e MGR_V="$MGR_V" node:24-bookworm-slim bash -c '
set -euo pipefail
corepack enable >/dev/null 2>&1
mkdir -p /w && tar -C /src -cf - --exclude=node_modules --exclude=dist . | tar -C /w -xf -
cd /w && pnpm install --frozen-lockfile
node manager/pack.mjs --version "$MGR_V"
node bot/pack.mjs     --version "$BOT_V"
cp /w/dist/*.tgz /out/
'
```

用 `tar --exclude` 而不是 `cp -r` 再删：仓库里的 `node_modules` 全是软链，`cp -r` 会
跟着链接拷贝，很慢。`.git` 要留着——`pack.mjs` 靠它算默认版本号。

给 x86_64 的机器出包加 `--platform linux/amd64`，并把版本号后缀换成 `-x64`。在 arm Mac
上那会走模拟，慢很多。

## 版本号

`pack.mjs` 的默认版本号是 `<package.json 的 version>+<git 短 sha>`，工作区脏时再加
`-dirty`。本地出包时**必须显式传 `--version`**，因为：

**一个版本号在 Gateway 上只能占用一次。** 传第二次同名的包会 409，即使内容不同。

**改动没提交时 sha 不变。** 同一个 `+5fa4ce4` 可以对应无数份不同的代码。所以本地反复
出包时，要么每次提交、要么**手动抬 `package.json` 的 version**——后者是实际做法：

```
bot/package.json      0.1.0 -> 0.1.1
manager/package.json  0.1.1 -> 0.1.2
```

本地包的后缀用架构名（`-arm64` / `-x64`），不用 `-dirty`：机器上跑起来之后，版本号是
唯一能看出「这台装的是哪个包」的东西，架构比脏不脏更值得占这个位置。

代价是**本地包的版本号不可复现**——`0.1.2+5fa4ce4-arm64` 只是「某次从这个 sha 附近的
工作区打出来的」。正式发布前先 commit，让版本号真的指向一个 commit。

## 传进本地 Gateway

传包 = 落盘到 `$SATUWORK_GATEWAY_HOME/releases/` + 在 `bot_releases` 表里写一行。
**只把 .tgz 拷进 releases 目录是不够的**，没有库里那行，机器拉不到。

**先看 Gateway 在不在跑**（`pnpm dev` 起的那个默认在 3080）：

```bash
curl -s localhost:3080/health && lsof -nP -iTCP:3080 -sTCP:LISTEN
```

在跑就直接传，不用另起。注意 `ps | grep gateway/src/index.ts` **搜不到**它——从
`gateway/` 目录起的进程，命令行里是相对路径 `src/index.ts`。按端口找，别按路径找。

没在跑就临时起一个。数据目录和库是同一套，起在哪个端口都一样：

```bash
cd gateway
GATEWAY_PORT=3099 GATEWAY_HOST=127.0.0.1 \
  node --env-file-if-exists=.env --import tsx src/index.ts &
```

然后 PUT 上去（`GATEWAY_PLATFORM_TOKEN` 在 `gateway/.env` 里）：

```bash
TOK=$(grep '^GATEWAY_PLATFORM_TOKEN=' gateway/.env | cut -d= -f2-)
F=dist/manager-0.1.2+5fa4ce4-arm64.tgz
V=$(basename "$F" .tgz | sed 's/^manager-//')
curl -X PUT "http://127.0.0.1:3099/platform/manager-releases/$(python3 -c \
      "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$V")" \
  -H "authorization: Bearer $TOK" \
  -H 'content-type: application/gzip' \
  -H "x-bot-sha256: $(shasum -a 256 "$F" | awk '{print $1}')" \
  --data-binary "@$F"
```

bot 换成 `/platform/bot-releases/`。

Desktop 本地 Bot 包必须在它实际运行的平台上打（依赖里有当前平台的 esbuild）：

```bash
pnpm --filter satuwork-desktop pack:runtime-release -- --version "0.1.13+$(git rev-parse --short HEAD)"
F=$(find dist -maxdepth 1 -name 'local-bot-*.tgz' -print -quit)
V=$(basename "$F" .tgz | sed 's/^local-bot-//')
MIN=$(node -p "require('./bot/package.json').minDesktopVersion || '0.1.0'")
curl -X PUT "http://127.0.0.1:3099/platform/local-bot-releases/$(python3 -c \
      "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$V")?minDesktopVersion=$MIN" \
  -H "authorization: Bearer $TOK" \
  -H 'content-type: application/gzip' \
  -H "x-bot-sha256: $(shasum -a 256 "$F" | awk '{print $1}')" \
  --data-binary "@$F"
```

脚本自动给版本加 `-darwin-arm64`、`-windows-x64` 等目标后缀。Gateway 按后缀给 Desktop
选包；不能手工改成另一种平台。`minDesktopVersion` 是这个包要求的最低 Desktop 版本，不带
按 `0.1.0` 登记；Gateway 只把包发给版本够得上的 Desktop（CI 登记时从 tag 上的
bot/package.json 读同一个字段）。正式发布推 `local-bot-v0.1.13` tag，
`.github/workflows/local-bot-release.yml` 会构建六个目标包并上传。上传只让新版本变为可用，
不会强杀正在运行的 Bot；Desktop 下次启动第一颗本地 Bot 时静默切换。

版本号里的 `+` 编不编码都行：路由那层对每段做 `decodeURIComponent`，而**路径段里的 `+`
是字面量**，不会被解成空格（那是 query string 的规矩，不是 path 的）。上面照着
`pack.mjs` 编成 `%2B` 只是保持一致。

如果是临时起的 Gateway，传完记得停掉：

```bash
lsof -nP -iTCP:3099 -sTCP:LISTEN -t | xargs kill
```

## 验一下包里确实是新代码

打包链路长（tar → pnpm deploy → tar），出错时表现是「装上去了但行为没变」，很难往打包
上想。花几秒直接看包里的文件：

```bash
M=dist/manager-0.1.2+5fa4ce4-arm64.tgz
tar xzf "$M" -O ./src/seat/deploy-seat.sh | grep -c GATEWAY_MACHINE_TOKEN   # 期望 0
tar xzf "$M" -O ./src/seat/slim-desktop.sh | grep 'websockify --web'        # 期望 127.0.0.1
tar tzf "$M" | grep -o '@esbuild/[a-z0-9-]*' | sort -u                      # 期望 linux-<你的架构>
```

注意 macOS 的 `tar` 是 bsdtar，**没有 `--wildcards`**（那是 GNU tar 的）。用上面这种完整
路径（`./src/...`），别用通配符——带 `--wildcards` 会报错，而如果你顺手加了
`2>/dev/null`，看到的就是「grep 到 0 处」这种假通过。

## 生产：CI

```bash
git tag manager-v0.1.2 && git push --tags     # 或 bot-v0.1.1 / local-bot-v0.1.13
```

`.github/workflows/{bot,manager}-release.yml` 会：

1. **两个架构各打一个包**——x64 在 `ubuntu-latest`、arm64 在 `ubuntu-24.04-arm`，
   都是原生 runner，不走模拟。出包前先断言 `process.arch` 和矩阵对得上。
2. **建 GitHub Release**，两个 `.tgz` 都挂上去（只在 tag 触发时建；手动触发没有可挂的
   tag，只上传 artifact 和传 Gateway）。
3. **传 Gateway**，两条独立的发布记录：`<ver>+<sha>-x64` 和 `<ver>+<sha>-arm64`。

版本号带架构后缀，和本地出包是同一套约定。

> **`ubuntu-24.04-arm`**：本仓库是公开的，arm runner 免费可用。若将来转回私有，这个
> runner 要 Team/Enterprise 方案——那时把矩阵里 arm64 那行换成 x64 runner 过 QEMU
> （`docker/setup-qemu-action` + `--platform linux/arm64`），慢很多但哪都能跑。

### 上传顺序是有意的

workflow 里是**串行**上传、**arm64 先 x64 后**。因为 Gateway 的 `latestBotRelease` 只按
`createdAt` 取，**不认架构**——矩阵并发上传的话「最新」是随机的，等于随机换架构。串行
之后 x64 稳定地是最新，和多架构之前的行为一致。

**所以 arm 机器必须显式钉版本**（`machines.desiredManagerVersion`，或部署时指定 bot
版本），别让它跟「最新」走。在 Gateway 学会按架构选包之前，这是唯一的办法。

装错架构的后果，两个包不一样：

- **管家**：换版前会拿新包跑一次 `--selftest`，架构不对会在那步失败，`current` 不动，
  原因报回心跳。**不会变砖**，但也升不上去。
- **bot**：没有这道自检。席位会「部署成功」但 bot 起不来，表现是聊天 503。重新部署到
  正确版本即可恢复。

## 传包之后会发生什么

**这一条比看起来重要。** 管家的目标版本按三级取（`desiredManagerRelease`）：

1. 这台机器的 `machines.desiredManagerVersion`
2. 平台设置里的 `managerVersion`
3. **都空 → 跟最新发布走**

两级 pin 都空是默认状态。也就是说**传一个 manager 包上去，所有没 pin 的机器会在下一次
心跳（≤30 秒）自己升上去**——不需要任何人点确认。本地测试时尤其要意识到这一点：你以为
只是"传个包看看"，实际是给全部机器发了版。

不想让它自动铺开，就先把 `desiredManagerVersion` 或平台的 `managerVersion` 钉在当前版本
上，再传。

bot 包没有这条自动路径：席位装哪个 bot 版本由**重新部署**时决定（不指定版本就取
`latestBotRelease`）。所以传 bot 包本身不动任何席位，但之后任何一次重新部署都会带上它。
