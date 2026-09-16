#!/bin/bash
# 从 data.binance.vision 拉取回测所需的历史数据
# 说明：api.binance.com / fapi.binance.com 在部分网络下不可达，
#       但官方历史数据归档站可访问，且为免 key 的原始 CSV。
set -u

B="https://data.binance.vision/data"
ROOT="$(cd "$(dirname "$0")" && pwd)"
DATA="$ROOT/data"
mkdir -p "$DATA"

SYMS="BTCUSDT ETHUSDT"

# 月度区间：2023-09 ~ 2026-08（36 个月，覆盖一轮完整牛熊）
months() {
  local y=2023 m=9
  while [ "$y" -lt 2026 ] || { [ "$y" -eq 2026 ] && [ "$m" -le 8 ]; }; do
    printf "%04d-%02d\n" "$y" "$m"
    m=$((m+1)); if [ "$m" -gt 12 ]; then m=1; y=$((y+1)); fi
  done
}

get() { # $1=url  $2=out
  if [ -s "$2" ]; then return 0; fi
  curl -s -f --max-time 60 -o "$2" "$1" || { rm -f "$2"; return 1; }
}
export -f get

task_list="$ROOT/tasks.txt"
: > "$task_list"

for s in $SYMS; do
  for ym in $(months); do
    echo "$B/spot/monthly/klines/$s/1h/$s-1h-$ym.zip|$DATA/$s-1h-$ym.zip" >> "$task_list"
    echo "$B/futures/um/monthly/fundingRate/$s/$s-fundingRate-$ym.zip|$DATA/$s-fund-$ym.zip" >> "$task_list"
    echo "$B/futures/um/monthly/premiumIndexKlines/$s/1h/$s-1h-$ym.zip|$DATA/$s-prem-$ym.zip" >> "$task_list"
  done
done

# 衍生品 metrics（持仓量/多空比/主动买卖比）只有日度归档，取近 4 个月
d=2026-05-01
while [ "$d" \< "2026-09-15" ]; do
  for s in $SYMS; do
    echo "$B/futures/um/daily/metrics/$s/$s-metrics-$d.zip|$DATA/$s-met-$d.zip" >> "$task_list"
  done
  d=$(date -j -f "%Y-%m-%d" -v+1d "$d" +%Y-%m-%d)
done

total=$(wc -l < "$task_list" | tr -d ' ')
echo "任务总数: $total"

cat "$task_list" | tr '|' ' ' | xargs -P 8 -n 2 bash -c 'get "$0" "$1"' 2>/dev/null

got=$(find "$DATA" -name '*.zip' | wc -l | tr -d ' ')
echo "已下载: $got / $total"
du -sh "$DATA" 2>/dev/null
