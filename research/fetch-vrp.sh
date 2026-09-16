#!/bin/bash
# 拉取 VRP 检验所需数据
#   DVOL : Deribit 隐含波动率指数日线（经 CryptoDataDownload 免费镜像；
#          Deribit 官方 API 也能取，但本机 shell 不可达，浏览器可达）
#   K线  : 币安日线（收盘价 RV / Parkinson）+ 5 分钟（高频已实现方差），
#          来自 data.binance.vision 免 key 归档
set -u
B="https://data.binance.vision/data"
ROOT="$(cd "$(dirname "$0")" && pwd)"
DATA="$ROOT/data"
mkdir -p "$DATA"

SYMS="BTCUSDT ETHUSDT"
TFS="1d 5m"

months() {
  local y=2021 m=3
  while [ "$y" -lt 2026 ] || { [ "$y" -eq 2026 ] && [ "$m" -le 8 ]; }; do
    printf "%04d-%02d\n" "$y" "$m"
    m=$((m+1)); if [ "$m" -gt 12 ]; then m=1; y=$((y+1)); fi
  done
}

get() {
  if [ -s "$2" ]; then return 0; fi
  curl -s -f --max-time 120 -o "$2" "$1" || { rm -f "$2"; return 1; }
}
export -f get

# ---- 1. DVOL 日线 ----
for s in BTC ETH; do
  out="$DATA/dvol_$s.csv"
  if [ ! -s "$out" ]; then
    curl -s -f --max-time 60 -o "$out" "https://www.cryptodatadownload.com/cdd/DeriBit_volatility_OHLC_$s.csv" \
      || { echo "DVOL $s 下载失败"; rm -f "$out"; }
  fi
done

# ---- 2. K线 ----
: > "$ROOT/tasks-vrp.txt"
for s in $SYMS; do
  for tf in $TFS; do
    for ym in $(months); do
      echo "$B/spot/monthly/klines/$s/$tf/$s-$tf-$ym.zip|$DATA/$s-$tf-$ym.zip" >> "$ROOT/tasks-vrp.txt"
    done
  done
done

total=$(wc -l < "$ROOT/tasks-vrp.txt" | tr -d ' ')
echo "K线任务总数: $total"
cat "$ROOT/tasks-vrp.txt" | tr '|' ' ' | xargs -P 8 -n 2 bash -c 'get "$0" "$1"' 2>/dev/null

# ---- 3. 解压 ----
for z in "$DATA"/*.zip; do
  [ -e "$z" ] || continue
  b=$(basename "$z" .zip)
  [ -s "$DATA/$b.csv" ] || unzip -p "$z" > "$DATA/$b.csv" 2>/dev/null
done

echo "DVOL: $(ls "$DATA"/dvol_*.csv 2>/dev/null | wc -l | tr -d ' ') 个文件"
echo "K线CSV: $(ls "$DATA"/*-1d-*.csv "$DATA"/*-5m-*.csv 2>/dev/null | wc -l | tr -d ' ') 个文件"
du -sh "$DATA"
