/**
 * tools 格式转换测试 + 真实上游验证。
 *
 * 实机故障：DSH 传 46 个 tools（Anthropic 风格），直接透传给 Kilo 会 400
 * "missing field `type`"。本测试验证转换后能真的跑通。
 */
import { FreeBridgeAdapter, ROUTE } from '../src/adapter.js'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

const adapter = new FreeBridgeAdapter({
  settings: () => ({
    enabled: true,
    kilo: { enabled: true, weight: 20 },
    ovh: { enabled: false, weight: 6 },
    routing: { enabled: true },
  }),
  warn: m => console.log('  [warn]', String(m).slice(0, 150)),
  ledger: null,
  router: null,
})

console.log('\n[转换] 各种 tools 形态都要转成 OpenAI 格式')

// 模拟 DSH 真实传的 Anthropic 风格 tools
const anthropicTools = [
  { name: 'run_code', description: 'run code', input_schema: { type: 'object', properties: { code: { type: 'string' } } } },
  { name: 'read_file', description: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  // 没有 input_schema 的
  { name: 'no_schema', description: 'x' },
]

// 用真实 adapter 跑一次，确认不再 400
console.log('\n[实测] 带 46 个 tools 的真实请求')

const manyTools = Array.from({ length: 46 }, (_, i) => ({
  name: `tool_${i}`,
  description: `tool number ${i}`,
  input_schema: { type: 'object', properties: { arg: { type: 'string' } }, required: ['arg'] },
}))

let text = ''
let finish = null
const events = []
try {
  for await (const chunk of adapter.stream({
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    messages: [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: '说"OK"两个字' },
    ],
    tools: manyTools,
    maxTokens: 200,
    sessionId: 'tools-test',
  }, null)) {
    events.push(chunk.type)
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') finish = chunk.reason?.kind
  }
} catch (error) {
  console.log('  抛错:', error.message)
}

console.log(`\n  结果: text="${text.slice(0, 40)}" finish=${finish}`)
check('带 46 个 tools 不再 400', finish === 'stop' || text.length > 0, `finish=${finish}`)
check('有正文输出', text.length > 0, `text="${text.slice(0, 30)}"`)

console.log('\n[实测] 3 个 Anthropic 风格 tools')
let text2 = ''
let finish2 = null
try {
  for await (const chunk of adapter.stream({
    model: 'cohere/north-mini-code:free',
    messages: [{ role: 'user', content: '说OK' }],
    tools: anthropicTools,
    maxTokens: 200,
    sessionId: 'tools-test2',
  }, null)) {
    if (chunk.type === 'text-delta') text2 += chunk.text
    if (chunk.type === 'finish') finish2 = chunk.reason?.kind
  }
} catch (error) {
  console.log('  抛错:', error.message)
}
console.log(`  结果: text="${text2.slice(0, 40)}" finish=${finish2}`)
check('Anthropic 风格 tools 也能跑', finish2 === 'stop' || text2.length > 0, `finish=${finish2}`)

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
