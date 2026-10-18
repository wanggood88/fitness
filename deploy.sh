#!/bin/sh
# 健身 App 部署脚本：把本目录所有文件上传到 GitHub 仓库 wanggood88/fitness（main 分支）
# 依赖：curl、python3、base64；需要环境变量 GITHUB_TOKEN（勿回显）
# 用法：sh deploy.sh [提交说明]
set -e
cd "$(dirname "$0")"
REPO="wanggood88/fitness"
BRANCH="main"
MSG="${1:-update}"
[ -n "$GITHUB_TOKEN" ] || { echo 'ERROR: GITHUB_TOKEN not set'; exit 1; }

OK=0; FAIL=0
for f in $(find . -type f ! -path './.git/*' | sed 's|^\./||' | sort); do
  B64=$(base64 < "$f" | tr -d '\n')
  SHA=$(curl -sf -H "Authorization: token $GITHUB_TOKEN" \
    "https://api.github.com/repos/$REPO/contents/$f?ref=$BRANCH" \
    | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["sha"])
except Exception: print("")')
  EXTRA=""
  [ -n "$SHA" ] && EXTRA=",\"sha\":\"$SHA\""
  printf '{"message":"%s: %s","branch":"%s","content":"%s"%s}' "$MSG" "$f" "$BRANCH" "$B64" "$EXTRA" > /tmp/fit_pay.json
  RES=$(curl -s -X PUT -H "Authorization: token $GITHUB_TOKEN" -H "Content-Type: application/json" \
    -d @/tmp/fit_pay.json "https://api.github.com/repos/$REPO/contents/$f")
  case "$RES" in
    *'"path"'*) OK=$((OK+1)) ;;
    *) FAIL=$((FAIL+1)); echo "FAIL: $f"; echo "$RES" | head -c 200; echo ;;
  esac
  rm -f /tmp/fit_pay.json
done
echo "uploaded: $OK ok, $FAIL failed"
echo "https://wanggood88.github.io/fitness/ （Pages 构建约 40-60s）"
