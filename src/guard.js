/**
 * 操作边界守门 —— 模块四（默认开启）。
 *
 * 计划书要求：
 * 1. 每个子操作（桌面操作、网络请求、文件写入）发出前先过范围检查：
 *    是否在用户原话意图之内。
 * 2. 超出范围时暂停并询问，不直接执行。
 * 3. 默认开启，不需要用户额外装审批插件。
 * 4. 规则匹配 + 可选小模型审查，规则明确、失效模式可枚举。
 * 5. 拦截事件记入账本元数据。
 *
 * 设计：三层判定
 * - 第一层 硬禁区：无论如何都拦（比如写到系统目录、读凭据文件）
 * - 第二层 意图匹配：操作是否落在用户原话覆盖范围内
 * - 第三层 可选 AI 审查：规则说不清的灰色地带交给小模型
 *
 * 判决三态：
 * - 'allow'  直接执行
 * - 'ask'    暂停询问用户
 * - 'deny'   直接拒绝（硬禁区）
 *
 * @module src/guard.js
 */

/** 操作类型 */
export const OP = {
  DESKTOP: 'desktop',
  NETWORK: 'network',
  FILE_WRITE: 'file_write',
}

/** 第一层：硬禁区。命中即 deny，不问用户。 */
const HARD_DENY = [
  // 凭据类文件。注意 `.env` 以点开头，前面不能用 \b（点和词边界不共存）
  { pattern: /(?:\.env(?:$|\.|\s)|id_rsa|id_ed25519|credentials|\.netrc|shadow)/i, why: 'credential file' },
  { pattern: /(?:\.ssh|\.aws|\.gnupg)(?:[\\/\s]|$)/i, why: 'credential directory' },
  // 系统关键目录
  { pattern: /^\s*(?:C:)?\\(?:Windows|Program Files|Program Files \(x86\))\b/i, why: 'system directory' },
  { pattern: /\b(?:boot|System32|drivers)\b|etc[\\/]shadow|etc[\\/]passwd/i, why: 'system critical path' },
  // 提权
  { pattern: /\b(?:sudo|runas|elevate|TakeOwnership)\b|icacls\s+.*grant/i, why: 'privilege escalation' },
  // 递归删除根
  { pattern: /\brm\s+-rf\s+(?:\/|~|C:\\)\s*$|\bformat\s+[a-z]:/i, why: 'destructive root operation' },
]

/** 第二层：常见越界信号。命中倾向 ask。 */
const SUSPICIOUS = [
  { pattern: /\b(?:reg\s+add|regedit|schtasks|sc\s+create|new-service)\b/i, why: 'persistence or system change' },
  { pattern: /\b(?:chmod\s+777|chown\s+-R)\b/i, why: 'permission widening' },
  { pattern: /\b(?:curl|wget|Invoke-WebRequest|iwr)\s+.*\|\s*(?:bash|sh|pwsh|powershell)/i, why: 'download and execute' },
  { pattern: /\b(?:base64\s+-d|FromBase64String|certutil\s+-decode)\b/i, why: 'encoded payload' },
  { pattern: /\b(?:Get-Process|taskkill|Stop-Process)\b/i, why: 'process control outside scope' },
]

/** 用户原话里表示授权的动词。没有授权词时，越界操作更可能被问。 */
const INTENT_ALLOW = [
  /(?:可以|帮我|请|给我|去做|执行|运行|装|安装|下载|打开|启动|删掉|删除|清理|改|修改|替换)/,
  /(?:please|go ahead|do it|run|install|execute|delete|remove|change|replace)/i,
]

/** 危险词：用户原话里出现这些说明他其实说了要干这件事 */
function mentionsTarget(text, target) {
  if (typeof target !== 'string' || target === '') return false
  const lower = text.toLowerCase()
  const t = target.toLowerCase()
  if (lower.includes(t)) return true
  // 只比较 basename，避免路径前缀不同被误判
  const base = t.split(/[\\/]/).pop()
  return base !== undefined && base !== '' && lower.includes(base)
}

/**
 * 守门器。
 */
export class OperationGuard {
  /**
   * @param {object} options
   * @param {boolean} [options.enabled=true]
   * @param {(req: object) => Promise<string|null>} [options.aiReview] 可选小模型审查，返回 'allow'|'ask'|'deny' 或 null
   * @param {(msg: string) => void} [options.warn]
   * @param {(event: object) => void} [options.onDecision] 决策回调（记账用）
   */
  constructor(options = {}) {
    this.enabled = options.enabled !== false
    this.aiReview = options.aiReview ?? null
    this.warn = options.warn ?? (() => {})
    this.onDecision = options.onDecision ?? (() => {})
  }

  /**
   * 判定一个子操作是否在执行范围内。
   *
   * @param {object} request
   * @param {string} request.op 操作类型（OP.*）
   * @param {string} [request.target] 目标（路径 / 主机 / 应用名）
   * @param {string} [request.command] 具体命令或动作描述
   * @param {string} [request.userIntent] 用户原话
   * @param {object} [request.context]
   * @returns {Promise<{verdict: 'allow'|'ask'|'deny', why: string, layer: string}>}
   */
  async check(request) {
    if (this.enabled !== true) {
      const result = { verdict: 'allow', why: 'guard disabled', layer: 'disabled' }
      this.onDecision({ ...request, ...result })
      return result
    }

    const op = request?.op ?? OP.FILE_WRITE
    const target = String(request?.target ?? '')
    const command = String(request?.command ?? '')
    const intent = String(request?.userIntent ?? '')
    const haystack = `${target} ${command}`

    // ── 第一层：硬禁区 ──
    for (const rule of HARD_DENY) {
      if (rule.pattern.test(haystack)) {
        const result = { verdict: 'deny', why: `hard deny: ${rule.why}`, layer: 'hard' }
        this.onDecision({ op, target, verdict: result.verdict, why: result.why, layer: result.layer })
        return result
      }
    }

    // ── 第二层：意图匹配 ──
    const hasIntentAllow = INTENT_ALLOW.some(re => re.test(intent))
    const targetMentioned = mentionsTarget(intent, target)

    for (const rule of SUSPICIOUS) {
      if (rule.pattern.test(haystack)) {
        // 用户在原话里明确提了这个目标，并且说了授权词 → 放行
        if (targetMentioned && hasIntentAllow) continue
        const result = { verdict: 'ask', why: `suspicious: ${rule.why}`, layer: 'intent' }
        this.onDecision({ op, target, verdict: result.verdict, why: result.why, layer: result.layer })
        return result
      }
    }

    // 用户原话里完全没提这个目标对象，且不是用户说了算的操作 → 问
    if (intent !== '' && target !== '' && targetMentioned === false) {
      const result = { verdict: 'ask', why: 'target not mentioned in user intent', layer: 'intent' }
      this.onDecision({ op, target, verdict: result.verdict, why: result.why, layer: result.layer })
      return result
    }

    // ── 第三层：可选 AI 审查（只处理灰色地带） ──
    if (this.aiReview !== null) {
      try {
        const verdict = await this.aiReview({ op, target, command, intent })
        if (verdict === 'ask' || verdict === 'deny') {
          const result = { verdict, why: 'ai review flagged', layer: 'ai' }
          this.onDecision({ op, target, verdict: result.verdict, why: result.why, layer: result.layer })
          return result
        }
      } catch (error) {
        // AI 审查自己挂了，不能因此放行越界操作：降级为 ask
        this.warn(`freebridge/guard: ai review failed: ${error?.message ?? error}`)
        const result = { verdict: 'ask', why: 'ai review unavailable', layer: 'ai-fallback' }
        this.onDecision({ op, target, verdict: result.verdict, why: result.why, layer: result.layer })
        return result
      }
    }

    const result = { verdict: 'allow', why: 'in scope', layer: 'intent' }
    this.onDecision({ op, target, verdict: result.verdict, why: result.why, layer: result.layer })
    return result
  }

  /** 运行时开关（设置页可切） */
  setEnabled(enabled) {
    this.enabled = enabled !== false
    return this.enabled
  }

  status() {
    return { enabled: this.enabled, hasAiReview: this.aiReview !== null, rules: { hard: HARD_DENY.length, suspicious: SUSPICIOUS.length, intent: INTENT_ALLOW.length } }
  }
}

/** 导出规则表，方便 README / 测试枚举失效模式 */
export function ruleCatalog() {
  return {
    hard: HARD_DENY.map(r => ({ pattern: r.pattern.source, why: r.why })),
    suspicious: SUSPICIOUS.map(r => ({ pattern: r.pattern.source, why: r.why })),
    intent: INTENT_ALLOW.map(r => ({ pattern: r.source })),
  }
}
