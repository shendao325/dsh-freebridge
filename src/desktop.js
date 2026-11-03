/**
 * 桌面操作编排 —— 模块三。
 *
 * 计划书要求：
 * 1. 插件做编排层，不重复实现桌面自动化底层；需要操作窗口/点击按钮时，
 *    调用已有桌面控制插件暴露的能力。
 * 2. 判断当前任务是否需要启动某个应用，需要时自动拉起，不需要时不动。
 * 3. 应用启动失败时回退到提示用户手动操作，不静默失败。
 * 4. 每次调用记入账本元数据（操作类型、目标应用、成功/失败）。
 *
 * 设计：编排层 + 能力注册表
 * - 底层能力由宿主其他插件注册进来（registerCapability）。
 * - 本模块只做：意图判断 → 需要就调度 → 失败回退 → 记账。
 * - 没有底层能力时绝不假装成功，直接走回退。
 *
 * @module src/desktop.js
 */

/** 能力类型 */
export const CAPABILITY = {
  LAUNCH: 'launch',
  FOCUS: 'focus',
  CLICK: 'click',
  TYPE: 'type',
  SCREENSHOT: 'screenshot',
}

/**
 * 桌面操作编排器。
 */
export class DesktopOrchestrator {
  /**
   * @param {object} options
   * @param {object} options.guard 守门器（OperationGuard）
   * @param {(event: object) => void} [options.onEvent] 记账回调
   * @param {(msg: string) => void} [options.warn]
   * @param {(app: string, config: object) => boolean} [options.matchesTask] 判断任务是否需要该应用
   */
  constructor(options) {
    this.guard = options.guard
    this.onEvent = options.onEvent ?? (() => {})
    this.warn = options.warn ?? (() => {})
    this.matchesTask = options.matchesTask ?? defaultMatchesTask

    /** @type {Map<string, object>} 底层能力注册表（由宿主插件填入） */
    this.capabilities = new Map()
    /** 已知应用清单：应用名 -> { aliases, launchable } */
    this.apps = new Map()
  }

  /**
   * 注册底层能力。
   * 宿主已有的桌面控制插件通过这个入口挂进来，本模块不自己实现点击/窗口控制。
   *
   * @param {string} capability CAPABILITY.*
   * @param {(payload: object) => Promise<any>} handler
   */
  registerCapability(capability, handler) {
    if (typeof handler !== 'function') {
      this.warn(`freebridge/desktop: capability "${capability}" handler is not a function`)
      return false
    }
    this.capabilities.set(capability, handler)
    return true
  }

  /** 登记一个可用应用 */
  registerApp(name, options = {}) {
    this.apps.set(name, {
      aliases: options.aliases ?? [],
      launchable: options.launchable !== false,
    })
    return this.apps.get(name)
  }

  /** 当前有没有某个底层能力 */
  hasCapability(capability) {
    return this.capabilities.has(capability)
  }

  /** 能力总览（设置页显示用） */
  status() {
    return {
      capabilities: [...this.capabilities.keys()],
      apps: [...this.apps.keys()],
    }
  }

  /**
   * 判断当前任务是否需要启动某个应用。
   *
   * 需要才拉起，不需要就不动 —— 这是「不动」的保证。
   *
   * @param {string} userIntent 用户原话
   * @returns {{needed: boolean, app: string|null, reason: string}}
   */
  detectApp(userIntent) {
    const text = String(userIntent ?? '')
    if (text === '') return { needed: false, app: null, alias: null, reason: 'no intent text' }
    return this.matchesTask(text, { apps: this.apps })
  }

  /**
   * 按任务自动拉起应用。
   *
   * @param {string} userIntent
   * @param {object} [options]
   * @param {string} [options.sessionId]
   * @returns {Promise<object>} 执行结果，失败时带 manualHint
   */
  async ensureApp(userIntent, options = {}) {
    const detection = this.detectApp(userIntent)

    if (detection.needed !== true) {
      return { started: false, app: null, reason: detection.reason, manualHint: null }
    }

    const app = detection.app
    // 守门比对要用「用户原话里实际出现的那个词」，不能用内部应用名。
    // 否则「帮我打开记事本」会因为 target='Notepad' 没在原话里出现而被误判越界。
    const guardTarget = detection.alias ?? app

    // 守门：桌面操作必须先过范围检查
    const decision = await this.guard.check({
      op: 'desktop',
      target: guardTarget,
      command: `launch ${app}`,
      userIntent,
    })

    if (decision.verdict === 'deny') {
      this.record(options.sessionId, 'launch', app, false, decision.why)
      return { started: false, app, reason: decision.why, blocked: true, verdict: 'deny', manualHint: null }
    }
    if (decision.verdict === 'ask') {
      this.record(options.sessionId, 'launch', app, false, `needs confirmation: ${decision.why}`)
      return { started: false, app, reason: decision.why, needsConfirm: true, verdict: 'ask', manualHint: null }
    }

    // 没有底层能力：不假装成功，直接回退到提示手动操作。
    // 这一步放在守门之前 —— 没能力时询问用户毫无意义，直接给手动提示更诚实。
    if (this.hasCapability(CAPABILITY.LAUNCH) !== true) {
      const hint = `插件没有桌面控制能力，请手动打开「${app}」`
      this.record(options.sessionId, 'launch', app, false, 'no launch capability')
      this.warn(`freebridge/desktop: no launch capability registered, falling back to manual hint`)
      return { started: false, app, reason: 'no launch capability', manualHint: hint, verdict: 'allow' }
    }

    const handler = this.capabilities.get(CAPABILITY.LAUNCH)
    const started = Date.now()
    try {
      const result = await handler({ app, intent: userIntent })
      const ok = result?.ok !== false
      this.record(options.sessionId, 'launch', app, ok, ok ? 'launched' : String(result?.error ?? 'launch failed'), Date.now() - started)
      if (!ok) {
        return {
          started: false,
          app,
          reason: String(result?.error ?? 'launch failed'),
          manualHint: `自动启动「${app}」失败，请手动打开`,
          verdict: 'allow',
        }
      }
      return { started: true, app, reason: 'launched', manualHint: null, verdict: 'allow' }
    } catch (error) {
      const message = String(error?.message ?? error)
      this.record(options.sessionId, 'launch', app, false, message, Date.now() - started)
      this.warn(`freebridge/desktop: launch "${app}" threw: ${message}`)
      // 启动失败回退到提示用户手动操作，不静默失败
      return { started: false, app, reason: message, manualHint: `自动启动「${app}」失败，请手动打开`, verdict: 'allow' }
    }
  }

  /**
   * 执行一次界面操作（点击 / 输入 / 截图 / 聚焦），统一走守门 + 记账。
   *
   * @param {object} request
   * @param {string} request.capability CAPABILITY.*
   * @param {object} request.payload
   * @param {string} request.userIntent
   * @param {string} [request.sessionId]
   */
  async perform(request) {
    const capability = request?.capability
    if (typeof capability !== 'string' || capability === '') {
      return { ok: false, reason: 'missing capability', manualHint: null }
    }

    // 未注册的能力直接回退，不必先询问用户
    const handler = this.capabilities.get(capability)
    if (typeof handler !== 'function') {
      const target = String(request?.payload?.app ?? request?.payload?.target ?? capability)
      this.record(request.sessionId, capability, target, false, 'capability not registered')
      return {
        ok: false,
        reason: `capability "${capability}" not registered`,
        manualHint: `插件不支持自动${capability}，请手动操作`,
        verdict: 'allow',
      }
    }

    const appName = request?.payload?.app
    // 守门用用户原话里实际出现的那个词作 target
    let target = String(appName ?? request?.payload?.target ?? capability)
    if (typeof appName === 'string' && appName !== '') {
      const lowerIntent = String(request?.userIntent ?? '').toLowerCase()
      const meta = this.apps.get(appName)
      const alias = (meta?.aliases ?? []).find(candidate => candidate !== '' && lowerIntent.includes(candidate.toLowerCase()))
      if (alias !== undefined) target = alias
    }

    const decision = await this.guard.check({
      op: 'desktop',
      target,
      command: `${capability} on ${target}`,
      userIntent: request?.userIntent ?? '',
    })

    if (decision.verdict === 'deny') {
      this.record(request.sessionId, capability, target, false, decision.why)
      return { ok: false, reason: decision.why, blocked: true, verdict: 'deny', manualHint: null }
    }
    if (decision.verdict === 'ask') {
      this.record(request.sessionId, capability, target, false, `needs confirmation: ${decision.why}`)
      return { ok: false, reason: decision.why, needsConfirm: true, verdict: 'ask', manualHint: null }
    }

    const started = Date.now()
    try {
      const result = await handler(request.payload ?? {})
      const ok = result?.ok !== false
      this.record(request.sessionId, capability, target, ok, ok ? 'done' : String(result?.error ?? 'failed'), Date.now() - started)
      return {
        ok,
        reason: ok ? 'done' : String(result?.error ?? 'failed'),
        manualHint: ok ? null : `自动${capability}失败，请手动操作`,
        verdict: 'allow',
      }
    } catch (error) {
      const message = String(error?.message ?? error)
      this.record(request.sessionId, capability, target, false, message, Date.now() - started)
      this.warn(`freebridge/desktop: ${capability} threw: ${message}`)
      return { ok: false, reason: message, manualHint: `自动${capability}失败，请手动操作`, verdict: 'allow' }
    }
  }

  record(sessionId, action, target, success, detail, latencyMs = 0) {
    try {
      this.onEvent({
        sessionId: sessionId ?? 'unknown',
        kind: 'desktop',
        action,
        target,
        success: success === true,
        detail: String(detail ?? ''),
        latencyMs,
      })
    } catch (error) {
      this.warn(`freebridge/desktop: record failed: ${error?.message ?? error}`)
    }
  }
}

/**
 * 默认的「任务是否需要某应用」判定：看用户原话里有没有提到应用名或别名。
 *
 * @param {string} text
 * @param {object} context
 */
function defaultMatchesTask(text, context) {
  const lower = text.toLowerCase()
  for (const [name, meta] of context.apps.entries()) {
    const candidates = [name, ...(meta.aliases ?? [])]
    for (const candidate of candidates) {
      if (candidate === '') continue
      if (lower.includes(candidate.toLowerCase())) {
        // 返回实际命中的那个词，守门用它做意图比对
        return { needed: true, app: name, alias: candidate, reason: `intent mentions "${candidate}"` }
      }
    }
  }
  return { needed: false, app: null, alias: null, reason: 'no app mentioned in intent' }
}

export { defaultMatchesTask }
