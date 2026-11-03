/**
 * harness provider 适配器。
 *
 * registerAdapter 是结构性校验：宿主调用这些方法，不看 instanceof。
 * 所以这里不 import 任何版本相关的基类，才能在多个 kernel 线上挂载。
 *
 * 本模块负责把「桥接」和「记账」「分流」串起来：
 * 每次真实请求都落一条账本记录，并把分流决策写进元数据。
 *
 * @module src/adapter.js
 */

import { UPSTREAMS, catalogFor, coolDownFrom, isBlocked, postStream, resolveModel, statusSnapshot } from './upstream.js'
import { readStream } from './parse.js'
import { estimateTokens } from './ledger.js'
import { ROUTE_KIND, hostOf } from './router.js'
import { VERIFIED_MODELS, filterVerified } from './models.js'

export const ROUTE = 'freebridge'
export const ROUTE_LABEL = 'FreeBridge'

/** 上游失败但可换一个继续的判定 */
function isFailoverable(code) {
  return code === 'EMPTY_RESPONSE' || code === 'SERVER' || code === 'RATE_LIMIT' || code === 'TRANSPORT'
}

export class FreeBridgeAdapter {
  /**
   * @param {object} deps
   * @param {() => object} deps.settings 读取当前插件设置
   * @param {(msg: string) => void} [deps.warn]
   * @param {object|null} [deps.ledger] TokenLedger 实例（可为 null，模块降级时就是 null）
   * @param {object|null} [deps.router] NetworkRouter 实例
   */
  constructor(deps) {
    this.deps = deps
  }

  /** 账本是否可用 —— 模块挂了也要能继续对话，记账只是旁路 */
  get ledger() {
    return this.deps.ledger ?? null
  }

  get router() {
    return this.deps.router ?? null
  }

  providerInfo(provider) {
    return { id: provider, name: ROUTE_LABEL }
  }

  /**
   * 重试策略必须是「已解析」的扁平对象。
   * 宿主把顶层的 delay 字段直接读走；包在 backoff 里会让每个 delay 变成 NaN，
   * 进而让可恢复的瞬时失败变成 aborted turn。
   */
  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 1,
      retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
      initialDelayMs: 700,
      maxDelayMs: 8000,
      jitterRatio: 0.2,
    })
  }

  /**
   * 视觉 token 估算。宿主 spill-policy 拿到 undefined 会放弃整条含图结果落盘，
   * 所以必须同步返回一个定价对象。
   */
  imageRequestPricing() {
    return {
      currency: 'USD',
      perImage: 0,
      perPixel: 0,
      note: 'free upstream: no image billing protocol, reported as zero cost',
    }
  }

  /** 当前该 route 对外暴露的模型。
   *
   * 只暴露实测可用的模型 —— 不可用的直接从选择器剔除，
   * 避免用户点到就报错（这是用户明确要求的行为）。
   */
  async listModels(provider) {
    const settings = this.deps.settings()
    const enabled = enabledUpstreams(settings)
    const rows = []
    const seen = new Set()

    for (const upstreamId of enabled) {
      const catalog = await catalogOf(upstreamId)
      // 只留实测可用的
      const usable = filterVerified(catalog, settings?.strictModels !== false)
      for (const id of usable) {
        if (seen.has(id)) continue
        seen.add(id)
        rows.push({
          provider,
          id,
          name: displayName(upstreamId, id),
          description: `${UPSTREAMS[upstreamId].label} · 已实测可用`,
          inputModalities: ['text'],
        })
      }
    }

    // 白名单模型即使上游目录拉不到也照样暴露（保证用户始终有可用模型）
    for (const model of VERIFIED_MODELS) {
      if (seen.has(model.id)) continue
      seen.add(model.id)
      rows.push({
        provider,
        id: model.id,
        name: model.name,
        description: model.note,
        inputModalities: model.tier === 'vision' ? ['text', 'image'] : ['text'],
      })
    }

    return rows
  }

  /**
   * 主入口。返回 async iterator，产出 chunk 事件。
   *
   * @param {object} options - GenerateOptions（含 model / messages / signal）
   * @param {object|null} pinned - prepareCall 冻结的目录行
   */
  /**
   * 解析单个模型的元数据。
   *
   * 这是宿主必需的契约方法（截图里 "registration.adapter.resolveModel
   * is not a function" 就是因为缺它）。宿主用它拿上下文窗口和输出上限，
   * 决定预算、压缩阈值、pill 显示等。
   *
   * @param {string} provider
   * @param {string} model
   */
  async resolveModel(provider, model) {
    const base = String(model).split('::')[0]
    const upstreamId = enabledUpstreams(this.deps.settings())[0] ?? 'kilo'
    let canonical = base
    try {
      canonical = await resolveModel(upstreamId, base)
    } catch {
      // 解析失败就用原名，不影响对话
    }

    return {
      provider,
      id: base,
      name: displayName(upstreamId, canonical),
      inputModalities: ['text'],
      context: { contextWindow: 131072 },
      defaultMaxTokens: 8192,
    }
  }

  /**
   * 绑定一次调用的模型元数据与流式闭包。
   *
   * 宿主在发起一轮前调用它，拿到 { model, stream }。
   * 把 stream 闭包绑在这里，可以保证中途目录刷新不会把两代状态混在一起。
   *
   * @param {string} provider
   * @param {string} model
   */
  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model)
    return {
      model: resolved,
      stream: options => this.stream(options, null),
    }
  }

  stream(options, pinned) {
    const controller = new AbortController()
    const onAbort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })

    const iterator = this.runStream({ ...options, signal: controller.signal }, pinned)
    const cleanup = () => options.signal?.removeEventListener('abort', onAbort)
    const step = async (method, value) => {
      try {
        const row = await iterator[method](value)
        if (row.done) cleanup()
        return row
      } catch (error) {
        cleanup()
        throw error
      }
    }

    return {
      [Symbol.asyncIterator]() {
        return this
      },
      next: value => step('next', value),
      return: value => {
        controller.abort()
        cleanup()
        return step('return', value)
      },
      throw: error => {
        controller.abort(error)
        cleanup()
        return step('throw', error)
      },
    }
  }

  async * runStream(options, pinned) {
    const settings = this.deps.settings()
    if (settings.enabled === false) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'FreeBridge is switched off in its settings', code: 'CONFIG_DISABLED' },
        },
      }
      return
    }

    const enabled = enabledUpstreams(settings)
    const wantedModel = pinned?.id ?? options.model

    // 按权重加权随机排序，同时剔除冷却中的上游
    const candidates = orderedCandidates(enabled, settings)
    if (candidates.length === 0) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'all free upstreams are cooling down, retry shortly', code: 'RATE_LIMIT' },
        },
      }
      return
    }

    const failures = []
    for (const upstreamId of candidates) {
      const outcome = yield* this.tryUpstream(upstreamId, wantedModel, options, settings)
      if (outcome === 'committed') return
      failures.push(`${upstreamId}: ${outcome}`)
    }

    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: `every free upstream failed (${failures.join('; ')})`,
          code: 'SERVER',
        },
      },
    }
  }

  /**
   * 单上游尝试。
   *
   * 提交规则：在拿到第一个正文 delta 之前，所有 chunk 都先扣着不发；
   * 一旦正文出现就把缓冲全部倒出去并标记 committed —— 此时答案已经属于调用方，
   * 后续失败按正常 turn 结束处理，不再换上游（否则会把两段文本拼在一起）。
   *
   * reasoning delta 故意不算提交：「想了一分钟然后撞上配额墙」是最值得换上游的场景。
   *
   * @returns {AsyncGenerator<string>} 'committed' | 'failed'
   */
  async * tryUpstream(upstreamId, wantedModel, options, settings) {
    if (isBlocked(upstreamId)) return 'cooling'

    let model
    try {
      // 不允许静默降级：用户点的是哪个模型就用哪个。
      // 之前允许降级会导致「点了 nemotron 实际跑的是别的模型」，
      // 而且降级目标一旦坏了就报 model-rejected，看起来像是模型不可用。
      model = await resolveModel(upstreamId, wantedModel, { allowFallback: false })
    } catch (error) {
      // 这个上游没有该模型：只跳过，不当作上游故障
      this.deps.warn?.(`freebridge: ${upstreamId} has no model "${wantedModel}": ${error?.message ?? error}`)
      return 'no-model'
    }

    const payload = buildPayload(model, options)
    const sessionId = String(options.sessionId ?? options.conversationId ?? 'unknown')

    // ── 分流决策：模型请求单独一条策略，不和网页抓取混在一起 ──
    const routeDecision = await this.decideRoute(upstreamId, sessionId)

    const started = Date.now()
    let response
    try {
      response = await postStream(upstreamId, payload, options.signal)
    } catch (error) {
      if (options.signal?.aborted === true) {
        this.recordAttempt({ sessionId, upstreamId, model, options, ok: false, latencyMs: Date.now() - started, route: routeDecision, error: 'request aborted' })
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } } }
        return 'committed'
      }
      this.deps.warn?.(`freebridge: ${upstreamId} transport failed: ${error?.message ?? error}`)
      coolDownFrom(upstreamId, null, 15000)
      this.recordAttempt({ sessionId, upstreamId, model, options, ok: false, latencyMs: Date.now() - started, route: routeDecision, error: String(error?.message ?? error) })
      this.learnRoute(upstreamId, false, routeDecision, String(error?.message ?? error))
      return 'transport'
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const status = response.status
      // 400/404：模型不认，只跳过不冷却
      if (status === 400 || status === 404) {
        this.deps.warn?.(`freebridge: ${upstreamId} rejected model "${model}" (${status})`)
        this.recordAttempt({ sessionId, upstreamId, model, options, ok: false, latencyMs: Date.now() - started, route: routeDecision, error: `model rejected (${status})` })
        return 'model-rejected'
      }
      coolDownFrom(upstreamId, response, 20000)
      this.deps.warn?.(`freebridge: ${upstreamId} returned ${status}: ${text.slice(0, 120)}`)
      this.recordAttempt({ sessionId, upstreamId, model, options, ok: false, latencyMs: Date.now() - started, route: routeDecision, error: `http ${status}` })
      this.learnRoute(upstreamId, false, routeDecision, `http ${status}`)
      return status === 429 ? 'rate-limited' : 'server-error'
    }

    // 扣住 chunk，等第一个正文 delta 再决定提交还是丢弃
    const held = []
    let committed = false
    // 自己累计 usage：上游可能不给，那就本地估算
    let reportedUsage = null
    let textForEstimate = ''

    const streamOptions = {
      onFirstText: () => {
        committed = true
      },
    }

    const reader = readStream(response, streamOptions)
    for await (const chunk of reader) {
      if (chunk.type === 'usage') reportedUsage = chunk.usage
      if (chunk.type === 'text-delta') textForEstimate += chunk.text

      if (!committed) {
        held.push(chunk)
        // finish 且未提交 => 这一轮没产出，丢弃整条并换上游
        if (chunk.type === 'finish') {
          const code = chunk.reason?.failure?.code
          if (chunk.reason?.kind === 'error' && isFailoverable(code)) {
            // 空响应对上游是个强信号，冷却短一点
            if (code === 'EMPTY_RESPONSE') coolDownFrom(upstreamId, null, 20000)
            this.recordAttempt({ sessionId, upstreamId, model, options, ok: false, latencyMs: Date.now() - started, route: routeDecision, error: String(code) })
            return `empty(${code})`
          }
          // 非错误的 finish（例如 length）：也得提交，否则调用方什么都没拿到
          for (const item of held) yield item
          this.recordAttempt({ sessionId, upstreamId, model, options, ok: true, latencyMs: Date.now() - started, route: routeDecision, usage: reportedUsage, text: textForEstimate })
          this.learnRoute(upstreamId, true, routeDecision)
          return 'committed'
        }
        continue
      }

      // committed 刚翻转为 true：必须先把扣下的 reasoning chunk 倒空再发正文，
      // 否则调用方会先收到 text-delta、后收到 reasoning，顺序整个错乱。
      if (held.length > 0) {
        for (const item of held) yield item
        held.length = 0
      }
      yield chunk
    }

    if (!committed) {
      // 整条流走完了都没有正文
      this.recordAttempt({ sessionId, upstreamId, model, options, ok: false, latencyMs: Date.now() - started, route: routeDecision, error: 'no text produced' })
      return 'empty(no-text)'
    }

    // 已提交：把缓冲里剩下的（含 finish）补发出去
    if (held.length > 0) {
      for (const item of held) yield item
    }
    this.recordAttempt({ sessionId, upstreamId, model, options, ok: true, latencyMs: Date.now() - started, route: routeDecision, usage: reportedUsage, text: textForEstimate })
    this.learnRoute(upstreamId, true, routeDecision)
    return 'committed'
  }

  /**
   * 决定这次请求走直连还是代理。
   * 分流器不可用时一律当直连（绝不因为分流挂了就不让对话）。
   */
  async decideRoute(upstreamId, sessionId) {
    const baseUrl = UPSTREAMS[upstreamId]?.baseUrl
    if (baseUrl === undefined) return null
    const host = hostOf(baseUrl)
    if (host === null) return null

    const router = this.router
    const settings = this.deps.settings()
    if (router === null || settings?.routing?.enabled === false) {
      return { host, route: 'direct', learned: false, source: 'router-disabled' }
    }

    try {
      // 只查记忆，不在请求路径上同步探测（会拖慢对话）
      const learned = router.lookup(host, ROUTE_KIND.MODEL)
      return { host, route: learned.route, learned: learned.learned, source: 'memory' }
    } catch (error) {
      this.deps.warn?.(`freebridge: route lookup failed: ${error?.message ?? error}`)
      return { host, route: 'direct', learned: false, source: 'lookup-failed' }
    }
  }

  /** 把真实请求结果反馈给分流器，让它自我修正 */
  learnRoute(upstreamId, ok, routeDecision, error) {
    const router = this.router
    if (router === null || routeDecision?.host === undefined) return
    try {
      router.record(routeDecision.host, ok, {
        kind: ROUTE_KIND.MODEL,
        viaProxy: routeDecision.route === 'proxy',
        error,
      })
    } catch (err) {
      this.deps.warn?.(`freebridge: route record failed: ${err?.message ?? err}`)
    }
  }

  /**
   * 落一条账本记录。
   *
   * 账本挂了绝不影响对话 —— 这是模块一降级的保证。
   *
   * @param {object} input
   */
  recordAttempt(input) {
    const ledger = this.ledger
    if (ledger === null) return

    const usage = input.usage
    const hasUsage = usage !== null && usage !== undefined
    // 上游给了 usage 就用上游的；没给就本地估算并标 estimated=true
    const inputTokens = hasUsage ? Number(usage.inputTokens ?? 0) : estimateTokens(promptTextOf(input.options))
    const outputTokens = hasUsage ? Number(usage.outputTokens ?? 0) : estimateTokens(input.text ?? '')

    try {
      ledger.append({
        sessionId: input.sessionId,
        turnIndex: input.options?.turnIndex,
        provider: ROUTE,
        upstream: input.upstreamId,
        model: input.model,
        level: input.ok === true ? 'logical' : 'attempt',
        inputTokens,
        outputTokens,
        reasoningTokens: hasUsage ? Number(usage.reasoningTokens ?? 0) : 0,
        estimated: hasUsage !== true,
        billable: input.ok === true ? 'yes' : 'unknown',
        ok: input.ok === true,
        latencyMs: input.latencyMs,
        route: input.route?.route ?? null,
        meta: input.route === null || input.route === undefined
          ? undefined
          : { kind: 'route', route: input.route.route, via: input.route.source, detail: input.error ?? null },
      })
    } catch (error) {
      this.deps.warn?.(`freebridge: ledger append failed: ${error?.message ?? error}`)
    }
  }
}

/** 组装发往上游的 OpenAI 兼容请求体 */
function buildPayload(model, options) {
  const payload = {
    model,
    messages: toChatMessages(options.messages),
    stream: true,
  }
  if (Number.isFinite(options.maxTokens) && options.maxTokens > 0) {
    payload.max_tokens = options.maxTokens
  }
  if (Number.isFinite(options.temperature)) payload.temperature = options.temperature
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    payload.tools = options.tools
  }
  return payload
}

/** 把 messages 拼成纯文本，只用于本地 token 估算 */
function promptTextOf(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  return messages.map(message => extractText(message)).join('\n')
}

/**
 * harness message -> OpenAI chat messages。
 * 只保留 text，丢弃宿主内部字段，避免上游因未知字段报错。
 */
function toChatMessages(messages) {
  if (!Array.isArray(messages)) return [{ role: 'user', content: '' }]
  const out = []
  for (const message of messages) {
    const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'system' ? 'system' : 'user'
    const content = extractText(message)
    if (content === '') continue
    out.push({ role, content })
  }
  if (out.length === 0) out.push({ role: 'user', content: '' })
  return out
}

function extractText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        if (part?.type === 'text') return part.text ?? ''
        return ''
      })
      .join('')
  }
  return ''
}

/** 插件设置里启用了哪些上游 */
function enabledUpstreams(settings) {
  const out = []
  for (const id of Object.keys(UPSTREAMS)) {
    const conf = settings?.[id]
    if (conf?.enabled === false) continue
    out.push(id)
  }
  return out
}

/** 加权随机排序 + 剔除冷却 */
function orderedCandidates(enabled, settings) {
  return enabled
    .filter(id => !isBlocked(id))
    .map(id => {
      const weight = Number(settings?.[id]?.weight ?? 1)
      return { id, score: (Number.isFinite(weight) ? weight : 1) * (0.5 + Math.random()) }
    })
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.id)
}

async function catalogOf(upstreamId) {
  return catalogFor(upstreamId)
}

function displayName(upstreamId, id) {
  const label = UPSTREAMS[upstreamId].label
  const pretty = id.replace(/:free$/, '')
  return `${label} · ${pretty}`
}

export { statusSnapshot }
