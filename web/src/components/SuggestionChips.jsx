/**
 * Quick-pick cards for the next user turn.
 * Stacked full-width rows aligned with the transcript measure.
 */
export default function SuggestionChips({ items, onPick, disabled }) {
  if (!items?.length) return null
  return (
    <div className="suggest-panel" aria-label="下一步建议">
      <div className="suggest-label-row">
        <span className="suggest-label">下一步</span>
      </div>
      <div className="suggest-list">
        {items.slice(0, 3).map((text, i) => (
          <button
            key={text}
            type="button"
            className="suggest-card"
            disabled={disabled}
            title={disabled ? '当前回合进行中' : '填入输入框并发送准备'}
            onClick={() => onPick(text)}
          >
            <span className="suggest-idx">{i + 1}</span>
            <span className="suggest-text">{text}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
