#!/bin/bash
# 铺一个席位在 ~/work 底下的那一格。由 deploy-seat.sh 以**席位用户**的身份调用（as_user），
# 单独成文件是为了能在 e2e 里直接跑（e2e/seat-workdir.mjs）——它碰的是员工的文件。
#
#   seat-workdir.sh <WORK_DIR> <SEAT_ID> <BOT_ID> [BOT_NAME]
#
#   $WORK_DIR/shared                 共享区，同一员工的所有席位都看得见
#   $WORK_DIR/bots/$SEAT_ID          这个席位的工作区（Bot 的 SATUWORK_WORK_DIR）
#   $WORK_DIR/bots/$SEAT_ID/shared   -> ../../shared
#   $WORK_DIR/bots/$SEAT_ID/.bot-name  名牌：这一格是哪颗 Bot 的
#
# **$WORK_DIR 根下别的东西一概不碰。** 那是分格之前的老文件，原地留着：还没重铺的席位照旧往
# 那儿写，Bot 按老路径读写时落回那里（bot 的 workspace.legacyOf）。以前试过部署时把它们收进
# shared/，结果是把还在跑的老席位脚下的文件挪走、两个席位并发部署时互相抢着挪。
set -euo pipefail

work="${1:?usage: seat-workdir.sh <WORK_DIR> <SEAT_ID> <BOT_ID> [BOT_NAME]}"
seat="${2:?}"
bot_id="${3:?}"
bot_name="${4:-}"
case "$seat" in
  *[!A-Za-z0-9_-]* | '') echo "seat-workdir: bad SEAT_ID" >&2; exit 1 ;;
esac

mkdir -p "$work/shared" "$work/bots/$seat"

# 通向共享区的链接。相对路径：家目录挪了位置也不断。那个名字上已经有别的东西（人自己建了个
# shared 目录）就不替换，只报一句——不替人删东西。
link="$work/bots/$seat/shared"
if [ -L "$link" ] || [ ! -e "$link" ]; then
  ln -sfn ../../shared "$link"
else
  echo "seat-workdir: 席位工作区里的 shared 不是链接，没有替换：$link" >&2
fi

# 名牌。目录名是 seatId（账号前缀 + botId 的散列），人在桌面上认不出哪一格是哪颗 Bot，Bot 删了
# 之后格子还留着（拆席位不碰 ~/work）就更认不出。隐藏文件：不进 Bot 自己的列目录和搜索。
# 名字里的控制字符剔掉——它要占一行，换行会把 botId 那行挤乱。先写临时文件再换名，半截不留。
nameplate="$work/bots/$seat/.bot-name"
clean_name=$(printf '%s' "$bot_name" | tr -d '\000-\037\177')
{
  [ -n "$clean_name" ] && printf '%s\n' "$clean_name"
  printf 'botId: %s\n' "$bot_id"
} > "$nameplate.tmp"
mv -f "$nameplate.tmp" "$nameplate"
