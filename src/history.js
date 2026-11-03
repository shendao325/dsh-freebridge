/**
 * 历史会话回填 —— 解决「token 统计只有 1.9K」。
 *
 * 插件自己的账本只统计它发出过的请求，而用户的历史用量在 DSH 的
 * session.v4.jsonl.zstd 里。这个模块扫描全部历史会话，把它们汇总进账本。
 *
 * 关键点（都是踩过的坑）：
 * 1. 会话是 zstd **多帧拼接**，必须逐帧解压。标准 zstdDecompress 只解第一帧，
 *    会得到一个只有会话头的假象。
 * 2. usage 在 data.usage 里，字段是 inputTokens/outputTokens/reasoningTokens。
 * 3. 归档会话也算：直接扫磁盘，不依赖 DSH 是否加载过该会话。
 *
 * @module src/history.js
 */

import fs from 'node:fs'
import path from 'node:path'
import z from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 逐帧解压 zstd（多帧拼接） */
export function decompressFrames(buf) {
  let pos = 0
  const parts = []
  while (pos < buf.length) {
    const start = buf.indexOf(MAGIC, pos)
    if (start === -1) break
    const next = buf.indexOf(MAGIC, start + 4)
    const end = next === -1 ? buf.length : next
    try {
      parts.push(z.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
    } catch {
      /* 坏帧跳过 */
    }
    pos = end
  }
  return parts.join('')
}

/** 抽 usage */
function usageOf(event) {
  const u = event?.data?.usage ?? event?.usage
  if (u === null || u === undefined || typeof u !== 'object') return null
  const input = Number(u.inputTokens ?? u.input_tokens ?? 0)
  const output = Number(u.outputTokens ?? u.output_tokens ?? 0)
  const reasoning = Number(u.reasoningTokens ?? u.reasoning_tokens ?? 0)
  const cacheRead = Number(u.cacheReadTokens ?? u.cache_read_tokens ?? 0)
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null
  return {
    inputTokens: Number.isFinite(input) ? input : 0,
    outputTokens: Number.isFinite(output) ? output : 0,
    reasoningTokens: Number.isFinite(reasoning) ? reasoning : 0,
    cacheReadTokens: Number.isFinite(cacheRead) ? cacheRead : 0,
  }
}

/**
 * 扫描一个会话文件。
 * @param {string} filePath
 */
export function scanSession(filePath) {
  const text = decompressFrames(fs.readFileSync(filePath))
  const result = {
    sessionId: path.basename(path.dirname(filePath)),
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    turns: 0,
    messages: 0,
    startAt: null,
    endAt: null,
    cwd: null,
    byModel: {},
    byProvider: {},
  }

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }

    if (ev.type === 'session') {
      result.sessionId = ev.id ?? result.sessionId
      result.cwd = ev.cwd ?? null
      if (typeof ev.createdAt === 'number') result.startAt = ev.createdAt
      continue
    }

    const at = typeof ev.at === 'number' ? ev.at : typeof ev.time === 'number' ? ev.time : null
    if (at !== null) {
      if (result.startAt === null || at < result.startAt) result.startAt = at
      if (result.endAt === null || at > result.endAt) result.endAt = at
    }

    if (ev.type === 'turn/start') result.turns += 1

    if (ev.type !== 'assistant/message') continue
    result.messages += 1
    const u = usageOf(ev)
    if (u === null) continue

    result.inputTokens += u.inputTokens
    result.outputTokens += u.outputTokens
    result.reasoningTokens += u.reasoningTokens
    result.cacheReadTokens += u.cacheReadTokens

    const model = String(ev.data?.message?.model ?? ev.data?.model ?? ev.model ?? 'unknown')
    const provider = String(ev.data?.message?.provider ?? ev.data?.provider ?? ev.provider ?? 'unknown')
    bump(result.byModel, model, u)
    bump(result.byProvider, provider, u)
  }

  result.totalTokens = result.inputTokens + result.outputTokens
  return result
}

function bump(map, key, u) {
  const e = map[key] ?? { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, requests: 0 }
  e.inputTokens += u.inputTokens
  e.outputTokens += u.outputTokens
  e.reasoningTokens += u.reasoningTokens
  e.requests += 1
  map[key] = e
}

/** 递归找会话文件 */
function findSessionFiles(root) {
  const out = []
  const walk = dir => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.jsonl.zstd') || entry.name.endsWith('.jsonl')) out.push(p)
    }
  }
  walk(root)
  return out
}

/**
 * 全量扫描历史会话。
 *
 * @param {object} options
 * @param {string} options.sessionsRoot 会话根目录（通常是 ~/.dsh/sessions）
 * @param {(msg: string) => void} [options.warn]
 * @returns {object} 汇总结果
 */
export function scanAllSessions(options) {
  const root = options.sessionsRoot
  const files = findSessionFiles(root)
  const aggregate = {
    files: files.length,
    parsed: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    turns: 0,
    messages: 0,
    byModel: {},
    byProvider: {},
    sessions: [],
  }

  for (const file of files) {
    try {
      const s = scanSession(file)
      aggregate.parsed += 1
      aggregate.inputTokens += s.inputTokens
      aggregate.outputTokens += s.outputTokens
      aggregate.reasoningTokens += s.reasoningTokens
      aggregate.cacheReadTokens += s.cacheReadTokens
      aggregate.totalTokens += s.totalTokens
      aggregate.turns += s.turns
      aggregate.messages += s.messages
      for (const [k, v] of Object.entries(s.byModel)) {
        const e = aggregate.byModel[k] ?? { inputTokens: 0, outputTokens: 0, requests: 0 }
        e.inputTokens += v.inputTokens
        e.outputTokens += v.outputTokens
        e.requests += v.requests
        aggregate.byModel[k] = e
      }
      for (const [k, v] of Object.entries(s.byProvider)) {
        const e = aggregate.byProvider[k] ?? { inputTokens: 0, outputTokens: 0, requests: 0 }
        e.inputTokens += v.inputTokens
        e.outputTokens += v.outputTokens
        e.requests += v.requests
        aggregate.byProvider[k] = e
      }
      if (s.totalTokens > 0) {
        aggregate.sessions.push({
          sessionId: s.sessionId,
          totalTokens: s.totalTokens,
          inputTokens: s.inputTokens,
          outputTokens: s.outputTokens,
          turns: s.turns,
          messages: s.messages,
          startAt: s.startAt,
          endAt: s.endAt,
        })
      }
    } catch (error) {
      aggregate.failed += 1
      options.warn?.(`freebridge/history: ${path.basename(file)} failed: ${error?.message ?? error}`)
    }
  }

  aggregate.sessions.sort((a, b) => b.totalTokens - a.totalTokens)
  return aggregate
}

/**
 * 把历史扫描结果导入账本。
 *
 * 每个会话写一条 logical 记录，标记 source=history，
 * 这样它会计入总量但不会和实时请求重复计算。
 *
 * @param {object} ledger TokenLedger 实例
 * @param {object} aggregate scanAllSessions 的返回值
 * @returns {number} 导入的记录数
 */
export function importIntoLedger(ledger, aggregate) {
  let imported = 0
  for (const session of aggregate.sessions) {
    try {
      ledger.append({
        sessionId: session.sessionId,
        provider: 'history',
        upstream: 'history',
        model: 'history-import',
        level: 'logical',
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        ok: true,
        billable: 'yes',
        latencyMs: 0,
        meta: { kind: 'history', detail: `imported ${session.turns} turns` },
      })
      imported += 1
    } catch {
      /* 单条失败不影响整体 */
    }
  }
  return imported
}

/** 默认会话根目录 */
export function defaultSessionsRoot() {
  const os = fs.default ?? fs
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  return path.join(home, '.dsh', 'sessions')
}

export { findSessionFiles }
