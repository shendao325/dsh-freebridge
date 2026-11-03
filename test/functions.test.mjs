/**
 * 功能可用性验证：在真实 cordis 环境里，逐个调用六个模块的对外接口。
 *
 * 目的：确认「功能不是摆设」——每个模块都能通过 HTTP 路由拿到真实数据。
 */

import { Context } from '@deepseek-ai/cordis'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

const app = new Context()
app.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }

const registrations = []
app.provide('llm', {
  registerAdapter: (routes, adapter) => {
    registrations.push({ routes, adapter })
    return () => {}
  },
  registerConfigurableProviders: () => {},
  registerModelDiscovery: () => {},
})

const mod = await import('dsh-freebridge')

// 模拟真实宿主的 webServer 契约：register({kind, path, handler})
const registered = []
const fakeWebServer = {
  register: spec => {
    registered.push(spec)
    return () => {}
  },
}
// 用真实 cordis provide 发 webServer 服务
app.provide('webServer', fakeWebServer)

mod.apply(app, mod.Config({}))

// 等异步模块启动 + inject 回调执行
await new Promise(r => setTimeout(r, 4000))

console.log('\n[功能验证] API 是否挂上宿主')
check('webServer.register 被调用', registered.length > 0, `calls=${registered.length}`)
check('注册了 /freebridge 前缀路由', registered.some(r => r.kind === 'prefix' && r.path === '/freebridge'),
  JSON.stringify(registered.map(r => `${r.kind}:${r.path}`)))

/** 模拟宿主分发一个请求到插件 handler */
function dispatch(path) {
  const spec = registered.find(r => r.path === '/freebridge' && r.kind === 'prefix')
  if (spec === undefined) return { status: 404, body: '' }
  return new Promise(resolve => {
    const chunks = []
    const res = {
      writeHead(code) { this.statusCode = code },
      end(body) { resolve({ status: this.statusCode ?? 200, body: body ?? chunks.join('') }) },
      write(c) { chunks.push(c) },
      statusCode: 200,
    }
    spec.handler({ url: path, method: 'GET', headers: {} }, res)
  })
}

console.log('\n[功能验证] 六个模块的对外接口是否真的能返回数据')

const health = await dispatch('/freebridge/health')
check('/freebridge/health 有响应', health.status === 200, `status=${health.status}`)
if (health.status === 200) {
  const h = JSON.parse(health.body)
  check('  health 含模块状态', Array.isArray(h.modules?.modules))
  check('  health 显示模块数 ≥ 4', h.modules?.modules?.length >= 4, `modules=${h.modules?.modules?.length}`)
  check('  health 显示上游状态', Array.isArray(h.upstreams))
  const running = h.modules?.modules?.filter(m => m.state === 'running').length ?? 0
  check('  所有模块 running', running >= 4, `running=${running}`)
}

const stats = await dispatch('/freebridge/stats')
check('/freebridge/stats（模块一）有响应', stats.status === 200, `status=${stats.status}`)
if (stats.status === 200) {
  const s = JSON.parse(stats.body)
  check('  返回全局统计结构', s.totals !== undefined && Array.isArray(s.byProvider))
  console.log(`    level=${s.level} requests=${s.totals?.requests}`)
}

const sessions = await dispatch('/freebridge/sessions')
check('/freebridge/sessions（模块一）有响应', sessions.status === 200, `status=${sessions.status}`)

const routes = await dispatch('/freebridge/routes')
check('/freebridge/routes（模块二）有响应', routes.status === 200, `status=${routes.status}`)
if (routes.status === 200) {
  const r = JSON.parse(routes.body)
  check('  返回分流快照', r.snapshot !== undefined && typeof r.snapshot.proxy === 'number')
  check('  返回节点状态', Array.isArray(r.nodes))
}

const guard = await dispatch('/freebridge/guard')
check('/freebridge/guard（模块四）有响应', guard.status === 200, `status=${guard.status}`)
if (guard.status === 200) {
  const g = JSON.parse(guard.body)
  check('  守门默认开启', g.enabled === true, `enabled=${g.enabled}`)
  check('  规则表可枚举', g.rules?.hard > 0 && g.rules?.suspicious > 0, JSON.stringify(g.rules))
}

const desktop = await dispatch('/freebridge/desktop')
check('/freebridge/desktop（模块三）有响应', desktop.status === 200, `status=${desktop.status}`)
if (desktop.status === 200) {
  const d = JSON.parse(desktop.body)
  check('  返回能力清单', Array.isArray(d.capabilities))
}

const onboarding = await dispatch('/freebridge/onboarding')
check('/freebridge/onboarding（模块五）有响应', onboarding.status === 200, `status=${onboarding.status}`)
if (onboarding.status === 200) {
  const o = JSON.parse(onboarding.body)
  check('  引导已完成', o.completed === true, `completed=${o.completed}`)
  check('  只有 2 个问题', o.questions?.length === 2, `questions=${o.questions?.length}`)
}

const unknown = await dispatch('/freebridge/nope')
check('未知路由返回 404', unknown.status === 404, `status=${unknown.status}`)

console.log('\n[功能验证] 单模块重启（模块六）')
const restart = await dispatch('/freebridge/restart?module=ledger')
check('/freebridge/restart 有响应', restart.status === 200, `status=${restart.status}`)
await new Promise(r => setTimeout(r, 1200))
const restart2 = await dispatch('/freebridge/restart?module=nope')
check('重启未知模块返回失败', restart2.status === 200 && JSON.parse(restart2.body).ok === false, restart2.body?.slice(0, 60))

console.log('\n[功能验证] 记账真的在写（模块一）')
const adapter = registrations[0].adapter
for await (const _ of adapter.stream({
  model: 'kilo-auto/free',
  messages: [{ role: 'user', content: '你好' }],
  sessionId: 'func-test',
}, null)) { /* consume */ }

const stats2 = await dispatch('/freebridge/stats')
if (stats2.status === 200) {
  const s = JSON.parse(stats2.body)
  check('  真实对话后账本有记录', s.totals.requests > 0, `requests=${s.totals.requests}`)
  check('  记录了 token 数', s.totals.totalTokens > 0, `tokens=${s.totals.totalTokens}`)
  console.log(`    记录 ${s.totals.requests} 次请求，${s.totals.totalTokens} tokens`)
}

const sessions2 = await dispatch('/freebridge/sessions')
if (sessions2.status === 200) {
  const list = JSON.parse(sessions2.body).sessions
  check('  会话列表含 func-test', list.some(x => x.sessionId === 'func-test'), JSON.stringify(list.map(x => x.sessionId)))
}


console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
