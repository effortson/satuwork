#!/bin/bash
# 一个席位的桌面栈：Xvfb + xfwm4 + picom + plank + x11vnc + websockify。
#
# 一个员工只有一个 Linux 账号，但可以有多个席位（多个 bot），所以**凡是会重名的
# 东西都必须按席位分开**，而不是按用户名——否则同一个员工的两块屏会抢同一个
# XDG_RUNTIME_DIR、同一份 Chrome profile、同一份 plank 配置。分法是把 XDG 三件套
# 整体指进席位目录：plank、dconf、picom、.desktop 全都跟着走，不用逐个改。
#
# 共享的只有 $HOME/work——同一员工的所有席位都看得见，这是「bot 之间共享资料」的
# 唯一入口。$HOME 下别的东西都不该被两个席位同时写。
set -euo pipefail
SEAT_ID="${1:-}"
[ -n "$SEAT_ID" ] || { echo "usage: slim-desktop.sh <seatId>" >&2; exit 1; }
: "${SEAT_DIR:?SEAT_DIR unset - check /etc/systemd/system/slim-desktop@${SEAT_ID}.service.d/seat.conf}"
: "${HOME:?HOME unset - same drop-in}"

ENV_FILE="$SEAT_DIR/desktop.env"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
DISPLAY_NUM="${DISPLAY_NUM:-10}"
RFB="${RFB:-5910}"
HTTP="${HTTP:-6081}"
CDP="${CDP:-9222}"
# 共享工作区。**这是这块屏上一切的默认落点**：文件管理器和终端都从这里开始，
# 因为同一个员工名下所有 bot 的产物都堆在这儿，而 $HOME 下别的东西是逐席位私有的，
# 开在 $HOME 等于把人放在一堆 .satuwork/、.cache/ 中间，还得自己找路进 work。
WORK_DIR="${WORK_DIR:-$HOME/work}"

export DISPLAY=":${DISPLAY_NUM}"
unset WAYLAND_DISPLAY
export XDG_SESSION_TYPE=x11
export GDK_BACKEND=x11
# logind（PAMName=login）会把 XDG_RUNTIME_DIR 设成 /run/user/<uid>，那是**按 uid**
# 的，同一员工的两块屏会撞在一起。改成按席位。
export XDG_RUNTIME_DIR="/tmp/xdg-runtime-${SEAT_ID}"
export XDG_CONFIG_HOME="$SEAT_DIR/config"
export XDG_DATA_HOME="$SEAT_DIR/share"
export XDG_CACHE_HOME="$SEAT_DIR/cache"
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME/picom" "$XDG_CONFIG_HOME/plank/dock1/launchers" \
  "$XDG_DATA_HOME/applications" "$XDG_CACHE_HOME" "$SEAT_DIR/bin" "$SEAT_DIR/chrome"
chmod 700 "$XDG_RUNTIME_DIR" || true

# ── 清掉上一轮的残留 ────────────────────────────────────────────────
# **这一段不能省。** 本单元是 PAMName=login 起的，Xvfb / x11vnc / websockify 会落进
# logind 的 session scope；而多屏部署要求 logind 的 KillUserProcesses=no（不然停一块屏
# 会连坐同一个员工的其它屏）。两条加在一起的后果是：`systemctl stop` 杀不到它们。
#
# 于是重启这个单元时，:10 和 5910 还被上一轮占着，Xvfb 起不来，脚本在下面那个
# xdpyinfo 循环里 exit 1，systemd 按 Restart=on-failure 反复重试——而**旧的那套进程一直
# 好好地在服务**。表面上「重新部署成功了」，实际什么都没换：新写进 vnc-passwd 的口令
# 没人读，x11vnc 内存里还是上一轮的那个。照着界面输口令永远是 password check failed，
# 而且重新部署多少次都一样。
#
# 只清**自己这一轮**留下的：按 display 和端口找，它们是逐席位唯一分配的。
# 按端口找持有者，不要去猜命令行长什么样——同一个东西可以写成 127.0.0.1:6081 也可以
# 写成 0.0.0.0:6081，按模式匹配会漏，而漏掉的后果见下面 require_listener 那段。
kill_stale() {
  pkill -u "$(id -u)" -f "$1" 2>/dev/null || true
}
kill_stale "Xvfb ${DISPLAY} "
kill_stale "x11vnc .*-rfbport ${RFB}"
kill_stale "websockify .*:${HTTP} "
# 上一轮的 dbus-daemon 也要杀。它跟 Xvfb 一样落在 logind 的 session scope 里，stop
# 杀不到，而它的命令行里没有任何席位标识（`dbus-daemon --fork --session`），按模式找会把
# 同一员工别的屏的总线一起杀掉。所以按 pid 找：起总线时把 pid 记进席位自己的
# XDG_RUNTIME_DIR（下面），这里核对一下那个 pid 还是不是我们的 dbus-daemon 再动手——
# pid 早被回收给别的进程的话就不能杀。不这么做每次重启都多留一个 dbus-daemon。
DBUS_PIDFILE="$XDG_RUNTIME_DIR/dbus-daemon.pid"
if [ -f "$DBUS_PIDFILE" ]; then
  old_pid="$(tr -dc '0-9' < "$DBUS_PIDFILE" 2>/dev/null || true)"
  if [ -n "$old_pid" ] \
    && [ "$(ps -o comm= -p "$old_pid" 2>/dev/null | tr -d ' ')" = dbus-daemon ] \
    && [ "$(ps -o uid= -p "$old_pid" 2>/dev/null | tr -d ' ')" = "$(id -u)" ]; then
    kill "$old_pid" 2>/dev/null || true
  fi
  rm -f "$DBUS_PIDFILE"
fi
# 等端口真的松手再往下走，否则新进程照样撞上「address already in use」。
for _ in $(seq 1 25); do
  if ! (command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE ":(${RFB}|${HTTP})\b"); then break; fi
  sleep 0.2
done
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true

# ── 每个席位一条**自己的** dbus 总线 ──────────────────────────────────
# 这里以前是 `if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]`，而那个条件永远不成立：本单元是
# PAMName=login 起的，logind 已经把它指到了 /run/user/<uid>/bus——那是**按 uid** 的，
# 同一个员工的两块屏于是共用一条总线。
#
# 后果和上面 Chrome 的 --user-data-dir 一模一样，只是更隐蔽：**plank 是单实例的**。
# 第二块屏起 plank 时，它在总线上发现已经有一个了，就把「显示 dock」转给第一个实例、
# 自己安静退出。于是第二块屏整条 dock 都没有，日志里一个字都不留——单元还是 active，
# 部署还是 ready，文件也都在，只有 dock 不见了。
#
# 所以不问，直接起一条。unset 是必须的：dbus-launch 看到已有地址会直接复用它。
unset DBUS_SESSION_BUS_ADDRESS
eval "$(dbus-launch --sh-syntax)"
# 记下 pid 给下一轮的 kill_stale 用，并且本轮正常收场（Xvfb 退了、或者收到 stop 的
# SIGTERM）时自己把它带走。TERM 要显式 trap：不 trap 的话 bash 被信号打死，EXIT 那条
# 跑不到。没选 `dbus-launch --exit-with-session`：它靠 stdin 的 HUP 或 X 连接断开来
# 判断，而这里 stdin 是 /dev/null、起总线时 Xvfb 还没起来，两条都靠不住。
printf '%s\n' "${DBUS_SESSION_BUS_PID:-}" > "$DBUS_PIDFILE"
trap 'kill "${DBUS_SESSION_BUS_PID:-}" 2>/dev/null || true; rm -f "$DBUS_PIDFILE"' EXIT
trap 'exit 143' TERM
# ── X 的门禁：每个席位一张**自己的** MIT-MAGIC-COOKIE ────────────────────
# 这里以前是 `Xvfb ... -ac`，也就是**关掉 X 的访问控制**。/tmp/.X11-unix/X<N> 谁都连得
# 上，于是同一台机器上另一个员工（另一个 Linux 账号，他的 Bot 能跑 shell）一句
# `DISPLAY=:11 xdotool type ...` 就能往这块屏的终端里打字，`import -window root` 就能
# 截走屏上的一切——包括员工登录着的网页。
#
# 现在 Xvfb 只认 -auth 那份文件里的 cookie。文件在席位目录里、0600、归席位账号，别的
# 账号读不到也就连不上。每次起屏换一张新的：上一轮泄出去的 cookie（如果有）跟着作废。
# XAUTHORITY 一 export，下面起的每一样（xdpyinfo、x11vnc、xfwm4、picom、plank、从 dock
# 点开的 Chrome/终端）都自己会去读它；Bot 那边 bot.env 里有同一条（deploy-seat.sh），
# 它拉起的 Chrome 和 terminal 里的 X 工具走的是那一份。
export XAUTHORITY="$SEAT_DIR/Xauthority"
# -c / -l 是 xauth 自己的锁。上一轮在写文件的半路被杀掉会留下它们，而 xauth 见锁就等、
# 等不到就失败——set -e 下整块屏起不来。这一刻本席位还没有别人在写这份文件，直接删。
rm -f "$XAUTHORITY" "$XAUTHORITY-c" "$XAUTHORITY-l"
# 再补一条「任意主机名」（family ffff）的同一张 cookie：`xauth add :N` 记的是**此刻的**
# 主机名，客户端按主机名去查。开机时 cloud-init 改主机名、或者人手工改过的话，之后起的
# 客户端就查不到，表现是 Chrome / 终端点了没反应——没有 cookie 可比没有 -ac 更难查。
(
  umask 077
  # 先建空文件：不然 xauth 每次都往 journal 里吼一句「file does not exist」。
  : > "$XAUTHORITY"
  xauth -q -f "$XAUTHORITY" add "$DISPLAY" . "$(mcookie)"
  xauth -q -f "$XAUTHORITY" nlist "$DISPLAY" | sed -e 's/^..../ffff/' | xauth -q -f "$XAUTHORITY" nmerge -
)
chmod 600 "$XAUTHORITY"
Xvfb "$DISPLAY" -screen 0 1280x800x24 -auth "$XAUTHORITY" +extension GLX +render -noreset &
XVFB_PID=$!
ready=0
for _ in $(seq 1 50); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.2
done
if [ "$ready" != 1 ]; then echo "X display did not become ready" >&2; exit 1; fi
hsetroot -solid "#e8e8e8" || xsetroot -solid "#e8e8e8" || true
PASSFILE="$SEAT_DIR/vnc-passwd"
# 口令文件有两种格式，按大小分：deploy-seat.sh 现在直接写明文（口令一行加换行，Gateway
# 发的口令固定 16 位），x11vnc 用 -passwdfile 读；老席位留下的是 `x11vnc -storepasswd`
# 生成的 DES 文件，恰好 8 字节、没有换行，还得用 -rfbauth。这样管家升级之后没重铺过
# 的席位重启照样能连——这份脚本是全机共享的，不能只认新格式。
# -auth 显式给一遍：x11vnc 自己也认 XAUTHORITY，但它有一套「猜 display 管理器的 cookie
# 在哪」的逻辑，写明了就不用赌它猜对。
if [ "$(stat -c %s "$PASSFILE" 2>/dev/null || echo 0)" = 8 ]; then
  x11vnc -display "$DISPLAY" -auth "$XAUTHORITY" -localhost -rfbauth "$PASSFILE" -shared -forever -noxdamage -rfbport "$RFB" &
else
  x11vnc -display "$DISPLAY" -auth "$XAUTHORITY" -localhost -passwdfile "$PASSFILE" -shared -forever -noxdamage -rfbport "$RFB" &
fi
X11VNC_PID=$!
NOVNC_WEB="/usr/share/novnc"
# 只听回环：对外那一跳由管家反代，并且要过 Gateway 签的桌面票。绑 0.0.0.0 会让
# 6081+N 直接暴露在网上，票就白验了——停用的员工照样能连上桌面。
# 后端写死 127.0.0.1，不写 localhost：别的账号先占了 127.0.0.1:RFB 时，x11vnc -localhost 只绑得上
# [::1]，照样「起来了」；而 localhost 先解析到 127.0.0.1，websockify 就把人送进了别人的 VNC。
# 下面 require_listener 核的正是 127.0.0.1 这一个口。
websockify --web="$NOVNC_WEB" --heartbeat=30 "127.0.0.1:${HTTP}" "127.0.0.1:${RFB}" &
WEBSOCKIFY_PID=$!

# ── 起来了没有？没起来就必须**失败**，不能接着往下跑 ──────────────────
# 这两条以前是 `&` 扔到后台就不管了。于是端口被别人占着时：websockify 起不来、直接
# 退出，而脚本一路跑到底、systemd 显示 active、管家上报 ready、界面显示部署成功——
# 可 6081 上蹲着的是**另一套 VNC**（这台机器上就有过一个 Aug 16 起的 :3/5902，
# 口令在 /home/slim/.vnc/passwd）。表现是画面能连上、口令却永远对不上，而且重新部署
# 多少次都一样，因为席位自己的 websockify 从来就没起来过。
#
# 「装作成功」是这里最贵的失败方式：它把一个一眼能看出的端口冲突，变成了一个要翻
# ps 才找得到的谜。宁可让这个单元 failed——那至少会写进 lastError 报回 Gateway。
#
# **「口上有人在听」不够，得是我们刚起的那一个在听。** 以前只看 `ss -ltn` 里有没有这个口：
# 同机别的账号抢先蹲在 5910+N 上，这一步照样通过，界面上报 ready，而「打开桌面」连进的是
# 它那一套。所以按 pid 认：监听这个口的必须是上面 `&` 起的那个进程（或者它的子孙——防着哪天
# 换成一个会 fork 的包装）。以席位用户跑的 `ss -ltnp` 只给得出**自己 uid** 的 pid，别的账号
# 的监听在这里看不到 pid，也就认不成我们的。父子关系是内核记的，谁也伪造不了。
#
# **看的是 IPv4 回环那一个口**（以及通配地址：蹲在 0.0.0.0 上的同样接得到 127.0.0.1 的连接）。
# 光看端口号会被这样骗过去：别的账号先占 127.0.0.1:5910，x11vnc -localhost 退而只绑 [::1]:5910，
# 端口上「有我们的进程」——而 websockify 和管家连的都是 127.0.0.1。所以这几个地址上的监听
# 必须**全是**我们的，而且至少有一个；[::1] 上的不算数。
is_ours() {
  local pid="$1" want="$2" _
  for _ in 1 2 3 4 5 6 7 8; do
    [ "$pid" = "$want" ] && return 0
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    case "$pid" in
      '' | 0 | 1) return 1 ;;
    esac
  done
  return 1
}
listener_is_ours() {
  local port="$1" want="$2" local_addr rest pid seen=0
  while read -r _ _ _ local_addr _ rest; do
    case "$local_addr" in
      "127.0.0.1:$port" | "0.0.0.0:$port" | "*:$port" | "[::]:$port" | "[::ffff:127.0.0.1]:$port") ;;
      *) continue ;;
    esac
    pid=$(printf '%s' "$rest" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
    [ -n "$pid" ] && is_ours "$pid" "$want" || return 1
    seen=1
  done < <(ss -ltnpH "sport = :$port" 2>/dev/null || true)
  [ "$seen" = 1 ]
}
require_listener() {
  local port="$1" what="$2" want="$3"
  for _ in $(seq 1 40); do
    if listener_is_ours "$port" "$want"; then return 0; fi
    # 我们的进程已经退了（多半是口被占着、bind 失败）：不必再等满十秒。
    kill -0 "$want" 2>/dev/null || break
    sleep 0.25
  done
  echo "$what 没能在端口 $port 上起来（或者在听这个口的不是本席位刚起的那个进程 $want）。" >&2
  echo "端口很可能被这台机器上别的进程占着（另一套 VNC / 上一轮的残留 / 别的账号）：" >&2
  ss -ltnp 2>/dev/null | grep -E ":${port}\b" >&2 || true
  ps -eo pid,user,cmd 2>/dev/null | grep -E "x11vnc|websockify" | grep -v grep >&2 || true
  exit 1
}
require_listener "$RFB" x11vnc "$X11VNC_PID"
require_listener "$HTTP" websockify "$WEBSOCKIFY_PID"
xfwm4 --compositor=off &
for _ in $(seq 1 40); do
  xprop -root _NET_SUPPORTING_WM_CHECK >/dev/null 2>&1 && break
  sleep 0.2
done
PICOM_CONF="$XDG_CONFIG_HOME/picom/picom.conf"
if [ -f "$PICOM_CONF" ]; then picom --config "$PICOM_CONF" &
else picom --backend xrender --no-vsync --no-use-damage &
fi
CHROME_BIN=""
if command -v google-chrome-stable >/dev/null 2>&1; then CHROME_BIN=google-chrome-stable
elif command -v google-chrome >/dev/null 2>&1; then CHROME_BIN=google-chrome
elif command -v chromium >/dev/null 2>&1; then CHROME_BIN=chromium
elif command -v chromium-browser >/dev/null 2>&1; then CHROME_BIN=chromium-browser
fi
if [ -n "$CHROME_BIN" ]; then
  # profile 必须按席位分。同一个 --user-data-dir 上起第二个 Chrome 不会启动，它会把
  # 「开个标签页」发给第一个实例然后自己退出——于是 B 席位要看的网页开在了 A 的屏上。
  WRAP="$SEAT_DIR/bin/seat-chrome"
  echo "#!/bin/bash" > "$WRAP"
  # XAUTHORITY 写死进 wrapper：谁拉起它（dock、Bot、员工在终端里敲）都连得上这块屏，
  # 不依赖调用方的环境里正好带着那一条。
  #
  # CDP 口本身没有鉴权，「只听 127.0.0.1」挡不住同机的别的账号。挡它的是 root 装的
  # 那条按 uid 放行的规则（seat-cdp-guard.sh），不在这里。
  echo "export XAUTHORITY=\"$XAUTHORITY\"" >> "$WRAP"
  echo "exec $CHROME_BIN --password-store=basic --no-first-run --no-default-browser-check --remote-debugging-port=${CDP} --remote-debugging-address=127.0.0.1 --user-data-dir=$SEAT_DIR/chrome \"\$@\"" >> "$WRAP"
  chmod +x "$WRAP"
  # 图标跟着**实际装的是哪个**走。写死 google-chrome 的话，装 Chromium 的机器上
  # 这一格是张白纸——功能正常，但 dock 上摆着个认不出来的东西。
  case "$CHROME_BIN" in
    google-chrome*) CHROME_ICON=google-chrome; CHROME_NAME=Chrome ;;
    chromium-browser) CHROME_ICON=chromium-browser; CHROME_NAME=Chromium ;;
    *) CHROME_ICON=chromium; CHROME_NAME=Chromium ;;
  esac
  D="$XDG_DATA_HOME/applications/seat-chrome.desktop"
  echo "[Desktop Entry]" > "$D"
  echo "Type=Application" >> "$D"
  echo "Name=$CHROME_NAME" >> "$D"
  echo "Exec=$WRAP --new-window %U" >> "$D"
  echo "Icon=$CHROME_ICON" >> "$D"
  echo "Categories=Network;WebBrowser;" >> "$D"
fi
# 文件管理器和终端**不直接挂系统那两个 .desktop**：那样点开落在 $HOME，人得自己
# 找路进 work。各写一份席位自己的，把 work 目录钉进 Exec 里。
mkdir -p "$WORK_DIR" 2>/dev/null || true

# **照 Chrome 那格的做法：wrapper 脚本 + 只指向 wrapper 的 .desktop。**
# 直接把目录写进 Exec（`Exec=thunar "/path/to/work"`）看着更省事，但 .desktop 的 Exec
# 有自己一套引号和 %f/%u 转义规则，写复杂了 plank 可能整条 dockitem 都不认——而
# 「dock 上少一格」是**没有任何报错**的，只能靠眼睛发现。wrapper 里是普通 shell，
# 规则少得多；Chrome 那格从来就是这么做的，已经验证可用。
FILES_WRAP="$SEAT_DIR/bin/seat-files"
printf '#!/bin/bash\nexec thunar "%s" "$@"\n' "$WORK_DIR" > "$FILES_WRAP"
chmod +x "$FILES_WRAP"
FILES_D="$XDG_DATA_HOME/applications/seat-files.desktop"
printf '[Desktop Entry]\nType=Application\nName=Files\nExec=%s\nIcon=system-file-manager\nTerminal=false\n' \
  "$FILES_WRAP" > "$FILES_D"

TERM_WRAP="$SEAT_DIR/bin/seat-terminal"
printf '#!/bin/bash\nexec xfce4-terminal --working-directory="%s" "$@"\n' "$WORK_DIR" > "$TERM_WRAP"
chmod +x "$TERM_WRAP"
TERM_D="$XDG_DATA_HOME/applications/seat-terminal.desktop"
printf '[Desktop Entry]\nType=Application\nName=Terminal\nExec=%s\nIcon=utilities-terminal\nTerminal=false\n' \
  "$TERM_WRAP" > "$TERM_D"

# plank 按 .dockitem 的**文件名排序**摆放，所以名字定了顺序：chrome → files → terminal。
LAUNCH="$XDG_CONFIG_HOME/plank/dock1/launchers"
mkdir -p "$LAUNCH"
dock_item() {
  [ -f "$2" ] || return 0
  printf "[PlankDockItemPreferences]\nLauncher=file://%s\n" "$2" > "$LAUNCH/$1.dockitem"
}
dock_item chrome "$XDG_DATA_HOME/applications/seat-chrome.desktop"
dock_item files "$FILES_D"
dock_item terminal "$TERM_D"
# 上一版留下的旧名字，不清掉会和新的并存，dock 上出现两个文件管理器。
rm -f "$LAUNCH/thunar.dockitem" "$LAUNCH/xfce4-terminal.dockitem" 2>/dev/null || true
# dconf 也认 XDG_CONFIG_HOME（$XDG_CONFIG_HOME/dconf/user），所以这几行是写进席位的。
dconf write /net/launchpad/plank/docks/dock1/hide-mode "'none'" 2>/dev/null || true
dconf write /net/launchpad/plank/docks/dock1/position "'bottom'" 2>/dev/null || true
dconf write /net/launchpad/plank/docks/dock1/icon-size 48 2>/dev/null || true
dconf write /net/launchpad/plank/docks/dock1/theme "'Transparent'" 2>/dev/null || true
plank --name dock1 &
wait "$XVFB_PID"
