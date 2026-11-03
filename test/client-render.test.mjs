/**
 * client bundle 真实执行测试。
 *
 * 提供一个 mock 的 window.__ModuleLoader__ 和最小 React，
 * 真正执行 client.js，验证：
 * - factory 能跑起来
 * - apply() 注册了 slot
 * - 渲染函数在拿到空数据时不会崩
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

// ── 极简 React 桩：只要 createElement 就行了 ──
const fakeReact = {
  createElement: (tag, props, ...children) => ({ tag, props, children: children.flat() }),
  Fragment: 'Fragment',
  useState: init => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
  useMemo: fn => fn(),
  useRef: () => ({ current: null }),
}

// ── 捕获 ModuleLoader 注册 ──
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load: spec => { captured = spec },
  },
}
globalThis.fetch = async () => {
  throw new Error('network disabled in test')
}

// ── 执行 client.js ──
const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
console.log('\n[执行] 运行 client.js')
try {
  // client.js 是立即执行 window.__ModuleLoader__.load(...)
  // 用 Function 执行，注入 window
  const runner = new Function('window', 'require', code)
  runner(globalThis.window, name => {
    if (name === 'react') return fakeReact
    throw new Error(`unexpected require: ${name}`)
  })
  check('client.js 执行不抛错', true)
} catch (error) {
  check('client.js 执行不抛错', false, String(error?.message))
  console.log(`    ${String(error?.stack).split('\n').slice(0, 5).join('\n    ')}`)
}

check('注册到了 ModuleLoader', captured !== null, captured === null ? '未捕获' : '')
if (captured !== null) {
  check('id 是 dsh-freebridge', captured.id === 'dsh-freebridge', String(captured.id))
  check('有 factory', typeof captured.factory === 'function')
}

// ── 调用 factory，拿到插件模块 ──
console.log('\n[factory] 执行 factory')
let pluginModule = null
try {
  pluginModule = captured.factory(name => {
    if (name === 'react') return fakeReact
    if (name === 'react-dom') throw new Error('no react-dom')
    throw new Error(`unexpected require: ${name}`)
  })
  check('factory 返回模块', typeof pluginModule === 'object' && pluginModule !== null)
} catch (error) {
  check('factory 返回模块', false, String(error?.message))
}

if (pluginModule !== null) {
  check('导出 apply', typeof pluginModule.apply === 'function')
  check('导出 inject', Array.isArray(pluginModule.inject))
  check('inject 含 slots', pluginModule.inject.includes('slots'))
  check('导出 name', pluginModule.name === 'freebridge')
}

// ── 调 apply，验证 slot 注册 ──
console.log('\n[apply] 调用 apply 注册 slot')
const registrations = []
const fakeCtx = {
  slots: {
    inject: (name, fn) => {
      console.log(`    inject slot: ${name}`)
      fn()
    },
    register: (meta, render) => {
      registrations.push({ meta, render })
      console.log(`    注册: ${meta.name}/${meta.id}`)
    },
  },
  locale: { get: () => 'zh' },
}

try {
  pluginModule.apply(fakeCtx)
  check('apply 执行不抛错', true)
} catch (error) {
  check('apply 执行不抛错', false, String(error?.message))
}

check('注册了 settings.section', registrations.some(r => r.meta.name === 'settings.section'),
  JSON.stringify(registrations.map(r => r.meta.name)))
check('注册了 settings.onboarding', registrations.some(r => r.meta.name === 'settings.onboarding'))

// ── 渲染函数能不能跑（用空数据） ──
console.log('\n[render] 渲染函数在无数据时不崩')
for (const reg of registrations) {
  try {
    const props = { t: k => k, locale: 'zh' }
    const tree = reg.render(props)
    check(`${reg.meta.id} 渲染不抛错`, tree !== null && tree !== undefined)
  } catch (error) {
    check(`${reg.meta.id} 渲染不抛错`, false, String(error?.message).slice(0, 80))
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
