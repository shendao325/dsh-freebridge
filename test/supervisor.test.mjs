#!/usr/bin/env node
/**
 * 故障隔离单测：验证计划书模块六。
 */
import { Supervisor, STATE } from '../src/supervisor.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('\n[6] 一个模块挂了，其他模块照常可用')
const sup = new Supervisor({ logger: {} })
sup.register('ledger', { start: () => ({ ok: true }) })
sup.register('router', { start: () => { throw new Error('proxy kernel missing') } })
sup.register('guard', { start: () => ({ ok: true }) })
sup.register('desktop', { start: () => { throw new Error('no desktop backend') } })

const result = await sup.startAll()
check('好模块进入 running', result.running.includes('ledger') && result.running.includes('guard'), JSON.stringify(result.running))
check('坏模块进入 degraded，不外抛', result.degraded.includes('router') && result.degraded.includes('desktop'), JSON.stringify(result.degraded))
check('startAll 本身没有抛错', true)

console.log('\n[6] 降级模块不影响其他模块的调用')
const ledgerInstance = sup.get('ledger')
check('健康模块可拿到实例', ledgerInstance !== null && ledgerInstance.ok === true)
const badInstance = sup.get('router')
check('降级模块取实例返回 null', badInstance === null)

const used = sup.use('ledger', inst => inst.ok, false)
check('use 正常模块返回真实值', used === true)
const fallback = sup.use('router', inst => inst.ok, 'fallback')
check('use 降级模块返回 fallback', fallback === 'fallback', String(fallback))

const threw = sup.use('guard', () => { throw new Error('runtime boom') }, 'safe')
check('use 捕获运行时异常并返回 fallback', threw === 'safe', String(threw))
check('运行时异常的模块被标为 degraded', sup.status().modules.find(m => m.name === 'guard').state === STATE.DEGRADED)

console.log('\n[6] 状态页可显示每个模块')
const status = sup.status()
check('状态含全部 4 个模块', status.total === 4, `total=${status.total}`)
check('每个模块有 state/error 字段', status.modules.every(m => typeof m.state === 'string' && (m.error === null || typeof m.error === 'string')))
check('能统计健康模块数', status.healthy >= 1)
check('记录启动失败清单', status.startupErrors.includes('router'))

const routerStatus = status.modules.find(m => m.name === 'router')
check('降级模块有错误原因', typeof routerStatus.error === 'string' && routerStatus.error.includes('proxy kernel missing'), String(routerStatus.error))

console.log('\n[6] 可单独重启某个模块')
// 让 router 重启时修好
const sup2 = new Supervisor({ logger: {} })
let routerHealthy = false
sup2.register('router', { start: () => { if (!routerHealthy) throw new Error('down'); return { ok: true } } })
sup2.register('ledger', { start: () => ({ ok: true }) })
await sup2.startAll()
check('router 初始是 degraded', sup2.status().modules.find(m => m.name === 'router').state === STATE.DEGRADED)

routerHealthy = true
const restartResult = await sup2.restart('router')
check('重启成功', restartResult.ok === true, JSON.stringify(restartResult))
check('重启后状态变 running', sup2.status().modules.find(m => m.name === 'router').state === STATE.RUNNING)
check('重启计数被记录', sup2.status().modules.find(m => m.name === 'router').restartCount === 1)

const restartUnknown = await sup2.restart('nope')
check('重启未知模块返回失败', restartUnknown.ok === false && restartUnknown.reason === 'unknown module: nope')

console.log('\n[6] 重启单个模块不影响其他模块')
const ledgerBefore = sup2.get('ledger')
await sup2.restart('router')
const ledgerAfter = sup2.get('ledger')
check('其他模块实例未被重建', ledgerBefore === ledgerAfter)

console.log('\n[6] 停止全部模块')
await sup.stopAll()
const stopped = sup.status()
check('停止后模块变 stopped 或保持 degraded', stopped.modules.every(m => m.state === STATE.STOPPED || m.state === STATE.DEGRADED))
check('停止后健康数为 0', stopped.healthy === 0, `healthy=${stopped.healthy}`)

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
