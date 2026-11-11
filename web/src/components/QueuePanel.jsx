import { useState } from 'react'

function preview(item) {
  const t = (item.text || '').replace(/\s+/g, ' ').trim()
  const imgs = item.attachments?.length ? ` [${item.attachments.length} 图]` : ''
  if (!t) return imgs.trim() || '（仅图片）'
  return (t.length > 80 ? t.slice(0, 80) + '…' : t) + imgs
}

/**
 * Pending send queue. Items sit here while a turn is running;
 * order is play order — first item goes out when the engine goes idle.
 */
export default function QueuePanel({ items, onEdit, onDelete, onJump, onClear }) {
  const [confirmId, setConfirmId] = useState(null)

  if (!items?.length) return null

  return (
    <div className="queue-panel" aria-label="待发送队列">
      <div className="queue-head">
        <span className="queue-title">
          待发送 <span className="queue-count">{items.length}</span>
        </span>
        <span className="queue-hint dim">当前回合结束后按顺序发出 · 第一条可插队</span>
        <span className="spacer" />
        <button type="button" className="queue-clear" onClick={onClear}>
          清空
        </button>
      </div>
      <ul className="queue-list">
        {items.map((item, i) => (
          <li key={item.id} className={`queue-item ${i === 0 ? 'next' : ''}`}>
            <div className="queue-idx mono">{i === 0 ? '下一条' : `+${i}`}</div>
            <div className="queue-body">
              <div className="queue-text">{preview(item)}</div>
              <div className="queue-actions">
                {i > 0 && (
                  <button type="button" title="插到队首，最先发出" onClick={() => onJump(item.id)}>
                    插队
                  </button>
                )}
                {i === 0 && (
                  <button type="button" title="已是下一条" disabled className="ghost-mini">
                    队首
                  </button>
                )}
                <button type="button" title="撤回并编辑" onClick={() => onEdit(item.id)}>
                  编辑
                </button>
                <button
                  type="button"
                  className="danger-mini"
                  title="删除"
                  onClick={() => {
                    if (confirmId === item.id) {
                      onDelete(item.id)
                      setConfirmId(null)
                    } else {
                      setConfirmId(item.id)
                    }
                  }}
                >
                  {confirmId === item.id ? '确认删除' : '删除'}
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
