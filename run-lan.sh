#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

echo "启动局域网访问模式"
echo "网页端口：8080"
echo "用户/模拟盘服务端口：8788"
echo "请用本机局域网 IP 访问，例如 http://192.168.1.23:8080"

HOST=0.0.0.0 node server/store.js &
STORE_PID=$!
trap 'kill "$STORE_PID" 2>/dev/null || true' EXIT INT TERM

python3 -m http.server 8080 --bind 0.0.0.0
