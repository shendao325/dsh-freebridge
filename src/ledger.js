/**
 * Token 账本 —— 模块一的核心。
 *
 * 设计规则（严格对齐计划书）：
 * 1. 账本按「请求事件」追加记录，只增不删。编辑消息 / 撤回 / 旁支提问
 *    都不回头扣减历史。这是「历史消耗不回溯扣减」的实现方式。
 * 2. 尝试级(attempt) / 逻辑级(logical) 双计数：
 *    - attempt 记每次真实发出的请求（重试会多次记）
 *    - logical 只记最终成功的那个渠道
 *    设置页默认看逻辑级，展开看尝试级，防止重试把总量算虚。
 * 3. 失败请求记 attempt，但 billable='unknown'，不算进渠道消耗。
 * 4. 只存计数和元数据，绝不存 prompt / completion 原文。
 * 5. 归档会话也能统计：聚合结果自己持久化，不依赖原始会话文件还在。
 *
 * @module src/ledger.js
 */

import fs from 'node:fs'
import path from 'node:path'

const SCHEMA = 'freebridge/ledger/v1'

/** 一行账本记录的字段白名单 —— 写进去的只能是这些，防止误存原文 */
const RECORD_FIELDS = [
  'id',
  'at',
  'sessionId',
  'turnIndex',
  'branch',
  'edited',
  'retracted',
  'provider',
  'upstream',
  'model',
  'level',
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'totalTokens',
  'estimated',
  'billable',
  'attempt',
  'ok',
  'latencyMs',
  'route',
  'meta',
]

/**
 * 账本。
 *
 * 内存索引 + 追加式 JSONL 落盘。落盘是逐事件的，
 * 所以即使 DSH 崩溃，已经发生的消耗也不会丢。
 */
export class TokenLedger {
  /**
   * @param {object} options
   * @param {string} options.dir 账本目录（默认由 host 提供）
   * @param {(msg: string) => void} [options.warn]
   */
  constructor(options) {
    this.dir = options.dir
    this.warn = options.warn ?? (() => {})
    this.file = path.join(this.dir, 'events.jsonl')
    /** @type {object[]} 追加式记录，索引常驻内存 */
    this.records = []
    this.seq = 0
    this.loaded = false
  }

  /** 从磁盘恢复。坏行跳过，不让一行脏数据毁掉整个账本。 */
  load() {
    if (this.loaded) return
    this.loaded = true
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      if (!fs.existsSync(this.file)) return
      const raw = fs.readFileSync(this.file, 'utf8')
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const record = JSON.parse(trimmed)
          if (record?.id === undefined) continue
          this.records.push(record)
          this.seq = Math.max(this.seq, Number(record.id) || 0)
        } catch {
          // 坏行跳过
        }
      }
    } catch (error) {
      this.warn(`freebridge/ledger: load failed: ${error?.message ?? error}`)
    }
  }

  /**
   * 追加一条记录。
   *
   * @param {object} input
   * @param {string} input.sessionId
   * @param {string} [input.provider] 逻辑供应商 route
   * @param {string} [input.upstream] 实际上游（kilo / ovh）
   * @param {string} [input.model]
   * @param {'attempt'|'logical'} [input.level]
   * @param {number} [input.inputTokens]
   * @param {number} [input.outputTokens]
   * @param {number} [input.reasoningTokens]
   * @param {boolean} [input.estimated]
   * @param {'yes'|'no'|'unknown'} [input.billable]
   * @param {boolean} [input.ok] 这次请求成功了吗
   * @param {boolean} [input.branch] 旁支提问
   * @param {boolean} [input.edited] 该轮次被编辑过
   * @param {boolean} [input.retracted] 该轮次被撤回
   * @param {object} [input.meta] 元数据（分流决策、守门拦截、桌面操作等）
   * @returns {object} 落账后的记录
   */
  append(input) {
    this.load()
    this.seq += 1

    const inputTokens = Math.max(0, Math.round(coerceNumber(input.inputTokens)))
    const outputTokens = Math.max(0, Math.round(coerceNumber(input.outputTokens)))
    const reasoningTokens = Math.max(0, Math.round(coerceNumber(input.reasoningTokens)))

    const record = {
      id: this.seq,
      at: Date.now(),
      sessionId: String(input.sessionId ?? 'unknown'),
      turnIndex: coerceNumber(input.turnIndex, 0),
      branch: input.branch === true,
      edited: input.edited === true,
      retracted: input.retracted === true,
      provider: input.provider ?? null,
      upstream: input.upstream ?? null,
      model: input.model ?? null,
      level: input.level === 'logical' ? 'logical' : 'attempt',
      inputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens: inputTokens + outputTokens,
      estimated: input.estimated === true,
      billable: input.billable === 'yes' || input.billable === 'no' ? input.billable : 'unknown',
      attempt: Math.max(1, Math.round(coerceNumber(input.attempt, 1))),
      ok: input.ok === true,
      latencyMs: Math.max(0, Math.round(coerceNumber(input.latencyMs))),
      route: input.route ?? null,
      meta: normalizeMeta(input.meta),
    }

    this.records.push(record)
    this.persist(record)
    return record
  }

  /** 标记某一轮的编辑/撤回状态。只改标记位，**不动数值**。 */
  markTurn(sessionId, turnIndex, flags) {
    this.load()
    let touched = 0
    for (const record of this.records) {
      if (record.sessionId !== sessionId) continue
      if (record.turnIndex !== turnIndex) continue
      if (flags?.edited === true) record.edited = true
      if (flags?.retracted === true) record.retracted = true
      touched += 1
    }
    if (touched > 0) this.rewrite()
    return touched
  }

  /** 追加一条元数据事件（分流/守门/桌面操作），不参与 token 统计。 */
  appendMeta(sessionId, kind, payload) {
    return this.append({
      sessionId,
      level: 'attempt',
      ok: true,
      billable: 'no',
      meta: { kind, ...normalizeMeta(payload) },
    })
  }

  persist(record) {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.appendFileSync(this.file, JSON.stringify(pickFields(record)) + '\n', 'utf8')
    } catch (error) {
      this.warn(`freebridge/ledger: persist failed: ${error?.message ?? error}`)
    }
  }

  /** 标记类操作要整文件重写（编辑/撤回是唯一的例外） */
  rewrite() {
    try {
      const body = this.records.map(record => JSON.stringify(pickFields(record))).join('\n')
      fs.writeFileSync(this.file, body === '' ? '' : body + '\n', 'utf8')
    } catch (error) {
      this.warn(`freebridge/ledger: rewrite failed: ${error?.message ?? error}`)
    }
  }

  // ─── 统计 ──────────────────────────────────────────────────────────────

  /**
   * 全局统计。
   *
   * @param {object} [options]
   * @param {'logical'|'attempt'} [options.level='logical']
   * @param {boolean} [options.branch=false] 旁支是否计入（默认不计）
   * @returns {object}
   */
  globalStats(options = {}) {
    this.load()
    const level = options.level === 'attempt' ? 'attempt' : 'logical'
    const withBranch = options.branch === true

    const totals = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, requests: 0 }
    const byProvider = new Map()
    const byModel = new Map()
    const byDay = new Map()
    let estimatedCount = 0
    let billableUnknown = 0
    let failedAttempts = 0

    for (const record of this.records) {
      const isTokenRecord = record.totalTokens > 0 || record.inputTokens > 0 || record.outputTokens > 0
      if (!isTokenRecord) continue
      if (!withBranch && record.branch === true) continue

      // 失败请求：记 attempt 但标 billable=unknown，不直接算进渠道消耗。
      // 这一步必须放在 level 过滤之前 —— 否则逻辑级视图下失败请求会被
      // `level !== 'logical'` 直接跳过，计数永远是 0。
      if (record.ok !== true) {
        failedAttempts += 1
        if (record.billable === 'unknown') billableUnknown += 1
        continue
      }

      // 逻辑级：跳过 attempt-only 的重复计入（同 turn 只算最终成功渠道）
      if (level === 'logical' && record.level !== 'logical') continue

      totals.inputTokens += record.inputTokens
      totals.outputTokens += record.outputTokens
      totals.reasoningTokens += record.reasoningTokens
      totals.totalTokens += record.totalTokens
      totals.requests += 1
      if (record.estimated === true) estimatedCount += 1

      const providerKey = record.provider ?? 'unknown'
      addInto(byProvider, providerKey, record)

      const modelKey = `${record.provider ?? 'unknown'}::${record.model ?? 'unknown'}`
      addInto(byModel, modelKey, record)

      const day = new Date(record.at).toISOString().slice(0, 10)
      addInto(byDay, day, record)
    }

    return {
      level,
      totals,
      estimatedCount,
      billableUnknown,
      failedAttempts,
      byProvider: toSortedArray(byProvider, ['provider']),
      byModel: toSortedArray(byModel, ['provider', 'model']),
      byDay: [...byDay.entries()]
        .map(([day, value]) => ({ day, ...value }))
        .sort((a, b) => a.day.localeCompare(b.day)),
    }
  }

  /**
   * 会话列表：每行显示会话标识、起止时间、总 Token（逻辑级）。
   * @returns {object[]}
   */
  sessions() {
    this.load()
    const map = new Map()
    for (const record of this.records) {
      if (record.totalTokens <= 0) continue
      // 失败请求不进会话总量（它的 billable 是 unknown）
      if (record.ok !== true) continue
      const entry = map.get(record.sessionId) ?? {
        sessionId: record.sessionId,
        startAt: record.at,
        endAt: record.at,
        logicalTokens: 0,
        attemptTokens: 0,
        turns: new Set(),
      }
      entry.startAt = Math.min(entry.startAt, record.at)
      entry.endAt = Math.max(entry.endAt, record.at)
      entry.turns.add(record.turnIndex)
      // attemptTokens = 该会话所有成功请求（attempt 级，含重试成功的那些）
      entry.attemptTokens += record.totalTokens
      // logicalTokens = 只算标记为 logical 的最终成功渠道
      if (record.level === 'logical') entry.logicalTokens += record.totalTokens
      map.set(record.sessionId, entry)
    }
    return [...map.values()]
      .map(entry => ({
        sessionId: entry.sessionId,
        startAt: entry.startAt,
        endAt: entry.endAt,
        durationMs: entry.endAt - entry.startAt,
        turns: entry.turns.size,
        logicalTokens: entry.logicalTokens,
        attemptTokens: entry.attemptTokens,
      }))
      .sort((a, b) => b.endAt - a.endAt)
  }

  /**
   * 单会话三层明细：会话 -> 供应商 -> 模型。
   *
   * 段边界按 upstream + model 变化自动切分：
   * 同一会话中途换供应商会归属到对应段。
   *
   * @param {string} sessionId
   * @returns {object|null}
   */
  sessionDetail(sessionId) {
    this.load()
    const records = this.records.filter(r => r.sessionId === sessionId)
    if (records.length === 0) return null

    let logicalTotal = 0
    let attemptTotal = 0
    let mainTotal = 0
    let branchTotal = 0
    let editedTurns = 0
    let retractedTurns = 0
    const providerMap = new Map()
    const segments = []

    let currentSegment = null

    for (const record of records) {
      if (record.totalTokens > 0) {
        // 尝试级总量：所有成功请求（含重试成功）
        if (record.ok === true) attemptTotal += record.totalTokens
        // 逻辑级 / 主分支 / 旁支：只认 logical 记录，避免重试把数值算虚
        if (record.level === 'logical') {
          logicalTotal += record.totalTokens
          if (record.branch === true) branchTotal += record.totalTokens
          else mainTotal += record.totalTokens
        }

        if (record.edited === true) editedTurns += 1
        if (record.retracted === true) retractedTurns += 1

        // 按 供应商 -> 模型 分组
        const providerKey = record.provider ?? 'unknown'
        const providerEntry = providerMap.get(providerKey) ?? {
          provider: providerKey,
          totalTokens: 0,
          requests: 0,
          models: new Map(),
        }
        providerEntry.totalTokens += record.totalTokens
        providerEntry.requests += 1
        addInto(providerEntry.models, record.model ?? 'unknown', record)
        providerMap.set(providerKey, providerEntry)

        // 段切分：upstream + model 变化就切
        const segmentKey = `${record.upstream ?? 'unknown'}::${record.model ?? 'unknown'}`
        if (currentSegment === null || currentSegment.key !== segmentKey) {
          currentSegment = {
            key: segmentKey,
            upstream: record.upstream ?? null,
            model: record.model ?? null,
            startAt: record.at,
            endAt: record.at,
            totalTokens: 0,
            requests: 0,
          }
          segments.push(currentSegment)
        }
        currentSegment.endAt = record.at
        currentSegment.totalTokens += record.totalTokens
        currentSegment.requests += 1
      }
    }

    // 会话级元数据事件（分流/守门/桌面操作）
    const metaCounts = {}
    for (const record of records) {
      const kind = record.meta?.kind
      if (typeof kind === 'string') metaCounts[kind] = (metaCounts[kind] ?? 0) + 1
    }

    return {
      sessionId,
      startAt: Math.min(...records.map(r => r.at)),
      endAt: Math.max(...records.map(r => r.at)),
      logicalTotal,
      attemptTotal,
      mainTotal,
      branchTotal,
      editedTurns,
      retractedTurns,
      metaCounts,
      segments,
      providers: [...providerMap.values()]
        .map(entry => ({
          provider: entry.provider,
          totalTokens: entry.totalTokens,
          requests: entry.requests,
          models: [...entry.models.entries()]
            .map(([model, value]) => ({ model, ...value }))
            .sort((a, b) => b.totalTokens - a.totalTokens),
        }))
        .sort((a, b) => b.totalTokens - a.totalTokens),
    }
  }

  /**
   * 旁支分支账本：同会话但 branch=true，默认折叠。
   * @param {string} sessionId
   */
  branches(sessionId) {
    this.load()
    return this.records
      .filter(r => r.sessionId === sessionId && r.branch === true && r.totalTokens > 0)
      .map(r => ({
        turnIndex: r.turnIndex,
        at: r.at,
        provider: r.provider,
        model: r.model,
        totalTokens: r.totalTokens,
      }))
  }

  /** 导出原始记录（给 API / 调试用） */
  export(sessionId) {
    this.load()
    const source = sessionId === undefined ? this.records : this.records.filter(r => r.sessionId === sessionId)
    return source.map(record => ({ ...record }))
  }
}

// ─── 工具 ────────────────────────────────────────────────────────────────

function coerceNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function pickFields(record) {
  const out = {}
  for (const field of RECORD_FIELDS) {
    if (record[field] !== undefined) out[field] = record[field]
  }
  return out
}

function normalizeMeta(meta) {
  if (meta === null || typeof meta !== 'object') return undefined
  // 元数据也过滤：绝不能让它顺手把 prompt 带出去
  const out = {}
  for (const key of ['kind', 'route', 'via', 'target', 'reason', 'success', 'app', 'action', 'blocked', 'detail']) {
    if (meta[key] !== undefined) out[key] = meta[key]
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function addInto(map, key, record) {
  const entry = map.get(key) ?? { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, requests: 0 }
  entry.totalTokens += record.totalTokens
  entry.inputTokens += record.inputTokens
  entry.outputTokens += record.outputTokens
  entry.reasoningTokens += record.reasoningTokens
  entry.requests += 1
  map.set(key, entry)
}

function toSortedArray(map, keyFields) {
  return [...map.entries()]
    .map(([key, value]) => {
      if (keyFields.length === 2) {
        const [provider, model] = key.split('::')
        return { provider, model, ...value }
      }
      return { [keyFields[0]]: key, ...value }
    })
    .sort((a, b) => b.totalTokens - a.totalTokens)
}

/** 本地 tokenizer 估算 —— 上游不给 usage 时的兜底 */
export function estimateTokens(text, options = {}) {
  if (typeof text !== 'string' || text === '') return 0
  // 粗略：CJK 约 1 字 1 token，拉丁约 4 字符 1 token
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length
  const rest = text.length - cjk
  const estimate = cjk + Math.ceil(rest / 4)
  return Math.max(0, Math.round(estimate * (options.safetyFactor ?? 1.08)))
}

export { SCHEMA }
