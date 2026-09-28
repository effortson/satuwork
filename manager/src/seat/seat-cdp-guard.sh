#!/bin/bash
# 席位 Chrome 的 CDP 口只许这个席位的 Linux 账号连。以 root 跑。
#
#   seat-cdp-guard.sh add <seatId> <linuxUser> <port>   装上（重复装是覆盖，不叠加）
#   seat-cdp-guard.sh del <seatId>                      拆掉这个席位名下的
#   seat-cdp-guard.sh purge                             全机拆干净（purge-machine.sh 用）
#
# **为什么要这一层。** Chrome 的 CDP 没有任何鉴权：谁连得上 127.0.0.1:<CDP> 谁就能
# 驱动那个浏览器——翻它的 cookie、在员工登过的 ERP 里点按钮、截图。「只听回环」挡得住
# 网上的人，挡不住**同一台机器上的另一个员工**：一台机器上跑着好几个员工的席位（一人
# 一个 Linux 账号），而每个员工的 Bot 都能执行 shell。A 的 Bot 一句
# `curl 127.0.0.1:9223/json` 就摸进了 B 的浏览器。
#
# **为什么是防火墙、不是换成管道。** `--remote-debugging-pipe` 要求拉起 Chrome 的那个
# 进程握着 fd 3/4，而席位上的 Chrome 有两个入口：Bot 拉的，和员工在 dock 上点开的——
# 两个用的是同一份 profile（那份 profile 就是这套工具存在的理由，见
# docs/browser-tools.md 第 1 节），同一份 profile 只能有一个实例。所以口还是 TCP 口，
# 只是按「谁在连」放行：本机发往 lo 上这个口的包，socket 不属于这个席位账号（也不是
# root）的，一律 RST。同一个员工的几个席位共用一个账号，互相连得上——那是同一个人，
# 本来就共享 work/，不算越界。
#
# **一个口一张表**（`inet satuwork_cdp_<port>`），不是一个席位一张：槽位会回收再分配，
# 键在口上的话，新席位装上的那一刻就把旧主人那条原子地顶掉了——哪怕旧席位没走
# remove-seat.sh（机器失联、手工删的）也不会留下一条「这个口只许早就不在的那个 uid
# 连」的规则，把新主人自己的 Bot 挡在门外。表里那条规则带着 `seat=<id>` 的注释，del
# 按它认领，不看端口：拆席位的时候 desktop.env 可能已经没了。
#
# 表不落盘：nft 的规则重启就没了。所以装的时机有两处——部署时（deploy-seat.sh，装不
# 上就让部署失败），以及两个席位单元每次启动前（drop-in 里的 `ExecStartPre=+`，开机
# 后第一次起屏就会补上）。两处都走这一个入口，参数都来自 root 写的 drop-in，**不读**
# 席位用户自己写得动的 desktop.env：不然改一行 CDP= 就能让 root 把别人的口判给自己。
set -euo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

TABLE_PREFIX=satuwork_cdp_

die() { echo "seat-cdp-guard: $*" >&2; exit 1; }

command -v nft >/dev/null 2>&1 || die "没有 nft（nftables 没装），CDP 口隔离装不上"

# 本机上所有 satuwork_cdp_* 表的名字。
our_tables() {
  nft list tables inet 2>/dev/null | sed -n "s/^table inet \(${TABLE_PREFIX}[0-9]*\)$/\1/p" || true
}

cmd="${1:-}"
case "$cmd" in
  add)
    seat="${2:-}" user="${3:-}" port="${4:-}"
    case "$seat" in *[!A-Za-z0-9_-]* | '') die "bad seatId" ;; esac
    case "$user" in *[!A-Za-z0-9_-]* | '') die "bad linuxUser" ;; esac
    case "$port" in *[!0-9]* | '') die "bad port" ;; esac
    [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || die "port $port 不在 1024-65535"
    uid="$(id -u "$user" 2>/dev/null)" || die "没有 $user 这个账号"
    # root 的席位不存在（deploy-seat.sh 不会建），真碰上了就是参数错了——放行 root 等于没装。
    [ "$uid" != 0 ] || die "$user 是 root"
    t="${TABLE_PREFIX}${port}"
    # 先建空表再删、再整张重建，三句在同一个事务里：已有就原样替换，没有也不报错，
    # 中间不存在「旧的删了、新的还没上」的空档。
    nft -f - << EOF_NFT
table inet $t
delete table inet $t
table inet $t {
  chain output {
    type filter hook output priority 0; policy accept;
    oif "lo" tcp dport $port meta skuid != { 0, $uid } reject with tcp reset comment "seat=$seat"
  }
}
EOF_NFT
    ;;
  del)
    seat="${2:-}"
    case "$seat" in *[!A-Za-z0-9_-]* | '') die "bad seatId" ;; esac
    for t in $(our_tables); do
      if nft list table inet "$t" 2>/dev/null | grep -qF "\"seat=$seat\""; then
        nft delete table inet "$t"
      fi
    done
    ;;
  purge)
    for t in $(our_tables); do
      nft delete table inet "$t" || true
    done
    ;;
  *)
    die "usage: seat-cdp-guard.sh add <seatId> <linuxUser> <port> | del <seatId> | purge"
    ;;
esac
