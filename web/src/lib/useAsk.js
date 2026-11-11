import { useCallback, useEffect, useState } from 'react'
import { api } from './api.js'

/**
 * Outstanding asks (questions and permission requests) for the open session.
 *
 * Why poll instead of trusting the event stream: a blocked agent stays `running`
 * forever until the ask is answered, and `question.updated` is just a nudge —
 * if that nudge is missed the turn hangs with no way back except abort. Reading
 * `GET /question` and `GET /permission` makes the panel self-healing: the
 * authoritative lists always win, and answering refreshes them.
 *
 * @param {string|null} activeId
 * @param {number} bump  counter raised by the event stream
 * @returns {[Array, Function]} pending asks and a manual refresh
 */
export function useAsk(activeId, bump) {
  const [items, setItems] = useState([])

  const refresh = useCallback(() => {
    if (!activeId) {
      setItems([])
      return
    }
    Promise.all([api.questions(), api.permissions()])
      .then(([qs, ps]) => {
        const q = (qs || [])
          .filter((x) => x.sessionID === activeId)
          .map((x) => ({ kind: 'question', ...x }))
        const p = (ps || [])
          .filter((x) => x.sessionID === activeId)
          .map((x) => ({ kind: 'permission', ...x }))
        setItems([...q, ...p])
      })
      .catch(() => {
        /* the panel is advisory; a failed refresh should not break the app */
      })
  }, [activeId])

  useEffect(refresh, [refresh, bump])

  /*
   * Safety net. A blocked agent is stuck until answered, and the event that
   * announces it is easy to miss (a dropped stream, a renamed event, a page
   * opened mid-turn). Polling while the tab is visible turns "the agent is
   * wedged and the UI never showed anything" into "the panel just appears".
   */
  useEffect(() => {
    const tick = setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, 4000)
    return () => clearInterval(tick)
  }, [refresh])

  return [items, refresh]
}
