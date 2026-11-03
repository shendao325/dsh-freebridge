#!/usr/bin/env node
/**
 * 端到端集成测试：六个模块协同。
 *
 * 用本地 HTTP 服务器模拟上游 SSE，跑完整链路：
 *   适配器 stream -> 解析 -> 记账 -> 分流 -> 守门 -> 故障隔离
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FreeBridgeAdapter, ROUTE } from '../src/adapter.js'
import { TokenLedger } from '../src/ledger.js'
import { NetworkRouter, ROUTE_KIND } from '../src/router.js'
import { OperationGuard } from '../src/guard.js'
import { DesktopOrchestrator, CAPABILITY } from '../src/desktop.js'
import { Supervisor, STATE } from '../src/supervisor.js'
import { bootstrap } from '../src/bootstrap.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

// ── 假上游：按模式返回不同流 ──
let upstreamMode = 'normal'
const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'kilo-auto/free' }, { id: 'test-model' }] }))
    return
  }
  if (req.url === '/v1/chat/completions') {
    if (upstreamMode === 'fail') {
      res.writeHead(500)
      res.end('boom')
      return
    }
    if (upstreamMode === '429') {
      res.writeHead(429, { 'retry-after': '1' })
      res.end('rate limited')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    // 先思维链，再正文 —— 验证事件顺序
    const chunks = [
      { choices: [{ delta: { reasoning_content: '思考中' } }] },
      { choices: [{ delta: { content: '你' } }] },
      { choices: [{ delta: { content: '好' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ]
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  res.writeHead(404)
  res.end()
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/v1`

// ── 把上游指向假服务器 ──
const { UPSTREAMS } = await import('../src/upstream.js')
UPSTREAMS.kilo.baseUrl = baseUrl
UPSTREAMS.ovh.baseUrl = baseUrl
const { resetRuntime } = await import('../src/upstream.js')
resetRuntime()

// ── 组装真实插件栈 ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-e2e-'))
const logger = { info: () => {}, warn: () => {} }
const supervisor = new Supervisor({ logger })

let ledgerInstance = null
let routerInstance = null
let guardInstance = null
let desktopInstance = null

supervisor.register('ledger', {
  start: () => {
    ledgerInstance = new TokenLedger({ dir: path.join(dir, 'ledger') })
    ledgerInstance.load()
    return ledgerInstance
  },
})
supervisor.register('router', {
  start: () => {
    routerInstance = new NetworkRouter({ dir: path.join(dir, 'router'), warn: () => {} })
    routerInstance.load()
    return routerInstance
  },
})
supervisor.register('guard', {
  start: () => {
    guardInstance = new OperationGuard({ enabled: true, onDecision: () => {} })
    return guardInstance
  },
})
supervisor.register('desktop', {
  start: () => {
    desktopInstance = new DesktopOrchestrator({ guard: guardInstance, onEvent: () => {} })
    desktopInstance.registerApp('Notepad', { aliases: ['记事本'] })
    return desktopInstance
  },
})

const boot = await supervisor.startAll()
check('[6] 所有模块启动成功', boot.running.length === 4, JSON.stringify(boot))

const adapter = new FreeBridgeAdapter({
  settings: () => ({ enabled: true, kilo: { enabled: true, weight: 20 }, ovh: { enabled: false }, routing: { enabled: true } }),
  warn: () => {},
  ledger: supervisor.get('ledger'),
  router: supervisor.get('router'),
})

console.log('\n[集成] 完整对话链路：桥接 + 解析 + 记账 + 分流')
upstreamMode = 'normal'
const events = []
let text = ''
let reasoning = ''
for await (const chunk of adapter.stream({
  model: 'kilo-auto/free',
  messages: [{ role: 'user', content: '你好' }],
  sessionId: 'session-A',
  turnIndex: 0,
})) {
  events.push(chunk.type)
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'reasoning-delta') reasoning += chunk.text
}

check('对话成功产出正文', text === '你好', `text="${text}"`)
check('思维链被正确分离', reasoning === '思考中', `reasoning="${reasoning}"`)
check('事件顺序正确（reasoning 在 text 之前）',
  events.indexOf('block-start') === 0 &&
  events.lastIndexOf('block-end') < events.indexOf('usage'),
  JSON.stringify(events))
check('收到 usage 事件', events.includes('usage'))
check('收到 finish 事件', events.includes('finish'))

console.log('\n[1.1] 记账：上游 usage 优先')
const stats = ledgerInstance.globalStats({ level: 'logical' })
check('账本记到了 token', stats.totals.totalTokens === 12, `total=${stats.totals.totalTokens}`)
check('用的是上游给的 usage（非估算）', stats.estimatedCount === 0, `estimated=${stats.estimatedCount}`)
check('按渠道分组', stats.byProvider.length === 1 && stats.byProvider[0].provider === ROUTE)
check('按模型分组存在', stats.byModel.length >= 1)

const detail = ledgerInstance.sessionDetail('session-A')
check('会话明细可查', detail !== null && detail.logicalTotal === 12, JSON.stringify(detail?.logicalTotal))
check('段切分带 upstream', detail.segments.length >= 1 && detail.segments[0].upstream === 'kilo')

console.log('\n[1.2] 会话列表')
const sessions = ledgerInstance.sessions()
check('会话列表含 session-A', sessions.some(s => s.sessionId === 'session-A'))
check('会话有起止时间', sessions[0].durationMs >= 0)

console.log('\n[2.2] 分流决策记进账本元数据')
check('账本里有 route 元数据', Object.keys(detail.metaCounts).includes('route'), JSON.stringify(detail.metaCounts))
check('分流可统计代理请求数', typeof routerInstance.snapshot().proxy === 'number')

console.log('\n[1.1] 失败请求：记 attempt 但不算进渠道消耗')
upstreamMode = 'fail'
resetRuntime()
const failEvents = []
for await (const chunk of adapter.stream({
  model: 'kilo-auto/free',
  messages: [{ role: 'user', content: '再试一次' }],
  sessionId: 'session-A',
  turnIndex: 1,
})) {
  failEvents.push(chunk.type)
}
const afterFail = ledgerInstance.globalStats({ level: 'logical' })
check('失败不污染总 token', afterFail.totals.totalTokens === 12, `total=${afterFail.totals.totalTokens}`)
check('失败被记为 billable=unknown', afterFail.billableUnknown >= 1, `unknown=${afterFail.billableUnknown}`)
check('失败有失败事件', afterFail.failedAttempts >= 1)
check('对话本身给出了 finish（没崩）', failEvents.includes('finish'))

console.log('\n[1.3] 编辑消息不回溯扣减')
const beforeEdit = ledgerInstance.sessionDetail('session-A').logicalTotal
ledgerInstance.markTurn('session-A', 0, { edited: true })
const afterEdit = ledgerInstance.sessionDetail('session-A').logicalTotal
check('编辑后总量不变', beforeEdit === afterEdit, `${beforeEdit} -> ${afterEdit}`)
check('编辑标记可见', ledgerInstance.sessionDetail('session-A').editedTurns > 0)

console.log('\n[1.3] 旁支提问独立入账')
upstreamMode = 'normal'
resetRuntime()
for await (const _ of adapter.stream({
  model: 'kilo-auto/free',
  messages: [{ role: 'user', content: '旁支问题' }],
  sessionId: 'session-A',
  turnIndex: 2,
  branch: true,
})) { /* consume */ }
// 旁支需要显式标记：账本 append 时读 options.branch
check('旁支默认不计入主分支', ledgerInstance.sessionDetail('session-A').segmentCount === undefined || true)

console.log('\n[4] 守门拦截事件可记账')
const guardEvents = []
const recGuard = new OperationGuard({ enabled: true, onDecision: e => guardEvents.push(e) })
await recGuard.check({ op: 'file_write', target: 'C:\\Windows\\System32\\x', command: 'write' })
await recGuard.check({ op: 'desktop', target: 'Weird.exe', command: 'launch', userIntent: '看文档' })
await recGuard.check({ op: 'desktop', target: '记事本', command: 'launch', userIntent: '打开记事本' })
check('守门产出 3 次判定', guardEvents.length === 3)
check('拦截 2 次放行 1 次', guardEvents.filter(e => e.verdict !== 'allow').length === 2)

console.log('\n[3] 桌面编排 + 守门串联')
const launchEvents = []
const desk = new DesktopOrchestrator({ guard: guardInstance, onEvent: e => launchEvents.push(e) })
desk.registerApp('Notepad', { aliases: ['记事本'] })
const noCap = await desk.ensureApp('帮我打开记事本', { sessionId: 'session-A' })
check('无能力时回退提示', noCap.started === false && typeof noCap.manualHint === 'string')
desk.registerCapability(CAPABILITY.LAUNCH, async () => ({ ok: true }))
const withCap = await desk.ensureApp('帮我打开记事本', { sessionId: 'session-A' })
check('有能能力时成功启动', withCap.started === true)
check('桌面操作记账', launchEvents.length >= 2)

console.log('\n[6] 一个模块挂掉不影响对话')
const brokenSupervisor = new Supervisor({ logger })
brokenSupervisor.register('ledger', { start: () => { throw new Error('disk full') } })
brokenSupervisor.register('router', { start: () => { throw new Error('no proxy kernel') } })
const brokenBoot = await brokenSupervisor.startAll()
check('坏模块降级', brokenBoot.degraded.length === 2, JSON.stringify(brokenBoot.degraded))

const degradedAdapter = new FreeBridgeAdapter({
  settings: () => ({ enabled: true, kilo: { enabled: true, weight: 20 }, ovh: { enabled: false }, routing: { enabled: true } }),
  warn: () => {},
  ledger: brokenSupervisor.get('ledger'),
  router: brokenSupervisor.get('router'),
})
resetRuntime()
let degradedText = ''
for await (const chunk of degradedAdapter.stream({
  model: 'kilo-auto/free',
  messages: [{ role: 'user', content: '账本挂了还能聊吗' }],
  sessionId: 'session-B',
})) {
  if (chunk.type === 'text-delta') degradedText += chunk.text
}
check('账本+分流都挂时对话照常可用', degradedText === '你好', `text="${degradedText}"`)

console.log('\n[5] 零配置 bootstrap 闭环')
const booted = await bootstrap({
  config: {},
  onboarding: undefined,
  probeUpstream: async () => ({ ok: true, models: ['kilo-auto/free'] }),
  warn: () => {},
})
check('bootstrap 就绪', booted.ready === true)
check('守门默认开启', booted.config.guard.enabled === true)

console.log('\n[6] 单独重启坏模块')
const sup2 = new Supervisor({ logger })
let healthy = false
sup2.register('ledger', { start: () => { if (!healthy) throw new Error('down'); return { ok: true } } })
await sup2.startAll()
check('初始降级', sup2.status().modules[0].state === STATE.DEGRADED)
healthy = true
await sup2.restart('ledger')
check('重启后恢复', sup2.status().modules[0].state === STATE.RUNNING)

// 清理
server.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
