#!/bin/bash
# 云端每日指标采集(GitHub Actions):star/traffic/npm 必采;X 粉丝尽力而为。
set -e
REPO="raysonmeng/agent-bridge"
PKG="@raysonmeng%2Fagentbridge"
TODAY=$(TZ=Asia/Shanghai date +%F)
mkdir -p traffic-archive

STARS=$(gh api "repos/$REPO" -q .stargazers_count)
FORKS=$(gh api "repos/$REPO" -q .forks_count)
VIEWS_JSON=$(gh api "repos/$REPO/traffic/views" 2>/dev/null || echo null)
REFS_JSON=$(gh api "repos/$REPO/traffic/referrers" 2>/dev/null || echo null)
CLONES_JSON=$(gh api "repos/$REPO/traffic/clones" 2>/dev/null || echo null)
NPM_DAY=$(curl -s "https://api.npmjs.org/downloads/point/last-day/$PKG" | python3 -c "import json,sys; print(json.load(sys.stdin).get('downloads',''))" || echo "")
NPM_WEEK=$(curl -s "https://api.npmjs.org/downloads/point/last-week/$PKG" | python3 -c "import json,sys; print(json.load(sys.stdin).get('downloads',''))" || echo "")

XFOLLOW=""
if npm i --no-save puppeteer-core@23 >/dev/null 2>&1; then
  XFOLLOW=$(node x-followers-cloud.mjs raysonmeng 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' | tr -dc '0-9' || echo "")
fi

printf '{"date":"%s","views":%s,"referrers":%s,"clones":%s}\n' \
  "$TODAY" "$VIEWS_JSON" "$REFS_JSON" "$CLONES_JSON" > "traffic-archive/$TODAY.json"

VIEWS14=$(echo "$VIEWS_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('count','') if isinstance(d,dict) else '')" 2>/dev/null || echo "")
UNIQ14=$(echo "$VIEWS_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('uniques','') if isinstance(d,dict) else '')" 2>/dev/null || echo "")
TOPREF=$(echo "$REFS_JSON" | python3 -c "
import json, sys
try:
    refs = json.load(sys.stdin)
    print(';'.join(f\"{r['referrer']}:{r['uniques']}\" for r in refs[:6]))
except Exception:
    print('')" 2>/dev/null || echo "")

CSV=metrics.csv
[ -f "$CSV" ] || echo "date,stars,forks,npm_day,npm_week,views_14d,uniques_14d,top_referrers_uniques,x_followers,notes" > "$CSV"
grep -v "^$TODAY," "$CSV" > "$CSV.tmp" || true; mv "$CSV.tmp" "$CSV"
echo "$TODAY,$STARS,$FORKS,$NPM_DAY,$NPM_WEEK,$VIEWS14,$UNIQ14,\"$TOPREF\",$XFOLLOW," >> "$CSV"
rm -rf node_modules package.json package-lock.json
echo "ok $TODAY stars=$STARS npm=$NPM_DAY x=$XFOLLOW"
