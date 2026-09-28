#!/bin/bash
# satuwork-bot@<seatId>.service 的入口。
#
# 存在的理由只有一个：bot 代码装在席位私有目录里（路径逐席位不同），而 ExecStart 是
# 列表型设置，drop-in 覆盖它要先写一行空的 `ExecStart=` 再重设，容易写错也难看。
# 让单元固定指向这个脚本，路径的事交给 $SEAT_DIR。
set -euo pipefail
SEAT_ID="${1:-}"
: "${SEAT_DIR:?SEAT_DIR unset - check /etc/systemd/system/satuwork-bot@${SEAT_ID}.service.d/seat.conf}"
APP="$SEAT_DIR/app"
if [ ! -f "$APP/bin/satuwork.mjs" ]; then
  echo "no bot code for seat $SEAT_ID at $APP" >&2
  exit 1
fi
cd "$APP"
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
