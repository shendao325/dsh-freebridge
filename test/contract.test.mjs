/**
 * adapter 契约完整性测试。
 *
 * 宿主会逐个调用 adapter 的这些方法。少一个就报
 * "registration.adapter.xxx is not a function"（实机已踩过 resolveModel）。
 *
 * 本测试以 dsh-our-free-model 的真实 adapter 为基准，逐方法比对。
 */
import { FreeBridgeAdapter, ROUTE } from '../src/adapter.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

const deps = {
  settings: () => ({
    enabled: true,
    kilo: { enabled: true, weight: 20 },
    ovh: { enabled: false, weight: 6 },
    routing: { enabled: true },
  }),
  warn: () => {},
  ledger: null,
  router: null,
}

const adapter = new FreeBridgeAdapter(deps)

console.log('\n[契约] 宿主必需的方法一个都不能少')

// 这些方法来自 dsh-our-free-model 的 FreeModelAdapter，是宿主的真实契约
const REQUIRED = [
  'providerInfo',
  'providerRetryPolicy',
  'imageRequestPricing',
  'listModels',
  'resolveModel',
  'prepareCall',
  'stream',
]

for (const method of REQUIRED) {
  check(`有 ${method}()`, typeof adapter[method] === 'function',
    typeof adapter[method] === 'function' ? '' : `实际 ${typeof adapter[method]}`)
}

console.log('\n[契约] providerInfo')
const info = adapter.providerInfo(ROUTE)
check('返回对象', typeof info === 'object')
check('含 id', info.id === ROUTE, String(info.id))
check('含 name', typeof info.name === 'string' && info.name.length > 0, String(info.name))

console.log('\n[契约] providerRetryPolicy')
const policy = adapter.providerRetryPolicy()
check('返回冻结对象', Object.isFrozen(policy))
check('maxRetries 是顶层数字（不嵌套 backoff）', typeof policy.maxRetries === 'number' && policy.backoff === undefined)
check('retryableCodes 是数组', Array.isArray(policy.retryableCodes) && policy.retryableCodes.length > 0)
check('delay 字段在顶层', typeof policy.initialDelayMs === 'number' && typeof policy.maxDelayMs === 'number')

console.log('\n[契约] imageRequestPricing（同步，不能返回 undefined）')
const pricing = adapter.imageRequestPricing(ROUTE, 'kilo-auto/free')
check('非 undefined', pricing !== undefined)
check('是对象', typeof pricing === 'object')

console.log('\n[契约] listModels')
const models = await adapter.listModels(ROUTE)
check('返回数组', Array.isArray(models))
check('非空（真实上游）', models.length > 0, `models=${models.length}`)
if (models.length > 0) {
  check('每项含 provider', models[0].provider === ROUTE)
  check('每项含 id', typeof models[0].id === 'string')
  check('每项含 name', typeof models[0].name === 'string')
}

console.log('\n[契约] resolveModel（实机崩溃点）')
const resolved = await adapter.resolveModel(ROUTE, 'kilo-auto/free')
check('返回对象', typeof resolved === 'object' && resolved !== null)
check('含 provider', resolved.provider === ROUTE)
check('含 id', typeof resolved.id === 'string')
check('含 name', typeof resolved.name === 'string')
check('含 context.contextWindow', typeof resolved.context?.contextWindow === 'number',
  JSON.stringify(resolved.context))
check('含 defaultMaxTokens', typeof resolved.defaultMaxTokens === 'number',
  String(resolved.defaultMaxTokens))

// 未知模型也要能解析（不能抛）
const resolvedUnknown = await adapter.resolveModel(ROUTE, 'gpt-6-sol')
check('未知模型名也能解析（不抛错）', typeof resolvedUnknown.id === 'string')

console.log('\n[契约] prepareCall')
const prepared = await adapter.prepareCall(ROUTE, 'kilo-auto/free')
check('返回对象', typeof prepared === 'object')
check('含 model 元数据', typeof prepared.model?.id === 'string')
check('含 stream 闭包', typeof prepared.stream === 'function')

// prepareCall 返回的 stream 必须能真跑
let text = ''
let finish = null
for await (const chunk of prepared.stream({
  model: 'kilo-auto/free',
  messages: [{ role: 'user', content: '回复OK' }],
  sessionId: 'contract-test',
})) {
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'finish') finish = chunk.reason?.kind
}
check('prepareCall 返回的 stream 能产出正文', text.length > 0, `text="${text.slice(0, 20)}"`)
check('finish 正常', finish === 'stop', String(finish))

console.log('\n[契约] stream 返回 async iterator')
const it = adapter.stream({ model: 'kilo-auto/free', messages: [{ role: 'user', content: 'hi' }] }, null)
check('有 Symbol.asyncIterator', typeof it[Symbol.asyncIterator] === 'function')
check('有 next', typeof it.next === 'function')
check('有 return（可提前终止）', typeof it.return === 'function')
check('有 throw', typeof it.throw === 'function')
await it.return?.()

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
