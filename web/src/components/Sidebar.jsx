import { useMemo } from 'react'

function when(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const now = Date.now()
  const diff = now - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export default function Sidebar({ sessions, activeId, onSelect, onNew, onDelete, busy, onOpenSettings }) {
  const sorted = useMemo(
    () => [...sessions].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)),
    [sessions],
  )

  return (
    <aside className="sidebar">
      {/* Drag strip for the integrated window; traffic lights float over it. */}
      <div className="sidebar-head">
        <span className="brand">Mimo Shell</span>
        <button className="new-session" onClick={onNew} title="新建会话">
          +
        </button>
      </div>

      <div className="session-list">
        {sorted.length === 0 && <div className="empty">还没有会话，点 + 开始</div>}
        {sorted.map((s) => (
          <div
            key={s.id}
            className={`session ${s.id === activeId ? 'active' : ''}`}
            onClick={() => onSelect(s.id)}
          >
            <div className="session-title">{s.title || '…'}</div>
            <div className="session-meta">
              <span className="dim">{when(s.time?.updated)}</span>
              {busy[s.id] === 'busy' && <span className="pill busy">运行中</span>}
            </div>
            <button
              className="del"
              title="删除会话"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(s.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <button type="button" className="settings-trigger" onClick={onOpenSettings} title="设置（⌘,）">
          <span className="settings-trigger-icon" aria-hidden>
            ⚙
          </span>
          设置
        </button>
      </div>
    </aside>
  )
}
