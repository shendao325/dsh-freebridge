/**
 * FreeBridge — DSH 插件入口（一体化版）。
 *
 * 装好即用：apply() 里完成零配置引导、模块装配、provider 注册，
 * 模型自动出现在选择器，不需要用户改 cordis.yml。
 *
 * 六个模块全部挂在 Supervisor 上，任一模块出错都不阻断 DSH 启动。
 *
 * @module dsh-freebridge
 */

import path from 'node:path'
import FileSystem from 'node:fs'

import { FreeBridgeAdapter, ROUTE, statusSnapshot } from './src/adapter.js'
import { TokenLedger } from './src/ledger.js'
import { NetworkRouter } from './src/router.js'
import { OperationGuard } from './src/guard.js'
import { DesktopOrchestrator, CAPABILITY } from './src/desktop.js'
import { Supervisor, STATE } from './src/supervisor.js'
import { bootstrap, resolveConfig, Onboarding, ONBOARDING_QUESTIONS } from './src/bootstrap.js'

export const name = 'freebridge'

export const inject = ['llm']

/** 设置项 schema。全部有默认值，小白不用碰。 */
export const Config = {
  enabled: { type: 'boolean', default: true, description: '启用 FreeBridge' },
  kilo: {
    type: 'object',
    description: 'Kilo Gateway（匿名免费，主力通道）',
    fields: {
      enabled: { type: 'boolean', default: true },
      weight: { type: 'number', default: 20, description: '权重越大越常被选中' },
    },
  },
  ovh: {
    type: 'object',
    description: 'OVHcloud AI（匿名，2 RPM，备用）',
    fields: {
      enabled: { type: 'boolean', default: true },
      weight: { type: 'number', default: 6 },
    },
  },
  ledger: {
    type: 'object',
    description: 'Token 用量统计',
    fields: {
      enabled: { type: 'boolean', default: true },
      showAttemptLevel: { type: 'boolean', default: false, description: '默认显示尝试级而不是逻辑级' },
      includeBranch: { type: 'boolean', default: false, description: '统计时包含旁支提问' },
    },
  },
  routing: {
    type: 'object',
    description: '按需网络分流（直连优先，失败自动走代理）',
    fields: {
      enabled: { type: 'boolean', default: true },
      probeTimeoutMs: { type: 'number', default: 4000 },
      separateWebRoute: { type: 'boolean', default: true, description: '模型请求与网页抓取分开路由' },
      followSystemProxy: { type: 'boolean', default: true, description: '跟随本机已有代理客户端' },
    },
  },
  desktop: {
    type: 'object',
    description: '桌面操作编排（调用已有桌面控制插件的能力）',
    fields: {
      enabled: { type: 'boolean', default: true },
      autoLaunch: { type: 'boolean', default: true, description: '任务需要时自动拉起应用' },
    },
  },
  guard: {
    type: 'object',
    description: '操作边界守门（默认开启）',
    fields: {
      enabled: { type: 'boolean', default: true },
      useAiReview: { type: 'boolean', default: false, description: '灰色地带交给小模型审查' },
    },
  },
  exposeHealth: { type: 'boolean', default: true, description: '暴露 /freebridge/* 状态与统计接口' },
}

/**
 * @param {import('cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config = {}) {
  let currentConfig = resolveConfig(config)
  const logger = ctx.logger ?? {}
  const warn = message => logger.warn?.(message)

  const supervisor = new Supervisor({ logger })
  const dataDir = resolveDataDir(ctx)

  // ── 模块一：Token 账本 ──
  supervisor.register('ledger', {
    start: () => {
      const ledger = new TokenLedger({ dir: path.join(dataDir, 'ledger'), warn })
      ledger.load()
      return ledger
    },
  })

  // ── 模块二：网络分流 ──
  supervisor.register('router', {
    start: () => {
      const router = new NetworkRouter({
        dir: path.join(dataDir, 'router'),
        timeoutMs: currentConfig.routing.probeTimeoutMs,
        warn,
      })
      router.load()
      return router
    },
  })

  // ── 模块四：守门（模块三依赖它，先建） ──
  supervisor.register('guard', {
    start: () => new OperationGuard({
      enabled: currentConfig.guard.enabled !== false,
      onDecision: event => recordMeta('guard', event),
      warn,
    }),
  })

  // ── 模块三：桌面编排 ──
  supervisor.register('desktop', {
    start: () => {
      // 守门挂了也要能编排，只是没有范围检查；取不到就传放行版
      const guard = supervisor.get('guard') ?? {
        check: async () => ({ verdict: 'allow', why: 'guard unavailable', layer: 'fallback' }),
      }
      const orchestrator = new DesktopOrchestrator({
        guard,
        onEvent: event => recordMeta('desktop', event),
        warn,
      })
      registerHostDesktopCapabilities(ctx, orchestrator, warn)
      return orchestrator
    },
  })

  /**
   * 记账旁路：把守门/桌面事件写进账本。
   * 账本挂了就静默丢弃 —— 记账不能反过来搞坏主流程。
   */
  function recordMeta(kind, payload) {
    const ledger = supervisor.get('ledger')
    if (ledger === null) return
    try {
      ledger.appendMeta(String(payload?.sessionId ?? 'unknown'), kind, {
        action: payload?.action ?? payload?.op,
        target: payload?.target,
        success: payload?.success,
        reason: payload?.why ?? payload?.reason,
        blocked: payload?.verdict !== undefined && payload?.verdict !== 'allow',
        detail: payload?.detail,
      })
    } catch (error) {
      warn(`freebridge: meta record failed: ${error?.message ?? error}`)
    }
  }

  // ── 模块五：零配置引导 ──
  const onboarding = loadOnboarding(dataDir, warn)

  async function runBootstrap() {
    try {
      const result = await bootstrap({
        config: currentConfig,
        onboarding,
        probeUpstream: upstreamId => probeUpstream(upstreamId),
        warn,
      })
      currentConfig = result.config
      logger.info?.(
        `[freebridge] bootstrap: available=[${result.probe.available.join(',')}] ` +
        `unavailable=[${result.degradedUpstreams.join(',')}]`
      )
      return result
    } catch (error) {
      // 引导失败也不能挡住插件：退回默认配置
      warn(`freebridge: bootstrap failed, falling back to defaults: ${error?.message ?? error}`)
      currentConfig = resolveConfig(config)
      return { config: currentConfig, ready: true, degradedUpstreams: [], probe: { available: [], unavailable: [], models: [] } }
    }
  }

  // ── 装配 adapter：所有模块通过 getter 注入 ──
  const adapter = new FreeBridgeAdapter({
    settings: () => currentConfig,
    warn,
    get ledger() {
      return supervisor.get('ledger')
    },
    get router() {
      return supervisor.get('router')
    },
  })

  let registration = null
  let bootstrapped = false

  // 启动全部模块（不阻塞宿主启动）
  void supervisor.startAll()
    .then(result => {
      logger.info?.(`[freebridge] modules running=${result.running.length} degraded=${result.degraded.length}`)
      if (result.degraded.length > 0) {
        logger.warn?.(`[freebridge] degraded modules: ${result.degraded.join(', ')} (restart individually via /freebridge/restart?module=)`)
      }
      return runBootstrap()
    })
    .then(() => {
      bootstrapped = true
      registerProvider()
    })
    .catch(error => {
      // 兜底：装配层再怎么错，也要把 provider 注册上，让对话可用
      logger.warn?.(`[freebridge] init sequence failed: ${error?.message ?? error}`)
      registerProvider()
    })

  /** 向宿主注册 provider（模型进选择器） */
  function registerProvider() {
    if (registration !== null) return registration
    try {
      registration = ctx.llm.registerAdapter([ROUTE], adapter)
    } catch (error) {
      logger.warn?.(`[freebridge] registerAdapter failed: ${error?.message ?? error}`)
      return null
    }

    try {
      ctx.llm.registerConfigurableProviders?.([
        {
          provider: ROUTE,
          displayName: 'FreeBridge',
          settingsNs: ctx.fiber?.entry?.options?.id ?? name,
          settingsPath: [],
        },
      ])
    } catch (error) {
      logger.warn?.(`[freebridge] registerConfigurableProviders failed: ${error?.message ?? error}`)
    }

    try {
      ctx.llm.registerModelDiscovery?.(ctx.fiber?.entry?.options?.id ?? name, async () => {
        try {
          return await adapter.listModels(ROUTE)
        } catch (error) {
          logger.warn?.(`freebridge: model discovery failed: ${error?.message ?? error}`)
          return []
        }
      })
    } catch (error) {
      logger.warn?.(`[freebridge] registerModelDiscovery failed: ${error?.message ?? error}`)
    }

    logger.info?.('[freebridge] ready — anonymous free LLM routes registered')
    return registration
  }

  // ── 设置热更新 ──
  ctx.on?.('config', next => {
    currentConfig = resolveConfig(next)
    const guard = supervisor.get('guard')
    if (guard !== null) guard.setEnabled(currentConfig.guard.enabled !== false)
  })

  // ── HTTP 接口 ──
  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer?.server ?? scoped.webServer
    if (typeof server?.on !== 'function') return

    server.on('request', (req, res) => {
      const url = String(req.url ?? '')
      if (!url.startsWith('/freebridge/')) return
      try {
        handleHttp(url, req, res)
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(error?.message ?? error) }))
      }
    })
  })

  function handleHttp(url, req, res) {
    const parsed = new URL(url, 'http://localhost')
    const route = parsed.pathname

    const sendJson = (body, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body, null, 2))
    }

    // 模块健康：哪个坏了、能不能重启
    if (route === '/freebridge/health') {
      return sendJson({
        ok: true,
        bootstrapped,
        config: currentConfig,
        modules: supervisor.status(),
        upstreams: statusSnapshot(),
      })
    }

    // 全局统计
    if (route === '/freebridge/stats') {
      const level = parsed.searchParams.get('level') === 'attempt' ? 'attempt' : 'logical'
      const includeBranch = parsed.searchParams.get('branch') === '1'
      const ledger = supervisor.get('ledger')
      if (ledger === null) return sendJson({ error: 'ledger module unavailable' }, 503)
      return sendJson(ledger.globalStats({ level, branch: includeBranch }))
    }

    // 会话列表
    if (route === '/freebridge/sessions') {
      const ledger = supervisor.get('ledger')
      if (ledger === null) return sendJson({ error: 'ledger module unavailable' }, 503)
      return sendJson({ sessions: ledger.sessions() })
    }

    // 单会话明细（总 -> 供应商 -> 模型）
    if (route === '/freebridge/session') {
      const sessionId = parsed.searchParams.get('id')
      const ledger = supervisor.get('ledger')
      if (ledger === null) return sendJson({ error: 'ledger module unavailable' }, 503)
      if (sessionId === null) return sendJson({ error: 'missing ?id=' }, 400)
      const detail = ledger.sessionDetail(sessionId)
      if (detail === null) return sendJson({ error: 'session not found' }, 404)
      return sendJson({ ...detail, branches: ledger.branches(sessionId) })
    }

    // 分流状态
    if (route === '/freebridge/routes') {
      const router = supervisor.get('router')
      if (router === null) return sendJson({ error: 'router module unavailable' }, 503)
      return sendJson({ snapshot: router.snapshot(), nodes: router.nodeStatus() })
    }

    // 守门状态
    if (route === '/freebridge/guard') {
      const guard = supervisor.get('guard')
      if (guard === null) return sendJson({ error: 'guard module unavailable' }, 503)
      return sendJson(guard.status())
    }

    // 桌面编排状态
    if (route === '/freebridge/desktop') {
      const desktop = supervisor.get('desktop')
      if (desktop === null) return sendJson({ error: 'desktop module unavailable' }, 503)
      return sendJson(desktop.status())
    }

    // 引导状态与问题
    if (route === '/freebridge/onboarding') {
      return sendJson({ ...onboarding.snapshot(), questions: ONBOARDING_QUESTIONS })
    }

    // 单独重启某个模块（计划书模块六）
    if (route === '/freebridge/restart') {
      const moduleName = parsed.searchParams.get('module')
      if (moduleName === null) return sendJson({ error: 'missing ?module=' }, 400)
      supervisor.restart(moduleName)
        .then(result => sendJson(result))
        .catch(error => sendJson({ ok: false, reason: String(error?.message ?? error) }, 500))
      return
    }

    return sendJson({
      error: 'not found',
      routes: [
        '/freebridge/health',
        '/freebridge/stats',
        '/freebridge/sessions',
        '/freebridge/session?id=',
        '/freebridge/routes',
        '/freebridge/guard',
        '/freebridge/desktop',
        '/freebridge/onboarding',
        '/freebridge/restart?module=',
      ],
    }, 404)
  }

  // ── 探测上游（给 bootstrap 用） ──
  async function probeUpstream(upstreamId) {
    const { catalogFor } = await import('./src/upstream.js')
    try {
      const ids = await catalogFor(upstreamId)
      if (ids.length === 0) return { ok: false, error: 'no models advertised' }
      return { ok: true, models: ids }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  ctx.effect?.(() => {
    return () => {
      registration?.dispose?.()
      void supervisor.stopAll()
    }
  })
}

/**
 * 把宿主已有的桌面控制能力接进编排层。
 *
 * 计划书要求「不重复实现桌面自动化底层」，所以这里只做能力桥接：
 * 宿主有这个能力就注册进来，没有就让编排层走回退提示。
 */
function registerHostDesktopCapabilities(ctx, orchestrator, warn) {
  const launcher = ctx.get?.('desktopControl') ?? ctx.desktopControl ?? null
  if (launcher === null || launcher === undefined) {
    // 宿主没有桌面控制插件：不注册能力，编排层会给出「请手动打开」提示
    return
  }
  try {
    for (const capability of Object.values(CAPABILITY)) {
      const handler = launcher[capability] ?? launcher[`${capability}App`]
      if (typeof handler === 'function') {
        orchestrator.registerCapability(capability, payload => handler.call(launcher, payload))
      }
    }
  } catch (error) {
    warn(`freebridge: desktop capability bridge failed: ${error?.message ?? error}`)
  }
}

/** 数据目录：优先宿主目录，退临时目录，保证总能启动 */
function resolveDataDir(ctx) {
  const candidates = [
    typeof ctx?.dshHomePath === 'function' ? ctx.dshHomePath('freebridge') : null,
    typeof ctx?.storagePath === 'string' ? path.join(ctx.storagePath, 'freebridge') : null,
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    try {
      FileSystem.mkdirSync(candidate, { recursive: true })
      return candidate
    } catch {
      // 试下一个
    }
  }
  const fallback = path.join(process.env.TEMP ?? process.env.TMPDIR ?? '.', 'freebridge')
  try {
    FileSystem.mkdirSync(fallback, { recursive: true })
  } catch {
    // 实在不行用当前目录
  }
  return fallback
}

/** 读引导答案（存过就复用，坏了就当没存过） */
function loadOnboarding(dataDir, warn) {
  const file = path.join(dataDir, 'onboarding.json')
  try {
    if (FileSystem.existsSync(file)) {
      const raw = JSON.parse(FileSystem.readFileSync(file, 'utf8'))
      return new Onboarding({ persisted: raw, askedOnce: true })
    }
  } catch (error) {
    warn(`freebridge: onboarding state unreadable: ${error?.message ?? error}`)
  }
  const onboarding = new Onboarding()
  // 首次：直接按默认值完成，不卡用户
  onboarding.acceptDefaults()
  try {
    FileSystem.mkdirSync(dataDir, { recursive: true })
    FileSystem.writeFileSync(file, JSON.stringify(onboarding.snapshot().answers, null, 2), 'utf8')
  } catch (error) {
    warn(`freebridge: onboarding state unprestatable: ${error?.message ?? error}`)
  }
  return onboarding
}

export { STATE, statusSnapshot }
