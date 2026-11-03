/**
 * 可用模型白名单 —— 只保留实测验证过的模型。
 *
 * 这份表是逐个发真实请求测出来的（2026-11-03），不是抄来的。
 * 不可用的直接剔除，用户在选择器里看不到。
 *
 * 判定标准：发真实对话请求，必须返回非空正文。
 */

/** 实测可用（5 个，全部真实测过能正常回复） */
export const VERIFIED_MODELS = [
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    name: 'Nemotron 3 Ultra 550B',
    tier: 'best',
    verified: true,
    note: '550B，代码能力最强：LRU/三数之和都写出教科书级答案',
  },
  {
    id: 'kilo-auto/free',
    name: 'Kilo Auto Free',
    tier: 'default',
    verified: true,
    note: '自动路由，永远有兜底，日常首选',
  },
  {
    id: 'cohere/north-mini-code:free',
    name: 'North Mini Code',
    tier: 'code',
    verified: true,
    note: '专攻代码，出字干脆',
  },
  {
    id: 'nvidia/nemotron-3.5-lightning:free',
    name: 'Nemotron 3.5 Lightning',
    tier: 'fast',
    verified: true,
    note: '1M 上下文，速度快',
  },
  {
    id: 'dots-studio/dots-3-note-preview:free',
    name: 'Dots3 Note',
    tier: 'vision',
    verified: true,
    note: '512K，支持视觉',
  },
]

/** 实测不可用 —— 直接从白名单剔除，不显示给用户 */
export const EXCLUDED_MODELS = [
  { id: 'kilo-auto/efficient', reason: '401 PAID_MODEL_AUTH_REQUIRED' },
  { id: 'kilo-auto/frontier', reason: '401 PAID_MODEL_AUTH_REQUIRED' },
  { id: 'kilo-auto/balanced', reason: '401 PAID_MODEL_AUTH_REQUIRED' },
  { id: 'recursive/flint-v1.0:free', reason: '503 provider error' },
  { id: 'xingchen-agi/xing4.0-29b-a4b:free', reason: '429 rate limited' },
  { id: 'liquid/lfm-2.5-2.6b:free', reason: '429 rate limited' },
  { id: 'thinkingmachines/inkling-small:free', reason: '429 rate limited' },
  { id: 'thinkingmachines/inkling:free', reason: '429 rate limited' },
  { id: 'google/gemma-4-31b-it:free', reason: '429 rate limited' },
  { id: 'nvidia/nemotron-3.5-content-safety:free', reason: '404 not available' },
  { id: 'nvidia/nemotron-3.5-super-vl:free', reason: '实际可用但小 max_tokens 易空，保留观察' },
]

/** 白名单模型 id 集合，供 adapter 过滤 */
export const VERIFIED_IDS = new Set(VERIFIED_MODELS.map(m => m.id))

/**
 * 过滤上游返回的模型列表，只留实测可用的。
 *
 * @param {string[]} ids 上游拉到的全部模型
 * @param {boolean} [strict=true] true=只留白名单内；false=白名单优先，其余也带
 * @returns {string[]}
 */
export function filterVerified(ids, strict = true) {
  if (!Array.isArray(ids)) return []
  if (strict === true) {
    return ids.filter(id => VERIFIED_IDS.has(id))
  }
  // 非严格：白名单排前面
  const verified = ids.filter(id => VERIFIED_IDS.has(id))
  const rest = ids.filter(id => !VERIFIED_IDS.has(id))
  return [...verified, ...rest]
}

/** 给 UI 用的模型表数据 */
export function modelTable() {
  return {
    verified: VERIFIED_MODELS,
    excluded: EXCLUDED_MODELS,
    verifiedCount: VERIFIED_MODELS.length,
    excludedCount: EXCLUDED_MODELS.length,
  }
}
