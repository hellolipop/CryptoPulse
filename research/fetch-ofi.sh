#!/bin/bash
# 拉取订单流检验所需的逐笔成交（aggTrades）
#
# 取舍说明：
#   - Bybit 公开数据门户 public.bybit.com 在本机 shell 与浏览器均不可达，无法使用。
#   - Binance 免费归档没有 bookTicker / bookDepth，拿不到最优买卖价与量，
#     因此无法计算 CKS(2014) 定义的真正 OFI（真 OFI 需要限价单到达与撤销事件）。
#   - 可行的是逐笔成交的主动方方向字段，用于计算成交型失衡（trade imbalance, TI）。
#     结论只对 TI 成立，不能等同于 OFI。
#
# 数据源 data.binance.vision（免 key），永续合约日度 aggTrades
set -u
B="https://data.binance.vision/data"
ROOT="$(cd "$(dirname "$0")" && pwd)"
DATA="$ROOT/data/trades"
mkdir -p "$DATA"

SYMS="BTCUSDT ETHUSDT"
START="${1:-2026-07-22}"
END="${2:-2026-08-20}"

get() {
  if [ -s "$2" ]; then return 0; fi
  curl -s -f --max-time 300 -o "$2" "$1" || { rm -f "$2"; return 1; }
}
export -f get

LIST="$ROOT/tasks-ofi.txt"
: > "$LIST"
d="$START"
while [ "$d" \< "$END" ]; do
  for s in $SYMS; do
    echo "$B/futures/um/daily/aggTrades/$s/$s-aggTrades-$d.zip|$DATA/$s-aggTrades-$d.zip" >> "$LIST"
  done
  d=$(date -j -f "%Y-%m-%d" -v+1d "$d" +%Y-%m-%d)
done

n=$(wc -l < "$LIST" | tr -d ' ')
echo "tasks: $n  range: $START .. $END"
tr '|' ' ' < "$LIST" | xargs -P 6 -n 2 bash -c 'get "$0" "$1"' 2>/dev/null
echo "downloaded: $(find "$DATA" -name '*.zip' | wc -l | tr -d ' ') / $n"
du -sh "$DATA"
