import { useEffect, useRef, useState } from 'react'

/**
 * Detect a session MiMo Code will never finish.
 *
 * The signature: the last message is an assistant message with neither a
 * `finish` reason nor an `error`, and it carries no content. The runner has
 * gone idle, but nothing was ever finalised — so every later prompt returns an
 * empty 200 immediately and leaves another dangling message. Observed twice:
 * once after an aborted turn, once after a subagent failure. Neither `abort`
 * nor `fork` clears it; only a new session does.
 *
 * @param {string|null} sessionId
 * @param {object} slot    byId[sessionId]
 * @param {string} status  'busy' | 'idle' | undefined
 * @returns {boolean}
 */
export function useWedged(sessionId, slot, status) {
  const [wedged, setWedged] = useState(false)
  const timer = useRef(null)

  useEffect(() => {
    const check = () => {
      if (!sessionId || status === 'busy' || !slot) return false
      const ids = Object.keys(slot.messages || {})
      if (!ids.length) return false
      // Newest by creation time, not insertion order.
      const last = ids
        .map((id) => slot.messages[id])
        .filter(Boolean)
        .sort((a, b) => (a.info?.time?.created ?? 0) - (b.info?.time?.created ?? 0))
        .pop()
      const info = last?.info
      if (!info || info.role !== 'assistant') return false
      if (info.finish || info.error) return false
      const hasContent = Object.values(last.parts || {}).some(
        (p) => p && p.type !== 'step-start' && (p.text?.trim() || p.state),
      )
      return !hasContent
    }

    const suspect = check()
    clearTimeout(timer.current)
    if (!suspect) {
      setWedged(false)
      return
    }
    // Require the condition to hold for a while: right after sending, a fresh
    // assistant message legitimately looks like this for a second or two.
    timer.current = setTimeout(() => setWedged(true), 8000)
    return () => clearTimeout(timer.current)
  }, [sessionId, slot, status])

  return wedged
}
