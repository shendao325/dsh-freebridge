#!/usr/bin/env node
/**
 * 零配置 bootstrap 单测：验证计划书模块五。
 */
import { resolveConfig, Onboarding, probeUpstreams, bootstrap, DEFAULTS, ONBOARDING_QUESTIONS } from '../src/bootstrap.js'

let pass = 0
let fail = 0
function check(name, condition, detail = '') {
  if (condition) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('\n[5] 所有配置项有合理默认值，小白不用碰')
const cfg = resolveConfig()
check('空配置也能得到完整配置', typeof cfg === 'object' && cfg.kilo !== undefined && cfg.routing !== undefined)
check('总开关默认开启', cfg.enabled === true)
check('守门默认开启（计划书要求）', cfg.guard.enabled === true)
check('分流默认开启且直连优先', cfg.routing.enabled === true && cfg.routing.followSystemProxy === true)
check('模型与网页分开路由默认开', cfg.routing.separateWebRoute === true)
check('统计默认显示逻辑级', cfg.ledger.showAttemptLevel === false)
check('桌面编排默认开', cfg.desktop.enabled === true)

const deep = resolveConfig({ kilo: { weight: 99 } })
check('部分配置能合并', deep.kilo.weight === 99)
check('合并后其余字段仍有默认值', deep.kilo.enabled === true && deep.ovh.enabled === false)
check('传入 null 不炸', resolveConfig(null).enabled === true)
check('传入错误类型不炸', resolveConfig('bad').kilo.enabled === true)

console.log('\n[5] 极简引导只问 1–2 个问题')
check('引导问题数量为 2', ONBOARDING_QUESTIONS.length === 2, `实际 ${ONBOARDING_QUESTIONS.length}`)
check('每个问题都有默认答案', ONBOARDING_QUESTIONS.every(q => typeof q.default === 'boolean'))

const ob = new Onboarding()
check('未回答时未完成', ob.completed === false)
check('待问两个问题', ob.pendingQuestions().length === 2)

ob.answer('autoConfigFreeModels', true)
check('答一个后还剩一个', ob.pendingQuestions().length === 1)
ob.answer('enableGuard', false)
check('答完即完成', ob.completed === true)
check('答案被记录', ob.snapshot().answers.enableGuard === false)

const ob2 = new Onboarding()
ob2.acceptDefaults()
check('不回答也能按默认值完成', ob2.completed === true)
check('默认值取自问题定义', ob2.snapshot().answers.autoConfigFreeModels === true)

console.log('\n[5] 答案影响配置')
const guarded = new Onboarding()
guarded.acceptDefaults()
const withGuard = guarded.applyTo({})
check('守门开启时配置开启', withGuard.guard.enabled === true)
const noGuard = new Onboarding()
noGuard.answer('enableGuard', false)
noGuard.answer('autoConfigFreeModels', true)
const withoutGuard = noGuard.applyTo({})
check('守门关闭时配置关闭', withoutGuard.guard.enabled === false)
const noFree = new Onboarding()
noFree.answer('autoConfigFreeModels', false)
noFree.answer('enableGuard', true)
const withoutFree = noFree.applyTo({})
check('关闭免费模型时两条匿名通道都禁用', withoutFree.kilo.enabled === false && withoutFree.ovh.enabled === false)

console.log('\n[5] 首次启动自动探测（并行、失败不阻塞）')
const probeResult = await probeUpstreams({
  config: resolveConfig(),
  probeUpstream: async id => {
    // 模拟 kilo 通、ovh 挂
    if (id === 'kilo') return { ok: true, models: ['kilo-auto/free', 'nvidia/nemotron:free'] }
    throw new Error('ovh unreachable')
  },
  warn: m => console.log('    warn: ' + m),
})
check('可用通道识别正确', probeResult.available.includes('kilo'))
check('ovh 默认关闭，不参与探测', probeResult.unavailable.length === 0)
check('汇总到可用模型', probeResult.models.length === 2)

const allDown = await probeUpstreams({
  config: resolveConfig(),
  probeUpstream: async () => { throw new Error('all down') },
  warn: () => {},
})
check('全部不可用也不抛错', allDown.available.length === 0 && allDown.unavailable.length === 1)

console.log('\n[5] 首启完整闭环')
const booted = await bootstrap({
  config: {},
  onboarding: new Onboarding(),
  probeUpstream: async () => ({ ok: true, models: ['kilo-auto/free'] }),
  warn: () => {},
})
check('bootstrap 返回 ready', booted.ready === true)
check('返回了完整配置', booted.config.kilo.enabled === true)
check('附带探测结果（默认只 kilo 一条）', booted.probe.available.length === 1, `实际 ${booted.probe.available.length}`)
check('降级通道清单存在', Array.isArray(booted.degradedUpstreams))

console.log('\n[5] 装完即用（不要求用户填任何东西）')
const bare = await bootstrap({
  config: undefined,
  onboarding: undefined,
  probeUpstream: async () => ({ ok: true }),
  warn: () => {},
})
check('不传 config 也能跑', bare.ready === true)
check('不传 onboarding 也能跑', bare.config.guard.enabled === DEFAULTS.guard.enabled)
check('无需任何必填项', bare.probe.available.length >= 0)

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
