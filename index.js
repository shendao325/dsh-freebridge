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

import os from 'node:os'
import path from 'node:path'
import FileSystem from 'node:fs'
import z from '@deepseek-ai/schemastery'

import { FreeBridgeAdapter, ROUTE, statusSnapshot } from './src/adapter.js'
import { TokenLedger } from './src/ledger.js'
import { NetworkRouter } from './src/router.js'
import { OperationGuard } from './src/guard.js'
import { DesktopOrchestrator, CAPABILITY } from './src/desktop.js'
import { Supervisor, STATE } from './src/supervisor.js'
import { bootstrap, resolveConfig, Onboarding, ONBOARDING_QUESTIONS } from './src/bootstrap.js'

export const name = 'freebridge'

export const inject = ['llm']

/**
 * 设置项 schema。
 *
 * 必须是 schemastery schema —— cordis 会对它调 `.validate()`，
 * 普通对象会让宿主启动时直接炸在 resolveConfig 里（实测会崩 DSH）。
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('启用 FreeBridge'),

  kilo: z
    .object({
      enabled: z.boolean().default(true),
      weight: z.number().default(20).description('权重越大越常被选中'),
    })
    .default({}),

  ovh: z
    .object({
      enabled: z.boolean().default(true),
      weight: z.number().default(6),
    })
    .default({}),

  ledger: z
    .object({
      enabled: z.boolean().default(true),
      showAttemptLevel: z.boolean().default(false).description('默认显示尝试级而不是逻辑级'),
      includeBranch: z.boolean().default(false).description('统计时包含旁支提问'),
    })
    .default({}),

  routing: z
    .object({
      enabled: z.boolean().default(true),
      probeTimeoutMs: z.number().default(4000),
      separateWebRoute: z.boolean().default(true).description('模型请求与网页抓取分开路由'),
      followSystemProxy: z.boolean().default(true).description('跟随本机已有代理客户端'),
    })
    .default({}),

  desktop: z
    .object({
      enabled: z.boolean().default(true),
      autoLaunch: z.boolean().default(true).description('任务需要时自动拉起应用'),
    })
    .default({}),

  guard: z
    .object({
      enabled: z.boolean().default(true),
      useAiReview: z.boolean().default(false).description('灰色地带交给小模型审查'),
    })
    .default({}),

  exposeHealth: z.boolean().default(true).description('暴露 /freebridge/* 状态与统计接口'),
})

/**
 * @param {import('cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config = {}) {
  let currentConfig = resolveConfig(config)
  const logger = ctx.logger ?? {}
  const warn = message => logger.warn?.(message)

  const supervisor = new Supervisor({ logger })
  const dataDir = resolveDataDir()

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

  /**
   * 向宿主注册 provider。
   *
   * **必须在 apply 里同步调用完** —— 宿主一看到 apply 返回就认为插件初始化结束，
   * 那时如果 adapter 还没注册，插件就会被标成「异常」，模型也不进选择器。
   * 之前我把这一步放在 bootstrap 的异步 then 里，结果等了几秒才注册，
   * 宿主早就判完状态了 —— 这就是「显示异常 + 功能全无」的根因。
   */
  function registerProvider() {
    if (registration !== null) return registration

    try {
      // 注意：registerAdapter 返回的是 dispose 函数本身，不是带 .dispose 的对象
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

    logger.info?.('[freebridge] provider registered — models available in picker')
    return registration
  }

  // ── 关键顺序：同步注册 provider，然后再异步启动重活 ──
  // 1) 同步：注册 adapter（宿主立刻能看到 FreeBridge 分组，状态正常）
  registerProvider()

  // 2) 异步：启动模块 + 探测上游（这些慢活不能挡住宿主初始化）
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
      logger.info?.('[freebridge] bootstrap complete')
    })
    .catch(error => {
      // 后备：异步链再怎么错，provider 已经注册好了，对话照样可用
      logger.warn?.(`[freebridge] async init failed (provider still registered): ${error?.message ?? error}`)
    })

  // ── 设置热更新 ──
  ctx.on?.('config', next => {
    currentConfig = resolveConfig(next)
    const guard = supervisor.get('guard')
    if (guard !== null) guard.setEnabled(currentConfig.guard.enabled !== false)
  })

  // ── HTTP 接口 ──
  //
  // 真实宿主用 server.register({kind:'prefix', path, handler}) 挂路由，
  // 而不是 server.on('request')。对照 dsh-our-free-model 的用法：
  //   scoped.effect(() => server.register({ kind:'prefix', path:'/api/xxx', handler }))
  // 用 inject 是必须的：插件加载早于 webServer 发布，直接 get 会拿到 undefined。
  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    if (server === null || server === undefined) return

    const route = (req, res) => {
      try {
        handleHttp(req.url ?? '/', req, res)
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: String(error?.message ?? error) }))
      }
    }

    // 优先用宿主的 register 接口（真实 DSH 走这条）
    if (typeof server.register === 'function') {
      scoped.effect?.(() => server.register({ kind: 'prefix', path: '/freebridge', handler: route }),
        'freebridge: status + stats api')
      logger.info?.('freebridge: API mounted at /freebridge')
      return
    }

    // 后备：如果宿主暴露的是原生 http.Server，用 request 监听
    const raw = server.server ?? server
    if (typeof raw?.on === 'function') {
      raw.on('request', (req, res) => {
        if (!String(req.url ?? '').startsWith('/freebridge')) return
        route(req, res)
      })
      logger.info?.('freebridge: API mounted on raw http server at /freebridge')
    }
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

    // UI 的「全部用默认值」按钮
    if (route === '/freebridge/onboarding/accept-defaults') {
      onboarding.acceptDefaults()
      saveOnboarding(dataDir, onboarding, warn)
      return sendJson({ ok: true, ...onboarding.snapshot() })
    }

    // UI 的单题作答
    if (route === '/freebridge/onboarding/answer') {
      const id = parsed.searchParams.get('id')
      const raw = parsed.searchParams.get('value')
      if (id === null) return sendJson({ error: 'missing ?id=' }, 400)
      const result = onboarding.answer(id, raw !== 'false')
      saveOnboarding(dataDir, onboarding, warn)
      return sendJson({ ...result, ...onboarding.snapshot() })
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

  // registerAdapter 返回的是 dispose 函数本身（对照 dsh-vision-router 的用法：
  // 直接 `handle()` 调用），不是带 .dispose 方法的对象。
  ctx.effect?.(() => {
    return () => {
      try {
        if (typeof registration === 'function') registration()
        else registration?.dispose?.()
      } catch (error) {
        logger.warn?.(`[freebridge] provider dispose failed: ${error?.message ?? error}`)
      }
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
  // 只能用 ctx.get() 查询服务（这是查询接口，不触发 inject 守卫）。
  // 直接写 ctx.desktopControl 会抛 "cannot get property without inject"。
  const launcher = ctx.get?.('desktopControl') ?? null
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

/**
 * 数据目录。
 *
 * **绝不能读 ctx.storagePath / ctx.dshHomePath 这类未声明的属性** ——
 * cordis 有 inject 守卫：读一个没在 `inject` 里声明过的 ctx 属性会直接抛
 * "cannot get property X without inject"，整个插件激活失败。
 * 这个错误曾让插件在用户机器上一直显示「异常」。
 *
 * 正确做法：自己用 os.homedir() 拼出 ~/.dsh 下的目录（同 dsh-session-remove）。
 */
function resolveDataDir() {
  const candidates = []

  // 1. 标准位置：~/.dsh/freebridge
  try {
    candidates.push(path.join(os.homedir(), '.dsh', 'freebridge'))
  } catch {
    // 拿不到 home 就跳过
  }

  // 2. 环境变量兜底
  if (process.env.DSH_HOME) candidates.push(path.join(process.env.DSH_HOME, 'freebridge'))

  // 3. 临时目录兜底
  candidates.push(path.join(os.tmpdir(), 'freebridge'))

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    try {
      FileSystem.mkdirSync(candidate, { recursive: true })
      return candidate
    } catch {
      // 试下一个
    }
  }

  // 4. 最后兜底：当前目录（连临时目录都写不了的话）
  return process.cwd()
}

/** 保存引导答案（UI 点按钮后调用） */
function saveOnboarding(dataDir, onboarding, warn) {
  try {
    const file = path.join(dataDir, 'onboarding.json')
    FileSystem.mkdirSync(dataDir, { recursive: true })
    FileSystem.writeFileSync(file, JSON.stringify(onboarding.snapshot().answers, null, 2), 'utf8')
    return true
  } catch (error) {
    warn?.(`freebridge: onboarding save failed: ${error?.message ?? error}`)
    return false
  }
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
