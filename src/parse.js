/**
 * SSE 解析：把上游的 OpenAI 流式响应解析成 harness 认的 chunk 事件。
 *
 * harness 的 chunk 协议（与 dsh-our-free-model 一致）：
 *   { type: 'block-start', index, blockType }
 *   { type: 'text-delta', index, text }
 *   { type: 'reasoning-delta', index, text }
 *   { type: 'block-end', index, block }
 *   { type: 'usage', usage }
 *   { type: 'finish', reason }
 *
 * @module src/stream.js
 */

/** 从上游 SSE 里取 delta 文本。不同网关字段名不统一，按优先级试。 */
function pickText(delta) {
  if (!delta || typeof delta !== 'object') return { text: '', reasoning: '' }
  const reasoning =
    delta.reasoning_content ??
    delta.reasoning ??
    delta.thinking ??
    (Array.isArray(delta.reasoning_details) ? delta.reasoning_details.map(d => d?.text ?? '').join('') : '') ??
    ''
  const text = delta.content ?? ''
  return {
    text: typeof text === 'string' ? text : '',
    reasoning: typeof reasoning === 'string' ? reasoning : '',
  }
}

/** 把 finish_reason 映射成 harness 的 reason.kind */
function mapFinish(reason) {
  if (reason === 'stop' || reason === 'end_turn' || reason === null || reason === undefined) {
    return { kind: 'stop' }
  }
  if (reason === 'length' || reason === 'max_tokens') return { kind: 'length' }
  if (reason === 'tool_calls' || reason === 'tool_call' || reason === 'stop_sequence') {
    return { kind: 'tool-calls' }
  }
  return { kind: 'stop' }
}

/**
 * 把上游 Response 的 body 解析成 chunk 事件流。
 *
 * @param {Response} response
 * @param {object} [options]
 * @param {() => void} [options.onFirstText] 首个正文 delta 出现时回调（用于提交裁决）
 * @returns {AsyncGenerator<object>}
 */
export async function* readStream(response, options = {}) {
  const body = response.body
  if (body === null || body === undefined) {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream returned an empty body', code: 'EMPTY_RESPONSE' } } }
    return
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()

  let textIndex = -1
  let reasoningIndex = -1
  let textBuffer = ''
  let reasoningBuffer = ''
  let usage = null
  let finishReason = null
  let sawAny = false
  let firstTextFired = false

  const commit = () => {
    if (firstTextFired) return
    firstTextFired = true
    options.onFirstText?.()
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunkText = decoder.decode(value, { stream: true })
      // SSE 一行一行来；末尾不完整的一行留到下一轮
      for (const line of chunkText.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith(':')) continue
        if (!trimmed.startsWith('data:')) continue

        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') continue

        let parsed
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }

        sawAny = true

        // 上游有时把错误包在流里
        if (parsed.error) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: {
                message: String(parsed.error.message ?? parsed.error),
                code: 'UPSTREAM_ERROR',
              },
            },
          }
          return
        }

        if (parsed.usage) usage = parsed.usage

        const choice = parsed.choices?.[0]
        if (choice === undefined) continue

        if (choice.finish_reason) finishReason = choice.finish_reason

        const delta = choice.delta ?? choice.message ?? {}
        const { text, reasoning } = pickText(delta)

        if (reasoning !== '') {
          if (reasoningIndex < 0) {
            reasoningIndex = 0
            yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
          }
          reasoningBuffer += reasoning
          yield { type: 'reasoning-delta', index: reasoningIndex, text: reasoning }
        }

        if (text !== '') {
          commit()
          if (textIndex < 0) {
            textIndex = reasoningIndex >= 0 ? 1 : 0
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          textBuffer += text
          yield { type: 'text-delta', index: textIndex, text }
        }
      }
    }
  } finally {
    reader.releaseLock?.()
  }

  if (reasoningIndex >= 0 && reasoningBuffer !== '') {
    yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningBuffer } }
  }
  if (textIndex >= 0 && textBuffer !== '') {
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuffer } }
  }

  if (usage !== null && typeof usage === 'object') {
    yield {
      type: 'usage',
      usage: {
        inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      },
    }
  }

  // 上游连一个字节都没给，按空响应对待，让上层故障转移
  if (!sawAny || (textBuffer === '' && reasoningBuffer === '' && finishReason === null)) {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'upstream produced no content', code: 'EMPTY_RESPONSE' } },
    }
    return
  }

  yield { type: 'finish', reason: mapFinish(finishReason) }
}
