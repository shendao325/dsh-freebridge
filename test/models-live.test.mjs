/**
 * 白名单模型逐个实测：模拟 DSH 传参（含 freebridge:: 前缀），
 * 验证每个模型都能真正返回内容。
 */
import { resolveModel } from '../src/upstream.js'
import { VERIFIED_MODELS } from '../src/models.js'

const BASE = 'https://api.kilo.ai/api/gateway'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log('\n[实测] 白名单模型，模拟 DSH 带前缀传参\n')

for (const model of VERIFIED_MODELS) {
  const dshName = `freebridge::${model.id}`
  let resolved = null
  try {
    resolved = await resolveModel('kilo', dshName, { allowFallback: false })
  } catch (error) {
    check(`${model.id} 能被解析`, false, String(error?.message).slice(0, 60))
    continue
  }
  check(`${model.id} 能被解析`, resolved === model.id, `→ ${resolved}`)

  // 真实请求
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: resolved,
        messages: [{ role: 'user', content: '回复两个字：可用' }],
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) {
      const t = await res.text()
      check(`  ${model.id} 真实对话`, false, `${res.status} ${t.slice(0, 60)}`)
      continue
    }
    const j = await res.json()
    const text = (j.choices?.[0]?.message?.content ?? '').trim()
    check(`  ${model.id} 真实对话`, text.length > 0, `"${text.slice(0, 30)}"`)
  } catch (error) {
    check(`  ${model.id} 真实对话`, false, String(error?.message).slice(0, 60))
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
