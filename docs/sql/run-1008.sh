#!/bin/sh
# 10 月 8 日对账：跑 usage-vs-openai-1008.sql，再按 272k 档位精确重算 gpt-6.1-sol。只读。
# 连接串：环境变量优先，否则读仓库根的 .env.production（worktree 里没有那个文件，就先 export）。
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
URL="${GATEWAY_DATABASE_URL:-$(grep '^GATEWAY_DATABASE_URL=' "$ROOT/.env.production" 2>/dev/null | cut -d= -f2- | tr -d '"')}"
[ -n "$URL" ] || { echo "没有连接串：export GATEWAY_DATABASE_URL=… 或在仓库根放 .env.production" >&2; exit 1; }
PSQL=psql
command -v psql >/dev/null 2>&1 || PSQL=/opt/homebrew/bin/psql

"$PSQL" "$URL" -X --pset pager=off -f "$HERE/usage-vs-openai-1008.sql"

echo '== 6. gpt-6.1-sol 按 272k 翻倍档精确重算（原价，不含倍率）'
"$PSQL" "$URL" -X --pset pager=off -c "
select count(*) as calls,
       count(*) filter (where p > 272000) as over_272k,
       round(sum((p-c)*2 + c*0.1 + o*10)/1e6, 4) as flat_cost_usd,
       round(sum(case when p > 272000 then 2 else 1 end * ((p-c)*2 + c*0.1 + o*10))/1e6, 4) as tiered_cost_usd
from (select (quantity->>'promptTokens')::bigint p,
             (quantity->>'cachedTokens')::bigint c,
             (quantity->>'completionTokens')::bigint o
      from usage_charges
      where kind = 'llm' and subject = 'openai/gpt-6.1-sol'
        and \"createdAt\" >= 1791417600000 and \"createdAt\" < 1791504000000) t"
