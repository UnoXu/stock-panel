#!/usr/bin/env bash
# macOS / Linux / Git Bash 启动脚本
set -euo pipefail
cd "$(dirname "$0")"

NODE="${DSH_NODE:-}"
if [ -z "$NODE" ]; then
  for c in "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" node; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then NODE="$c"; break; fi
  done
fi

if [ -z "$NODE" ]; then
  echo "找不到 Node.js。请先安装 Node 18+，或设置 DSH_NODE 指向 node 可执行文件。" >&2
  exit 1
fi

exec "$NODE" server.mjs
