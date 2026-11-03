/**
 * 零配置体验 —— 模块五（贯穿所有模块）。
 *
 * 计划书要求：
 * 1. 首次启动自动完成：匿名上游探测、代理内核初始化、默认分流规则加载、操作守门开启。
 * 2. 极简引导只问 1–2 个问题（是否自动配置免费模型、是否开启操作守门），其余全部自动。
 * 3. 所有配置项有合理默认值，高级用户可展开调整，小白不用碰。
 * 4. README 写「装完即用」。
 *
 * 设计：
 * - 所有配置项都有默认值，resolveConfig(partial) 永远返回完整可用的配置。
 * - 引导问题只有两个，且都有默认答案；用户不回答也能继续。
 * - 探测失败不阻塞：降级为该通道禁用，其他通道照常。
 *
 * @module src/bootstrap.js
 */

/** 全部默认值。改这里就等于改「装完即用」的行为。 */
export const DEFAULTS = Object.freeze({
  enabled: true,

  // 匿名上游
  kilo: { enabled: true, weight: 20 },
  ovh: { enabled: true, weight: 6 },

  // 统计
  ledger: { enabled: true, showAttemptLevel: false, includeBranch: false },

  // 分流
  routing: {
    enabled: true,
    probeTimeoutMs: 4000,
    separateWebRoute: true,
    followSystemProxy: true,
  },

  // 桌面编排
  desktop: { enabled: true, autoLaunch: true },

  // 守门（计划书要求默认开启）
  guard: { enabled: true, useAiReview: false },

  // 健康检查
  exposeHealth: true,
})

/** 引导只有这两个问题，且都有默认答案 */
export const ONBOARDING_QUESTIONS = Object.freeze([
  {
    id: 'autoConfigFreeModels',
    question: '是否自动配置免费模型？',
    default: true,
    hint: '推荐开启：装完就能直接对话，不需要填任何 key',
  },
  {
    id: 'enableGuard',
    question: '是否开启操作边界守门？',
    default: true,
    hint: '推荐开启：超出你原话范围的操作会先询问，不会直接执行',
  },
])

/**
 * 把用户给的片段配置补成完整配置。永远不抛错，永远有可用值。
 *
 * @param {object} [partial]
 * @returns {object}
 */
export function resolveConfig(partial) {
  const source = partial !== null && typeof partial === 'object' ? partial : {}
  return {
    enabled: source.enabled !== false,
    kilo: { ...DEFAULTS.kilo, ...(source.kilo ?? {}) },
    ovh: { ...DEFAULTS.ovh, ...(source.ovh ?? {}) },
    ledger: { ...DEFAULTS.ledger, ...(source.ledger ?? {}) },
    routing: { ...DEFAULTS.routing, ...(source.routing ?? {}) },
    desktop: { ...DEFAULTS.desktop, ...(source.desktop ?? {}) },
    guard: { ...DEFAULTS.guard, ...(source.guard ?? {}) },
    exposeHealth: source.exposeHealth !== false,
  }
}

/**
 * 一次性的引导状态机。
 * 只需要回答 1–2 个问题，不回答就用默认值走下去。
 */
export class Onboarding {
  /**
   * @param {object} [options]
   * @param {object} [options.persisted] 已经存下来的答案
   */
  constructor(options = {}) {
    this.answers = { ...(options.persisted ?? {}) }
    const keys = Object.keys(this.answers)
    this.completed = keys.length >= ONBOARDING_QUESTIONS.length
    this.askedOnce = options.askedOnce === true
  }

  /** 需要问哪几个问题（已答过的不再问） */
  pendingQuestions() {
    return ONBOARDING_QUESTIONS.filter(q => this.answers[q.id] === undefined)
  }

  /**
   * 提交一个答案。
   * @param {string} id
   * @param {boolean} value
   */
  answer(id, value) {
    const known = ONBOARDING_QUESTIONS.find(q => q.id === id)
    if (known === undefined) return { ok: false, reason: `unknown question: ${id}` }
    this.answers[id] = value !== false
    if (this.pendingQuestions().length === 0) this.completed = true
    return { ok: true, completed: this.completed }
  }

  /** 直接按默认值全部答完（用户点了「随便，你决定」） */
  acceptDefaults() {
    for (const q of ONBOARDING_QUESTIONS) {
      if (this.answers[q.id] === undefined) this.answers[q.id] = q.default
    }
    this.completed = true
    return { ...this.answers }
  }

  /** 把答案合并进配置 */
  applyTo(config) {
    const base = resolveConfig(config)
    const autoFree = this.answers.autoConfigFreeModels
    const guardOn = this.answers.enableGuard
    return {
      ...base,
      kilo: { ...base.kilo, enabled: autoFree !== false ? base.kilo.enabled : false },
      ovh: { ...base.ovh, enabled: autoFree !== false ? base.ovh.enabled : false },
      guard: { ...base.guard, enabled: guardOn !== false ? base.guard.enabled : false },
    }
  }

  snapshot() {
    return { completed: this.completed, answers: { ...this.answers }, pending: this.pendingQuestions().map(q => q.id) }
  }
}

/**
 * 首次启动的自动探测：并行探各个匿名上游，任何一个通就够用。
 * 探测失败不阻塞启动，只把该通道标成不可用。
 *
 * @param {object} options
 * @param {object} options.config
 * @param {(upstreamId: string) => Promise<{ok: boolean, models?: string[], error?: string}>} options.probeUpstream
 * @param {(msg: string) => void} [options.warn]
 * @returns {Promise<{available: string[], unavailable: string[], models: string[]}>}
 */
export async function probeUpstreams(options) {
  const config = resolveConfig(options.config)
  const upstreamIds = []
  if (config.kilo.enabled !== false) upstreamIds.push('kilo')
  if (config.ovh.enabled !== false) upstreamIds.push('ovh')

  const available = []
  const unavailable = []
  const models = []

  // 并行探测，任何一个失败都不影响其他
  const results = await Promise.all(
    upstreamIds.map(async id => {
      try {
        const result = await options.probeUpstream(id)
        return { id, ...result }
      } catch (error) {
        // 探测函数自己抛错也不能炸掉启动
        return { id, ok: false, error: String(error?.message ?? error) }
      }
    })
  )

  for (const result of results) {
    if (result.ok === true) {
      available.push(result.id)
      for (const model of result.models ?? []) models.push(model)
    } else {
      unavailable.push(result.id)
      options.warn?.(`freebridge/bootstrap: upstream "${result.id}" unavailable at startup: ${result.error ?? 'unknown'}`)
    }
  }

  return { available, unavailable, models }
}

/**
 * 首启完整流程：探测 → 补配置 → 得到可直接用的运行时配置。
 *
 * @param {object} options
 * @param {object} options.config
 * @param {object} options.onboarding
 * @param {Function} options.probeUpstream
 * @param {(msg: string) => void} [options.warn]
 */
export async function bootstrap(options) {
  const onboarding = options.onboarding ?? new Onboarding()
  // 用户没回答就用默认值，绝不卡在引导页
  if (onboarding.completed !== true) onboarding.acceptDefaults()

  const config = onboarding.applyTo(options.config)

  const probe = await probeUpstreams({
    config,
    probeUpstream: options.probeUpstream,
    warn: options.warn,
  })

  // 全部不可用也不算失败：继续用默认兜底模型表
  if (probe.available.length === 0) {
    options.warn?.('freebridge/bootstrap: no anonymous upstream reachable at startup; will retry on demand')
  }

  return {
    config,
    probe,
    ready: true,
    degradedUpstreams: probe.unavailable,
  }
}
