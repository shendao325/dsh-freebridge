/**
 * 关键回归测试：验证 apply 返回时 adapter 已经注册。
 *
 * 这是「显示异常 + 功能全无」的根因 ——
 * 如果 adapter 在 apply 返回后才异步注册，宿主已经判完状态了。
 */
import { Context } from '@deepseek-ai/cordis'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

const logs = []
const logger = {
  info: (...a) => logs.push(['info', a.join(' ')]),
  warn: (...a) => logs.push(['warn', a.join(' ')]),
  error: (...a) => logs.push(['error', a.join(' ')]),
  debug: () => {},
}

const app = new Context()
app.logger = logger

const registrations = []
app.provide('llm', {
  registerAdapter: (routes, adapter) => {
    registrations.push({ routes, adapter, at: Date.now() })
    return () => { registrations.length = 0 }
  },
  registerConfigurableProviders: () => {},
  registerModelDiscovery: () => {},
})

const mod = await import('dsh-freebridge')

console.log('\n[核心] apply 返回时 adapter 必须已注册')
const before = registrations.length
const startedAt = Date.now()
mod.apply(app, mod.Config({}))
const after = registrations.length
const elapsed = Date.now() - startedAt

check('apply 返回后立刻有 adapter 注册', after > before, `注册数 ${after - before}`)
check('注册发生在 apply 同步期间（不是延后）', elapsed < 2000, `elapsed=${elapsed}ms`)
check('route 是 freebridge', registrations[0]?.routes?.includes('freebridge') === true)

console.log('\n[核心] 这是宿主判状态时看到的情况')
// 模拟宿主：apply 一返回就检查状态
check('宿主视角：插件已是可用状态（模型可被发现）', registrations.length === 1)
const listModels = await registrations[0].adapter.listModels('freebridge')
check('listModels 可调用并返回模型', Array.isArray(listModels) && listModels.length > 0, `models=${listModels?.length}`)
console.log(`    模型数: ${listModels.length}`)

console.log('\n[核心] adapter 契约完整性')
const adapter = registrations[0].adapter
check('providerInfo 存在', typeof adapter.providerInfo === 'function')
check('providerRetryPolicy 存在', typeof adapter.providerRetryPolicy === 'function')
check('imageRequestPricing 存在', typeof adapter.imageRequestPricing === 'function')
check('stream 存在', typeof adapter.stream === 'function')
const info = adapter.providerInfo('freebridge')
check('providerInfo 返回 displayName FreeBridge', info.name === 'FreeBridge', JSON.stringify(info))

console.log('\n[核心] 异步重活不阻塞注册')
check('模块启动日志在 apply 之后出现', logs.filter(([, m]) => m.includes('module "')).length > 0)
check('日志显示 provider registered', logs.some(([, m]) => m.includes('provider registered')),
  JSON.stringify(logs.map(([, m]) => m).slice(0, 3)))

console.log('\n[核心] 真实对话（验证模型真能用）')
let text = ''
let finish = null
for await (const chunk of adapter.stream({
  model: 'kilo-auto/free',
  messages: [{ role: 'user', content: '回复OK' }],
  sessionId: 'regression-test',
}, null)) {
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'finish') finish = chunk.reason?.kind
}
check('真实对话有内容', text.length > 0, `text="${text.slice(0, 30)}"`)
check('finish = stop', finish === 'stop', String(finish))

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
