#!/bin/bash
# 把一台席位机器还原成装机之前的样子：停单元、删文件、（可选）删席位账号和系统包。
#
# **正路不是这个脚本。** 平台上「移除机器」会让管家自己收拾（src/standdown.ts）：先拆
# 席位，再清配对状态，最后 disable 自己。那条路是在线的、有回执的。这份脚本是给收拾不
# 掉的场合用的——机器已经失联、管家起不来、或者这台机器要还给别人。
#
# **输出是英文。** 和装机脚本（gateway/src/install.ts）同一个理由：它跑在那台机器的终端
# 上，locale 可能是 C，中文会变成一屏乱码，而出问题时这是唯一能看的东西。注释仍然是
# 中文——注释不会打到那个终端上。
#
# ── 默认删什么 ────────────────────────────────────────────────────────
# 默认只删 satuwork 自己放上去的东西：管家、席位单元、席位私有目录、发布包缓存。
# 三样「装机时顺带装上、但不只 satuwork 在用」的东西要单独点头：
#
#   --accounts   删席位 Linux 账号（只认 sw-<12 hex>，见「清点」），连 /home/<user>/work 一起
#                work/ 是**人的资料**，不是这个席位的运行态——remove-seat.sh 一直刻意不碰它
#   --packages   apt purge 桌面栈和浏览器
#   --node       apt purge nodejs 和 nodesource 源；这台机器上别的东西很可能也在用 Node
#
# 三样都不给的话，跑完这个脚本机器上还剩：账号、work/、系统包。那是安全的默认值。
set -Eeuo pipefail

# -E（errtrace）不能省，理由同 deploy-seat.sh：不加的话下面这条 ERR trap 进不了函数。
trap 'rc=$?; echo "purge-machine.sh failed at line $LINENO (exit $rc)" >&2; exit $rc' ERR

# **PATH 写死。** `sudo` 不带 `-i`、`su` 不带 `-` 时拿到的是普通用户的 PATH，里面没有
# sbin，于是 deluser / userdel 报 "command not found"——这一步失败在删账号那一段，
# 而那时前面的东西已经删掉了，人会以为是脚本坏了。
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# 路径可以整体挪走，理由同 config.ts：测试要在 /tmp 里跑，不碰真的 /etc 和 /opt。
ETC_DIR="${SATUWORK_MANAGER_HOME:-/etc/satuwork}"
MANAGER_ROOT="${SATUWORK_MANAGER_ROOT:-/opt/satuwork/manager}"
RELEASE_ROOT="${SATUWORK_RELEASE_ROOT:-/opt/satuwork/releases}"

DRY=0
ASSUME_YES=0
DO_ACCOUNTS=0
DO_PACKAGES=0
DO_NODE=0

usage() {
  cat >&2 << 'EOF_USAGE'
Usage: purge-machine.sh [options]

Restores a Satuwork seat machine to its pre-install state. Run as root.

  -n, --dry-run    Print every step without touching anything
  -y, --yes        Skip the confirmation prompt (required when piped)
      --accounts   Also delete the seat Linux accounts AND their home
                   directories, including /home/<user>/work (people's files).
                   Only accounts named sw-<12 hex> with home /home/<name>;
                   anything else is listed as skipped and left alone
      --packages   Also apt purge the desktop stack and the browser
      --node       Also apt purge nodejs and the NodeSource apt source
      --all        --accounts --packages --node
  -h, --help       This text

Without --accounts/--packages/--node the accounts, their work directories and
the system packages stay. That is the safe default.
EOF_USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --accounts) DO_ACCOUNTS=1; shift ;;
    --packages) DO_PACKAGES=1; shift ;;
    --node) DO_NODE=1; shift ;;
    --all) DO_ACCOUNTS=1; DO_PACKAGES=1; DO_NODE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [ "$DRY" != 1 ] && [ "$(id -u)" != 0 ]; then
  echo "must run as root (prefix with sudo)" >&2
  exit 1
fi

# ── 先把自己搬出去 ────────────────────────────────────────────────────
# 这个脚本随管家的发布包走，所以它很可能正躺在 $MANAGER_ROOT/current/src/seat/ 下面,
# 而下面有一步是 rm -rf "$MANAGER_ROOT"。Linux 上 unlink 之后已打开的 fd 还能读完，
# 多半不会出事——但赌注是一台正在被擦干净的机器，代价不对等。拷一份出来跑。
SELF="$(readlink -f "$0")"
case "$SELF" in
  "$MANAGER_ROOT"/*)
    if [ "${SATUWORK_PURGE_REEXEC:-}" != 1 ]; then
      COPY="$(mktemp /tmp/satuwork-purge.XXXXXX)"
      cp "$SELF" "$COPY"
      chmod 755 "$COPY"
      SATUWORK_PURGE_REEXEC=1 exec "$COPY" "$@"
    fi
    ;;
esac
if [ "${SATUWORK_PURGE_REEXEC:-}" = 1 ]; then
  trap 'rm -f "$SELF"' EXIT
fi

# ── 清点 ──────────────────────────────────────────────────────────────
# **形状先于来源。** 席位账号和席位号都是 Gateway 按固定式子算出来的
# （gateway/src/deploy.ts 的 linuxUserOf / seatIdOf）：
#
#   账号    sw-<sha256(accountId) 前 12 hex>
#   席位号  <账号>-<sha256(botId) 前 12 hex>
#
# 这里**只认这两种形状**，别的一律不碰。以前的认法是「/home 下谁有 ~/.satuwork 谁就是
# 席位账号」——可 ~/.satuwork 也是 bot 本地跑时的默认家目录（bot/src/home.ts），一个
# 在自己账号下跑过 bot 的运维，/home/alice/.satuwork/sessions 就被当成了席位目录 rm -rf，
# 加 --accounts 时连 alice 这个人都会被 pkill + deluser --remove-home。脚本是 root 跑的。
#
# 老机器上可能还有 `bot-xxxxxxxx` 形状的旧账号（改成 sw- 之前按 (account, bot) 建的）。
# 它们**也不在这里删**：那个前缀不够特别，认错一个的代价是删掉一个人。要清就手工清。
SEAT_USER_RE='^sw-[0-9a-f]{12}$'
SEAT_ID_RE='^sw-[0-9a-f]{12}-[0-9a-f]{12}$'

# 被拒掉的候选，最后原样报出来：**跳过要跳得响**，不然人会以为那台机器已经清干净了。
SKIPPED=""
skip() {
  SKIPPED="$SKIPPED$1"$'\n'
}

# 席位号的候选从三个地方找，取并集。**任何一处都可能是残缺的**：seats.json 可能已经被删
# 了，单元可能已经 disable 了，席位目录可能被手工删过。少认出一个席位的后果是留下一个
# 还在跑的 x11vnc 占着端口，而下一次装机时那正是最难查的一种故障。
#
# 前两处是管家自己写的（名册、它建的单元和 drop-in）。第三处是磁盘，**只看席位账号的家**：
# /home/sw-<12hex>/.satuwork 下面、名字又恰好以这个账号开头的目录。别人家里的 .satuwork
# 从来不进这张单子。
seat_id_candidates() {
  local d b u
  if [ -f "$ETC_DIR/seats.json" ]; then
    sed -n 's/.*"seatId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ETC_DIR/seats.json" || true
  fi
  systemctl list-units --all --plain --no-legend 'satuwork-bot@*.service' 'slim-desktop@*.service' 2>/dev/null \
    | awk '{print $1}' | sed -e 's/^[^@]*@//' -e 's/\.service$//' || true
  for d in /etc/systemd/system/satuwork-bot@*.service.d /etc/systemd/system/slim-desktop@*.service.d; do
    [ -d "$d" ] || continue
    b="${d##*/}"; b="${b%.service.d}"
    printf '%s\n' "${b#*@}"
  done
  for d in /home/sw-*/.satuwork/sw-*; do
    [ -d "$d" ] || continue
    u="${d%/.satuwork/*}"; u="${u##*/}"
    b="${d##*/}"
    # 目录名得是「这个账号自己的」席位号：/home/sw-A/.satuwork/sw-B-… 不认。
    case "$b" in "$u"-*) printf '%s\n' "$b" ;; esac
  done
}

# 账号的候选：名册里记着的 linuxUser、每个席位号的前缀（账号就是它），加上 /home 下
# 本身就是席位形状、且有 .satuwork 的家目录。
seat_user_candidates() {
  local d u
  if [ -f "$ETC_DIR/seats.json" ]; then
    sed -n 's/.*"linuxUser"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ETC_DIR/seats.json" || true
  fi
  for u in $SEATS; do
    printf '%s\n' "${u%-*}"
  done
  for d in /home/*/.satuwork; do
    [ -d "$d" ] || continue
    u="${d%/.satuwork}"
    printf '%s\n' "${u##*/}"
  done
}

# 过形状：认的留下，不认的记进 SKIPPED。下面这些值会变成 rm -rf、pkill -u 和 deluser 的
# 参数，而脚本是以 root 跑的。
SEATS=""
while IFS= read -r c; do
  [ -n "$c" ] || continue
  if printf '%s\n' "$c" | grep -Eq "$SEAT_ID_RE"; then
    SEATS="$SEATS$c"$'\n'
  else
    skip "seat id '$c' (not of the form sw-<12hex>-<12hex>)"
  fi
done < <(seat_id_candidates | sort -u)
SEATS="$(printf '%s' "$SEATS" | sort -u)"

USERS=""
while IFS= read -r c; do
  [ -n "$c" ] || continue
  if ! printf '%s\n' "$c" | grep -Eq "$SEAT_USER_RE"; then
    skip "account '$c' (not of the form sw-<12hex>; /home/$c/.satuwork is left alone)"
    continue
  fi
  # 形状对了还要**家也对**：席位账号是 deploy-seat.sh 用 adduser 建的，家一定是 /home/<名>。
  # 对不上说明这个名字不是我们建的（或者被人改过），deluser --remove-home 会删到别处去。
  if id "$c" >/dev/null 2>&1; then
    home="$(getent passwd "$c" | cut -d: -f6)"
    if [ "$home" != "/home/$c" ]; then
      skip "account '$c' (home is '$home', not /home/$c)"
      continue
    fi
  fi
  USERS="$USERS$c"$'\n'
done < <(seat_user_candidates | sort -u)
USERS="$(printf '%s' "$USERS" | sort -u)"

seat_dir_of() {
  # 席位目录只有一个可能的位置：/home/<席位号的账号前缀>/.satuwork/<席位号>。
  # 不再 glob /home/*——那正是把别人家当成席位的来路。
  local seat="$1" d
  d="/home/${seat%-*}/.satuwork/$seat"
  [ -d "$d" ] && printf '%s\n' "$d"
  return 0
}

DESKTOP_PKGS="xvfb dbus-x11 x11-xserver-utils xfwm4 thunar xfce4-terminal plank picom hsetroot x11vnc novnc python3-websockify google-chrome-stable chromium chromium-browser"

# ── 说清楚要干什么 ────────────────────────────────────────────────────
echo "Satuwork machine purge"
echo
echo "  manager:   satuwork-manager.service, satuwork-manager-confirm.{service,timer}"
echo "  config:    $ETC_DIR (machine identity, pairing token, seat roster)"
echo "  installs:  $MANAGER_ROOT, $RELEASE_ROOT"
if [ -n "$SEATS" ]; then
  echo "  seats:     $(echo $SEATS)"
else
  echo "  seats:     (none found)"
fi
if [ "$DO_ACCOUNTS" = 1 ]; then
  echo "  accounts:  DELETE $(echo ${USERS:-none}) with their home dirs, INCLUDING work/"
else
  echo "  accounts:  keep $(echo ${USERS:-none}) (pass --accounts to delete them and their work/)"
fi
if [ -n "$SKIPPED" ]; then
  echo "  skipped:   not recognised as Satuwork seats, will NOT be touched:"
  printf '%s' "$SKIPPED" | sed 's/^/               /'
fi
if [ "$DO_PACKAGES" = 1 ]; then
  echo "  packages:  apt purge the desktop stack and the browser, then autoremove"
fi
if [ "$DO_NODE" = 1 ]; then
  echo "  node:      apt purge nodejs and drop the NodeSource apt source"
fi
echo

if [ "$DRY" = 1 ]; then
  echo "(dry run: nothing will be changed)"
  # 非 root 的空盘点是**假的**：seats.json 是 0600，读不到就一个席位都认不出来，
  # 而输出长得和「这台机器很干净」一模一样。说破它，别让人照着这份清单下判断。
  if [ "$(id -u)" != 0 ]; then
    echo "(not root: $ETC_DIR is unreadable, so this list is probably incomplete)"
  fi
  echo
elif [ "$ASSUME_YES" != 1 ]; then
  # **从 /dev/tty 读，不从 stdin。** 这个脚本很可能是 `curl ... | bash` 下来的，那时
  # stdin 是脚本自己；从 stdin 读会吃掉脚本剩下的部分。没有 tty 就让它失败，人加 --yes。
  printf 'Type PURGE to continue: '
  answer=""
  read -r answer < /dev/tty || true
  if [ "$answer" != "PURGE" ]; then
    echo "aborted (use --yes for a non-interactive run)" >&2
    exit 1
  fi
  echo
fi

act() {
  if [ "$DRY" = 1 ]; then
    printf '    would run: %s\n' "$*"
    return 0
  fi
  printf '    %s\n' "$*"
  "$@"
}

# ── 1. 先停管家 ───────────────────────────────────────────────────────
# **顺序不能反。** 管家是 Restart=always，confirm.timer 每 120 秒还会试着把它拉回来。
# 先删文件后停服务的话，会看到「删了又回来」，而且管家可能正好在中途重新部署一个席位。
echo "==> Stopping the manager"
act systemctl disable --now satuwork-manager.service 2>/dev/null || true
act systemctl disable --now satuwork-manager-confirm.timer 2>/dev/null || true
act systemctl disable --now satuwork-manager-confirm.service 2>/dev/null || true

# ── 2. 席位单元 ───────────────────────────────────────────────────────
echo "==> Stopping seats"
for seat in $SEATS; do
  act systemctl disable --now "satuwork-bot@$seat.service" 2>/dev/null || true
  act systemctl disable --now "slim-desktop@$seat.service" 2>/dev/null || true
  act rm -rf "/etc/systemd/system/satuwork-bot@$seat.service.d" \
    "/etc/systemd/system/slim-desktop@$seat.service.d"
done
act rm -f /etc/systemd/system/satuwork-manager.service \
  /etc/systemd/system/satuwork-manager-confirm.service \
  /etc/systemd/system/satuwork-manager-confirm.timer \
  /etc/systemd/system/slim-desktop@.service \
  /etc/systemd/system/satuwork-bot@.service
act systemctl daemon-reload || true
act systemctl reset-failed || true

# ── 3. logind 留下的活口 ──────────────────────────────────────────────
# 桌面单元是 PAMName=login 起的，进程落进 logind 的 session scope；而多屏部署要求
# KillUserProcesses=no（不然停一块屏会连坐同一员工的其它屏）。两条加起来的后果是
# `systemctl stop` **杀不到 Xvfb / x11vnc / websockify**——slim-desktop.sh 里那段
# kill_stale 正是为这个存在的。这里不清的话，端口一直被占着，下一次装机撞上它。
echo "==> Killing leftover seat processes"
for u in $USERS; do
  if id "$u" >/dev/null 2>&1; then
    act pkill -KILL -u "$u" -f 'Xvfb|x11vnc|websockify|satuwork|plank|picom|xfwm4' || true
  fi
done

# ── 4. 席位落盘 ───────────────────────────────────────────────────────
echo "==> Removing seat files"
act rm -f /usr/local/bin/slim-desktop.sh /usr/local/bin/satuwork-bot.sh \
  /usr/local/bin/satuwork-manager-confirm.sh
for seat in $SEATS; do
  for dir in $(seat_dir_of "$seat"); do
    act rm -rf "$dir"
  done
  act rm -rf "/tmp/xdg-runtime-$seat"
  # bot 单元读的 bot.env 和凭据固定放在 /etc/satuwork/seats 下（不跟 SATUWORK_MANAGER_HOME
  # 走），单独删。
  act rm -rf "/etc/satuwork/seats/$seat"
done
if [ -d /etc/satuwork/seats ]; then act rmdir /etc/satuwork/seats 2>/dev/null || true; fi
# deploy-seat.sh 的 ensure_ptrace_scope 留下的持久化配置。只删文件、不把当前内核值调回去：
# 那是更安全的一侧，调低要管理员自己决定。
act rm -f /etc/sysctl.d/60-satuwork-ptrace.conf
# X 的锁和 socket 没带席位号，只能按属主认。按属主认也顺手保住了这台机器上**别人的**
# 那套 VNC——deploy-seat.sh 的 verify_seat_listener 就撞见过一套。
for f in /tmp/.X*-lock /tmp/.X11-unix/X*; do
  [ -e "$f" ] || continue
  owner="$(stat -c %U "$f" 2>/dev/null || echo '')"
  for u in $USERS; do
    if [ "$owner" = "$u" ]; then act rm -f "$f"; break; fi
  done
done
# CDP 口的 nft 表（seat-cdp-guard.sh 装的，一个口一张 satuwork_cdp_<port>）。不拆的话
# 这台机器上以后谁再用 9222+N 这几个口，除了早就不在的那个席位账号谁都连不上。
# 这里不调 seat-cdp-guard.sh：它可能已经被上面删掉了，也可能是装机太早压根没有。
if command -v nft >/dev/null 2>&1; then
  for t in $(nft list tables inet 2>/dev/null | sed -n 's/^table inet \(satuwork_cdp_[0-9]*\)$/\1/p' || true); do
    act nft delete table inet "$t" || true
  done
fi
act rm -f /usr/local/bin/seat-cdp-guard.sh

# ── 5. 管家落盘 ───────────────────────────────────────────────────────
# manager.json 是**机器身份**（machineId、smt_ 票、Gateway 公钥）。删掉就等于解绑，
# 想再上线必须回 Gateway 生成新配对码重装。
echo "==> Removing manager files"
act rm -rf "$ETC_DIR" "$MANAGER_ROOT" "$RELEASE_ROOT"
if [ "$DRY" != 1 ]; then
  rmdir /opt/satuwork 2>/dev/null || true
fi

# ── 6. 账号（要点头）────────────────────────────────────────────────
if [ "$DO_ACCOUNTS" = 1 ]; then
  echo "==> Deleting seat accounts"
  for u in $USERS; do
    if ! id "$u" >/dev/null 2>&1; then continue; fi
    # 账号下还有活着的进程时 deluser 会拒绝（"user is currently used by process"）。
    act pkill -KILL -u "$u" || true
    # 建账号用的是 adduser，删就用它对称的那一半：deluser 会连同名的组一起收掉。
    # 没有 deluser 的系统回落到 userdel -r。
    if command -v deluser >/dev/null 2>&1; then
      act deluser --remove-home "$u" || echo "    could not delete $u; do it by hand" >&2
    else
      act userdel -r "$u" || echo "    could not delete $u; do it by hand" >&2
    fi
  done
fi

# ── 7. 系统包（要点头）──────────────────────────────────────────────
if [ "$DO_PACKAGES" = 1 ]; then
  echo "==> Purging the desktop stack"
  # procps / iproute2 / curl / gnupg / ca-certificates 也是装机时装的，但**不在这张单子上**：
  # 它们是别的东西的地基，purge 掉会把这台机器弄坏，而省下的那点空间毫无意义。
  # xorg 同理不在单子上——它是元包，机器上可能还有别的图形界面靠它。
  act apt-get purge -y $DESKTOP_PKGS || true
  act rm -f /etc/apt/sources.list.d/google-chrome.list /usr/share/keyrings/google-chrome.gpg
  # autoremove 可能会带走别的东西：它删的是「没人依赖了」的包，而这台机器上装过什么
  # 只有它自己知道。所以先说一声。
  echo "    autoremove may take unrelated packages with it"
  act apt-get autoremove -y || true
fi

if [ "$DO_NODE" = 1 ]; then
  echo "==> Purging Node"
  act apt-get purge -y nodejs || true
  act rm -f /etc/apt/sources.list.d/nodesource.list /etc/apt/sources.list.d/nodesource.sources \
    /usr/share/keyrings/nodesource.gpg
  # /usr/bin/node 有两种来源：nodejs 这个 deb（purge 会带走），或者机器上本来就有别处
  # 装的 Node、装机脚本 ln -sf 过来的。**只删符号链接**——删掉真文件等于卸了别人的 Node。
  if [ -L /usr/bin/node ]; then act rm -f /usr/bin/node; fi
fi

if [ "$DO_PACKAGES" = 1 ] || [ "$DO_NODE" = 1 ]; then
  act apt-get update -y || true
fi

echo
if [ "$DRY" = 1 ]; then
  echo "Dry run finished. Nothing was changed."
else
  echo "Done."
fi
echo
echo "Not handled here:"
echo "  - The Gateway still has a record for this machine. Remove it in the console,"
echo "    otherwise it just shows up as unreachable forever."
echo "  - The timezone. Install set it from the Gateway's heartbeat; reset it with"
echo "    'timedatectl set-timezone <zone>' if you care."
if [ "$DO_ACCOUNTS" != 1 ]; then
  echo "  - Seat accounts and /home/<user>/work are still there (--accounts removes them)."
fi
if [ "$DO_PACKAGES" != 1 ]; then
  echo "  - The desktop stack and the browser are still installed (--packages removes them)."
fi
if [ "$DO_NODE" != 1 ]; then
  echo "  - Node is still installed (--node removes it)."
fi
