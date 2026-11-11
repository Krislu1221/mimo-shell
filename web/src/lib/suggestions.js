/**
 * Next-step suggestions under the latest reply.
 *
 * The engine's `/session/:id/predict` returns one string. We pad it with
 * 1–2 local follow-ups so the user always gets 2–3 quick picks.
 */

function lastAssistant(messages) {
  const list = (messages || []).filter((m) => m?.info)
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].info.role === 'assistant') return list[i]
  }
  return null
}

function toolsOf(msg) {
  return Object.values(msg?.parts || {})
    .filter((p) => p?.type === 'tool' && p.tool)
    .map((p) => p.tool)
}

function textOf(msg) {
  return Object.values(msg?.parts || {})
    .filter((p) => p?.type === 'text')
    .map((p) => p.text || '')
    .join('\n')
    .trim()
}

const HEURISTICS = [
  {
    when: (tools, text) => tools.some((t) => ['edit', 'write', 'notebook_edit'].includes(t)),
    items: ['检查刚才的改动，有问题就修', '把这次改动整理成简短说明'],
  },
  {
    when: (tools) => tools.includes('bash'),
    items: ['看下刚才命令的结果，失败就换方案', '继续下一步'],
  },
  {
    when: (_t, text) => /[?？]\s*$/.test(text) || /为什么|怎么|如何/.test(text),
    items: ['再举一个具体例子', '用更短的话总结要点'],
  },
  {
    when: () => true,
    items: ['继续', '换个思路再试一次'],
  },
]

/**
 * @returns {string[]} 2–3 unique suggestion strings (may be empty if nothing).
 */
export function buildSuggestions(messages, enginePrediction = '') {
  const msg = lastAssistant(messages)
  const tools = toolsOf(msg)
  const text = textOf(msg)

  const out = []
  // enginePrediction may be one string (the engine's /predict) or several
  // (the gateway's model-backed suggestions).
  const engineList = Array.isArray(enginePrediction) ? enginePrediction : [enginePrediction]
  for (const raw of engineList) {
    const t = String(raw || '').trim()
    if (t && !out.includes(t)) out.push(t)
  }

  for (const rule of HEURISTICS) {
    try {
      if (rule.when(tools, text)) {
        for (const item of rule.items) {
          if (!out.includes(item)) out.push(item)
          if (out.length >= 3) return out
        }
      }
    } catch {
      /* keep going */
    }
  }
  return out.slice(0, 3)
}
