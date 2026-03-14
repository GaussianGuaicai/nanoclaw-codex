#!/usr/bin/env bash
set -euo pipefail

COMMAND="${1:-status}"
LABEL="com.nanoclaw"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"

usage() {
  cat <<'EOF'
Usage: scripts/service-control.sh <status|start|stop|restart>

Controls the NanoClaw background service using the local platform's service manager.
EOF
}

service_manager() {
  case "$(uname -s)" in
    Darwin) echo "launchd" ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1; then
        echo "systemd"
      else
        echo "none"
      fi
      ;;
    *) echo "none" ;;
  esac
}

launchd_line() {
  launchctl list | grep -F "${LABEL}" || true
}

launchd_loaded() {
  [[ -n "$(launchd_line)" ]]
}

launchd_status() {
  local line pid
  line="$(launchd_line)"
  if [[ -z "${line}" ]]; then
    echo "not loaded"
    return 0
  fi

  pid="$(printf '%s\n' "${line}" | awk '{print $1}')"
  if [[ -n "${pid}" && "${pid}" != "-" ]]; then
    echo "running (pid ${pid})"
  else
    echo "loaded/stopped"
  fi
}

ensure_plist() {
  if [[ ! -f "${PLIST_PATH}" ]]; then
    echo "LaunchAgent plist not found: ${PLIST_PATH}" >&2
    exit 1
  fi
}

launchd_start() {
  ensure_plist
  if launchd_loaded; then
    launchctl kickstart -k "gui/$(id -u)/${LABEL}"
  else
    launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}"
  fi
}

launchd_stop() {
  ensure_plist
  if launchd_loaded; then
    launchctl bootout "gui/$(id -u)" "${PLIST_PATH}"
  else
    echo "${LABEL} already stopped"
  fi
}

systemd_status() {
  systemctl --user is-active nanoclaw || true
}

systemd_start() {
  systemctl --user start nanoclaw
}

systemd_stop() {
  systemctl --user stop nanoclaw
}

main() {
  local manager
  manager="$(service_manager)"

  case "${COMMAND}" in
    status)
      case "${manager}" in
        launchd) launchd_status ;;
        systemd) systemd_status ;;
        *) echo "unsupported platform" >&2; exit 1 ;;
      esac
      ;;
    start)
      case "${manager}" in
        launchd) launchd_start ;;
        systemd) systemd_start ;;
        *) echo "unsupported platform" >&2; exit 1 ;;
      esac
      ;;
    stop)
      case "${manager}" in
        launchd) launchd_stop ;;
        systemd) systemd_stop ;;
        *) echo "unsupported platform" >&2; exit 1 ;;
      esac
      ;;
    restart)
      case "${manager}" in
        launchd) launchd_start ;;
        systemd)
          systemd_stop
          systemd_start
          ;;
        *)
          echo "unsupported platform" >&2
          exit 1
          ;;
      esac
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
