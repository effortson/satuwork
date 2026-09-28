#!/bin/bash
# 拆掉一个席位。停单元、删 drop-in、删席位私有目录。
#
# **不删 Linux 账号，也不碰 $HOME_DIR/work**：同一个员工的别的席位还在用这个账号，
# 而 work/ 里是人的资料，不是这个席位的运行态。账号的回收是另一件事，要单独做。
#
# **这条脚本的成败只由一件事决定：那两个 systemd 单元还在不在。** 它们背后是一组
# 端口（3200+N / 6081+N）和一块屏，槽位能不能重新分出去看的就是它。删 drop-in、删
# 席位目录失败只是留下垃圾，不该把整次拆除判成失败——那些步骤都排在「单元已经停
# 掉」之后，一旦据此报错，Bot 已经聊不了了，而 Gateway 那边的删除每次都以同一个
# 理由失败：界面上于是挂着一颗既用不了也删不掉的 Bot。真发生过。
#
# 因此这里**不用 `set -e`**：每一步自己判，最后统一按「单元还活着吗」给退出码。
set -uo pipefail

: "${LINUX_USER:?}"
: "${SEAT_ID:?}"
: "${SEAT_DIR:?}"

BOT_UNIT="satuwork-bot@$SEAT_ID.service"
DESKTOP_UNIT="slim-desktop@$SEAT_ID.service"

warn() { echo "remove-seat: $*" >&2; }

# 停一个单元。**给它一个上限**：管家只等 120 秒，一个卡在 stopping 的单元能把这点
# 预算全吃掉，然后连「停下来没有」都来不及看。先好好停，停不动就 SIGKILL。
stop_unit() {
  local unit="$1"
  if timeout 30 systemctl disable --now "$unit" >/dev/null 2>&1; then return; fi
  warn "$unit 没在 30 秒内停下，改用 SIGKILL"
  systemctl kill -s KILL "$unit" >/dev/null 2>&1
  timeout 15 systemctl stop "$unit" >/dev/null 2>&1
  systemctl disable "$unit" >/dev/null 2>&1
}

stop_unit "$BOT_UNIT"
stop_unit "$DESKTOP_UNIT"

# ── 单元停了，进程未必死了 ────────────────────────────────────────────
# `slim-desktop@` 是 PAMName=login 起的：Xvfb / x11vnc / websockify 落在 logind 的
# session scope 里，而多屏部署又要求 logind 的 KillUserProcesses=no（否则停一块屏会
# 连坐同一个员工的其它屏）。两条加在一起 = 上面那个 stop_unit **够不着它们**，
# 连 `systemctl kill` 也够不着——它杀的是单元自己的 cgroup。
#
# 于是席位拆完，5910/6081 上还蹲着这个席位的 x11vnc 和 websockify，指着一个已经被
# rm 掉的 vnc-passwd（启动时就打开了，文件删掉照样服务）。Gateway 那边行一删，槽位
# 立刻分给下一个席位——下一次部署撞上同一个口，报「端口被别人占着」，而那个「别人」
# 正是刚拆掉的这个席位。真跑出来过：sw-…-7bbe43f21941 的 x11vnc 占着 5910。
#
# 按 XDG_RUNTIME_DIR 认领：它是 /tmp/xdg-runtime-$SEAT_ID，**逐席位唯一**，
# slim-desktop.sh 在起任何东西之前就 export 了，所有子进程都带着。命令行认不出来
# ——`Xvfb :10`、`websockify 127.0.0.1:6081` 里没有席位标识，而同一个员工的几块屏
# 还共用一个 Linux 账号，按用户杀会把别的屏一起带走。
seat_pids() {
  local pid
  for pid in /proc/[0-9]*; do
    pid="${pid##*/}"
    grep -qzFx "XDG_RUNTIME_DIR=/tmp/xdg-runtime-$SEAT_ID" "/proc/$pid/environ" 2>/dev/null || continue
    printf '%s\n' "$pid"
  done
}

# 这个席位的进程开在哪些显示号上。**杀之前问，杀完就问不出来了。**
seat_displays() {
  local pid
  for pid in $(seat_pids); do
    tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n 's/^DISPLAY=://p'
  done | sort -u
}

# X 的锁和 socket。**必须由这个脚本（root）来删。**
#
# slim-desktop.sh 里也有一句 `rm -f /tmp/.X$N-lock`，但那是**以席位用户**跑的：
# /tmp 带 sticky 位，删不掉别人建的文件，`rm -f` 连报错都被 `|| true` 吞了。于是下
# 一个拿到这个槽位的席位若属于另一个员工（另一个 Linux 账号），端口都清干净了，锁
# 还在——Xvfb 报「Server is already active for display N」起不来，桌面单元进重启循
# 环，而部署那边只留一句「30 秒还没起来」的告警，不算失败。**又是「装作成功」。**
#
# Xvfb 收到 TERM 通常会自己收拾这两个文件，但走到下面 SIGKILL 那一步就不会了。
drop_x_locks() {
  local d
  for d in "$@"; do
    case "$d" in
      *[!0-9]* | '') continue ;;
    esac
    rm -f "/tmp/.X$d-lock" "/tmp/.X11-unix/X$d" 2>/dev/null ||
      warn "显示 :$d 的锁没删掉，下一个用这个槽位的席位 Xvfb 会起不来"
  done
}

# 杀掉逃出去的进程，并把它们开在哪些显示号上留给 ESCAPEE_DISPLAYS——**不是 local**，
# 外面那句 drop_x_locks 要用。
ESCAPEE_DISPLAYS=""
kill_escapees() {
  local pids
  pids=$(seat_pids | tr '\n' ' ')
  [ -n "${pids// /}" ] || return 0
  ESCAPEE_DISPLAYS=$(seat_displays | tr '\n' ' ')
  warn "单元停了但还有进程活着（从 logind session 里逃掉的）：$pids"
  # 先 TERM：x11vnc / websockify 收到会自己关掉 socket 和 X 连接。5 秒不走再补刀。
  kill -TERM $pids 2>/dev/null
  for _ in $(seq 1 20); do
    [ -n "$(seat_pids)" ] || return 0
    sleep 0.25
  done
  pids=$(seat_pids | tr '\n' ' ')
  [ -n "${pids// /}" ] || return 0
  warn "还剩 $pids，改用 SIGKILL"
  kill -KILL $pids 2>/dev/null
  sleep 0.5
}
kill_escapees
# **清锁只做这一处。** kill_escapees 有好几条 return（TERM 就够时会提前回来），在
# 函数里清就得每条路上都写一遍，漏一条就是漏一次。显示号是它在进程还活着时取好放
# 进 ESCAPEE_DISPLAYS 的——杀完再问就问不出来了。
drop_x_locks ${ESCAPEE_DISPLAYS:-}

rm -rf "/etc/systemd/system/$BOT_UNIT.d" "/etc/systemd/system/$DESKTOP_UNIT.d" ||
  warn "drop-in 没删干净"
systemctl daemon-reload >/dev/null 2>&1 || warn "daemon-reload 失败"

# 目录里有会话日志，删之前确认路径确实长得像一个席位目录——这段是以 root 跑的。
# 不长得像就跳过：这是一道防手滑的闸，不是拆除失败。
#
# **以席位用户的身份删，不以 root 删。** 路径长对了不等于指对了：~/.satuwork 归席位
# 用户，他可以把它换成指向任意目录的链接，root 的 `rm -rf` 就会顺着删到别处去。检查
# 和删除之间换一次链接只要一个系统调用，所以不靠 `[ -L ]` 预检，而是让删除本身没有
# 越权的余地（同 deploy-seat.sh 的 as_user）。代价：老版本中途失败留下的 root 文件删
# 不掉，只是留下垃圾——按上面的约定，这不算拆除失败。
# 账号已经没了（手工 deluser 过）就没有能换链接的人，这时才由 root 删，且仍拒绝链接。
remove_seat_dir() {
  if id "$LINUX_USER" >/dev/null 2>&1; then
    runuser -u "$LINUX_USER" -- env -i -C / PATH=/usr/bin:/bin rm -rf "$SEAT_DIR"
  elif [ -L "/home/$LINUX_USER" ] || [ -L "/home/$LINUX_USER/.satuwork" ]; then
    warn "席位目录的上层是符号链接，跳过删除：$SEAT_DIR"
  else
    rm -rf "$SEAT_DIR"
  fi
}
case "$SEAT_DIR" in
  /home/"$LINUX_USER"/.satuwork/"$SEAT_ID") remove_seat_dir || warn "席位目录没删干净：$SEAT_DIR" ;;
  *) warn "席位目录 $SEAT_DIR 不在它该在的位置，跳过删除" ;;
esac
rm -rf "/tmp/xdg-runtime-$SEAT_ID" || warn "运行时目录没删干净"

# 退出码只答一个问题：端口还被这个席位占着吗。
#
# `is-active` 对 activating / deactivating 也回非零，那两种状态下进程还在、端口还
# 占着——所以按状态名判，不按退出码判。
#
# **逃出去的进程和单元同等看待。** 它们占的是同一组端口，而 Gateway 拿这个退出码
# 决定「这行能不能删、槽位能不能让出去」。单元停了但进程还在时报成功，等于把一个
# 还占着 5910 的席位从库里抹掉——下一个人的席位起不来，且没有任何地方说得出为什么。
rc=0
if [ -n "$(seat_pids)" ]; then
  warn "SIGKILL 之后仍有进程活着：$(seat_pids | tr '\n' ' ')"
  rc=1
fi
for unit in "$BOT_UNIT" "$DESKTOP_UNIT"; do
  state=$(systemctl is-active "$unit" 2>/dev/null)
  case "$state" in
    inactive | failed | unknown | '') ;;
    *)
      warn "$unit 还是 $state"
      rc=1
      ;;
  esac
done
exit "$rc"
