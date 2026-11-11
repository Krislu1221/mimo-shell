import { useEffect, useReducer, useRef } from 'react'
import { initialState, reducer } from './store'

/** Delay between reconnect attempts, in ms. */
const RETRY_MS = 2000

/**
 * One EventSource for the whole app, with an explicit reconnect loop.
 *
 * EventSource's built-in retry only covers a connection that was established and
 * then dropped. When the upstream is *down*, the gateway answers 502 — and a
 * non-2xx response makes the browser fire `error` and set readyState to CLOSED
 * **permanently**, with no further retries. That is exactly the case we hit
 * every time the engine restarts, so the reconnect loop is ours to own.
 *
 * @returns {[object, Function]} reducer state and dispatch
 */
export function useEventStream() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const sourceRef = useRef(null)
  const timerRef = useRef(null)
  const stoppedRef = useRef(false)

  useEffect(() => {
    stoppedRef.current = false

    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    const connect = () => {
      if (stoppedRef.current) return
      const source = new EventSource('/api/event')
      sourceRef.current = source

      source.onopen = () => {
        clearTimer()
        dispatch({ type: 'connected', value: true })
      }

      source.onerror = () => {
        dispatch({ type: 'connected', value: false })
        // CLOSED means the browser gave up on this instance; a fresh one is the
        // only way back. Guard against stacking timers on repeated errors.
        if (source.readyState === EventSource.CLOSED) {
          try {
            source.close()
          } catch {
            /* already gone */
          }
          clearTimer()
          timerRef.current = setTimeout(connect, RETRY_MS)
        }
      }

      source.onmessage = (ev) => {
        try {
          dispatch({ type: 'event', event: JSON.parse(ev.data) })
        } catch {
          /* a heartbeat or partial frame — nothing to apply */
        }
      }
    }

    connect()

    // Recover immediately when the tab comes back to the foreground; browsers
    // may have suspended the stream while hidden.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && sourceRef.current?.readyState === EventSource.CLOSED) {
        clearTimer()
        connect()
      }
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      stoppedRef.current = true
      clearTimer()
      document.removeEventListener('visibilitychange', onVisible)
      try {
        sourceRef.current?.close()
      } catch {
        /* already gone */
      }
      sourceRef.current = null
    }
  }, [])

  return [state, dispatch]
}
