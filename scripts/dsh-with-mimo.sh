#!/usr/bin/env bash
#
# 用钥匙链里的 MiMo key 启动 DeepSeek Harness。
#
#   ./scripts/dsh-with-mimo.sh web --no-open    # 无头 web（端口 3080）
#   ./scripts/dsh-with-mimo.sh                 # 交互式 CLI
#
# DSH 的 provider 配置写的是 `apiKeyEnv: MIMO_API_KEY`，
# 所以只要这个变量在进程环境里，DSH 就能用 MiMo Token Plan。
# 变量来源是 macOS 钥匙链，磁盘上不留明文。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! eval "$("$HERE/mimo-key.sh" env)"; then
  echo "提示：钥匙链里还没有 MiMo key，先跑 $HERE/mimo-key.sh save" >&2
  exit 1
fi
export MIMO_API_KEY

echo "→ 已从钥匙链注入 MIMO_API_KEY（${#MIMO_API_KEY} 字符）" >&2

# 桌面版 DSH 是 GUI app，走 launchd 启动，继承的是 launchd 的环境。
# 这里顺带写一份，让老板从启动台重开的 DSH 也能用上。
if [ "${DSH_PROPAGATE_LAUNCHCTL:-0}" = "1" ]; then
  "$HERE/mimo-key.sh" launchctl >&2 || true
fi

exec dsh "$@"
