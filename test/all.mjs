#!/usr/bin/env node
/**
 * 全套测试跑一遍。
 * 用法：node test/all.mjs
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const suites = [
  ['inject 守卫（实机崩溃复现）', 'inject-guard.test.mjs'],
  ['注册时序（核心回归）', 'registration.test.mjs'],
  ['功能可用性（真实宿主 HTTP）', 'functions.test.mjs'],
  ['账本（模块一）', 'ledger.test.mjs'],
  ['分流（模块二）', 'router.test.mjs'],
  ['桌面编排（模块三）', 'desktop.test.mjs'],
  ['守门（模块四）', 'guard.test.mjs'],
  ['零配置（模块五）', 'bootstrap.test.mjs'],
  ['故障隔离（模块六）', 'supervisor.test.mjs'],
  ['端到端集成', 'integration.test.mjs'],
  ['宿主装配', 'host.test.mjs'],
]

let failed = 0
for (const [label, file] of suites) {
  console.log(`\n${'='.repeat(52)}\n${label}  (${file})\n${'='.repeat(52)}`)
  const result = spawnSync(process.execPath, [path.join(here, file)], { stdio: 'inherit' })
  if (result.status !== 0) failed += 1
}

console.log(`\n${'='.repeat(52)}`)
if (failed === 0) console.log('全部套件通过 ✓')
else console.log(`${failed} 个套件失败 ✗`)
console.log('='.repeat(52))
process.exit(failed === 0 ? 0 : 1)
