#!/bin/bash
# 生成行情汇报 (使用 Finnhub API)
# 用法: ./market-report.sh [pre|open|close]

FINNHUB_KEY="d61296hr01qjrrugm7qgd61296hr01qjrrugm7r0"
BASE_URL="https://finnhub.io/api/v1/quote"
WATCHLIST="/workspace/group/watchlist.json"

# 读取股票列表
STOCKS=$(cat "$WATCHLIST" | grep -o '"symbol": "[^"]*"' | head -10 | cut -d'"' -f4)

SESSION_TYPE="${1:-current}"

case "$SESSION_TYPE" in
  pre) SESSION_NAME="盘前行情" ;;
  open) SESSION_NAME="开盘行情" ;;
  close) SESSION_NAME="收盘行情" ;;
  *) SESSION_NAME="当前行情" ;;
esac

DATE=$(date +"%Y-%m-%d")

echo "📊 *${SESSION_NAME}* (${DATE})"
echo ""
echo "*持仓*"

for symbol in $STOCKS; do
  result=$(curl -s "${BASE_URL}?symbol=${symbol}&token=${FINNHUB_KEY}")

  # Finnhub 返回: c=当前价, d=变化, dp=变化百分比, pc=前收
  price=$(echo "$result" | grep -o '"c":[0-9.]*' | cut -d':' -f2)
  change=$(echo "$result" | grep -o '"d":[0-9.-]*' | cut -d':' -f2)
  change_pct=$(echo "$result" | grep -o '"dp":[0-9.-]*' | cut -d':' -f2)

  if [ -n "$price" ] && [ "$price" != "0" ]; then
    # 判断涨跌
    first_char="${change:0:1}"
    if [ "$first_char" = "-" ]; then
      arrow="▼"
      sign=""
    else
      arrow="▲"
      sign="+"
    fi
    printf "• %s \$%.2f %s%s%.2f%%\n" "$symbol" "$price" "$arrow" "$sign" "$change_pct"
  else
    echo "• ${symbol} 获取失败"
  fi
done

echo ""
echo "*指数*"

# SPY = S&P 500 ETF, QQQ = Nasdaq 100 ETF
for symbol in SPY QQQ; do
  result=$(curl -s "${BASE_URL}?symbol=${symbol}&token=${FINNHUB_KEY}")

  price=$(echo "$result" | grep -o '"c":[0-9.]*' | cut -d':' -f2)
  change=$(echo "$result" | grep -o '"d":[0-9.-]*' | cut -d':' -f2)
  change_pct=$(echo "$result" | grep -o '"dp":[0-9.-]*' | cut -d':' -f2)

  if [ -n "$price" ] && [ "$price" != "0" ]; then
    first_char="${change:0:1}"
    if [ "$first_char" = "-" ]; then
      arrow="▼"
      sign=""
    else
      arrow="▲"
      sign="+"
    fi

    name="$symbol"
    [ "$symbol" = "SPY" ] && name="标普500"
    [ "$symbol" = "QQQ" ] && name="纳指100"

    printf "• %s \$%.2f %s%s%.2f%%\n" "$name" "$price" "$arrow" "$sign" "$change_pct"
  fi
done
