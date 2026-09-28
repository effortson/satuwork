#!/bin/bash
# satuwork-bot@<seatId>.service 的入口。
#
# 存在的理由：bot 代码按席位各装一份（路径逐席位不同），而 ExecStart 是列表型设置，
# drop-in 覆盖它要先写一行空的 `ExecStart=` 再重设，容易写错也难看。让单元固定指向
# 这个脚本，路径由席位号推出来。
set -euo pipefail
SEAT_ID="${1:-}"
case "$SEAT_ID" in
  *[!A-Za-z0-9_-]* | '') echo "bad seat id: '$SEAT_ID'" >&2; exit 1 ;;
esac
: "${SEAT_DIR:?SEAT_DIR unset - check /etc/systemd/system/satuwork-bot@${SEAT_ID}.service.d/seat.conf}"
# 代码在 root 的目录里，**不在** $SEAT_DIR：那里归席位用户，bot 起的任何子进程都改得动，
# 改完 kill 一下 bot，重启跑的就是改过的代码，还照样从 fd 0 读到凭据（见 deploy-seat.sh
# step 5）。老部署的 $SEAT_DIR/app 不再认——宁可起不来，也不跑一份谁都能改的代码。
APP="/opt/satuwork/seats/$SEAT_ID/app"
if [ ! -f "$APP/bin/satuwork.mjs" ]; then
  echo "no bot code for seat $SEAT_ID at $APP（老版本部署的席位要重新部署一次）" >&2
  exit 1
fi
if [ "$(stat -c %u "$APP")" != 0 ] || [ -n "$(find "$APP" -maxdepth 0 -perm /022)" ]; then
  echo "refusing: $APP 不是 root 独占可写的，重新部署这个席位" >&2
  exit 1
fi
# 席位的 XDG_RUNTIME_DIR（bot.env 里那一行）：systemd 以 root 建、归本席位账号、0700
# （drop-in 里的 RuntimeDirectory=）。不对就不起——bot 拉起的 Chrome 会把 socket 放进去，
# 放进一个别人建的目录等于把浏览器交出去。见 slim-desktop.sh 里同一段。
RUN_DIR="/run/satuwork/$SEAT_ID"
if [ -L "$RUN_DIR" ] || [ ! -d "$RUN_DIR" ] || [ "$(stat -c %u:%a "$RUN_DIR")" != "$(id -u):700" ]; then
  echo "refusing: 运行时目录 $RUN_DIR 不在、不归 $(id -un) 或不是 0700（老部署的席位要重新部署一次）" >&2
  exit 1
fi
cd "$APP"
# tsx 默认把编译好的 .ts 缓存在 $TMPDIR/tsx-<uid>/，那个目录归席位用户——往里放一份
# 伪造的缓存，和改 app 里的源码是一回事。关掉缓存，每次启动现编（多一两秒）。
export TSX_DISABLE_CACHE=1
# 关掉 SIGUSR1 开 inspector 那条路：同 uid 的子进程 `kill -USR1 $PPID` 一下，Node 就在
# 127.0.0.1:9229 上开调试口，连上去就能读 bot 内存里的席位凭据——绕过 ptrace_scope。
# Node 22.14 / 23.7 起才有这个开关；老 Node 上加它会直接起不来，所以先探一下。
NODE_FLAGS=()
if /usr/bin/node --disable-sigusr1 -e '' </dev/null >/dev/null 2>&1; then
  NODE_FLAGS+=(--disable-sigusr1)
else
  echo "satuwork-bot: 这版 Node 没有 --disable-sigusr1，SIGUSR1 仍能打开 inspector；升级到 Node 24" >&2
fi
exec /usr/bin/node "${NODE_FLAGS[@]}" --import tsx "$APP/bin/satuwork.mjs"
