/**
 * client bundle 契约测试。
 *
 * 验证浏览器半边符合 DSH 的 ModuleLoader 约定：
 * - 有 window.__ModuleLoader__.load({id, factory})
 * - factory 里导出 apply / inject / name
 * - inject 含 slots
 * - 注册 settings.section
 */
import fs from 'node:fs'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

const src = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

console.log('\n[client] ModuleLoader 契约')
check('使用 window.__ModuleLoader__.load', /window\.__ModuleLoader__\.load\(\{/.test(src))
check('声明 id', /id:\s*'dsh-freebridge'/.test(src))
check('声明 factory', /factory:\s*require\s*=>/.test(src))
check('factory 返回 module.exports', /return module\.exports/.test(src))
check('require("react")', /require\('react'\)/.test(src))

console.log('\n[client] 导出')
check('导出 apply', /exports\.apply\s*=\s*apply/.test(src))
check('导出 inject', /exports\.inject\s*=\s*inject/.test(src))
check('导出 name', /exports\.name\s*=\s*'freebridge'/.test(src))
check('inject 含 slots', /const inject = \['slots'/.test(src) || /inject = \[[^\]]*'slots'/.test(src))

console.log('\n[client] 注册设置页')
check('注册 settings.section', /slots\.inject\('settings\.section'/.test(src))
check('section id 是 freebridge', /id:\s*'freebridge'/.test(src))
check('注册 settings.onboarding', /slots\.inject\('settings\.onboarding'/.test(src))

console.log('\n[client] UI 覆盖六个模块')
const sections = [
  ['模块健康 + 重启', 'HealthSection'],
  ['Token 用量统计（模块一）', 'StatsSection'],
  ['会话统计三层下钻（模块一）', 'SessionsSection'],
  ['网络分流（模块二）', 'RoutesSection'],
  ['桌面编排（模块三）', 'DesktopSection'],
  ['操作守门（模块四）', 'GuardSection'],
  ['引导卡片（模块五）', 'OnboardingCard'],
]
for (const [label, fn] of sections) {
  check(`有 ${label}`, new RegExp(`function ${fn}`).test(src))
}

console.log('\n[client] 数据来源是同源接口')
for (const api of ['/freebridge/health', '/freebridge/stats', '/freebridge/sessions', '/freebridge/routes', '/freebridge/guard', '/freebridge/desktop', '/freebridge/onboarding']) {
  check(`读取 ${api}`, src.includes(api))
}

console.log('\n[client] 关键交互')
check('单模块重启按钮', /freebridge\/restart/.test(src))
check('逻辑级/尝试级切换', /setLevel/.test(src))
check('会话点击展开', /openSession/.test(src))

console.log('\n[client] 主题兼容（不写死颜色）')
const hardcoded = src.match(/#[0-9a-fA-F]{6}/g) ?? []
check('不写死背景色（用 var(--)）', /var\(--/.test(src))
check('硬编码颜色仅用于兜底', hardcoded.length <= 6, `实际 ${hardcoded.length} 处: ${hardcoded.slice(0, 5).join(',')}`)

console.log('\n[client] i18n')
check('有中文文案', src.includes("nav: 'FreeBridge'"))
check('有英文文案', src.includes("'stats.title': 'Token usage'"))

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
