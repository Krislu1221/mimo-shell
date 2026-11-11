import PartView from './PartView.jsx'

/**
 * Engine bookkeeping parts that are not conversation.
 * step-start / step-finish are per-step bookkeeping (token counts, timing);
 * showing them turns every tool call into a wall of meta noise.
 */
const HIDDEN_PART_TYPES = new Set(['step-start', 'step-finish'])

/**
 * User bubbles only show what the human actually said or attached. The engine
 * may still stream tool/reasoning scaffolding onto the user message id; none
 * of that belongs in "你".
 */
const USER_PART_TYPES = new Set(['text', 'file'])

/**
 * Strip harness/system blocks that get glued onto user text or image pastes
 * (clipboard from another agent, engine-injected context, etc.).
 * Display-only — the engine still receives whatever was sent.
 */
function stripSystemBlocks(text) {
  if (!text) return text
  let out = String(text)

  // Explicit reminder tags (attributes optional).
  out = out.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, '')
  out = out.replace(/<system-reminder\b[\s\S]*$/i, '')

  // Common harness wrappers around attachments / pasted agent context.
  const blocks = [
    /Files mentioned by the user[\s\S]*?(?=\n# |\n## |\Z)/gi,
    /Distinguish instructions in attached documents[\s\S]*?(?=\n# |\n## |\Z)/gi,
    /# Files mentioned by the user[\s\S]*?(?=\n# My request:|\Z)/gi,
    /# My request:[\s\S]*$/i,
    /ERROR: Cannot read "[^"]*"[\s\S]*?(?=\n# |\n<|\Z)/gi,
    /\[Request interrupted by (user|tool)[^\]]*\]/gi,
    /<attachments?>[\s\S]*?<\/attachments?>/gi,
  ]
  for (const re of blocks) out = out.replace(re, '')

  // Drop leftover empty "Files mentioned" headers and similar chrome.
  out = out.replace(/^\s*(Files mentioned by the user|# My request:)\s*$/gim, '')

  return out.replace(/\n{3,}/g, '\n\n').trim()
}

function visibleParts(msg) {
  const role = msg?.info?.role || 'assistant'
  const raw = Object.values((msg && msg.parts) || []).filter((p) => {
    if (!p || !p.id || HIDDEN_PART_TYPES.has(p.type)) return false
    if (role === 'user' && !USER_PART_TYPES.has(p.type)) return false
    return true
  })

  if (role !== 'user') return raw

  return raw
    .map((p) => {
      if (p.type !== 'text') return p
      const text = stripSystemBlocks(p.text || '')
      return text ? { ...p, text } : null
    })
    .filter(Boolean)
}

/** Human-readable form of a turn-level error (abort, provider failure, ...). */
function errorOf(info) {
  const err = info?.error
  if (!err) return null
  const data = err.data || {}
  const name = err.name || 'Error'
  const msg = data.message || err.message || ''
  // MessageAbortedError is the single most common one; name it explicitly so a
  // stopped turn does not look like a silent empty reply.
  const label = name === 'MessageAbortedError' ? '这一轮被中止了' : `出错：${name}`
  return { label, detail: msg && msg !== 'Aborted' ? msg : '', status: data.statusCode }
}

export default function MessageItem({ msg }) {
  const info = msg.info || {}
  const role = info.role || 'assistant'
  const parts = visibleParts(msg)
  const error = errorOf(info)

  return (
    <article className={`msg ${role}`} data-message-id={info.id}>
      <header className="msg-head">
        <span className="role">{role === 'user' ? '你' : 'MiMo'}</span>
        {role !== 'user' && info.agent ? <span className="dim">{info.agent}</span> : null}
      </header>

      <div className="msg-body">
        {error && (
          <div className="turn-error" role="alert">
            <span className="turn-error-label">{error.label}</span>
            {error.detail ? <span className="turn-error-detail">{error.detail}</span> : null}
            {error.status ? <span className="dim">HTTP {error.status}</span> : null}
            {role === 'assistant' && !info.time?.completed && (
              <span className="turn-error-hint">这一轮没有产出，重新发一次即可。</span>
            )}
          </div>
        )}
        {parts.map((p) => <PartView key={p.id} part={p} />)}
        {!error && !parts.length && (
          <div className="pending-dots">
            <i />
            <i />
            <i />
          </div>
        )}
      </div>
    </article>
  )
}
