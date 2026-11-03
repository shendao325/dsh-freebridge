#!/usr/bin/env node
/**
 * 守门器单测：验证计划书模块四。
 */
import { OperationGuard, OP, ruleCatalog } from '../src/guard.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('\n[4] 硬禁区 → deny，不问用户')
const guard = new OperationGuard({ onDecision: () => {} })
const r1 = await guard.check({ op: OP.FILE_WRITE, target: 'C:\\Windows\\System32\\drivers\\x.sys', command: 'write file' })
check('写入 System32 被拒', r1.verdict === 'deny', r1.verdict)
check('命中 hard 层', r1.layer === 'hard', r1.layer)
check('给出了原因', /system/.test(r1.why), r1.why)

const r2 = await guard.check({ op: OP.FILE_WRITE, target: '.env', command: 'read' })
check('碰 .env 凭据文件被拒', r2.verdict === 'deny', r2.verdict)

const r3 = await guard.check({ op: OP.DESKTOP, target: 'powershell', command: 'sudo runas /user:admin cmd' })
check('提权命令被拒', r3.verdict === 'deny', r3.verdict)

console.log('\n[4] 越界 → ask，暂停询问')
const r4 = await guard.check({
  op: OP.DESKTOP,
  target: 'SomeApp.exe',
  command: 'launch SomeApp.exe',
  userIntent: '帮我看一下这个文档的内容',
})
check('用户没提目标应用 → ask', r4.verdict === 'ask', r4.verdict)
check('命中 intent 层', r4.layer === 'intent', r4.layer)
check('原因说明目标未被提及', /not mentioned/.test(r4.why), r4.why)

console.log('\n[4] 在范围内 → allow')
const r5 = await guard.check({
  op: OP.DESKTOP,
  target: 'SomeApp.exe',
  command: 'launch SomeApp.exe',
  userIntent: '帮我打开 SomeApp.exe 看看',
})
check('用户明确提了目标且说了授权 → allow', r5.verdict === 'allow', r5.verdict)

console.log('\n[4] 可疑操作在无授权时 → ask')
const r6 = await guard.check({
  op: OP.DESKTOP,
  target: 'cmd',
  command: 'schtasks /create /tn evil /tr x',
  userIntent: '把系统设置弄一下',
})
check('创建计划任务 → ask', r6.verdict === 'ask', r6.verdict)
check('原因指出 persistence', /persistence/.test(r6.why), r6.why)

console.log('\n[4] 可疑操作但有明确授权 → 放行')
const r7 = await guard.check({
  op: OP.DESKTOP,
  target: 'reg',
  command: 'reg add HKLM\\...',
  userIntent: '帮我改注册表 reg add 这一项',
})
check('用户明确要求改注册表 → allow', r7.verdict === 'allow', r7.verdict)

console.log('\n[4] 默认开启')
check('enabled 默认 true', guard.status().enabled === true)
check('规则表可枚举', guard.status().rules.hard > 0 && guard.status().rules.suspicious > 0)

console.log('\n[4] 可关闭')
guard.setEnabled(false)
const r8 = await guard.check({ op: OP.FILE_WRITE, target: 'C:\\Windows\\x', command: 'write' })
check('关闭后放行（用户自己关了就得认）', r8.verdict === 'allow' && r8.layer === 'disabled', `${r8.verdict}/${r8.layer}`)
guard.setEnabled(true)

console.log('\n[4] 可选 AI 审查')
const aiGuard = new OperationGuard({
  aiReview: async () => 'ask',
  onDecision: () => {},
})
const r9 = await aiGuard.check({
  op: OP.NETWORK,
  target: 'api.example.com',
  command: 'POST',
  userIntent: '帮我调这个接口 api.example.com',
})
check('AI 审查标记 ask 时采纳', r9.verdict === 'ask' && r9.layer === 'ai', `${r9.verdict}/${r9.layer}`)

const aiDownGuard = new OperationGuard({
  aiReview: async () => { throw new Error('model down') },
  onDecision: () => {},
  warn: () => {},
})
const r10 = await aiDownGuard.check({
  op: OP.NETWORK,
  target: 'api2.example.com',
  command: 'GET',
  userIntent: '帮我请求 api2.example.com',
})
check('AI 审查挂了降级为 ask（不静默放行）', r10.verdict === 'ask' && r10.layer === 'ai-fallback', `${r10.verdict}/${r10.layer}`)

const aiOkGuard = new OperationGuard({ aiReview: async () => 'allow', onDecision: () => {} })
const r11 = await aiOkGuard.check({
  op: OP.NETWORK,
  target: 'api3.example.com',
  command: 'GET',
  userIntent: '请求 api3.example.com',
})
check('AI 审查放行时 allow', r11.verdict === 'allow', r11.verdict)

console.log('\n[4] 拦截事件可记账')
const events = []
const recGuard = new OperationGuard({ onDecision: e => events.push(e) })
await recGuard.check({ op: OP.FILE_WRITE, target: 'C:\\Windows\\System32\\a', command: 'w' })
await recGuard.check({ op: OP.DESKTOP, target: 'X.exe', command: 'launch', userIntent: '看文档' })
await recGuard.check({ op: OP.DESKTOP, target: 'Y.exe', command: 'launch Y.exe', userIntent: '打开 Y.exe' })
check('每次判定都有回调', events.length === 3, `events=${events.length}`)
check('回调带 verdict', events.every(e => typeof e.verdict === 'string'))
check('能统计拦截次数', events.filter(e => e.verdict !== 'allow').length === 2, `blocked=${events.filter(e => e.verdict !== 'allow').length}`)

console.log('\n[4] 规则表可枚举（失效模式可审计）')
const catalog = ruleCatalog()
check('硬禁区规则已列出', catalog.hard.length > 0)
check('可疑规则已列出', catalog.suspicious.length > 0)
check('每条规则都有 why', catalog.hard.every(r => typeof r.why === 'string'))

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
