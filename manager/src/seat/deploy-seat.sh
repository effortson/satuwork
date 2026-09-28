#!/bin/bash
# 部署一个席位。由机器管家在本机以 root 运行——**没有 sudo，也没有占位符替换**，
# 全部参数走环境变量（见下面的 `: "${VAR:?}"` 一组）。
#
# 它的前身是 Gateway 通过 SSH 灌进来的 remote-deploy.sh。搬到管家之后少了两样东西：
# 每次 scp 一份安装包（改成管家按版本缓存在 SEAT_ASSETS 之外的 releases 目录），
# 以及满屏的 sudo。逻辑本身没动。
#
# 粒度：**一个员工一个 Linux 账号**（$LINUX_USER），账号下**一个 bot 一个席位**
# （$SEAT_ID）。所以对账号的部分是幂等复用的，对席位的部分才是新建。
#
#   $HOME_DIR/work                 共享工作区。同员工的所有席位都看得见，这是共享入口。
#   $HOME_DIR/.satuwork/$SEAT_ID   席位私有：$SATUWORK_HOME、Chrome profile、XDG 各目录
#   /etc/satuwork/seats/$SEAT_ID   root 的：bot 单元读的 bot.env 和凭据
#   /opt/satuwork/seats/$SEAT_ID   root 的：这个席位的 bot 程序（app/），席位用户只读
# -E（errtrace）**不能省**：不加的话下面那条 ERR trap 只在顶层生效，进不了函数、
# 命令替换和子 shell。这脚本里失败最可能发生的地方恰恰都在函数里（ensure_chrome、
# verify_seat_listener），漏了 -E 等于白加——已经这样白加过一轮了。
set -Eeuo pipefail

# **失败要自报家门。** set -e 让任何一条命令非零时立刻退出，而这里有不少命令
# （mkdir、chown、rsync、systemctl、runuser）失败时**两个流一个字都不写**，或者只往
# stdout 写进度。那时候管家收到的是「非零退出」外加一堆无关的进度输出，看不出断在
# 哪一步——真出过一次：日志显示走到了写 VNC 口令，再往后什么都没有。
#
# 这条 trap 保证 stderr 的最后一句永远说得出「第几行、退出码多少」。
# **不打印 $BASH_COMMAND**：那一行展开之后可能带着 VNC 口令或票，而这条消息要一路
# 送到浏览器上去。行号配上这个版本的脚本，足够定位到具体哪一条命令。
trap 'rc=$?; echo "deploy-seat.sh 第 $LINENO 行失败（退出码 $rc）" >&2; exit $rc' ERR

: "${LINUX_USER:?}"
: "${SEAT_ID:?}"
: "${HOME_DIR:?}"
: "${WORK_DIR:?}"
: "${SEAT_DIR:?}"
: "${DISPLAY_NUM:?}"
: "${RFB:?}"
: "${HTTP:?}"
: "${BOT_PORT:?}"
: "${CDP:?}"
: "${BOT_VERSION:?}"
# 管家已经把发布包解好了，这里只管拷。管家保证同一版本全机只解一次。
: "${BOT_EXTRACT:?}"
# 管家自己包里的 seat 资源目录：两个 .service 模板、两个启动脚本。
: "${SEAT_ASSETS:?}"
: "${VNC_PASSWORD:?}"
: "${GATEWAY_URL:?}"
: "${GATEWAY_TOKEN:?}"
: "${GATEWAY_API_KEY:?}"
: "${SATUWORK_BOT_ID:?}"

# 以 root 跑，下面这些值会变成 mkdir/chown 的目标和 systemd 单元里的字段。管家的
# specOf 已经按形状校过一遍并且**自己推导路径**；这里再兜一层，理由和
# remove-seat.sh 里那段 case 一样：脚本可能被手工调用，而且这一层的代价近乎零。
case "$LINUX_USER" in
  *[!A-Za-z0-9_-]* | '') echo "refusing: bad LINUX_USER" >&2; exit 1 ;;
esac
case "$SEAT_ID" in
  *[!A-Za-z0-9_-]* | '') echo "refusing: bad SEAT_ID" >&2; exit 1 ;;
esac
# 路径必须正好长成席位应该在的样子，否则拒绝——不然一个 HOME_DIR=/etc 就是
# chown -R "$LINUX_USER" /etc。
[ "$HOME_DIR" = "/home/$LINUX_USER" ] || { echo "refusing: HOME_DIR $HOME_DIR" >&2; exit 1; }
[ "$WORK_DIR" = "$HOME_DIR/work" ] || { echo "refusing: WORK_DIR $WORK_DIR" >&2; exit 1; }
[ "$SEAT_DIR" = "$HOME_DIR/.satuwork/$SEAT_ID" ] || { echo "refusing: SEAT_DIR $SEAT_DIR" >&2; exit 1; }

DISPLAY_VAR=":${DISPLAY_NUM}"
# bot 单元要 root（systemd）读的文件都放这儿：$HOME 之外、root 的 0700 目录。
# 理由见 step 4 的「bot 单元读的文件」那一段。
SEAT_ETC="/etc/satuwork/seats/$SEAT_ID"
BOT_ENV_FILE="$SEAT_ETC/bot.env"
SECRETS_FILE="$SEAT_ETC/secrets.env"
# bot 的程序：root 的目录，席位用户只读、改不动。理由见 step 5。
SEAT_APP_ROOT="/opt/satuwork/seats/$SEAT_ID"
APP_DIR="$SEAT_APP_ROOT/app"

# ── 进度自报 ──────────────────────────────────────────────────────────
# 一行 `@@step <第几步>/<共几步> <这一步在干什么>`，管家按行读（见 manager/src/seats.ts
# 的 stepOf），最后落到建完 Bot 那一屏的安装进度上。
#
# **为什么非要脚本自己报。** 机器上这一段在干净机器上要跑十几分钟，其中 apt 装桌面栈
# 和装浏览器各占一大截；而这段时间里 Gateway 手上只有一条挂着的 HTTP 请求，它看不见
# 里面任何一步。人对着一句不动的「部署中…」等十分钟，唯一能做的判断是「是不是卡死
# 了」——而正确答案通常是「没有，正常就这么久」。
#
# 报的是**即将开始的那一步**（在它前面 echo），不是百分比：这几步的时长差着一个数量
# 级，摊成一个匀速的百分比条只会在装桌面那一步停住不动，比不报还糟。
#
# 步数写死在这里，加减步骤时两个数一起改——管家不认识这几步，它只是把括号里的数原样
# 往上送。
STEPS=7
step() { echo "@@step $1/$STEPS $2"; }

step 1 "创建席位账号"
if ! id "$LINUX_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$LINUX_USER"
fi

step 2 "安装桌面组件"
# procps/iproute2：slim-desktop.sh 靠 pkill 和 ss 清上一轮的残留，少了它们那段会静默失效。
# xauth：slim-desktop.sh 给每块屏发 cookie（不再 -ac）；nftables：seat-cdp-guard.sh 的 nft。
PKGS="xorg xvfb dbus-x11 x11-xserver-utils xfwm4 thunar xfce4-terminal plank picom hsetroot x11vnc novnc python3-websockify procps iproute2 xauth nftables"
NEED=""
for p in $PKGS; do
  if ! dpkg -s "$p" >/dev/null 2>&1; then NEED="$NEED $p"; fi
done
if [ -n "$NEED" ]; then
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y $NEED
fi
# ── 浏览器 ────────────────────────────────────────────────────────────
# bot 干活主要靠它（开网页、填表单、截图），dock 上第一格也是它。所以这是部署的一
# 部分，不是「顺手装装看」：每次部署都确认在位，不在就装，装完再确认一次。
#
# 原来这里是一句 `apt-get install -y chromium 2>/dev/null || true`——**失败完全静默**。
# 源里没有、网络不通、包名不对，结果都一样：部署照常成功，桌面起来了，dock 上少一
# 格，没有任何地方说得出为什么。
#
# **按架构分。** Google 官方只为 linux/amd64 发 Chrome，arm64 上没有这个包；在 arm 机
# 器上去配 Google 的 apt 源，`apt update` 会 404，还会把整条 apt 链路弄脏。所以只有
# amd64 才走官方源，arm64 一律用 Debian 自己的 Chromium——对 bot 来说两者等价。
chrome_bin() {
  for c in google-chrome-stable google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then echo "$c"; return 0; fi
  done
  return 1
}

install_google_chrome() {
  local key=/usr/share/keyrings/google-chrome.gpg
  local need=""
  for p in curl gnupg ca-certificates; do
    dpkg -s "$p" >/dev/null 2>&1 || need="$need $p"
  done
  if [ -n "$need" ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y $need >/dev/null 2>&1 || return 1
  fi
  curl -fsSL --max-time 60 https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o "$key" 2>/dev/null || return 1
  echo "deb [arch=amd64 signed-by=$key] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  # 只刷 Google 这一个源。整库 update 在慢网上要好几分钟，而这里只关心一个包。
  apt-get update \
    -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/google-chrome.list \
    -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 >/dev/null 2>&1 || return 1
  DEBIAN_FRONTEND=noninteractive apt-get install -y google-chrome-stable >/dev/null 2>&1
}

ensure_chrome() {
  local have
  if have=$(chrome_bin); then
    echo "chrome: 已在位（$have）"
    return 0
  fi
  local arch
  arch=$(dpkg --print-architecture 2>/dev/null || echo unknown)
  echo "chrome: 没找到浏览器，开始安装（arch=$arch）"
  if [ "$arch" = "amd64" ]; then
    install_google_chrome || echo "chrome: 官方源装不上，回落到 Chromium" >&2
  fi
  if ! chrome_bin >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y chromium >/dev/null 2>&1 || true
  fi
  if ! chrome_bin >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y chromium-browser >/dev/null 2>&1 || true
  fi
  if have=$(chrome_bin); then
    echo "chrome: 装好了（$have）"
    return 0
  fi
  # **不让部署失败。** 没有浏览器，桌面、终端、文件管理器和 bot 的其它能力都还在；
  # 而部署失败会让整个席位起不来，代价大得多。但必须吼出来——静默正是上一版的毛病。
  echo "chrome: 装不上（源里没有或网络不通），这个席位没有浏览器可用" >&2
  return 0
}
step 3 "安装浏览器"
ensure_chrome

step 4 "铺席位目录"
mkdir -p /usr/local/bin /etc/systemd/system

# ── 家目录底下的东西，root 一律不亲手碰 ─────────────────────────────────
# $HOME_DIR 往下每一层都归席位用户，**他能随时把任何一层换成符号链接**。而这个脚本是
# root：从前那句 `chown "$LINUX_USER" "$WORK_DIR"` 不带 -h，是跟着链接走的——员工
# `rm -rf ~/work && ln -s /etc ~/work`，下一次重新部署 root 就把 /etc 送给了他。同一
# 类洞还有一串：root 往 $SEAT_DIR 里 `cat >`、`printf >`、`chmod`、`chown -R`，以及
# `rsync --delete` 到 $SEAT_DIR/app/（app 要是指向 /etc/systemd/system，整个目录会被
# 清空）。
#
# 逐条补 `[ -L ]` 堵不住：检查和使用之间有时间差，席位用户的 bot 这时候正跑着，换一个
# 链接只要一个系统调用。所以换个思路——**家目录底下的写，全部以席位用户的身份做**。
# 他换什么链接都只能指到他自己本来就写得动的地方，等于没换。root 只剩两件事：
#   - $HOME_DIR 本身：它在 /home（root 的目录）底下，席位用户换不掉它，是链接就拒绝；
#   - 修归属：只用 `chown -h`（不跟链接），递归用 `chown -hR`（GNU 默认 -P，一层链接都不跟）。
#
# env -i：不把这个脚本的环境（GATEWAY_API_KEY、VNC_PASSWORD……）带进席位用户的进程。
# 要写进文件的内容一律走 stdin，不上命令行。-C /：管家的工作目录席位用户未必进得去。
as_user() {
  runuser -u "$LINUX_USER" -- env -i -C / PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME_DIR" "$@"
}
# stdin 原样写进 $1，0600。umask 077 让文件**一出生**就是 0600——先按默认 0644 建出来
# 再 chmod，中间那一瞬谁都读得到（bot.env 里是票和 API key）。
write_as_user() {
  as_user sh -c 'umask 077; cat > "$1"' sh "$1"
}

if [ -L "$HOME_DIR" ]; then
  echo "refusing: $HOME_DIR 是符号链接" >&2
  exit 1
fi
mkdir -p "$HOME_DIR"
chown -h "$LINUX_USER:$LINUX_USER" "$HOME_DIR"
# 老版本留下的、中途失败时是 root 的目录，先把归属修回来，否则下面以席位用户建目录会
# 被拒。-h：它们要是链接，改的是链接本身，不碰指向的东西。不存在就算了。
chown -h "$LINUX_USER:$LINUX_USER" "$WORK_DIR" "$HOME_DIR/.satuwork" 2>/dev/null || true
if [ -d "$SEAT_DIR" ] && [ ! -L "$SEAT_DIR" ]; then
  chown -hR "$LINUX_USER:$LINUX_USER" "$SEAT_DIR"
fi
# 账号级：共享工作区。已存在就别动，里面是员工和 bot 的资料。
# 席位级：整棵子树都归这个席位。
as_user mkdir -p "$WORK_DIR" "$HOME_DIR/.satuwork" \
  "$SEAT_DIR" "$SEAT_DIR/bin" "$SEAT_DIR/chrome" "$SEAT_DIR/cache" \
  "$SEAT_DIR/config/picom" "$SEAT_DIR/config/plank/dock1/launchers" "$SEAT_DIR/share/applications"

install -m 755 "$SEAT_ASSETS/slim-desktop.sh" /usr/local/bin/slim-desktop.sh
install -m 755 "$SEAT_ASSETS/satuwork-bot.sh" /usr/local/bin/satuwork-bot.sh
install -m 755 "$SEAT_ASSETS/seat-cdp-guard.sh" /usr/local/bin/seat-cdp-guard.sh
install -m 644 "$SEAT_ASSETS/slim-desktop@.service" /etc/systemd/system/slim-desktop@.service
install -m 644 "$SEAT_ASSETS/satuwork-bot@.service" /etc/systemd/system/satuwork-bot@.service

# 模板里的 %i 是席位 ID，不再是用户名，所以 User= 只能从这儿来。模板里的
# User=nobody 是兜底；drop-in 在主文件之后加载，标量设置后写覆盖先写。
#
# ExecStartPre=+ 那一行以 root 跑（`+` 不受 User= 管）：把 CDP 口判给这个席位的账号，
# 别的账号连不上（见 seat-cdp-guard.sh）。nft 规则重启就没，所以挂在单元启动前而不是只
# 在部署时装一次；两个单元都挂，因为 Chrome 两边都拉得起来（dock 上点、Bot 自己拉）。
# 参数写死在这份 root 写的 drop-in 里，不从席位用户写得动的 desktop.env 读。
mkdir -p "/etc/systemd/system/slim-desktop@$SEAT_ID.service.d" \
  "/etc/systemd/system/satuwork-bot@$SEAT_ID.service.d"
cat > "/etc/systemd/system/slim-desktop@$SEAT_ID.service.d/seat.conf" << EOF_DESK_DROPIN
[Service]
User=$LINUX_USER
Group=$LINUX_USER
Environment=HOME=$HOME_DIR
Environment=SEAT_DIR=$SEAT_DIR
ExecStartPre=+/usr/local/bin/seat-cdp-guard.sh add $SEAT_ID $LINUX_USER $CDP
EOF_DESK_DROPIN
cat > "/etc/systemd/system/satuwork-bot@$SEAT_ID.service.d/seat.conf" << EOF_BOT_DROPIN
[Service]
User=$LINUX_USER
Group=$LINUX_USER
Environment=HOME=$HOME_DIR
Environment=SEAT_DIR=$SEAT_DIR
# 两个文件都在 $SEAT_ETC（root 的 0700 目录），理由见下面「bot 单元读的文件」。
EnvironmentFile=$BOT_ENV_FILE
# 两把凭据不进 env：systemd（root）打开 root 的 0600 文件接到 fd 0 上，bot 启动读完即关。
# 见 bot/src/seat-secrets.ts。
StandardInput=file:$SECRETS_FILE
StandardOutput=journal
StandardError=journal
Environment=SATUWORK_SECRETS_STDIN=1
ExecStartPre=+/usr/local/bin/seat-cdp-guard.sh add $SEAT_ID $LINUX_USER $CDP
EOF_BOT_DROPIN

# ── bot 单元读的文件：只放在 root 的目录里 ─────────────────────────────
# bot 和它起的子进程（terminal 的 bash、Chrome）是**同一个 Linux 用户**。凭据原先两处
# 都摸得到：$SEAT_DIR/bot.env 归席位用户，`cat` 就有；EnvironmentFile 又把它们放进 bot
# 的初始环境，`/proc/$PPID/environ` 一读就有（Node 里 delete process.env 改不到那个
# 文件）。拿到 sat_ 的脚本能自己去 /api/sessions/<sid>/approvals 把审批全点掉。
#
# 光把凭据挪走还不够：EnvironmentFile= 和 StandardInput=file: 是 **systemd 以 root 打开**
# 的。文件留在 $SEAT_DIR 里（席位用户可写的目录），他随时能把它换成符号链接——指向
# 管家的配置之类只有 root 读得了的 KEY=VALUE 文件，杀掉自己的 bot，Restart=on-failure
# 就把那份内容注入进他的进程；或者往 bot.env 里写一行 NODE_OPTIONS / LD_PRELOAD。
# 所以这两个文件都放 $SEAT_ETC：root 的 0700 目录，文件 root 0600。
#
# 非机密的那部分（GATEWAY_URL 之外）bot 运行时不改；GATEWAY_URL 学到新地址时 bot 写的是
# $SEAT_DIR/gateway-url（带席位票做的 HMAC，由 bot 自己在启动时校验着读，root 不碰它），
# 见 bot/src/gateway-url.ts。
#
# 写法：先写同目录的临时文件再 rename——umask 077 让它一出生就是 0600。
write_root_file() {
  local tmp="$1.tmp"
  rm -f "$tmp"
  (umask 077; cat > "$tmp")
  chown root:root "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$1"
}
install -d -m 700 -o root -g root /etc/satuwork/seats "$SEAT_ETC"
printf 'GATEWAY_TOKEN=%s\nGATEWAY_API_KEY=%s\n' "$GATEWAY_TOKEN" "$GATEWAY_API_KEY" | write_root_file "$SECRETS_FILE"

# ── 同 uid 的子进程不许读 bot 的内存 ──────────────────────────────────
# 凭据挪出 env 之后还在 bot 进程的内存里。Debian 默认 kernel.yama.ptrace_scope=0：同 uid
# 的任何进程都能 ptrace 它、读 /proc/<pid>/mem。设成 1 之后只有祖先进程能这么做，而
# terminal 起的 bash 是 bot 的**子孙**，够不着它；同一员工另一个席位的子进程也够不着。
# 已经更严（2/3）的不降；写进 sysctl.d 是为了重启之后还在。
# 设不上（内核没有 Yama、容器里 /proc/sys 只读）不让部署失败，但要吼出来。
ensure_ptrace_scope() {
  local knob=/proc/sys/kernel/yama/ptrace_scope cur target
  if [ ! -r "$knob" ]; then
    echo "ptrace: 内核没有 Yama（$knob 不存在），同 uid 的子进程仍能读 bot 的内存" >&2
    return 0
  fi
  cur=$(cat "$knob" 2>/dev/null || echo 0)
  case "$cur" in [0-3]) ;; *) cur=0 ;; esac
  target=$cur
  if [ "$cur" -lt 1 ]; then target=1; fi
  printf '# satuwork：席位 bot 的子进程不许 ptrace / 读 bot 的内存（见 deploy-seat.sh）\nkernel.yama.ptrace_scope = %s\n' "$target" \
    > /etc/sysctl.d/60-satuwork-ptrace.conf
  if [ "$cur" -lt 1 ]; then
    if ! sysctl -q -w kernel.yama.ptrace_scope=1 >/dev/null 2>&1; then
      echo "ptrace: kernel.yama.ptrace_scope 设不成 1（当前 $cur），同 uid 的子进程仍能读 bot 的内存" >&2
    fi
  fi
}
ensure_ptrace_scope

write_as_user "$SEAT_DIR/desktop.env" << EOF_ENV
DISPLAY_NUM=$DISPLAY_NUM
DISPLAY=$DISPLAY_VAR
RFB=$RFB
HTTP=$HTTP
CDP=$CDP
WORK_DIR=$WORK_DIR
EOF_ENV
# 口令**直接写文件**，不再经 `x11vnc -storepasswd <口令> <文件>`：那样口令挂在命令行上，
# 这台机器上任何用户 `ps` 一下都看得见（虽然只有一瞬）。x11vnc 的 -storepasswd 没有
# 从 stdin 读的口子（只给文件名时它走 getpass 找 /dev/tty，runuser 下没有）。所以写成
# 明文文件（0600、归席位用户，见 write_as_user），slim-desktop.sh 用 -passwdfile 读它；
# 老席位留下的 DES 文件那边照旧用 -rfbauth 认，按大小分（DES 文件恰好 8 字节）。
# 顺带也没了「storepasswd 的正常输出混进错误里」那桩老毛病。
# 加密强度没有变差：-rfbauth 那个 DES 文件用的是公开的固定密钥，本来就等于明文。
# printf 是内建命令，口令不会出现在任何进程的命令行上。
printf '%s\n' "$VNC_PASSWORD" | write_as_user "$SEAT_DIR/vnc-passwd"
printf 'backend = "xrender";\nvsync = false;\nuse-damage = false;\n' | write_as_user "$SEAT_DIR/config/picom/picom.conf"

step 5 "拷贝 Bot 程序"
if [ ! -f "$BOT_EXTRACT/bin/satuwork.mjs" ]; then
  echo "release $BOT_VERSION has no bin/satuwork.mjs" >&2
  exit 42
fi

# 每个席位还是各自一份 app：cordis.yml 里的监听端口是逐席位 sed 出来的，共享一份
# 目录就没法让两个席位听不同的口。版本也因此能逐席位钉死。
#
# **app 放在 root 的 /opt/satuwork/seats/<席位>/app，席位用户只读。** 它以前在
# $SEAT_DIR/app，归席位用户——而 bot 起的每个子进程（terminal 的 bash、被提示注入
# 驱动的脚本）都是这个用户。凭据挪进 root 的文件、从 fd 0 递进去之后，这里就成了最
# 短的那条路：改掉 app 里的一个 .ts，`kill -9 $PPID`，Restart=on-failure 把 bot 拉起来，
# 跑的已经是改过的代码，它照样从 fd 0 读到 sat_ 和 API key。代码归 root，这条路就断了。
#
# root 在这里只碰 root 自己的目录，所以可以放心地 cp / chown / sed（不必像家目录那样
# 绕 as_user）。先整份铺进 app.new，改好属主和 cordis.yml，再换名顶上去：换的那一下
# 之前旧的 app 完好，部署半路失败不会留下半份代码。
install -d -m 755 -o root -g root /opt/satuwork /opt/satuwork/seats "$SEAT_APP_ROOT"
rm -rf "$APP_DIR.new" "$APP_DIR.old"
cp -a "$BOT_EXTRACT/." "$APP_DIR.new/"
printf '%s\n' "$BOT_VERSION" > "$APP_DIR.new/VERSION"
if [ -f "$APP_DIR.new/cordis.yml" ]; then
  # bot 只听 127.0.0.1：对外那一跳由管家反代，席位端口不再需要暴露到网络上。
  sed -i -E "s/^([[:space:]]*host:).*/\1 127.0.0.1/" "$APP_DIR.new/cordis.yml"
  sed -i -E "s/^([[:space:]]*port:)[[:space:]]*[0-9]+/\1 $BOT_PORT/" "$APP_DIR.new/cordis.yml"
fi
# 属主一律 root，谁都不许写；读和进目录留给所有人（席位用户要能读它来跑）。
chown -hR root:root "$APP_DIR.new"
chmod -R u+rwX,go+rX,go-w "$APP_DIR.new"
if [ -d "$APP_DIR" ]; then mv "$APP_DIR" "$APP_DIR.old"; fi
mv "$APP_DIR.new" "$APP_DIR"
rm -rf "$APP_DIR.old"
# **迁移**：老版本的 app 在 $SEAT_DIR/app（归席位用户）。不删的话，谁看都以为 bot 跑的
# 是那一份。以席位用户身份删：那是他的目录，root 不在里面动手（见 step 4 开头）。
as_user rm -rf "$SEAT_DIR/app"

# 非机密配置。写到 $SEAT_ETC，不再写 $SEAT_DIR——理由见 step 4「bot 单元读的文件」。
write_root_file "$BOT_ENV_FILE" << EOF_ENV
GATEWAY_URL=$GATEWAY_URL
# 协议 10：调模型走管家的回环口（管家再向 Gateway 要授权、报结算），不直打 Gateway 的 /v1。
GATEWAY_LLM_URL=$MANAGER_LLM_URL
SATUWORK_BOT_ID=$SATUWORK_BOT_ID
SATUWORK_HOME=$SEAT_DIR
SATUWORK_PORT=$BOT_PORT
SATUWORK_WORK_DIR=$WORK_DIR
# 桌面上那个 Chrome 的 CDP 口。**bot.env 也要有一份**：它原先只写进 desktop.env，
# 而 bot 单元的 EnvironmentFile 是 bot.env——于是 Bot 进程看不见这个端口，浏览器
# 那几把工具连不上自己席位的浏览器。两份写的是同一个值，来源都是 $CDP。
SATUWORK_CDP_PORT=$CDP
DISPLAY=$DISPLAY_VAR
# 这块屏的 X cookie（slim-desktop.sh 每次起屏写一张新的）。Bot 拉起的 Chrome、terminal
# 里跑的 X 工具要靠它才连得上屏——Xvfb 已经不再 -ac 了。
XAUTHORITY=$SEAT_DIR/Xauthority
XDG_SESSION_TYPE=x11
XDG_CONFIG_HOME=$SEAT_DIR/config
XDG_DATA_HOME=$SEAT_DIR/share
XDG_CACHE_HOME=$SEAT_DIR/cache
XDG_RUNTIME_DIR=/tmp/xdg-runtime-$SEAT_ID
GDK_BACKEND=x11
HOME=$HOME_DIR
EOF_ENV

# 文件本来就是席位用户建的，不用再 chown。chmod 补的是「文件早就在」的情况：
# `cat >` 截断重写不改已有文件的权限位，老席位留下的可能是 0644。
as_user chmod 600 "$SEAT_DIR/desktop.env" "$SEAT_DIR/vnc-passwd"
# **迁移**：老版本把票和 API key 写在 $SEAT_DIR/bot.env 里（gateway-url.ts 改写时还可能留
# 下一份 bot.env.tmp）。现在两样都不用了，删掉。以席位用户身份删（as_user 带 env -i）：
# root 不在席位用户换得掉的路径上动手，也不把这个脚本的环境（票、口令）带进他的进程。
as_user rm -f "$SEAT_DIR/bot.env" "$SEAT_DIR/bot.env.tmp"

step 6 "启动桌面与 Bot"
systemctl daemon-reload
# **两个都要 restart，不能用 `enable --now`。**
# `--now` 的语义是「没在跑就起来」——已经在跑就什么都不做。桌面这条以前正是
# `enable --now`，于是重新部署时：新的 VNC 口令写进了 vnc-passwd，而 x11vnc 是启动
# 那一刻用 -rfbauth 读的文件，进程没重启，内存里还是**上一次部署**的旧口令。
# 表现是界面上明明写着口令、照着输却一直 password check failed，而且怎么重新部署
# 都不会好——因为每次都不重启。
enable_and_restart() {
  systemctl enable "$1" >/dev/null 2>&1 || true
  systemctl restart "$1"
}
# 先当场装一遍 CDP 口的规则：单元里的 ExecStartPre 也会装，但那里失败只落进 journal，
# 部署这边只看到一句 restart 失败。装不上（没有 nf_tables、容器里没权限）就让部署失败
# ——没有这一层，同机的别的员工就能直接驱动这个席位的浏览器。
/usr/local/bin/seat-cdp-guard.sh add "$SEAT_ID" "$LINUX_USER" "$CDP"
enable_and_restart "slim-desktop@$SEAT_ID.service"
enable_and_restart "satuwork-bot@$SEAT_ID.service"

# 占着这个 pid 的是哪个席位。认不出来回空。
#
# **不能只比 Linux 用户名。** 一个员工的所有席位共用一个账号，于是同账号下另一块屏
# 的 x11vnc 蹲在这个口上时，`owner = $LINUX_USER` 是成立的——这道自证会放它过去，
# 而界面上「打开桌面」进的是另一块屏，口令永远对不上。正是这道自证要拦的那种事。
#
# XDG_RUNTIME_DIR 是 /tmp/xdg-runtime-$SEAT_ID，逐席位唯一，slim-desktop.sh 在起任何
# 东西之前就 export 了；bot.env 里也有同一条。三个监听进程都带着自己那一份。
# `|| true` 写在命令替换**里面**——和下面 verify_seat_listener 里 pid= 那处同一个理由：
# errtrace 会让 ERR trap 在子 shell 里先响，写在外面拦不住那一声。进程刚退时
# /proc/<pid>/environ 就没了，而那恰恰是这个函数最常被调用的时刻。
seat_of_pid() {
  printf '%s' "$(tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null | sed -n 's|^XDG_RUNTIME_DIR=/tmp/xdg-runtime-||p' | head -1 || true)"
}

# ── 部署完自证：那两个端口上蹲着的得是**这个席位的**进程 ────────────────
# 「起完就算成功」在这里是不够的。机器上完全可能有另一套 VNC 占着 6081——这台就
# 撞过：一个 Aug 16 起的 x11vnc :3 + websockify 0.0.0.0:6081 → localhost:5902，口令在
# /home/slim/.vnc/passwd。它把席位的 websockify 挤得起不来，而管家照样上报 ready。
#
# 结果是界面上「部署成功」，点开桌面也**真的能连上**——连的是那一套，于是照着界面
# 输口令永远 password check failed，重新部署多少次都一样。这种失败不会自己浮出来，
# 只能靠人去 ps 里翻。所以在这里就断掉，把原因写进部署错误里报回 Gateway。
verify_seat_listener() {
  local port="$1" what="$2" pid owner holder
  # 等 30 秒。**新建席位第一次起屏比想象的慢**：adduser、daemon-reload、Xvfb 就绪、
  # 上一轮残留的端口释放，叠起来轻松过十秒——等太短会把「慢」判成「坏」。
  for _ in $(seq 1 120); do
    # **末尾的 `|| true` 不能省。** 端口空着时 grep 退出 1，pipefail 把整条管道判成
    # 非零，脚本开头的 set -e 当场终止——而「端口还没起来」正是这个循环存在的理由，
    # 于是第一圈就炸。就这么炸过：部署报 502，stderr 只剩「第 272 行失败（退出码
    # 1）」，底下那段「超时不算失败、让 systemd 继续拉」一次都没跑到。
    # （`|| true` 要写在命令替换**里面**：errtrace 会让 ERR trap 在子 shell 里先响，
    # 写在外面的 `|| pid=` 拦不住那一声。顺带也挡掉 head -1 提前关管道给 grep 的
    # SIGPIPE——那同样是非零。）
    pid=$(ss -ltnp 2>/dev/null | grep -E ":${port}\b" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
    if [ -n "${pid:-}" ]; then
      # 同上：pid 是上一条 ss 抓的，进程完全可能在这一瞬已经退了，读 environ、跑 ps
      # 于是都可能空手而归。那时该继续等，而不是让整个部署崩掉。
      holder=$(seat_of_pid "$pid" || true)
      [ "$holder" = "$SEAT_ID" ] && return 0
      owner=$(ps -o user:32= -p "$pid" 2>/dev/null | tr -d ' ' || true)
      # 认不出席位、用户又对得上：多半是本席位刚 fork 出来还没走到 export，也可能
      # 进程已经退了。**不据此放行**（放行就是上面那个「进的是另一块屏」的洞），
      # 继续绕圈；真起不来的话，下面那句超时告警会兜住，且不算部署失败。
      if [ -z "$holder" ] && [ "$owner" = "$LINUX_USER" ]; then
        sleep 0.25
        continue
      fi
      # 端口被**别人**占着：这是确定的错误，而且没人去动它就永远不会自己好。
      # 这一条必须让部署失败——否则又变成「部署成功但连进去是另一套 VNC」。
      #
      # 话要说准。管家在跑这个脚本之前已经清过一轮占口的席位（见 reclaim.ts），
      # 所以走到这里的两种情况都不是「有别的 VNC 在跑」那么简单：占口的若是另一个
      # 席位，说明它是在这次部署途中才起来的（或者这个脚本是被手工跑的，前面那一层
      # 压根没跑）——两种的处置完全不同，别混成一句。
      if [ -n "$holder" ]; then
        echo "端口 $port（$what）被席位 $holder 的进程 $pid 占着，不是这个席位（$SEAT_ID）：" >&2
        ps -o pid,user:32,cmd -p "$pid" >&2 || true
        echo "部署前那一轮端口回收之后它才起来的，或者这个脚本是手工跑的（没走管家那一层）。" >&2
        echo "从管家重新部署一次即可——回收会先把这个口要回来。" >&2
      else
        echo "端口 $port（$what）被 ${owner:-?} 的进程 $pid 占着，它不是任何一个 satuwork 席位：" >&2
        ps -o pid,user:32,cmd -p "$pid" >&2 || true
        echo "这台机器上有别的 VNC/桌面在跑。确认无用后停掉它再重新部署——" >&2
        echo "不停的话「打开桌面」进的是那一套，口令永远对不上。" >&2
      fi
      exit 43
    fi
    sleep 0.25
  done
  # **超时不算部署失败。** 端口空着只说明「还没起来」，说不清是坏了还是慢；而
  # systemd 的 Restart=on-failure 本来就会继续拉。部署失败会让整个席位不可用，
  # 把一次「起得慢」升级成「用不了」，比漏报贵得多。吼一声，让它继续。
  echo "$what 还没在端口 $port 上起来（等了 30 秒）；systemd 会继续拉起。" >&2
  echo "若一直不好：journalctl -u slim-desktop@$SEAT_ID" >&2
}
step 7 "等桌面起来"
verify_seat_listener "$RFB" x11vnc
verify_seat_listener "$HTTP" websockify
