/**
 * inject 守卫测试 —— 这是能真正测出「cannot get property X without inject」的测试。
 *
 * 关键：必须用 `app.plugin()` 创建带 runtime 的 fiber，守卫才生效。
 * 之前用普通对象当 ctx，守卫完全不触发，所以测试全绿、实机崩溃。
 *
 * 本测试同时验证「测试自身有检测能力」（用一个故意违规的插件做对照）。
 */
import { Context } from '@deepseek-ai/cordis'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

// ── 第一步：确认测试环境有守卫能力（对照实验）──
console.log('\n[对照] 测试环境能否测出注入违规')
{
  const probe = new Context()
  probe.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  let caught = null
  const badPlugin = {
    name: 'guard-canary',
    apply(ctx) {
      // 故意读一个未声明属性：必须被拦
      void ctx.storagePath
    },
  }
  try {
    await probe.plugin(badPlugin, {})
    await new Promise(r => setTimeout(r, 800))
  } catch (error) {
    caught = error
  }
  check('环境有守卫能力（违规插件被拦下）', caught !== null, caught === null ? '未拦下，测试不可信！' : '')
  if (caught !== null) console.log(`    拦截信息: ${String(caught.message).slice(0, 70)}`)
}

// ── 第二步：用真实 fiber 加载我们的插件 ──
console.log('\n[真实 fiber] 加载 dsh-freebridge')
const logs = []
const app = new Context()
app.logger = {
  info: (...a) => logs.push(['info', a.join(' ')]),
  warn: (...a) => logs.push(['warn', a.join(' ')]),
  error: (...a) => logs.push(['error', a.join(' ')]),
  debug: () => {},
}

const registrations = []
const apiRegs = []
app.provide('llm', {
  registerAdapter: (routes, adapter) => {
    registrations.push({ routes, adapter })
    return () => {}
  },
  registerConfigurableProviders: () => {},
  registerModelDiscovery: () => {},
})
app.provide('webServer', {
  register: spec => {
    apiRegs.push(spec)
    return () => {}
  },
})

const mod = await import('dsh-freebridge')

let applyError = null
try {
  await app.plugin(mod, mod.Config({}))
} catch (error) {
  applyError = error
  console.log(`    激活抛错: ${String(error.message).slice(0, 120)}`)
}
await new Promise(r => setTimeout(r, 2500))

check('插件激活没有抛错', applyError === null, applyError ? String(applyError.message).slice(0, 100) : '')
check('不是 inject 守卫错误', !(applyError && /without inject|inactive context/.test(applyError.message)),
  applyError ? String(applyError.message).slice(0, 80) : '')
check('注册了 adapter', registrations.length > 0, `regs=${registrations.length}`)
check('注册了 API 路由', apiRegs.length > 0, `api=${apiRegs.length}`)

console.log('\n[真实 fiber] 运行状况')
const guardErrors = logs.filter(([, m]) => /without inject|inactive context/.test(m))
check('运行期无守卫错误', guardErrors.length === 0, JSON.stringify(guardErrors.slice(0, 2)))
const errorLogs = logs.filter(([l]) => l === 'error')
check('无 error 级日志', errorLogs.length === 0, JSON.stringify(errorLogs.slice(0, 2)))
const startLogs = logs.filter(([, m]) => m.includes('module "'))
check('4 个模块启动', startLogs.length === 4, `实际 ${startLogs.length}`)
check('provider 已注册（同步）', logs.some(([, m]) => m.includes('provider registered')))

console.log('\n[真实 fiber] API 可用')
if (apiRegs.length > 0) {
  const spec = apiRegs.find(r => r.path === '/freebridge')
  if (spec !== undefined) {
    const res = await new Promise(resolve => {
      const r = {
        statusCode: 200,
        writeHead(c) { this.statusCode = c },
        end(b) { resolve({ status: this.statusCode, body: b ?? '' }) },
        write() {},
      }
      spec.handler({ url: '/freebridge/health', method: 'GET', headers: {} }, r)
    })
    check('health 返回 200', res.status === 200, `status=${res.status}`)
    if (res.status === 200) {
      try {
        const h = JSON.parse(res.body)
        check('  health 含模块状态', Array.isArray(h.modules?.modules))
      } catch {
        check('  health 是合法 JSON', false)
      }
    }
  }
}

console.log('\n日志:')
for (const [lv, m] of logs.slice(0, 10)) console.log(`    [${lv}] ${m}`)

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
