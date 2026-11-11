import { useState } from 'react'
import { api } from '../lib/api.js'

/**
 * Renders pending questions and permission requests.
 *
 * Without this panel a blocked agent sits in `running` forever: it called the
 * `question` tool (or is waiting on a permission) and nothing in the UI can
 * answer it, so the only way out was abort.
 */

function Option({ label, description, onClick, disabled }) {
  return (
    <button className="ask-option" onClick={onClick} disabled={disabled}>
      <span className="ask-option-label">{label}</span>
      {description ? <span className="ask-option-desc">{description}</span> : null}
    </button>
  )
}

function QuestionCard({ item, onDone, onError }) {
  /*
   * One request can carry several questions, each with its own options. An
   * answer array must line up with them positionally, so the reply is built
   * per question instead of splashing one chosen label across all of them.
   */
  const [picked, setPicked] = useState(() => item.questions.map(() => ''))
  const [free, setFree] = useState(() => item.questions.map(() => ''))
  const [busy, setBusy] = useState(false)

  const toggle = (i, label) =>
    setPicked((prev) => prev.map((v, j) => (i === j ? (v === label ? '' : label) : v)))

  const complete = item.questions.every((_, i) => picked[i] || free[i].trim())
  const anyFree = free.some((f) => f.trim())

  const send = () => {
    if (busy || !complete) return
    setBusy(true)
    const answers = item.questions.map((q, i) => [q.question, (picked[i] || free[i].trim()).trim()])
    api
      .replyQuestion(item.id, answers)
      .then(onDone)
      .catch((e) => {
        setBusy(false)
        onError(e.message)
      })
  }

  const reject = () => {
    if (busy) return
    setBusy(true)
    api
      .rejectQuestion(item.id, '用户选择不回答')
      .then(onDone)
      .catch((e) => {
        setBusy(false)
        onError(e.message)
      })
  }

  return (
    <div className="ask-card">
      <div className="ask-head">
        <span className="ask-kind">需要你确认</span>
        <span className="dim">
          {item.questions.length > 1
            ? `${item.questions.length} 个问题，不回答就一直停在这里`
            : 'Agent 在等回复，不回答就一直停在这里'}
        </span>
      </div>

      {item.questions.map((q, i) => (
        <div className="ask-question" key={i}>
          {q.header ? <div className="ask-header">{q.header}</div> : null}
          <div className="ask-text">{q.question}</div>
          {(q.options || []).map((opt, j) => (
            <button
              key={j}
              className={`ask-option ${picked[i] === opt.label ? 'on' : ''}`}
              disabled={busy}
              onClick={() => toggle(i, opt.label)}
            >
              <span className="ask-option-label">{opt.label}</span>
              {opt.description ? <span className="ask-option-desc">{opt.description}</span> : null}
            </button>
          ))}
          <div className="ask-free">
            <input
              value={free[i]}
              placeholder="或者自己写一句…"
              disabled={busy}
              onChange={(e) => setFree((prev) => prev.map((v, j) => (i === j ? e.target.value : v)))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && complete) send()
              }}
            />
          </div>
        </div>
      ))}

      <div className="ask-actions">
        <button className="primary" disabled={!complete || busy} onClick={send}>
          提交回答
        </button>
        <button className="ask-reject" disabled={busy} onClick={reject}>
          不回答，直接继续
        </button>
      </div>
    </div>
  )
}

function PermissionCard({ item, onDone, onError }) {
  const [busy, setBusy] = useState(false)

  const reply = (value) => {
    if (busy) return
    setBusy(true)
    api
      .replyPermission(item.id, value)
      .then(onDone)
      .catch((e) => {
        setBusy(false)
        onError(e.message)
      })
  }

  const title = item.title || item.typ?.title || '需要授权'
  const detail = item.typ?.patterns?.join(', ') || item.command || item.filePath || ''

  return (
    <div className="ask-card">
      <div className="ask-head">
        <span className="ask-kind">需要授权</span>
        <span className="dim">Agent 在等授权</span>
      </div>
      <div className="ask-question">
        <div className="ask-text">{title}</div>
        {detail ? <div className="ask-detail">{detail}</div> : null}
      </div>
      <div className="ask-actions">
        <button className="primary" disabled={busy} onClick={() => reply('once')}>
          允许这一次
        </button>
        <button disabled={busy} onClick={() => reply('always')}>
          始终允许
        </button>
        <button className="ask-reject" disabled={busy} onClick={() => reply('reject')}>
          拒绝
        </button>
      </div>
    </div>
  )
}

export default function AskPanel({ items, onChanged, onError }) {
  if (!items.length) return null
  return (
    <div className="ask-panel">
      {items.map((item) =>
        item.kind === 'question' ? (
          <QuestionCard key={`q-${item.id}`} item={item} onDone={onChanged} onError={onError} />
        ) : (
          <PermissionCard key={`p-${item.id}`} item={item} onDone={onChanged} onError={onError} />
        ),
      )}
    </div>
  )
}
