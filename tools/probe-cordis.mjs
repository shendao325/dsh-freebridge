/**
 * 用真实 cordis 内核加载插件，复现「显示异常」。
 */
import { Context } from '@deepseek-ai/cordis'

const logs = []
const logger = {
  info: (...a) => { logs.push(['info', a.join(' ')]); console.log('[info]', a.join(' ')) },
  warn: (...a) => { logs.push(['warn', a.join(' ')]); console.log('[warn]', a.join(' ')) },
  error: (...a) => { logs.push(['error', a.join(' ')]); console.log('[error]', a.join(' ')) },
  debug: () => {},
}

console.log('=== 启动 cordis Context ===')
const app = new Context()
app.logger = logger

const registrations = []
app.provide('llm', {
  registerAdapter: (routes, adapter) => {
    console.log('[llm] registerAdapter routes =', JSON.stringify(routes))
    registrations.push({ routes, adapter })
    return () => { console.log('[llm] adapter disposed') }
  },
  registerConfigurableProviders: list => console.log('[llm] registerConfigurableProviders', list?.length ?? 0),
  registerModelDiscovery: (ns, fn) => console.log('[llm] registerModelDiscovery', ns),
})

console.log('=== 加载插件 ===')
let mod
try {
  mod = await import('dsh-freebridge')
  console.log('加载成功，name =', mod.name, ' inject =', JSON.stringify(mod.inject))
} catch (error) {
  console.log('✗ import 失败:', error.message)
  process.exit(1)
}

console.log('=== 校验 Config ===')
try {
  const validated = mod.Config({})
  console.log('Config({}) 通过:', JSON.stringify(validated).slice(0, 100))
} catch (error) {
  console.log('✗ Config 校验失败:', error.message)
}

console.log('=== 调用 apply ===')
try {
  mod.apply(app, mod.Config({}))
  console.log('apply 同步执行完成')
} catch (error) {
  console.log('✗ apply 抛错:', error.message)
  console.log(error.stack?.split('\n').slice(0, 8).join('\n'))
}

await new Promise(r => setTimeout(r, 5000))

console.log('=== 结果 ===')
console.log('registrations:', registrations.length)
console.log('日志条数:', logs.length)
console.log(registrations.length > 0 ? '✓ 插件注册成功' : '✗ 插件没有注册 adapter（这就是显示异常的原因）')
process.exit(0)
