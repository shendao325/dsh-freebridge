#!/usr/bin/env node
/**
 * 分流器单测：验证计划书模块二。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NetworkRouter, hostOf, ROUTE_DIRECT, ROUTE_PROXY, ROUTE_KIND } from '../src/router.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-router-'))

// 可控的探测 fetch：按 host 决定通不通
let probeBehavior = { 'reachable.example': true, 'blocked.example': false }
const router = new NetworkRouter({
  dir,
  timeoutMs: 1000,
  warn: m => console.log('    warn: ' + m),
  probeFetch: async url => {
    const host = hostOf(url)
    if (probeBehavior[host] === true) return new Response('', { status: 200 })
    throw new Error('ETIMEDOUT')
  },
})

console.log('\n[2.1] 直连优先 + 学习')
const r1 = await router.probe('reachable.example', { kind: ROUTE_KIND.MODEL })
check('直连可用时选直连', r1.route === ROUTE_DIRECT, r1.route)
check('记住了结果', router.lookup('reachable.example', ROUTE_KIND.MODEL).learned === true)

const r2 = await router.probe('blocked.example', { kind: ROUTE_KIND.MODEL })
check('直连失败时改走代理', r2.route === ROUTE_PROXY, r2.route)
check('返回了失败原因', typeof r2.error === 'string' && r2.error.length > 0, r2.error)

console.log('\n[2.1] 不需要用户维护域名列表（自己学习）')
const learned = router.lookup('blocked.example', ROUTE_KIND.MODEL)
check('无需任何入参即可拿到决策', learned.learned === true && learned.route === ROUTE_PROXY)

console.log('\n[2.2] 模型请求与网页抓取分开路由')
const modelRoute = router.lookup('shared.example', ROUTE_KIND.MODEL)
const webRoute = router.lookup('shared.example', ROUTE_KIND.WEB)
check('未学习的域名默认直连（模型）', modelRoute.route === ROUTE_DIRECT && modelRoute.learned === false)
check('未学习的域名默认直连（网页）', webRoute.route === ROUTE_DIRECT && webRoute.learned === false)

// 让同一域名在 model 和 web 下学出不同结论
probeBehavior['shared.example'] = true
await router.probe('shared.example', { kind: ROUTE_KIND.MODEL, force: true })
probeBehavior['shared.example'] = false
await router.probe('shared.example', { kind: ROUTE_KIND.WEB, force: true })
check('同域名两种策略独立（model=direct）', router.lookup('shared.example', ROUTE_KIND.MODEL).route === ROUTE_DIRECT)
check('同域名两种策略独立（web=proxy）', router.lookup('shared.example', ROUTE_KIND.WEB).route === ROUTE_PROXY)

console.log('\n[2.1] 成功则记住域名下次直连')
probeBehavior['flaky.example'] = false
await router.probe('flaky.example', { kind: ROUTE_KIND.MODEL, force: true })
check('首次失败记 proxy', router.lookup('flaky.example', ROUTE_KIND.MODEL).route === ROUTE_PROXY)
probeBehavior['flaky.example'] = true
await router.probe('flaky.example', { kind: ROUTE_KIND.MODEL, force: true })
check('恢复后改回 direct', router.lookup('flaky.example', ROUTE_KIND.MODEL).route === ROUTE_DIRECT)

console.log('\n[2.1] 自我修正：真实请求成功就固化直连')
router.record('blocked.example', true, { kind: ROUTE_KIND.MODEL })
check('代理域名直连成功后改回 direct', router.lookup('blocked.example', ROUTE_KIND.MODEL).route === ROUTE_DIRECT)

console.log('\n[2.1] 连续失败才改判（避免一次抖动永久改道）')
const r3 = router.record('stable.example', false, { kind: ROUTE_KIND.MODEL, error: 'boom' })
check('第一次失败仍是直连', r3.route === ROUTE_DIRECT, `failures=${r3.failures}`)
const r4 = router.record('stable.example', false, { kind: ROUTE_KIND.MODEL, error: 'boom' })
check('连续两次失败才切 proxy', r4.route === ROUTE_PROXY, `failures=${r4.failures}`)

console.log('\n[2.2] 节点健康只标记不删除')
router.markNode('node-a', false, 'handshake timeout')
const status = router.nodeStatus()
check('失效节点仍在列表里（没被删）', status.length === 1 && status[0].nodeId === 'node-a')
check('失效节点标为 unhealthy', status[0].healthy === false)
check('标记了原因', status[0].reason === 'handshake timeout')
router.markNode('node-a', true, 'recovered')
check('恢复后自动重新启用', router.healthyNodes().length === 1)
check('节点没被重建（保留 firstSeenAt）', router.nodeStatus()[0].firstSeenAt > 0)

console.log('\n[2.2] 分流决策可统计')
const snap = router.snapshot()
check('能统计代理请求数', typeof snap.proxy === 'number' && snap.proxy >= 1, `proxy=${snap.proxy}`)
check('能统计总域名数', snap.total >= 3, `total=${snap.total}`)
const modelSnap = router.snapshot(ROUTE_KIND.MODEL)
check('可按策略类型过滤', modelSnap.total > 0 && modelSnap.total < snap.total || snap.total === modelSnap.total)

console.log('\n[2.1] 持久化')
const router2 = new NetworkRouter({ dir })
router2.load()
check('学习结果落盘后可恢复', router2.lookup('shared.example', ROUTE_KIND.WEB).learned === true)
check('节点状态落盘可恢复', router2.nodeStatus().length === 1)

console.log('\n[2.1] 探测去重（并发只探一次）')
let probeCount = 0
const router3 = new NetworkRouter({
  dir: fs.mkdtempSync(path.join(os.tmpdir(), 'fb-router2-')),
  timeoutMs: 500,
  probeFetch: async () => { probeCount += 1; return new Response('', { status: 200 }) },
})
await Promise.all([
  router3.probe('dedupe.example', { kind: ROUTE_KIND.MODEL, force: true }),
  router3.probe('dedupe.example', { kind: ROUTE_KIND.MODEL, force: true }),
  router3.probe('dedupe.example', { kind: ROUTE_KIND.MODEL, force: true }),
])
check('同域名并发只探测一次', probeCount === 1, `实际探测 ${probeCount} 次`)

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
