/**
 * Single reducer for the whole live view.
 *
 * Everything the chat shows arrives on one channel: `GET /event`, a long-lived
 * SSE stream. MiMo pushes ~20 distinct event types; the ones that matter for
 * rendering a turn are message.updated / message.part.updated / message.part.delta
 * plus the session lifecycle and metrics events.
 *
 * The shape here mirrors the server's own vocabulary on purpose — `byId` keyed
 * by session, messages keyed by message id, parts keyed by part id — so a new
 * event type is usually a one-line addition rather than a redesign.
 */

export const initialState = {
  connected: false,
  sessions: [],
  activeId: null,
  byId: {}, // sessionId -> { messages: {msgId: {info, parts}}, order: [msgId] }
  status: {}, // sessionId -> 'busy' | 'idle'
  metrics: {}, // sessionId -> last model_call metrics
  errors: {}, // sessionId -> last session.error payload
  askBump: 0, // bumped on question/permission events so the UI re-pulls the list
  error: null,
}

function emptySession() {
  return { messages: {}, order: [] }
}

function slot(state, sessionId) {
  if (!state.byId[sessionId]) {
    state.byId = { ...state.byId, [sessionId]: emptySession() }
  }
  return state.byId[sessionId]
}

function touchMessage(state, sessionId, messageId) {
  const s = slot(state, sessionId)
  if (!s.messages[messageId]) {
    /*
     * A delta can arrive before its `message.updated` — always the case right
     * after a reconnect, when live deltas race the history fetch. Placeholder
     * info must be an object, not null: the transcript renders `msg.info.id` as
     * a React key and reading `.id` off null takes the whole view down.
     */
    s.messages = {
      ...s.messages,
      [messageId]: { info: { id: messageId, sessionID: sessionId, role: 'assistant' }, parts: {} },
    }
    if (!s.order.includes(messageId)) s.order = [...s.order, messageId]
  }
  return s.messages[messageId]
}

/** Sort a session's message ids by creation time, stable for undated entries. */
function sortedOrder(s) {
  return [...s.order].sort((a, b) => {
    const ta = s.messages[a]?.info?.time?.created ?? 0
    const tb = s.messages[b]?.info?.time?.created ?? 0
    return ta - tb
  })
}

/**
 * Keep the sidebar list newest-first and de-duplicated.
 *
 * Never clobber a real title with a placeholder. Engine events frequently
 * carry incomplete session snapshots (especially message.updated, which has
 * no title at all) — merging those blindly flipped "MiMo Code 桌面壳打磨"
 * back to 未命名 during every turn.
 */
function upsertSession(list, info) {
  if (!info?.id) return list
  const next = list.filter((s) => s.id !== info.id)
  const prev = list.find((s) => s.id === info.id)
  const merged = { ...prev, ...info }

  const prevTitle = (prev?.title || '').trim()
  const nextTitle = (merged.title || '').trim()
  const placeholder = !nextTitle || /^(untitled|未命名会话?)$/i.test(nextTitle)
  if (placeholder && prevTitle && !/^(untitled|未命名会话?)$/i.test(prevTitle)) {
    merged.title = prev.title
    if (prev.titleSource) merged.titleSource = prev.titleSource
    if (prev.titleRevision != null) merged.titleRevision = prev.titleRevision
  }
  if (merged.title === '未命名会话' && !nextTitle) delete merged.title

  next.unshift(merged)
  next.sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0))
  return next
}

/**
 * Sidebar-safe summary. Children (checkpoint-writer, etc.) are marked with
 * parentID so the UI can hide them — they are engine bookkeeping, not chats.
 */
function toSummary(info) {
  if (!info?.id) return null
  const out = {
    id: info.id,
    directory: info.directory || '',
    time: info.time || {},
  }
  if (info.title != null && String(info.title).trim()) out.title = String(info.title).trim()
  if (info.titleSource) out.titleSource = info.titleSource
  if (info.titleRevision != null) out.titleRevision = info.titleRevision
  if (info.parentID) out.parentID = info.parentID
  if (info.slug) out.slug = info.slug
  return out
}

/** Merge one SSE event into state. Mutates by convention; caller returns a new root. */
function applyEvent(prev, event) {
  const state = { ...prev, byId: { ...prev.byId } }
  const p = event.properties || {}
  const sid = p.sessionID

  switch (event.type) {
    case 'server.connected':
      state.connected = true
      break

    case 'session.created':
    case 'session.updated': {
      const summary = toSummary(p.info)
      if (summary) state.sessions = upsertSession(state.sessions, summary)
      break
    }

    case 'session.deleted':
      state.sessions = state.sessions.filter((s) => s.id !== (p.sessionID || p.id))
      if (state.activeId === (p.sessionID || p.id)) state.activeId = null
      break

    case 'session.status':
      if (sid) state.status = { ...state.status, [sid]: p.status?.type || 'idle' }
      break

    case 'session.idle':
      if (sid) state.status = { ...state.status, [sid]: 'idle' }
      break

    case 'session.deleted.different':
      break

    case 'message.updated': {
      if (!sid || !p.info) break
      const msg = touchMessage(state, sid, p.info.id)
      msg.info = p.info
      // Touch the session's updated time only — never rewrite title from a message.
      if (p.info.time) {
        state.sessions = upsertSession(state.sessions, { id: sid, time: p.info.time })
      }
      break
    }

    case 'message.removed': {
      const s = state.byId[sid]
      if (s?.messages[p.messageID]) {
        const messages = { ...s.messages }
        delete messages[p.messageID]
        state.byId[sid] = { messages, order: s.order.filter((id) => id !== p.messageID) }
      }
      break
    }

    case 'message.part.updated': {
      if (!sid || !p.part) break
      const msg = touchMessage(state, sid, p.part.messageID)
      msg.parts = { ...msg.parts, [p.part.id]: p.part }
      break
    }

    case 'message.part.delta': {
      if (!sid) break
      const msg = touchMessage(state, sid, p.messageID)
      const prev = msg.parts[p.partID]
      const base = prev || { id: p.partID, messageID: p.messageID, sessionID: sid, type: 'text' }
      msg.parts = {
        ...msg.parts,
        [p.partID]: { ...base, [p.field]: (base[p.field] || '') + (p.delta || '') },
      }
      break
    }

    case 'message.part.removed': {
      const s = state.byId[sid]
      if (s?.messages[p.messageID]?.parts[p.partID]) {
        const parts = { ...s.messages[p.messageID].parts }
        delete parts[p.partID]
        s.messages[p.messageID].parts = parts
      }
      break
    }

    case 'metrics.model_call':
      if (sid) state.metrics = { ...state.metrics, [sid]: p }
      break

    case 'session.error': {
      // MiMo reports a failed turn here. The HTTP response of the prompt
      // request is already committed (200) by then, so this event is the only
      // place the real reason shows up.
      if (sid) state.errors = { ...state.errors, [sid]: p.error }
      break
    }


    default:
      /*
       * Asks are matched by prefix, not exact name. The server emits
       * `question.asked` / `permission.asked` plus `.replied` / `.rejected`
       * variants — guessing `question.updated` silently never matches, and a
       * blocked agent then waits forever with nothing in the UI able to answer
       * it.
       *
       * The reducer deliberately does not accumulate the asks themselves:
       * removing a resolved one is the hard part. Bump a counter and let
       * useAsk() re-read the authoritative lists instead.
       */
      if (/^(question|permission)\./.test(event.type || '')) {
        state.askBump = (state.askBump || 0) + 1
      }
      break
  }
  return state
}

export function reducer(prev, action) {
  switch (action.type) {
    case 'event':
      return applyEvent(prev, action.event)

    case 'connected':
      return { ...prev, connected: action.value }

    case 'error':
      return { ...prev, error: action.error }

    case 'setSessions':
      return { ...prev, sessions: action.sessions }

    case 'setActive':
      return { ...prev, activeId: action.id }

    case 'ensureSlot':
      if (prev.byId[action.id]) return prev
      return { ...prev, byId: { ...prev.byId, [action.id]: emptySession() } }

    /** Replace a session's history with a freshly fetched page. */
    case 'hydrate': {
      const messages = {}
      const order = []
      for (const m of action.messages || []) {
        // History can carry malformed entries (a message with no info, a part
        // that is null). Rendering a turn must not be taken down by one.
        if (!m || !m.info || !m.info.id) continue
        const parts = {}
        for (const part of m.parts || []) {
          if (part && part.id) parts[part.id] = part
        }
        messages[m.info.id] = { info: m.info, parts }
        order.push(m.info.id)
      }
      return {
        ...prev,
        byId: { ...prev.byId, [action.id]: { messages, order: sortedOrder({ messages, order }) } },
      }
    }

    case 'clearError': {
      if (!prev.errors[action.id]) return prev
      const errors = { ...prev.errors }
      delete errors[action.id]
      return { ...prev, errors }
    }

    default:
      return prev
  }
}

export function activeMessages(state) {
  if (!state.activeId) return []
  const s = state.byId[state.activeId]
  if (!s) return []
  return sortedOrder(s).map((id) => s.messages[id]).filter(Boolean)
}
