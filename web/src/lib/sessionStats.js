/** Aggregate session transcript into the header stats strip. */

function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(Math.round(n))
}

function fmtCost(n) {
  if (!Number.isFinite(n) || n <= 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(3)}`
}

/**
 * @param {Array} messages  activeMessages(state) — [{info, parts}]
 * @returns {{
 *   turns: number, steps: number, tokTotal: number, tokOut: number,
 *   cacheHit: number|null, cost: number, context: number,
 *   tokPerSec: number|null, parts: string[]
 * } | null}
 */
export function sessionStats(messages) {
  const list = (messages || []).filter((m) => m && m.info)
  if (!list.length) return null

  let turns = 0
  let steps = 0
  let tokTotal = 0
  let tokOut = 0
  let tokRead = 0
  let tokInput = 0
  let cost = 0
  let durationMs = 0
  let context = 0

  for (const m of list) {
    const info = m.info
    const role = info.role || 'assistant'
    if (role === 'user') {
      turns += 1
      continue
    }
    if (role !== 'assistant') continue
    steps += 1
    const t = info.tokens || {}
    const total = Number(t.total) || 0
    const out = Number(t.output) || 0
    tokTotal += total
    tokOut += out
    tokRead += Number(t.cache?.read) || 0
    tokInput += Number(t.input) || 0
    if (Number.isFinite(info.cost)) cost += info.cost
    if (info.time?.created && info.time?.completed) {
      durationMs += Math.max(0, info.time.completed - info.time.created)
    }
    // Latest assistant step approximates current context window usage.
    if (total > 0) context = total
  }

  const denom = tokRead + tokInput
  const cacheHit = denom > 0 ? tokRead / denom : null
  const tokPerSec = durationMs > 0 && tokOut > 0 ? tokOut / (durationMs / 1000) : null

  const parts = [`${turns} 轮`]
  if (steps) parts.push(`${steps} 步`)
  if (tokPerSec) parts.push(`${Math.round(tokPerSec)} tok/s`)
  parts.push(`${fmtTokens(tokTotal)} tok`)
  if (cacheHit != null) parts.push(`缓存 ${Math.round(cacheHit * 100)}%`)
  if (context) parts.push(`上下文 ${fmtTokens(context)}`)
  parts.push(fmtCost(cost))

  return {
    turns,
    steps,
    tokTotal,
    tokOut,
    cacheHit,
    cost,
    context,
    tokPerSec,
    parts,
  }
}
