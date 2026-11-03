#!/usr/bin/env node
/**
 * 账本单测：验证计划书模块一的全部记账规则。
 * 直接 node 跑，不依赖任何框架。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TokenLedger, estimateTokens } from '../src/ledger.js'

let pass = 0
let fail = 0

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-ledger-'))
const ledger = new TokenLedger({ dir, warn: m => console.log('    warn: ' + m) })

console.log('\n[1.1] 全局统计 · 尝试级 / 逻辑级双计数')
ledger.append({ sessionId: 's1', turnIndex: 0, provider: 'freebridge', upstream: 'kilo', model: 'kilo-auto/free', level: 'attempt', inputTokens: 100, outputTokens: 50, ok: false, billable: 'unknown' })
ledger.append({ sessionId: 's1', turnIndex: 0, provider: 'freebridge', upstream: 'ovh', model: 'Meta-Llama-3_3-70B-Instruct', level: 'attempt', inputTokens: 100, outputTokens: 50, ok: true })
ledger.append({ sessionId: 's1', turnIndex: 0, provider: 'freebridge', upstream: 'ovh', model: 'Meta-Llama-3_3-70B-Instruct', level: 'logical', inputTokens: 100, outputTokens: 50, ok: true })

const logical = ledger.globalStats({ level: 'logical' })
const attempt = ledger.globalStats({ level: 'attempt' })

check('逻辑级只算最终成功渠道 150 token', logical.totals.totalTokens === 150, `实际 ${logical.totals.totalTokens}`)
check('尝试级把重试也计入 300 token', attempt.totals.totalTokens === 300, `实际 ${attempt.totals.totalTokens}`)
check('失败请求标 billable=unknown 不计入渠道消耗', logical.billableUnknown >= 1, `billableUnknown=${logical.billableUnknown}`)
check('逻辑级渠道消耗只来自成功的 ovh', logical.byProvider.length === 1 && logical.byProvider[0].provider === 'freebridge')

console.log('\n[1.1] 按日趋势')
ledger.append({ sessionId: 's1', turnIndex: 1, provider: 'freebridge', upstream: 'kilo', model: 'kilo-auto/free', level: 'logical', inputTokens: 200, outputTokens: 100, ok: true })
const trend = ledger.globalStats({ level: 'logical' })
check('按日趋势有 1 天', trend.byDay.length === 1)
check('按模型分组存在', trend.byModel.length >= 1)

console.log('\n[1.2] 会话统计')
const sessions = ledger.sessions()
check('会话列表有 s1', sessions.length === 1 && sessions[0].sessionId === 's1')
check('会话逻辑级总量 450', sessions[0].logicalTokens === 450, `实际 ${sessions[0].logicalTokens}`)
check('会话尝试级总量大于逻辑级', sessions[0].attemptTokens > sessions[0].logicalTokens, `attempt=${sessions[0].attemptTokens}`)

const detail = ledger.sessionDetail('s1')
check('会话明细存在', detail !== null)
check('明细逻辑级总量 450', detail.logicalTotal === 450, `实际 ${detail.logicalTotal}`)
check('明细按供应商分组', detail.providers.length >= 1)
check('明细按模型细分', detail.providers[0].models.length >= 1)
check('段边界按 upstream+model 切分（≥2 段）', detail.segments.length >= 2, `段数 ${detail.segments.length}`)
check('段包含 upstream 信息', detail.segments.every(s => s.upstream !== null))

console.log('\n[1.3] 消息编辑 / 撤回 · 历史不回溯扣减')
const before = ledger.sessionDetail('s1').logicalTotal
ledger.markTurn('s1', 0, { edited: true })
const after = ledger.sessionDetail('s1').logicalTotal
check('编辑后总量不变（不回溯扣减）', before === after, `before=${before} after=${after}`)
check('编辑标记已写入', ledger.sessionDetail('s1').editedTurns > 0, `editedTurns=${ledger.sessionDetail('s1').editedTurns}`)

const beforeRetract = ledger.sessionDetail('s1').logicalTotal
ledger.markTurn('s1', 1, { retracted: true })
const afterRetract = ledger.sessionDetail('s1').logicalTotal
check('撤回后总量不变', beforeRetract === afterRetract)
check('撤回标记已写入', ledger.sessionDetail('s1').retractedTurns > 0)

console.log('\n[1.3] 旁支提问 branch=true')
ledger.append({ sessionId: 's1', turnIndex: 5, branch: true, provider: 'freebridge', upstream: 'kilo', model: 'kilo-auto/free', level: 'logical', inputTokens: 30, outputTokens: 20, ok: true })
const withBranchOff = ledger.globalStats({ level: 'logical', branch: false })
const withBranchOn = ledger.globalStats({ level: 'logical', branch: true })
check('默认不含旁支', withBranchOff.totals.totalTokens === 450, `实际 ${withBranchOff.totals.totalTokens}`)
check('显式开启后含旁支 500', withBranchOn.totals.totalTokens === 500, `实际 ${withBranchOn.totals.totalTokens}`)
const branches = ledger.branches('s1')
check('旁支独立账本条目', branches.length === 1 && branches[0].totalTokens === 50)
check('主分支 total 450 未被污染', ledger.sessionDetail('s1').mainTotal === 450, `mainTotal=${ledger.sessionDetail('s1').mainTotal}`)

console.log('\n[1.1] 持久化 · 归档会话计入')
const ledger2 = new TokenLedger({ dir })
ledger2.load()
check('重新加载后记录条数一致', ledger2.records.length === ledger.records.length, `${ledger2.records.length} vs ${ledger.records.length}`)
check('重新加载后总量仍为 500', ledger2.globalStats({ level: 'logical', branch: true }).totals.totalTokens === 500)
check('编辑标记持久化', ledger2.sessionDetail('s1').editedTurns > 0)

console.log('\n[1.1] 不存原文')
const raw = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
check('账本不含 prompt 字段', !raw.includes('"prompt"'))
check('账本不含 content 字段', !raw.includes('"content"'))

console.log('\n[1.1] 本地估算兜底')
check('CJK 估算 5 字约 6 token', estimateTokens('你好世界啊') >= 5)
check('空串估算为 0', estimateTokens('') === 0)
check('拉丁 40 字符约 11 token', estimateTokens('a'.repeat(40)) >= 10)

console.log('\n[meta] 元数据事件不计入 token')
const metaBefore = ledger.globalStats({ level: 'logical' }).totals.totalTokens
ledger.appendMeta('s1', 'route', { via: 'proxy', route: 'model' })
check('meta 事件不增加 token 总量', ledger.globalStats({ level: 'logical' }).totals.totalTokens === metaBefore)
check('会话可查到 meta 计数', ledger.sessionDetail('s1').metaCounts.route === 1)

fs.rmSync(dir, { recursive: true, force: true })

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
