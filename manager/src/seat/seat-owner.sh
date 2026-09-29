# 「这个进程是哪个席位的」。由 deploy-seat.sh 和 remove-seat.sh source（都以 root 跑）。
#
# **判据和 manager/src/seat-owner.ts 一模一样，改一处两处一起改**；为什么这么判也写在那边。
# 一句话：不认进程自报的环境变量（任何账号都能伪造一条 XDG_RUNTIME_DIR），只认
#   - cgroup 落在 satuwork-bot@<席位>.service / slim-desktop@<席位>.service 里；或者
#   - 在 logind 的 session-<N>.scope 里、那个会话是 PAM 服务 login 开的（桌面单元的
#     PAMName=login），这时才拿环境里的 XDG_RUNTIME_DIR 当候选；
# 两路最后都核 uid：进程的 uid 必须是那个席位的账号（第二个参数；不给就读 root 写的 drop-in
# 里那行 User=）。
#
# 用法：seat_of_pid <pid> [linux-user]。打印席位 ID，认不出来什么都不打印；**永远返回 0**。
# 调用方开着 set -E 和 ERR trap（deploy-seat.sh），所以每一条可能失败的命令都自己兜住，
# 而且兜在命令替换**里面**——errtrace 下写在外面拦不住子 shell 里先响的那一声。
seat_of_pid() {
  local pid="$1" user="${2:-}" cg id sess uid want
  case "$pid" in
    *[!0-9]* | '') return 0 ;;
  esac
  cg=$(cat "/proc/$pid/cgroup" 2>/dev/null || true)
  [ -n "$cg" ] || return 0
  id=$(printf '%s\n' "$cg" | sed -nE 's#^.*/(slim-desktop|satuwork-bot)@([A-Za-z0-9_-]+)\.service(/.*)?$#\2#p' | head -1 || true)
  if [ -z "$id" ]; then
    sess=$(printf '%s\n' "$cg" | sed -nE 's#^.*/session-([A-Za-z0-9]+)\.scope$#\1#p' | head -1 || true)
    [ -n "$sess" ] || return 0
    grep -qx 'SERVICE=login' "/run/systemd/sessions/$sess" 2>/dev/null || return 0
    id=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null |
      sed -nE 's#^XDG_RUNTIME_DIR=(/run/satuwork/|/tmp/xdg-runtime-)([A-Za-z0-9_-]+)$#\2#p' | head -1 || true)
    [ -n "$id" ] || return 0
  fi
  if [ -z "$user" ]; then
    user=$(sed -n 's/^User=\([A-Za-z0-9_-]*\)[[:space:]]*$/\1/p' \
      "/etc/systemd/system/slim-desktop@$id.service.d/seat.conf" \
      "/etc/systemd/system/satuwork-bot@$id.service.d/seat.conf" 2>/dev/null | head -1 || true)
  fi
  [ -n "$user" ] || return 0
  want=$(id -u "$user" 2>/dev/null || true)
  uid=$(sed -nE 's/^Uid:[[:space:]]+([0-9]+).*/\1/p' "/proc/$pid/status" 2>/dev/null || true)
  if [ -n "$want" ] && [ "$uid" = "$want" ]; then
    printf '%s' "$id"
  fi
  return 0
}
