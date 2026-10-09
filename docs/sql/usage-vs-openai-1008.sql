-- 对账：10 月 8 日本地账本 vs OpenAI 后台。只读。
-- 用法：psql "$GATEWAY_DATABASE_URL" -X -f docs/sql/usage-vs-openai-1008.sql
--
-- 两种切天：OpenAI 后台按 UTC 切，公司用量统计按浏览器时区（东八区）切。
--   北京 10/08 = 1791388800000 .. 1791475200000
--   UTC   10/08 = 1791417600000 .. 1791504000000

\set b0 1791388800000
\set b1 1791475200000
\set u0 1791417600000
\set u1 1791504000000

\echo '== 1. 账本按窗口合计（amount 已含倍率；cost = amount / multiplier 是原价）'
select w.name as window, kind, status, unpriced, count(*) as rows,
       round(sum("amountMicros")/1e6, 4) as amount_usd,
       round((sum("amountMicros"/multiplier)/1e6)::numeric, 4) as cost_usd
from usage_charges c
join (values ('beijing', :b0::bigint, :b1::bigint), ('utc', :u0::bigint, :u1::bigint)) as w(name, f, t)
  on c."createdAt" >= w.f and c."createdAt" < w.t
where kind = 'llm'
group by 1,2,3,4 order by 1,2,3,4;

\echo '== 2. 按模型：token 与金额（UTC 窗口，和 OpenAI 后台同口径）'
select subject, status, unpriced, count(*) as calls,
       sum((quantity->>'promptTokens')::bigint)     as prompt,
       sum((quantity->>'cachedTokens')::bigint)     as cached,
       sum((quantity->>'completionTokens')::bigint) as completion,
       max((quantity->>'promptTokens')::bigint)     as max_prompt,
       count(*) filter (where (quantity->>'promptTokens')::bigint > 272000) as over_272k,
       round(sum("amountMicros")/1e6, 4) as amount_usd,
       (array_agg("unitPrice" order by "createdAt" desc))[1] as latest_unit_price
from usage_charges
where kind = 'llm' and "createdAt" >= :u0 and "createdAt" < :u1
group by 1,2,3 order by amount_usd desc;

\echo '== 3. 0 元行：没拿到 usage 的调用（OpenAI 照收钱，这里记 0）'
select subject, status, count(*) as calls
from usage_charges
where kind = 'llm' and "createdAt" >= :u0 and "createdAt" < :u1
  and "amountMicros" = 0
group by 1,2 order by 3 desc;

\echo '== 4. llm_calls 里有调用、账本里没行（从未结算）'
select l.provider, l.model, count(*) as calls,
       count(*) filter (where l."promptTokens" = 0 and l."completionTokens" = 0) as zero_token_calls
from llm_calls l
left join usage_charges c on c."refId" = l.id and c.kind = 'llm'
where l."createdAt" >= :u0 and l."createdAt" < :u1 and c.id is null
group by 1,2 order by 3 desc;

\echo '== 5. 平台设置：倍率 / 改价 / 兜底价'
select payload->'priceMultiplier' as multiplier,
       payload->'modelPricing'    as overrides,
       payload->'defaultModelRate' as fallback_rate
from platform_settings where id = 'platform';
