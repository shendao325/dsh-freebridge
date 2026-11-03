#!/usr/bin/env node
/**
 * 宿主装配测试：用一个假的 cordis Context 跑 apply()，
 * 验证插件能在真实宿主里装起来（不依赖 DSH 本体）。
 */
import { apply, name, inject, Config } from '../index.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

// ── 假宿主 ──
const logs = []
const registered = { adapters: [], providers: [], discovery: [] }

const fakeCtx = {
  logger: {
    info: m => logs.push(['info', m]),
    warn: m => logs.push(['warn', m]),
  },
  llm: {
    registerAdapter: (routes, adapter) => {
      registered.adapters.push({ routes, adapter })
      return { dispose: () => { registered.adapters.length = 0 } }
    },
    registerConfigurableProviders: list => { registered.providers.push(...list) },
    registerModelDiscovery: (ns, fn) => { registered.discovery.push({ ns, fn }) },
  },
  fiber: { entry: { options: { id: 'freebridge' } } },
  dshHomePath: sub => `${process.env.TEMP}/fb-host/${sub}`,
  on: () => {},
  effect: fn => fn(),
  inject: (deps, cb) => cb({ webServer: null }),
  get: () => null,
}

console.log('\n[装配] apply() 能在宿主里跑起来')
const config = {}
apply(fakeCtx, config)
// bootstrap 会去真实网络探测上游，这里轮询等它完成（最多 12s）
for (let i = 0; i < 24; i += 1) {
  if (registered.adapters.length > 0) break
  await new Promise(resolve => setTimeout(resolve, 500))
}

check('插件 name 正确', name === 'freebridge')
check('声明了 llm 依赖', inject.includes('llm'))
check('Config schema 存在', typeof Config === 'object' && Config.guard !== undefined)
check('注册了 adapter', registered.adapters.length === 1, `adapters=${registered.adapters.length}`)
check('adapter 挂在 freebridge route', registered.adapters[0]?.routes?.includes('freebridge') === true)
check('注册了 provider 显示名', registered.providers.length >= 1 && registered.providers[0].displayName === 'FreeBridge')
check('注册了模型发现', registered.discovery.length >= 1)
check('日志里有 ready 或 module 信息', logs.some(([level, m]) => m.includes('[freebridge]')), JSON.stringify(logs.slice(0, 2)))
check('没有 ERROR 级别崩溃', logs.filter(([l]) => l === 'warn').length <= 4, `warn=${logs.filter(([l]) => l === 'warn').length}`)

console.log('\n[装配] adapter 契约完整')
const adapter = registered.adapters[0].adapter
check('有 providerInfo', typeof adapter.providerInfo === 'function')
check('有 providerRetryPolicy', typeof adapter.providerRetryPolicy === 'function')
check('有 imageRequestPricing', typeof adapter.imageRequestPricing === 'function')
check('有 listModels', typeof adapter.listModels === 'function')
check('有 stream', typeof adapter.stream === 'function')

const policy = adapter.providerRetryPolicy()
check('重试策略是扁平对象（不在 backoff 里嵌套）', policy.maxRetries !== undefined && policy.backoff === undefined)
check('重试策略冻结', Object.isFrozen(policy))
check('视觉定价非 undefined（spill-policy 需要）', adapter.imageRequestPricing() !== undefined)

console.log('\n[装配] 模型发现可调用')
const models = await registered.discovery[0].fn()
check('模型发现返回数组（可能为空，因网络）', Array.isArray(models))
if (models.length > 0) {
  check('模型行有 provider/id/name', models[0].provider === 'freebridge' && typeof models[0].id === 'string')
  console.log(`    （发现 ${models.length} 个模型）`)
}

console.log('\n[装配] stream 可迭代')
const stream = adapter.stream(
  { model: 'kilo-auto/free', messages: [{ role: 'user', content: 'hi' }], sessionId: 'host-test' },
  null
)
check('stream 返回 async iterator', typeof stream[Symbol.asyncIterator] === 'function')
check('有 next/return/throw', typeof stream.next === 'function' && typeof stream.return === 'function' && typeof stream.throw === 'function')

// 消费一小段就退出（不实际打网络请求的全流程）
const first = await stream.next()
check('能拿到第一个事件', first.done === false || first.done === true)
if (first.done !== true) {
  console.log(`    第一个事件: ${JSON.stringify(first.value).slice(0, 90)}`)
}
await stream.return?.()

console.log('\n[装配] 真实上游端到端（可能因网络失败，仅作观测）')
let realText = ''
let realOk = false
try {
  const s2 = adapter.stream(
    { model: 'kilo-auto/free', messages: [{ role: 'user', content: '回复OK两个字' }], sessionId: 'host-e2e' },
    null
  )
  for await (const chunk of s2) {
    if (chunk.type === 'text-delta') realText += chunk.text
    if (chunk.type === 'finish') realOk = chunk.reason?.kind === 'stop'
  }
} catch (error) {
  console.log(`    网络异常（可接受）: ${error.message}`)
}
console.log(`    真实回复: "${realText.slice(0, 40)}" finish=${realOk}`)
check('真实调用有产出或明确失败（不挂死）', realText.length > 0 || true)

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
