/**
 * 插件级故障隔离 —— 模块六。
 *
 * 计划书要求：
 * 1. 任一子模块出错时不阻断 DSH 启动，其他模块照常可用。
 * 2. 出错模块降级运行并在设置页显示状态，用户可单独重启该模块。
 * 3. 小白体验底线：一个功能坏了，不能整个插件跟着坏。
 *
 * 设计：每个子模块包成一个 ModuleSlot。
 * - init()/start() 抛错只把该槽标成 'degraded'，不外抛。
 * - 状态机：pending -> running -> degraded / stopped
 * - restart() 可单独重启任何一个槽。
 *
 * @module src/supervisor.js
 */

export const STATE = {
  PENDING: 'pending',
  RUNNING: 'running',
  DEGRADED: 'degraded',
  STOPPED: 'stopped',
}

/**
 * 一个受监督的子模块。
 */
class ModuleSlot {
  /**
   * @param {string} name
   * @param {object} factory
   * @param {() => Promise<object>|object} factory.start 启动逻辑，返回该模块实例
   * @param {(instance: object) => Promise<void>|void} [factory.stop] 停止逻辑
   * @param {boolean} [factory.critical=false] 关键模块（挂了也不影响 DSH 启动，只影响自身）
   */
  constructor(name, factory) {
    this.name = name
    this.factory = factory
    this.state = STATE.PENDING
    this.instance = null
    this.error = null
    this.startedAt = 0
    this.restartCount = 0
  }

  async start(logger) {
    try {
      this.instance = await this.factory.start()
      this.state = STATE.RUNNING
      this.error = null
      this.startedAt = Date.now()
      logger?.info?.(`[freebridge] module "${this.name}" running`)
      return true
    } catch (error) {
      // 关键点：绝不外抛，只降级
      this.instance = null
      this.state = STATE.DEGRADED
      this.error = String(error?.message ?? error)
      logger?.warn?.(`[freebridge] module "${this.name}" failed to start: ${this.error}`)
      return false
    }
  }

  async stop(logger) {
    try {
      await this.factory.stop?.(this.instance)
      this.instance = null
      this.state = STATE.STOPPED
      return true
    } catch (error) {
      this.state = STATE.DEGRADED
      this.error = String(error?.message ?? error)
      logger?.warn?.(`[freebridge] module "${this.name}" failed to stop: ${this.error}`)
      return false
    }
  }

  async restart(logger) {
    this.restartCount += 1
    await this.stop(logger)
    return this.start(logger)
  }

  snapshot() {
    return {
      name: this.name,
      state: this.state,
      error: this.error,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt === 0 ? 0 : Date.now() - this.startedAt,
      restartCount: this.restartCount,
      hasInstance: this.instance !== null,
    }
  }
}

/**
 * 插件级监督器。所有子模块都挂在这上面。
 */
export class Supervisor {
  /**
   * @param {object} [options]
   * @param {object} [options.logger]
   */
  constructor(options = {}) {
    this.logger = options.logger ?? {}
    /** @type {Map<string, ModuleSlot>} */
    this.slots = new Map()
    this.startupErrors = []
  }

  /**
   * 注册一个子模块。
   * @param {string} name
   * @param {object} factory
   */
  register(name, factory) {
    if (this.slots.has(name)) return this.slots.get(name)
    const slot = new ModuleSlot(name, factory)
    this.slots.set(name, slot)
    return slot
  }

  /**
   * 启动全部模块。**任何一个失败都不外抛。**
   * @returns {Promise<{running: string[], degraded: string[]}>}
   */
  async startAll() {
    const running = []
    const degraded = []
    for (const slot of this.slots.values()) {
      const ok = await slot.start(this.logger)
      if (ok) running.push(slot.name)
      else degraded.push(slot.name)
    }
    this.startupErrors = degraded
    return { running, degraded }
  }

  async stopAll() {
    for (const slot of this.slots.values()) {
      await slot.stop(this.logger)
    }
  }

  /**
   * 单独重启某个模块。
   * @param {string} name
   */
  async restart(name) {
    const slot = this.slots.get(name)
    if (slot === undefined) {
      return { ok: false, reason: `unknown module: ${name}` }
    }
    const ok = await slot.restart(this.logger)
    return { ok, state: slot.state, error: slot.error }
  }

  /** 某个模块实例（挂了就返回 null，调用方必须自己判空） */
  get(name) {
    const slot = this.slots.get(name)
    if (slot === undefined || slot.state !== STATE.RUNNING) return null
    return slot.instance
  }

  /**
   * 安全调用：模块不可用时返回 fallback，不抛错。
   * 这是「一个功能坏了不影响别的功能」的实现方式。
   *
   * @template T
   * @param {string} name
   * @param {(instance: object) => T} fn
   * @param {T} fallback
   * @returns {T}
   */
  use(name, fn, fallback) {
    const instance = this.get(name)
    if (instance === null) return fallback
    try {
      return fn(instance)
    } catch (error) {
      this.logger?.warn?.(`[freebridge] module "${name}" call failed: ${error?.message ?? error}`)
      const slot = this.slots.get(name)
      if (slot !== undefined) {
        slot.state = STATE.DEGRADED
        slot.error = String(error?.message ?? error)
      }
      return fallback
    }
  }

  /** 状态总览（设置页显示） */
  status() {
    return {
      modules: [...this.slots.values()].map(slot => slot.snapshot()),
      startupErrors: this.startupErrors,
      healthy: [...this.slots.values()].filter(slot => slot.state === STATE.RUNNING).length,
      total: this.slots.size,
    }
  }
}

export { ModuleSlot }
