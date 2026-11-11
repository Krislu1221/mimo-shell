import { useState } from 'react'
import { renderMarkdown, escapeHtml } from '../lib/markdown.js'

/** Human-readable one-liner for a tool call. */
function toolSummary(part) {
  const input = part.state?.input || {}
  const name = part.tool || 'tool'
  const pick = ['command', 'filePath', 'path', 'pattern', 'description', 'query', 'url', 'prompt']
  for (const key of pick) {
    if (typeof input[key] === 'string' && input[key]) {
      const value = input[key].replace(/\s+/g, ' ')
      return `${name} · ${value.length > 120 ? value.slice(0, 120) + '…' : value}`
    }
  }
  return name
}

function ToolPart({ part }) {
  const [open, setOpen] = useState(false)
  const state = part.state || {}
  const status = state.status || 'pending'
  const tone =
    status === 'error' ? 'bad' : status === 'completed' ? 'good' : status === 'running' ? 'busy' : 'idle'

  const body = state.output ?? state.raw ?? state.error ?? ''

  return (
    <div className="tool" data-status={tone}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className={`dot ${tone}`} />
        <span className="tool-name">{toolSummary(part)}</span>
        <span className="caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-body">
          {state.title ? <div className="tool-title">{state.title}</div> : null}
          <div className="tool-io">
            <div>
              <span className="tag">输入</span>
              <pre>{JSON.stringify(state.input ?? {}, null, 2)}</pre>
            </div>
            {body ? (
              <div>
                <span className="tag">输出</span>
                <pre>{typeof body === 'string' ? body : JSON.stringify(body, null, 2)}</pre>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

function ReasoningPart({ part }) {
  const [open, setOpen] = useState(false)
  const text = part.text || part.reasoning || ''
  if (!text) return null
  return (
    <div className="reasoning">
      <button className="reasoning-head" onClick={() => setOpen((v) => !v)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span>思考</span>
        <span className="dim">{text.length} 字</span>
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  )
}

function FilePart({ part }) {
  const mime = part.mime || ''
  const isImage = mime.startsWith('image/')
  const url = part.url || ''
  // Prefer a live data/file URL; if the engine only stored a path, fall back
  // to the text chip so the attachment is still visible.
  const canShow = isImage && (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('http'))

  if (canShow) {
    return (
      <figure className="file-image">
        <img src={url} alt={part.filename || 'image'} loading="lazy" />
        {part.filename ? (
          <figcaption className="dim">{escapeHtml(part.filename)}</figcaption>
        ) : null}
      </figure>
    )
  }

  return (
    <div className="file-part">
      附件 <code>{escapeHtml(part.filename || mime || 'file')}</code>
    </div>
  )
}

function StepFinish({ part }) {
  const t = part.tokens
  if (!t) return null
  const pct = t.total ? Math.round(((t.cache?.read ?? 0) / t.total) * 100) : 0
  return (
    <div className="step-finish">
      <span>本步 {t.total?.toLocaleString?.() ?? t.total} tokens</span>
      {pct > 0 && <span className="dim">缓存命中 {pct}%</span>}
      {part.cost ? <span className="dim">$ {part.cost.toFixed(5)}</span> : null}
    </div>
  )
}

export default function PartView({ part }) {
  switch (part.type) {
    case 'text':
      return <div className="part-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(part.text) }} />

    case 'reasoning':
      return <ReasoningPart part={part} />

    case 'tool':
      return <ToolPart part={part} />

    case 'step-finish':
    case 'step-start':
      // Engine bookkeeping — never rendered in the transcript.
      return null

    case 'file':
      return <FilePart part={part} />

    default:
      // Unknown part types stay visible rather than silently vanishing, so a
      // server-side addition is obvious instead of looking like data loss.
      return (
        <details className="unknown-part">
          <summary>{part.type}</summary>
          <pre>{JSON.stringify(part, null, 2)}</pre>
        </details>
      )
  }
}
