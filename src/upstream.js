/**
 * 上游调用层：模型目录 + 流式请求。
 *
 * 设计要点：
 * 1. 所有上游都是「免鉴权」的 OpenAI 兼容端点，请求头不带任何 key。
 * 2. 模型目录按上游缓存 10 分钟，避免每个 turn 都拉 /models。
 * 3. 差异化冷却：429/5xx 冷却整个上游；400/404 只跳过（模型不认 != 上游挂了）。
 *
 * @module src/upstream.js
 */

/** 每个上游的兜底模型表（/models 拉不到时用） */
const FALLBACK_MODELS = {
  kilo: [
    'kilo-auto/free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'nvidia/nemotron-3.5-lightning:free',
    'nvidia/nemotron-3.5-super-vl:free',
    'reflection/beam-free',
    'stealth/glyph-cluster',
    'dots-studio/dots-3-note-preview:free',
    'cohere/north-mini-code:free',
  ],
  ovh: [
    'Meta-Llama-3_3-70B-Instruct',
    'Qwen3.5-397B-A17B',
    'Qwen3.8-27B',
    'Qwen3.5-9B',
  ],
}

/** 选型优先级：上游若有多模型，先挑这些 */
const PREFERRED = [
  'kilo-auto/free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'reflection/beam-free',
  'Meta-Llama-3_3-70B-Instruct',
]

/** 上游定义 */
export const UPSTREAMS = {
  kilo: {
    id: 'kilo',
    label: 'Kilo Gateway',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    // 免鉴权：不带 Authorization
    headers: {},
  },
  ovh: {
    id: 'ovh',
    label: 'OVHcloud AI',
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    headers: {},
  },
}

const CATALOG_TTL_MS = 10 * 60 * 1000

/** 每个上游的运行时状态（进程内单例） */
const runtime = new Map()

function stateOf(upstreamId) {
  let s = runtime.get(upstreamId)
  if (!s) {
    s = { blockedUntil: 0, catalog: null, catalogAt: 0 }
    runtime.set(upstreamId, s)
  }
  return s
}

export function isBlocked(upstreamId) {
  return Date.now() < stateOf(upstreamId).blockedUntil
}

export function blockUpstream(upstreamId, ms) {
  stateOf(upstreamId).blockedUntil = Date.now() + (ms > 0 ? ms : 15000)
}

export function statusSnapshot() {
  const out = []
  for (const key of Object.keys(UPSTREAMS)) {
    const s = stateOf(key)
    out.push({
      id: key,
      label: UPSTREAMS[key].label,
      blocked: Date.now() < s.blockedUntil,
      blockedForMs: Math.max(0, s.blockedUntil - Date.now()),
      modelCount: s.catalog?.length ?? 0,
    })
  }
  return out
}

/**
 * 拉取某个上游的模型目录，10 分钟内复用。
 * @param {string} upstreamId
 * @returns {Promise<string[]>}
 */
export async function catalogFor(upstreamId) {
  const upstream = UPSTREAMS[upstreamId]
  if (!upstream) return []
  const s = stateOf(upstreamId)
  if (s.catalog !== null && Date.now() - s.catalogAt < CATALOG_TTL_MS) {
    return s.catalog
  }

  let ids = []
  try {
    const res = await fetch(`${upstream.baseUrl}/models`, {
      headers: { 'Content-Type': 'application/json', ...upstream.headers },
      signal: AbortSignal.timeout(10000),
    })
    if (res.ok) {
      const body = await res.json()
      const raw = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
      ids = raw
        .map(entry => (typeof entry === 'string' ? entry : entry?.id ?? entry?.name))
        .filter(id => typeof id === 'string' && id.trim() !== '')
    }
  } catch {
    // 网络失败就走兜底表
  }

  if (ids.length === 0) ids = FALLBACK_MODELS[upstreamId] ?? []

  s.catalog = ids
  s.catalogAt = Date.now()
  return ids
}

/**
 * 把用户请求的模型名解析成该上游真正认的 id。
 *
 * 这是插件最关键的一处：用户可能填 `gpt-6-sol` 这种官方名，
 * 上游根本没有。静默降级到该上游首选的免费模型，避免整个 turn 直接失败。
 *
 * @param {string} upstreamId
 * @param {string} wanted
 * @returns {Promise<string>}
 */
export async function resolveModel(upstreamId, wanted) {
  const ids = await catalogFor(upstreamId)
  if (ids.length === 0) return wanted
  if (ids.includes(wanted)) return wanted

  const stripped = wanted.replace(/:free$/, '')
  const fuzzy = ids.find(id => id === stripped || id.startsWith(stripped) || id.includes(stripped))
  if (fuzzy !== undefined) return fuzzy

  for (const preferred of PREFERRED) {
    if (ids.includes(preferred)) return preferred
  }
  const freeIds = ids.filter(id => /free/i.test(id))
  if (freeIds.length > 0) return freeIds[0]
  return ids[0]
}

/**
 * 向上游发起一次流式对话请求。
 *
 * @param {string} upstreamId
 * @param {object} payload - OpenAI 兼容请求体
 * @param {AbortSignal} [signal]
 * @returns {Promise<Response>} 上游响应（调用方负责读流）
 */
export async function postStream(upstreamId, payload, signal) {
  const upstream = UPSTREAMS[upstreamId]
  if (!upstream) throw new Error(`unknown upstream: ${upstreamId}`)

  const timeout = AbortSignal.timeout(120000)
  // Node 20.3+ 才有 AbortSignal.any；低版本回退到手写组合，避免插件在老宿主上直接崩
  const composed = signal
    ? typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeout])
      : combineSignals(signal, timeout)
    : timeout

  return fetch(`${upstream.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...upstream.headers },
    body: JSON.stringify({ ...payload, stream: true }),
    signal: composed,
  })
}

/** 把两个 AbortSignal 合成一个：任一 abort 就 abort */
function combineSignals(a, b) {
  const controller = new AbortController()
  const forward = source => () => controller.abort(source.reason)
  if (a.aborted || b.aborted) {
    controller.abort(a.aborted ? a.reason : b.reason)
    return controller.signal
  }
  a.addEventListener('abort', forward(a), { once: true })
  b.addEventListener('abort', forward(b), { once: true })
  return controller.signal
}

/**
 * 按 Retry-After 或默认值给上游上冷却。
 * @param {string} upstreamId
 * @param {Response} res
 * @param {number} defaultMs
 */
export function coolDownFrom(upstreamId, res, defaultMs) {
  const retryAfter = Number(res?.headers?.get?.('retry-after'))
  const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : defaultMs
  blockUpstream(upstreamId, ms)
  return ms
}

/** 测试用：清空运行时状态 */
export function resetRuntime() {
  runtime.clear()
}
