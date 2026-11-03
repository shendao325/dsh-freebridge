/**
 * 安装后自检：在 profile 环境里真实加载插件、跑装配、打真实上游。
 * 不依赖 DSH 本体，用假 ctx 模拟宿主。
 *
 * 用法：node tools/selftest-installed.mjs
 */
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'

const PROFILE = 'C:/Users/test/.dsh/profiles/desktop'

/** 检查 package.json 有没有残留 dsh.client 声明（有就会崩客户端组合） */
async function hasNoClientDeclaration() {
  try {
    const pkg = JSON.parse(fs.readFileSync(`${PROFILE}/node_modules/dsh-freebridge/package.json`, 'utf8'))
    return pkg.dsh?.client === undefined
  } catch {
    return false
  }
}

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('\n[1] 从 profile 加载插件（验证安装生效）')
let mod = null
try {
  mod = await import(pathToFileURL(`${PROFILE}/node_modules/dsh-freebridge/index.js`).href)
  check('能 import', true)
} catch (error) {
  check('能 import', false, error.message)
  process.exit(1)
}
check('导出 name', mod.name === 'freebridge')
check('导出 inject 含 llm', Array.isArray(mod.inject) && mod.inject.includes('llm'))
check('导出 apply 函数', typeof mod.apply === 'function')
check('导出 Config（schemastery schema，是函数）', typeof mod.Config === 'function')
// 这里曾踩过坑：Config 必须是 schemastery schema 且能补全默认值，
// 否则宿主启动时会在 resolveConfig 里炸掉（实测崩 DSH）。
const validated = typeof mod.Config === 'function' ? mod.Config({}) : null
check('Config 可调用并补全默认值', validated?.guard?.enabled === true && validated?.kilo?.weight === 20,
  JSON.stringify(validated).slice(0, 100))
check('package.json 不再声明 dsh.client（纯 host 插件）', await hasNoClientDeclaration())

console.log('\n[2] 假宿主跑 apply()')
const logs = []
const reg = { adapters: [], providers: [], discovery: [] }
const fakeCtx = {
  logger: { info: m => logs.push(['info', m]), warn: m => logs.push(['warn', m]) },
  llm: {
    registerAdapter: (routes, adapter) => {
      reg.adapters.push({ routes, adapter })
      return { dispose: () => {} }
    },
    registerConfigurableProviders: list => reg.providers.push(...list),
    registerModelDiscovery: (ns, fn) => reg.discovery.push({ ns, fn }),
  },
  fiber: { entry: { options: { id: 'freebridge' } } },
  dshHomePath: sub => `${PROFILE}/../freebridge-data/${sub}`,
  on: () => {},
  effect: fn => fn(),
  inject: (deps, cb) => cb({ webServer: null }),
  get: () => null,
}
mod.apply(fakeCtx, {})

// 等 bootstrap 完成（会去真实网络探测）
for (let i = 0; i < 30; i += 1) {
  if (reg.adapters.length > 0) break
  await new Promise(r => setTimeout(r, 400))
}

check('adapter 已注册', reg.adapters.length === 1, `adapters=${reg.adapters.length}`)
check('route 是 freebridge', reg.adapters[0]?.routes?.includes('freebridge') === true)
check('provider 显示名 FreeBridge', reg.providers[0]?.displayName === 'FreeBridge')
check('模型发现已注册', reg.discovery.length >= 1)
check('日志显示 ready', logs.some(([l, m]) => m.includes('ready')), JSON.stringify(logs.slice(-2)))

console.log('\n[3] 六个模块都起来了吗')
const startLogs = logs.filter(([, m]) => m.includes('module "')).map(([, m]) => m)
check('4 个模块全部 running', startLogs.every(m => m.includes('running')), JSON.stringify(startLogs))
check('模块总数 4（ledger/router/guard/desktop）', startLogs.length === 4, `实际 ${startLogs.length}`)

console.log('\n[4] 模型发现（真实上游）')
const models = await reg.discovery[0].fn()
check('模型列表非空', models.length > 0, `models=${models.length}`)
if (models.length > 0) {
  console.log(`    发现 ${models.length} 个模型，示例：${models.slice(0, 3).map(m => m.name).join(' | ')}`)
  check('模型带 provider 字段', models[0].provider === 'freebridge')
}

console.log('\n[5] 真实对话')
const adapter = reg.adapters[0].adapter
let text = ''
let finishKind = null
try {
  for await (const chunk of adapter.stream({
    model: 'kilo-auto/free',
    messages: [{ role: 'user', content: '回复OK两个字' }],
    sessionId: 'install-selftest',
  }, null)) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') finishKind = chunk.reason?.kind
  }
} catch (error) {
  console.log(`    网络异常: ${error.message}`)
}
check('真实回复有内容', text.length > 0, `text="${text.slice(0, 40)}"`)
check('finish 是 stop', finishKind === 'stop', String(finishKind))

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
