#!/usr/bin/env bash
#
# MiMo 引擎（`mimo serve`）的启停。环境变量从钥匙链注入。
#
#   ./scripts/mimo-engine.sh start [工作目录]   启动（已在跑就跳过）
#   ./scripts/mimo-engine.sh restart [工作目录] 重启（换 key 后用这个）
#   ./scripts/mimo-engine.sh stop
#   ./scripts/mimo-engine.sh status
#
# 引擎以 nohup 后台运行，日志在 /tmp/mimo-serve.log，PID 记在 /tmp/mimo-serve.pid。

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIMO_BIN="${MIMO_BIN:-$HOME/.mimocode/bin/mimo}"
MIMO_PORT="${MIMO_PORT:-4096}"
PID_FILE="/tmp/mimo-serve.pid"
LOG_FILE="/tmp/mimo-serve.log"
CWD_FILE="/tmp/mimo-serve.cwd"

running_pids() { lsof -nP -iTCP:"$MIMO_PORT" -sTCP:LISTEN -t 2>/dev/null; }

inject_env() {
  local key
  key="$("$HERE/mimo-key.sh" env 2>/dev/null)" || return 1
  eval "$key"
  export MIMO_API_KEY
  return 0
}

do_stop() {
  local pids
  pids="$(running_pids)"
  if [ -z "$pids" ]; then
    echo "· 引擎未在运行"
    rm -f "$PID_FILE"
    return 0
  fi
  echo "$pids" | xargs -r kill 2>/dev/null
  for _ in $(seq 1 40); do
    [ -z "$(running_pids)" ] && break
    sleep 0.25
  done
  pids="$(running_pids)"
  if [ -n "$pids" ]; then
    echo "$pids" | xargs -r kill -9 2>/dev/null
    sleep 0.5
  fi
  rm -f "$PID_FILE"
  echo "✓ 已停止引擎"
}

do_start() {
  local workdir="${1:-}"
  if [ -z "$workdir" ] && [ -f "$CWD_FILE" ]; then
    workdir="$(cat "$CWD_FILE")"
  fi
  workdir="${workdir:-$PWD}"
  if [ -n "$(running_pids)" ]; then
    echo "· 引擎已在 $MIMO_PORT 运行"
    return 0
  fi
  if [ ! -x "$MIMO_BIN" ]; then
    echo "错误：找不到 $MIMO_BIN" >&2
    return 1
  fi
  if inject_env; then
    echo "→ 已从钥匙链注入 MIMO_API_KEY（${#MIMO_API_KEY} 字符）"
  else
    echo "→ 钥匙链里没有 MiMo key，MiMo Token Plan 不可用"
  fi
  mkdir -p "$workdir"
  printf '%s' "$workdir" > "$CWD_FILE"
  # </dev/null + full redirection keeps the long-lived server from holding open
  # any pipe the caller may have wrapped this script in (e.g. `./start.sh | head`),
  # which would otherwise hang the caller forever.
  ( cd "$workdir" && nohup "$MIMO_BIN" serve --port "$MIMO_PORT" --hostname 127.0.0.1 \
      </dev/null >"$LOG_FILE" 2>&1 & echo $! >"$PID_FILE" )
  for _ in $(seq 1 60); do
    if [ -n "$(running_pids)" ]; then
      echo "✓ 引擎已启动：工作目录 ${workdir}，端口 $MIMO_PORT"
      return 0
    fi
    sleep 0.25
  done
  echo "错误：引擎启动超时，日志见 $LOG_FILE" >&2
  tail -20 "$LOG_FILE" >&2
  return 1
}

case "${1:-status}" in
  start)   do_start "${2:-$PWD}" ;;
  stop)    do_stop ;;
  # restart 不传目录时沿用上次记录的工作目录，而不是脚本所在目录
  restart) do_stop; do_start "${2:-}" ;;
  status)
    pids="$(running_pids)"
    if [ -n "$pids" ]; then
      echo "✓ 引擎运行中（pid ${pids}，端口 ${MIMO_PORT}）"
    else
      echo "✗ 引擎未运行"
    fi
    ;;
  *) echo "用法：$0 {start|stop|restart|status} [工作目录]" >&2; exit 1 ;;
esac
