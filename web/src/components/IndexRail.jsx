import { useMemo, useRef, useState, useCallback, useEffect } from 'react'

/**
 * Turn rail — DSH TurnNavigator, simplified.
 *
 * Only user turns are indexed (one mark per round). The ladder windows the
 * last WINDOW turns; clicking the top mark pulls older turns into the window
 * and jumps there.
 */

const WINDOW = 25
const PITCH = 12

function stripSystem(text) {
  return String(text || '')
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<system-reminder\b[\s\S]*$/i, '')
    .replace(/Files mentioned by the user[\s\S]*?(?=\n# |\n## |$)/gi, '')
    .replace(/Distinguish instructions in attached documents[\s\S]*?(?=\n# |\n## |$)/gi, '')
    .replace(/# My request:[\s\S]*$/i, '')
    .trim()
}

function firstText(parts, type) {
  const raw =
    Object.values(parts || {})
      .filter((p) => p?.type === type && typeof p.text === 'string' && p.text.trim())
      .map((p) => p.text.trim())[0] || ''
  return type === 'text' ? stripSystem(raw) : raw
}

function toolNames(parts) {
  const names = []
  for (const p of Object.values(parts || {})) {
    if (p?.type === 'tool' && p.tool) {
      if (!names.includes(p.tool)) names.push(p.tool)
    }
  }
  return names.slice(0, 4)
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n).trimEnd() + '…' : t
}

/** Build turn list: one entry per user message + following assistant reply summary. */
function buildTurns(messages) {
  const list = (messages || []).filter((m) => m?.info?.id)
  const turns = []
  for (let i = 0; i < list.length; i++) {
    const m = list[i]
    if ((m.info.role || '') !== 'user') continue
    // Collect assistant content until the next user message.
    let reply = ''
    let tools = []
    for (let j = i + 1; j < list.length; j++) {
      const a = list[j]
      if ((a.info.role || '') === 'user') break
      if ((a.info.role || '') === 'assistant') {
        if (!reply) reply = firstText(a.parts, 'text')
        tools = tools.concat(toolNames(a.parts))
      }
    }
    turns.push({
      id: m.info.id,
      prompt: firstText(m.parts, 'text') || (Object.values(m.parts || {}).some((p) => p?.type === 'file') ? '[图片]' : ''),
      response: reply,
      tools: [...new Set(tools)],
      seq: turns.length + 1,
      index: i,
    })
  }
  return turns
}

export default function IndexRail({ messages, streamRef }) {
  const [hover, setHover] = useState(null) // { id, top }
  const [windowEnd, setWindowEnd] = useState(WINDOW) // exclusive end into turns[]
  const railRef = useRef(null)

  const turns = useMemo(() => buildTurns(messages), [messages])

  // New session / new thread → back to the latest WINDOW turns.
  useEffect(() => {
    setWindowEnd(WINDOW)
  }, [messages?.[0]?.info?.sessionID])

  // Ladder window: last `windowEnd` turns. Never smaller than WINDOW.
  const end = Math.min(windowEnd, turns.length)
  const start = Math.max(0, end - WINDOW)
  const visible = turns.slice(start, end)
  const hasOlder = start > 0

  const scrollTo = useCallback(
    (messageId) => {
      const root = streamRef?.current
      const el = root?.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
      if (!el || !root) return
      const top = el.offsetTop - root.clientHeight * 0.18
      root.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    },
    [streamRef],
  )

  const jump = useCallback(
    (turn, isTopVisible) => {
      scrollTo(turn.id)
      // Top mark + more history exists → slide the ladder back one window.
      if (isTopVisible && hasOlder) {
        setWindowEnd((w) => Math.min(turns.length, w + WINDOW))
      }
    },
    [scrollTo, hasOlder, turns.length],
  )

  if (turns.length < 1) return null

  // Position marks with fixed pitch inside a scrollable mini-ladder.
  const railHeight = visible.length * PITCH
  const railTop = hover ? hover.top : 0

  return (
    <div
      className="turn-rail"
      ref={railRef}
      aria-label="轮次导航"
      onMouseLeave={() => setHover(null)}
    >
      <div className="turn-rail-marks" style={{ height: railHeight }}>
        {visible.map((turn, i) => {
          const isTop = i === 0
          const active = hover?.id === turn.id
          return (
            <button
              key={turn.id}
              type="button"
              className={`turn-mark ${active ? 'on' : ''} ${isTop && hasOlder ? 'more' : ''}`}
              style={{ top: i * PITCH }}
              title={`第 ${turn.seq} 轮`}
              aria-label={`跳转到第 ${turn.seq} 轮`}
              onMouseEnter={(e) => {
                const box = railRef.current?.getBoundingClientRect()
                const y = e.currentTarget.getBoundingClientRect().top + 5 - (box?.top || 0)
                setHover({ id: turn.id, top: y, turn })
              }}
              onFocus={(e) => {
                const box = railRef.current?.getBoundingClientRect()
                const y = e.currentTarget.getBoundingClientRect().top + 5 - (box?.top || 0)
                setHover({ id: turn.id, top: y, turn })
              }}
              onClick={() => jump(turn, isTop)}
            />
          )
        })}
      </div>

      {hover && (
        <div className="turn-preview" style={{ top: Math.max(0, railTop - 48) }} role="tooltip">
          <div className="turn-preview-meta">
            <span className="turn-preview-seq">第 {hover.turn.seq} 轮</span>
            {hasOlder && hover.id === visible[0]?.id && (
              <span className="turn-preview-more">点击加载更早</span>
            )}
          </div>
          <div className="turn-preview-prompt">{clip(hover.turn.prompt, 80) || '（无文字）'}</div>
          {hover.turn.tools.length > 0 && (
            <div className="turn-preview-tools">
              {hover.turn.tools.map((name) => (
                <span key={name} className="turn-tool-chip">
                  {name}
                </span>
              ))}
            </div>
          )}
          {hover.turn.response && (
            <div className="turn-preview-response">{clip(hover.turn.response, 120)}</div>
          )}
        </div>
      )}

      {hasOlder && (
        <button
          type="button"
          className="turn-rail-more"
          title="加载更早的轮次"
          aria-label="加载更早的轮次"
          onClick={() => setWindowEnd((w) => Math.min(turns.length, w + WINDOW))}
        >
          ↑
        </button>
      )}
    </div>
  )
}
