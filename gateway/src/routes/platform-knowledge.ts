/**
 * 平台「工具配置 → 知识库」：向量模型（区域、预设、模型、密钥）、向量表初始化与重建。owner-only。
 *
 * 和网页工具同一个分法：配置进平台设置的 `knowledgeEmbedding`，密钥进 platform_credentials
 * （`kb-embedding:<预设>`，自定义的再钉上地址的 origin；存进去不回显）。单价和门槛仍走
 * /platform/settings 的 `knowledge`。
 */
import type { RouteCtx } from './ctx.ts'
import { type Db, type KnowledgeEmbeddingSettings, parseKnowledgeEmbedding } from '../db.ts'
import { HttpError, json, type Router } from '../http.ts'
import { requireOwnerUser } from '../lib/guards.ts'
import { bodyOf, strField } from '../lib/validate.ts'
import {
  EMBEDDING_CUSTOM, EMBEDDING_PRESETS, embedTexts, embeddingProblem, embeddingSecretName, embeddingUsable, isEmbeddingSecret,
  loadEmbeddingConfig, resolveEmbedding,
} from '../lib/knowledge-embedding.ts'
import { vectorInfo } from '../lib/knowledge-vector.ts'
import { WebToolError, guardUrl } from '../web-tools.ts'

const INIT_HINT = '；如果是数据库权限不够，请让运维用迁移账号跑 gateway/scripts/init-knowledge-vectors.ts'

function knownProvider(id: string): boolean {
  return id === EMBEDDING_CUSTOM || EMBEDDING_PRESETS.some((p) => p.id === id)
}

async function embeddingView(db: Db) {
  const s = parseKnowledgeEmbedding((await db.platformSettings()).knowledgeEmbedding)
  const customKey = embeddingSecretName(EMBEDDING_CUSTOM, s.baseUrl)
  const keys: Record<string, { updatedAt: number }> = {}
  for (const c of await db.platformCredentials()) {
    if (!isEmbeddingSecret(c.provider)) continue
    // 自定义只报当前地址那一把：换过地址的旧密钥对现在的配置不算数。
    if (c.provider === customKey) keys[EMBEDDING_CUSTOM] = { updatedAt: c.updatedAt }
    else if (!c.provider.startsWith(embeddingSecretName(EMBEDDING_CUSTOM))) keys[c.provider.slice('kb-embedding:'.length)] = { updatedAt: c.updatedAt }
  }
  return { embedding: s, presets: EMBEDDING_PRESETS, keys, status: await vectorInfo(db) }
}

/**
 * 换了模型之后让表跟上。表还没建就建（失败不拦保存，状态行会说）；表是空的就把指纹换成当前
 * 模型。**不动任何文件**：从旧向量库迁来的「可用」文件要管理员点「重建」才重新入库——那一下
 * 按单价向各家公司计费，得是人看过提示后点的。
 */
async function followConfig(db: Db): Promise<void> {
  const cfg = await loadEmbeddingConfig(db)
  if (cfg.error) return
  const stored = await db.knowledgeVectorConfig().catch(() => undefined)
  if (!stored) {
    await db.initializeKnowledgeVectors(cfg.profile, cfg.model, cfg.dimension).catch(() => undefined)
    return
  }
  if (stored.profile !== cfg.profile) await db.adoptKnowledgeVectorProfile(cfg.profile, cfg.model, cfg.dimension)
}

/** 自定义地址要过 SSRF 闸：拿到平台管理员会话的人不该能借 Gateway 探内网。本机测试开关放行。 */
async function customUrlOr400(next: KnowledgeEmbeddingSettings): Promise<void> {
  if (next.provider !== EMBEDDING_CUSTOM || process.env.GATEWAY_KB_EMBEDDING_ALLOW_PRIVATE === '1') return
  try {
    await guardUrl(next.baseUrl)
  } catch (e) {
    throw new HttpError(400, e instanceof WebToolError ? e.hint : '向量服务地址不可用')
  }
}

export function attachPlatformKnowledge(router: Router, ctx: RouteCtx) {
  const { db, keys } = ctx

  /** 老接口，只给状态行。新页面用下面那条一次拿全。 */
  router.get('/platform/knowledge/status', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    json(res, 200, await vectorInfo(db))
  })

  router.get('/platform/knowledge/embedding', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    json(res, 200, await embeddingView(db))
  })

  /**
   * 带哪个字段改哪个。配出来的组合必须能解析成一份合法配置，否则 400。
   *
   * 会让现有向量失效的改动（换服务商、换模型、换地址）要带 `confirm: true`，否则 409：这一下
   * 对所有公司生效，检索和入库会停到重建完，不能是下拉框里一次误点。
   */
  router.put('/platform/knowledge/embedding', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const body = bodyOf(req)
    if ('batchSize' in body) {
      const n = Number(body.batchSize)
      if (!Number.isInteger(n) || n < 1 || n > 64) throw new HttpError(400, '单次条数要是 1 到 64 的整数')
    }
    if ('region' in body && !['cn', 'intl'].includes(String(body.region))) throw new HttpError(400, '区域只能是 cn 或 intl')
    const settings = await db.platformSettings()
    const cur = parseKnowledgeEmbedding(settings.knowledgeEmbedding)
    const next = parseKnowledgeEmbedding({ ...cur, ...body })
    if ('provider' in body && String(body.provider ?? '') !== next.provider) throw new HttpError(400, '向量服务 id 不合法')
    if (next.provider && !knownProvider(next.provider)) throw new HttpError(400, `不认识的向量服务：${next.provider}`)
    const preset = EMBEDDING_PRESETS.find((p) => p.id === next.provider)
    if ('provider' in body && preset && preset.region !== next.region) throw new HttpError(400, `${preset.label} 不在当前选的区域里，先切区域`)
    // 换了一家，上一家的模型名不该跟过来（百炼的 text-embedding-v4 拿去调 OpenAI 只会 404）。
    if (next.provider !== cur.provider && !('model' in body)) next.model = ''
    const after = resolveEmbedding(next, 'probe')
    if (next.provider && after.error) throw new HttpError(400, after.error)
    await customUrlOr400(next)

    const stored = await db.knowledgeVectorConfig().catch(() => undefined)
    const vectors = stored ? await db.knowledgeVectorCount() : 0
    if (stored && vectors > 0 && (after.error || after.profile !== stored.profile) && body.confirm !== true) {
      throw new HttpError(409, `现有 ${vectors} 个向量由 ${stored.model} 生成，这样改之后所有公司的知识库检索和入库都会暂停，直到重建向量。确定要改吗？`)
    }

    await db.putPlatformSettings({ ...settings, knowledgeEmbedding: next })
    // 自定义地址换了 origin：旧地址那把密钥不会再被取到，删掉，别在库里留一份用不上的密钥。
    const keep = embeddingSecretName(EMBEDDING_CUSTOM, next.baseUrl)
    for (const c of await db.platformCredentials()) {
      if (c.provider.startsWith(embeddingSecretName(EMBEDDING_CUSTOM)) && c.provider !== keep) await db.deletePlatformCredential(c.provider)
    }
    await followConfig(db)
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.knowledge.embedding.update', detail: { ...next } })
    json(res, 200, await embeddingView(db))
  })

  router.put('/platform/knowledge/embedding/key', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const body = bodyOf(req)
    const provider = strField(body, 'provider')
    if (!knownProvider(provider)) throw new HttpError(400, `不认识的向量服务：${provider}`)
    const secret = strField(body, 'secret').trim()
    if (!secret) throw new HttpError(400, '密钥不能为空')
    const s = parseKnowledgeEmbedding((await db.platformSettings()).knowledgeEmbedding)
    // 自定义的密钥钉在已保存的地址上：地址还没存，就不知道这把密钥是给谁的。
    if (provider === EMBEDDING_CUSTOM && (s.provider !== EMBEDDING_CUSTOM || !s.baseUrl)) throw new HttpError(400, '先保存自定义接口地址，再填密钥')
    await db.upsertPlatformCredential(embeddingSecretName(provider, s.baseUrl), secret)
    // **不带密钥**，同网页工具那条。
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.knowledge.embedding.key', detail: { provider } })
    await followConfig(db)
    json(res, 200, await embeddingView(db))
  })

  /** 自检：拿一句固定的话打一次当前配置。不记用量——这是验配置，不是用。 */
  router.post('/platform/knowledge/embedding/test', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const cfg = await loadEmbeddingConfig(db)
    if (!embeddingUsable(cfg)) {
      json(res, 200, { ok: false, error: embeddingProblem(cfg) })
      return
    }
    const startedAt = Date.now()
    try {
      await embedTexts(cfg, ['知识库向量服务连通性自检'], Date.now() + 15_000)
      json(res, 200, { ok: true, model: cfg.model, dimension: cfg.dimension, elapsedMs: Date.now() - startedAt })
    } catch (e) {
      json(res, 200, { ok: false, error: (e as Error).message })
    }
  })

  router.post('/platform/knowledge/init', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const cfg = await loadEmbeddingConfig(db)
    if (cfg.error) throw new HttpError(400, cfg.error)
    try {
      await db.initializeKnowledgeVectors(cfg.profile, cfg.model, cfg.dimension)
    } catch (e) {
      throw new HttpError(400, `初始化向量表失败：${(e as Error).message}${INIT_HINT}`)
    }
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.knowledge.init', detail: { model: cfg.model } })
    json(res, 200, await embeddingView(db))
  })

  /**
   * 重建：丢掉全部旧向量、所有文件重新排队，维护节拍按当前模型重新入库。
   * 重建期间检索命中会变少；重新入库按当前平台单价计费——界面上点之前要说清楚。
   */
  router.post('/platform/knowledge/reindex', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const cfg = await loadEmbeddingConfig(db)
    if (!embeddingUsable(cfg)) throw new HttpError(400, embeddingProblem(cfg))
    if (!await db.knowledgeVectorConfig()) throw new HttpError(400, '向量表还没初始化')
    const queued = await db.reindexKnowledgeVectors(cfg.profile, cfg.model, cfg.dimension)
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.knowledge.reindex', detail: { model: cfg.model, queued } })
    json(res, 200, { queued, ...await embeddingView(db) })
  })
}
