/**
 * 按需网络分流 —— 模块二。
 *
 * 计划书要求：
 * 1. 直连优先，超时或失败自动走代理，成功则记住域名下次直连。
 * 2. 不要求用户维护域名列表，规则由插件自己学习。
 * 3. 本机已有代理客户端则自动跟随；没有则内置轻量代理内核。
 * 4. 首次启动不需要用户填任何东西：探测—选择—分流闭环。
 * 5. 节点健康自动标记：失效节点只标记不删除，恢复后自动重新启用。
 * 6. 模型请求与网页抓取分开路由，避免模型 API 被代理拖慢。
 * 7. 分流决策记进账本元数据。
 *
 * 实现策略：
 * - 本插件做「决策层」，不做代理内核。代理内核由 host 或外部客户端提供，
 *   这里只负责选路、记住结论、标记健康。
 * - 学习结果是「每个域名一条记忆」，写入 JSON 持久化。
 * - 决策只做一次，结果缓存，避免每次请求都探测。
 *
 * @module src/router.js
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * 域名记忆的三种状态：
 * - 'direct'  ：探测证明直连可用，下次直接直连
 * - 'proxy'   ：直连失败，走代理
 * - 'unknown' ：还没探测过
 */
const ROUTE_DIRECT = 'direct'
const ROUTE_PROXY = 'proxy'

/** 两条独立的路由策略：模型 API 和网页抓取分开学，互不影响 */
export const ROUTE_KIND = {
  MODEL: 'model',
  WEB: 'web',
}

const SCHEMA = 'freebridge/router/v1'

/**
 * 分流决策器。
 */
export class NetworkRouter {
  /**
   * @param {object} options
   * @param {string} options.dir 记忆持久化目录
   * @param {number} [options.timeoutMs=4000] 直连探测超时
   * @param {(url: string, init: object) => Promise<Response>} [options.probeFetch] 探测用的 fetch（可注入）
   * @param {(msg: string) => void} [options.warn]
   */
  constructor(options) {
    this.dir = options.dir
    this.file = path.join(this.dir, 'routes.json')
    this.timeoutMs = options.timeoutMs ?? 4000
    this.probeFetch = options.probeFetch ?? ((url, init) => fetch(url, init))
    this.warn = options.warn ?? (() => {})

    /** @type {Map<string, {route: string, kind: string, at: number, failures: number, lastError: string|null}>} */
    this.memory = new Map()
    /** @type {Map<string, {healthy: boolean, at: number, reason: string}>} */
    this.nodes = new Map()
    this.loaded = false
    /** 进行一次探测的并发表，避免同一域名同时打多个探测 */
    this.inflight = new Map()
  }

  load() {
    if (this.loaded) return
    this.loaded = true
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      if (!fs.existsSync(this.file)) return
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      for (const [key, value] of Object.entries(raw?.hosts ?? {})) {
        this.memory.set(key, value)
      }
      for (const [key, value] of Object.entries(raw?.nodes ?? {})) {
        this.nodes.set(key, value)
      }
    } catch (error) {
      this.warn(`freebridge/router: load failed: ${error?.message ?? error}`)
    }
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const hosts = {}
      for (const [key, value] of this.memory.entries()) hosts[key] = value
      const nodes = {}
      for (const [key, value] of this.nodes.entries()) nodes[key] = value
      fs.writeFileSync(this.file, JSON.stringify({ schema: SCHEMA, hosts, nodes }, null, 2), 'utf8')
    } catch (error) {
      this.warn(`freebridge/router: save failed: ${error?.message ?? error}`)
    }
  }

  /**
   * 拿一条已学到的路由决策。
   *
   * @param {string} host
   * @param {string} [kind='model']
   * @returns {{route: string, learned: boolean, kind: string}}
   */
  lookup(host, kind = ROUTE_KIND.MODEL) {
    this.load()
    const key = `${kind}::${host}`
    const entry = this.memory.get(key)
    if (entry === undefined) return { route: ROUTE_DIRECT, learned: false, kind }
    return { route: entry.route, learned: true, kind }
  }

  /**
   * 探测并学习一条路由。
   *
   * 直连优先：先试直连，成功就记住 direct 并返回；
   * 失败则走代理路径并把该域名记为 proxy。
   *
   * @param {string} host
   * @param {object} [options]
   * @param {string} [options.kind='model']
   * @param {string} [options.probeUrl] 探测目标（默认 https://host/）
   * @param {boolean} [options.force=false] 忽略已有记忆，强制重探
   * @returns {Promise<{route: string, learned: boolean, probeMs: number, error: string|null}>}
   */
  async probe(host, options = {}) {
    this.load()
    const kind = options.kind ?? ROUTE_KIND.MODEL
    const key = `${kind}::${host}`

    const existing = this.memory.get(key)
    if (options.force !== true && existing !== undefined) {
      return { route: existing.route, learned: true, probeMs: 0, error: null }
    }

    // 去重：同域名同类型只探一次
    if (this.inflight.has(key)) return this.inflight.get(key)

    const task = (async () => {
      const started = Date.now()
      const url = options.probeUrl ?? `https://${host}/`
      try {
        const response = await this.probeFetch(url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'manual',
        })
        const probeMs = Date.now() - started
        // 任何 HTTP 响应都证明网络可达（4xx/5xx 也是通的）
        this.remember(key, ROUTE_DIRECT, kind)
        return { route: ROUTE_DIRECT, learned: false, probeMs, error: null }
      } catch (error) {
        const probeMs = Date.now() - started
        const message = String(error?.message ?? error)
        this.remember(key, ROUTE_PROXY, kind, message)
        return { route: ROUTE_PROXY, learned: false, probeMs, error: message }
      } finally {
        this.inflight.delete(key)
      }
    })()

    this.inflight.set(key, task)
    return task
  }

  remember(key, route, kind, lastError = null) {
    this.memory.set(key, {
      route,
      kind,
      at: Date.now(),
      failures: route === ROUTE_PROXY ? (this.memory.get(key)?.failures ?? 0) + 1 : 0,
      lastError,
    })
    this.save()
  }

  /**
   * 记录一次真实请求的成功/失败，让学习结果自我修正。
   *
   * 成功：如果之前记成 proxy 但直连其实通了，改回 direct。
   * 失败：连续失败就把该域名切到 proxy。
   *
   * @param {string} host
   * @param {boolean} ok
   * @param {object} [options]
   * @param {string} [options.kind='model']
   * @param {boolean} [options.viaProxy=false] 这次是否走了代理
   * @param {string} [options.error]
   */
  record(host, ok, options = {}) {
    this.load()
    const kind = options.kind ?? ROUTE_KIND.MODEL
    const key = `${kind}::${host}`

    if (ok === true) {
      // 直连成功就固化为直连
      if (options.viaProxy !== true) this.remember(key, ROUTE_DIRECT, kind)
      return { route: this.lookup(host, kind).route }
    }

    const previous = this.memory.get(key)
    const failures = (previous?.failures ?? 0) + 1
    this.memory.set(key, {
      route: previous?.route ?? ROUTE_DIRECT,
      kind,
      at: Date.now(),
      failures,
      lastError: options.error ?? previous?.lastError ?? null,
    })
    // 连续失败 2 次以上才改判走代理，避免一次抖动就永久改道
    if (failures >= 2) {
      this.memory.set(key, {
        route: ROUTE_PROXY,
        kind,
        at: Date.now(),
        failures,
        lastError: options.error ?? null,
      })
    }
    this.save()
    return { route: this.lookup(host, kind).route, failures }
  }

  /**
   * 标记节点健康状态。
   *
   * 计划书要求：失效节点只标记不删除，恢复后自动重新启用。
   * 所以这里只有 healthy 标志位，从不移除条目。
   *
   * @param {string} nodeId
   * @param {boolean} healthy
   * @param {string} [reason]
   */
  markNode(nodeId, healthy, reason = '') {
    this.load()
    const previous = this.nodes.get(nodeId)
    this.nodes.set(nodeId, {
      healthy,
      at: Date.now(),
      reason,
      // 保留首次登记时间，证明节点没被删掉
      firstSeenAt: previous?.firstSeenAt ?? Date.now(),
    })
    this.save()
    return this.nodes.get(nodeId)
  }

  /** 所有节点状态（含不可用的，用户配置不能丢） */
  nodeStatus() {
    this.load()
    return [...this.nodes.entries()].map(([nodeId, entry]) => ({ nodeId, ...entry }))
  }

  /** 可用节点列表（只返回健康的） */
  healthyNodes() {
    return this.nodeStatus().filter(entry => entry.healthy === true)
  }

  /** 分流决策快照，给统计页显示「本次会话多少请求走了代理」 */
  snapshot(kind) {
    this.load()
    const entries = [...this.memory.entries()]
    const out = { direct: 0, proxy: 0, total: 0, hosts: [] }
    for (const [key, value] of entries) {
      if (kind !== undefined && value.kind !== kind) continue
      out.total += 1
      if (value.route === ROUTE_PROXY) out.proxy += 1
      else out.direct += 1
      out.hosts.push({
        host: key.split('::')[1] ?? key,
        kind: value.kind,
        route: value.route,
        failures: value.failures ?? 0,
      })
    }
    out.hosts.sort((a, b) => b.failures - a.failures)
    return out
  }

  /** 清空学习结果（设置页「重置分流」用） */
  reset() {
    this.load()
    this.memory.clear()
    this.inflight.clear()
    this.save()
  }
}

/**
 * 从 URL 取出 host；取不到返回 null。
 * @param {string} url
 */
export function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

export { ROUTE_DIRECT, ROUTE_PROXY, SCHEMA }
