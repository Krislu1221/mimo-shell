/**
 * Thin client over the MiMo server API.
 *
 * Everything is same-origin: the production gateway strips the `/api` prefix
 * and forwards to `mimo serve`, and the Vite dev proxy does the same. So there
 * is no base URL to configure here.
 */

const BASE = '/api'

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`)
  }
  if (res.status === 204) return null
  const type = res.headers.get('content-type') || ''
  if (!type.includes('json')) return res.text()
  // A prompt that fails mid-stream leaves the 200 response with an empty body
  // (the status was committed before the turn started). Surface that as a
  // readable failure instead of the browser's raw "Unexpected end of JSON".
  const text = await res.text()
  if (!text.trim()) {
    throw new Error('引擎没有返回内容（该回合可能中途失败，详见 MiMo 服务端日志）')
  }
  return JSON.parse(text)
}

export const api = {
  /** Session list, newest first as returned by the server. */
  listSessions: () => request('/session'),

  createSession: (body = {}) => request('/session', { method: 'POST', body: JSON.stringify(body) }),

  /** Branch a session into a new one. Returns the new session. */
  fork: (id, title) =>
    request(`/session/${id}/fork`, { method: 'POST', body: JSON.stringify(title ? { title } : {}) }),

  deleteSession: (id) => request(`/session/${id}`, { method: 'DELETE' }),

  /**
   * Rename a session. Engine requires the revision we last saw so a generated
   * title cannot be clobbered by a stale client.
   */
  renameSession: (id, title, expectedRevision = 0) =>
    request(`/session/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, expectedRevision }),
    }),

  /** Full history for a session: messages with their parts, already ordered. */
  listMessages: (sessionId) => request(`/session/${sessionId}/message`),

  /** Configured providers and their models, plus cost metadata. */
  providers: () => request('/config/providers'),

  agents: () => request('/agent'),

  currentProject: () => request('/project/current'),

  abort: (sessionId) => request(`/session/${sessionId}/abort`, { method: 'POST', body: '{}' }),

  /**
   * Outstanding asks. Both lists are server-authoritative: an agent blocked on a
   * question stays `running` until answered, so the UI must be able to recover
   * the pending item even if the SSE notice was missed.
   */
  questions: () => request('/question'),
  permissions: () => request('/permission'),

  /** Body: { reply: 'once' | 'always' | 'reject', message?: string } */
  replyPermission: (requestId, reply, message) =>
    request(`/permission/${requestId}/reply`, {
      method: 'POST',
      body: JSON.stringify({ reply, message }),
    }),

  /**
   * Body: { answers: [[questionText, answerText], ...] } — one inner pair per
   * question, verified against the live endpoint (a flat string[] is a 400).
   */
  replyQuestion: (requestId, answers) =>
    request(`/question/${requestId}/reply`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    }),

  rejectQuestion: (requestId, reason) =>
    request(`/question/${requestId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  /**
   * Send a prompt.
   *
   * Deliberately NOT awaited by the UI for rendering. MiMo's idle response is
   * 200 `application/json` written once at the end, padded with a single space
   * every few seconds as a keep-alive — the actual token stream arrives on the
   * `/event` SSE channel. The returned promise exists only to surface hard
   * failures (session gone, validation error, upstream down).
   */
  sendMessage(sessionId, body) {
    return request(`/session/${sessionId}/message`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },

  /** Gateway-local: high-frequency config + shell meta. Not proxied to mimo. */
  getSettings: () => request('/settings'),

  /** PUT body is the panel draft; returns { ok, path, settings }. */
  saveSettings: (draft) =>
    request('/settings', { method: 'PUT', body: JSON.stringify(draft) }),

  /** Best-effort engine bounce. false → we do not own the engine process. */
  restartEngine: () => request('/shell/restart-engine', { method: 'POST', body: '{}' }),

  /**
   * Engine next-prompt prediction (TUI ghost text). Single string; empty when
   * disabled or the engine has nothing useful.
   */
  predict: (sessionId) =>
    request(`/session/${sessionId}/predict`, { method: 'POST', body: '{}' }),

  /**
   * Next-step suggestions for a finished turn.
   *
   * Goes to the gateway, which asks the engine first and falls back to a direct
   * model call — the engine's own /predict is empty too often to rely on.
   * Returns plain strings, ready to drop into the composer.
   */
  suggest: (sessionId) =>
    request(`/suggest`, { method: 'POST', body: JSON.stringify({ sessionId }) }),
}
