#!/usr/bin/env node
/**
 * 桌面编排单测：验证计划书模块三。
 */
import { DesktopOrchestrator, CAPABILITY } from '../src/desktop.js'
import { OperationGuard } from '../src/guard.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

const events = []
const guard = new OperationGuard({ onDecision: () => {} })
const desk = new DesktopOrchestrator({
  guard,
  onEvent: e => events.push(e),
  warn: m => console.log('    warn: ' + m),
})

desk.registerApp('Notepad', { aliases: ['记事本', 'notepad'] })
desk.registerApp('VSCode', { aliases: ['code', 'vscode'] })

console.log('\n[3] 需要时才拉起（不需要就不动）')
const noNeed = desk.detectApp('帮我看看这个报错是什么意思')
check('没提应用 → 不需要拉起', noNeed.needed === false, noNeed.reason)

const need = desk.detectApp('帮我打开记事本写点东西')
check('提到应用 → 需要拉起', need.needed === true && need.app === 'Notepad', `${need.needed}/${need.app}`)

const ensureNone = await desk.ensureApp('这个函数为什么返回 undefined')
check('不需要时 ensureApp 不动', ensureNone.started === false && ensureNone.app === null, ensureNone.reason)
check('不动时不产生记账事件', events.length === 0, `events=${events.length}`)

console.log('\n[3] 没有底层能力 → 回退提示手动操作（不静默失败）')
const ensure1 = await desk.ensureApp('帮我打开记事本', { sessionId: 's1' })
check('没能力时不假装成功', ensure1.started === false, String(ensure1.started))
check('给出了手动提示', typeof ensure1.manualHint === 'string' && ensure1.manualHint.includes('Notepad'), ensure1.manualHint)
check('记录了失败事件', events.some(e => e.success === false && e.target === 'Notepad'))

console.log('\n[3] 注册底层能力后能真正调用')
let launchCalls = []
desk.registerCapability(CAPABILITY.LAUNCH, async ({ app }) => {
  launchCalls.push(app)
  return { ok: true }
})
const ensure2 = await desk.ensureApp('帮我打开记事本', { sessionId: 's1' })
check('调用了底层能力', launchCalls.length === 1 && launchCalls[0] === 'Notepad')
check('启动成功', ensure2.started === true)
check('成功也记账', events.some(e => e.success === true && e.action === 'launch'))

console.log('\n[3] 底层能力失败 → 回退提示')
desk.registerCapability(CAPABILITY.LAUNCH, async ({ app }) => {
  if (app === 'VSCode') throw new Error('exec failed')
  return { ok: true }
})
const ensure3 = await desk.ensureApp('帮我打开 code', { sessionId: 's1' })
check('抛错不静默', ensure3.started === false, String(ensure3.started))
check('失败给了手动提示', typeof ensure3.manualHint === 'string' && ensure3.manualHint.includes('VSCode'), ensure3.manualHint)
check('失败原因带上了', /exec failed/.test(ensure3.reason), ensure3.reason)

console.log('\n[3] 守门拦截时不动')
const denyGuard = new OperationGuard({
  onDecision: () => {},
})
// 用一个必然命中硬禁区的目标
const desk2 = new DesktopOrchestrator({ guard: denyGuard, onEvent: e => events.push(e) })
desk2.registerApp('C:\\Windows\\System32\\evil', { aliases: ['evil'] })
desk2.registerCapability(CAPABILITY.LAUNCH, async () => ({ ok: true }))
const ensureDeny = await desk2.ensureApp('启动 evil', { sessionId: 's1' })
check('守门 deny 时不执行', ensureDeny.started === false && ensureDeny.blocked === true, `${ensureDeny.started}/${ensureDeny.blocked}`)
check('deny 时不建议手动操作（该拦就拦）', ensureDeny.manualHint === null)

console.log('\n[3] 界面操作统一走守门 + 记账')
const clickCalls = []
desk.registerCapability(CAPABILITY.CLICK, async payload => {
  clickCalls.push(payload)
  return { ok: true }
})
const click1 = await desk.perform({
  capability: CAPABILITY.CLICK,
  payload: { app: 'Notepad', selector: '#save' },
  userIntent: '帮我打开记事本然后点保存',
  sessionId: 's1',
})
check('点击成功', click1.ok === true)
check('底层收到 payload', clickCalls.length === 1 && clickCalls[0].selector === '#save')
check('点击也记账', events.some(e => e.action === 'click' && e.success === true))

const click2 = await desk.perform({
  capability: CAPABILITY.CLICK,
  payload: { app: 'Notepad', selector: '#delete-all' },
  userIntent: '看一下这个文档',
  sessionId: 's1',
})
check('不在意图内 → needsConfirm', click2.needsConfirm === true, `${click2.ok}/${click2.verdict}`)
check('未确认就不执行', clickCalls.length === 1, `clickCalls=${clickCalls.length}`)

console.log('\n[3] 没注册的能力 → 明确回退')
const shot = await desk.perform({
  capability: CAPABILITY.SCREENSHOT,
  payload: { app: 'Notepad' },
  userIntent: '帮我打开记事本并截图',
  sessionId: 's1',
})
check('未注册能力返回失败', shot.ok === false)
check('给出明确提示', typeof shot.manualHint === 'string' && shot.manualHint.length > 0, shot.manualHint)

console.log('\n[3] 能力总览')
const status = desk.status()
check('能列出已注册能力', status.capabilities.includes(CAPABILITY.LAUNCH) && status.capabilities.includes(CAPABILITY.CLICK))
check('能列出已登记应用', status.apps.includes('Notepad') && status.apps.includes('VSCode'))

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
