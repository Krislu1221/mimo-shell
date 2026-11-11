import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEventStream } from './lib/useEventStream.js'
import { useAsk } from './lib/useAsk.js'
import { useWedged } from './lib/useWedged.js'
import { activeMessages } from './lib/store.js'
import { api } from './lib/api.js'
import { toFileParts } from './lib/attachments.js'
import { sessionStats } from './lib/sessionStats.js'
import { shortTitleFrom, shouldAutoTitle } from './lib/autoTitle.js'
import IndexRail from './components/IndexRail.jsx'
import QueuePanel from './components/QueuePanel.jsx'
import SuggestionChips from './components/SuggestionChips.jsx'
import { buildSuggestions } from './lib/suggestions.js'
import { visibleSessions } from './lib/sessions.js'
import Sidebar from './components/Sidebar.jsx'
import MessageItem from './components/MessageItem.jsx'
import Composer, { buildModelOptions, buildAgentOptions } from './components/Composer.jsx'
import AskPanel from './components/AskPanel.jsx'
import SettingsPanel from './components/SettingsPanel.jsx'

/** Pull the human-readable reason out of a MiMo session.error payload. */
function formatError(err) {
  if (!err) return ''
  const data = err.data || err
  const msg = data.message || err.message || JSON.stringify(err)
  const status = data.statusCode ? `（HTTP ${data.statusCode}）` : ''
  return `引擎报错${status}：${msg}`
}

export default function App() {
  const [state, dispatch] = useEventStream()
  const [providers, setProviders] = useState([])
  const [agents, setAgents] = useState([])
  const [project, setProject] = useState(null)
  const [model, setModel] = useState(null)
  const [agent, setAgent] = useState('')
  const [harness, setHarness] = useState('auto')
  const [fatal, setFatal] = useState(null)
  const [dismissWedged, setDismissWedged] = useState(false)
  const [toast, setToast] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [savedDefaults, setSavedDefaults] = useState(null)
  /** Local send queue — messages typed while a turn is running. */
  const [sendQueue, setSendQueue] = useState([])
  const flushingRef = useRef(false)
  const [enginePrediction, setEnginePrediction] = useState([])

  const scrollRef = useRef(null)
  const hydratedFor = useRef(null)
  const wasConnected = useRef(false)
  const everConnected = useRef(false)

  const modelOptions = useMemo(() => buildModelOptions(providers), [providers])
  const [asks, refreshAsks] = useAsk(state.activeId, state.askBump)
  const wedged = useWedged(state.activeId, state.byId[state.activeId], state.status[state.activeId])

  /* ---- initial loads -------------------------------------------------- */

  useEffect(() => {
    api
      .listSessions()
      .then((list) => {
        dispatch({ type: 'setSessions', sessions: list })
        if (list.length) dispatch({ type: 'setActive', id: list[0].id })
      })
      .catch((e) => setFatal(`无法读取会话列表：${e.message}`))
  }, [dispatch])

  // Integrated window (hiddenInset) is the default; ?titlebar=default opts out.
  useEffect(() => {
    const forcedDefault = new URLSearchParams(window.location.search).get('titlebar') === 'default'
    if (!forcedDefault) document.body.classList.add('inset-titlebar')
  }, [])

  // Menu 「设置…」 / Cmd+, from the Electron shell.
  useEffect(() => {
    const open = () => setSettingsOpen(true)
    window.addEventListener('mimo:settings', open)
    return () => window.removeEventListener('mimo:settings', open)
  }, [])

  useEffect(() => {
    api
      .providers()
      .then((d) => setProviders(d.providers || []))
      .catch(() => setProviders([]))
    api.agents().then((list) => setAgents(buildAgentOptions(list))).catch(() => setAgents([]))
    api.currentProject().then(setProject).catch(() => setProject(null))
  }, [])

  /* ---- hydration: pull a session's history once per switch ------------- */

  /**
   * Name the session from the opening line when the engine has not yet
   * produced a real title (fallback / empty / Untitled). Local heuristic.
   */
  const maybeAutoTitle = useCallback(
    async (sessionId, text, attachmentCount = 0) => {
      const title = shortTitleFrom(text, attachmentCount)
      if (!title) return
      const session = state.sessions.find((s) => s.id === sessionId)
      if (!shouldAutoTitle(session)) return
      try {
        const updated = await api.renameSession(
          sessionId,
          title,
          Number.isFinite(session?.titleRevision) ? session.titleRevision : 0,
        )
        const merged = { ...(session || {}), ...updated, title, titleSource: updated?.titleSource || 'user' }
        dispatch({
          type: 'setSessions',
          sessions: state.sessions.map((s) => (s.id === sessionId ? { ...s, ...merged } : s)),
        })
      } catch (e) {
        try {
          const list = await api.listSessions()
          const fresh = list.find((s) => s.id === sessionId)
          const updated = await api.renameSession(sessionId, title, fresh?.titleRevision || 0)
          dispatch({
            type: 'setSessions',
            sessions: list.map((s) => (s.id === sessionId ? { ...s, ...updated } : s)),
          })
        } catch {
          setToast(`自动命名失败：${e.message}`)
        }
      }
    },
    [dispatch, state.sessions],
  )

  const hydrate = useCallback(
    (id) => {
      if (!id) return
      hydratedFor.current = id
      dispatch({ type: 'ensureSlot', id })
      return api
        .listMessages(id)
        .then((messages) => {
          dispatch({ type: 'hydrate', id, messages })
          // Backfill a short title for older sessions still on "Untitled".
          const firstUser = (messages || []).find((m) => m?.info?.role === 'user')
          if (firstUser) {
            const text = Object.values(firstUser.parts || {})
              .filter((p) => p?.type === 'text')
              .map((p) => p.text || '')
              .join('\n')
            const files = Object.values(firstUser.parts || {}).filter((p) => p?.type === 'file').length
            maybeAutoTitle(id, text, files)
          }
        })
    },
    [dispatch, maybeAutoTitle],
  )

  useEffect(() => {
    const id = state.activeId
    if (!id || hydratedFor.current === id) return
    // Opening a different session always starts at the bottom.
    stickToBottom.current = true
    hydrate(id).catch((e) => setFatal(`读取会话历史失败：${e.message}`))
  }, [state.activeId, hydrate])

  /*
   * The event stream dies whenever the engine restarts (project switch, key
   * change, crash). Events emitted during that window are simply lost, so a
   * drop -> reconnect transition must re-pull history for the open session or
   * the transcript silently loses turns.
   */
  useEffect(() => {
    const now = state.connected
    const was = wasConnected.current
    const hadConnectedBefore = everConnected.current

    // The first false -> true transition is just the stream coming up; only a
    // drop after a successful connect is worth announcing and repairing.
    if (!hadConnectedBefore) {
      if (now) everConnected.current = true
      wasConnected.current = now
      return
    }

    wasConnected.current = now
    if (was && !now) {
      setToast('事件流断开，正在重连…')
      return
    }
    if (!was && now) {
      setToast('事件流已恢复')
      const id = state.activeId
      if (id) {
        api
          .listSessions()
          .then((list) => dispatch({ type: 'setSessions', sessions: list }))
          .catch(() => {})
        hydrate(id).catch(() => {})
      }
    }
  }, [state.connected, state.activeId, hydrate, dispatch])

  /* ---- auto-scroll (stick to bottom only) ------------------------------ */

  const messages = activeMessages(state)
  /**
   * Only chase the bottom when the user is already there (or hasn't scrolled
   * away). Reading history must stay put — earlier builds force-scrolled on
   * every message tick and made the transcript unusable mid-history.
   */
  const stickToBottom = useRef(true)
  const onStreamScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottom.current = gap < 80
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  // Transient notices clear themselves. A sticky error bar was the single most
  // confusing thing in the first build: it stayed after the problem healed.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  useEffect(() => {
    if (!fatal) return
    const t = setTimeout(() => setFatal(null), 8000)
    return () => clearTimeout(t)
  }, [fatal])

  // A recovered stream clears the "send failed" leftovers from the gap.
  useEffect(() => {
    if (state.connected) setFatal((f) => (f && f.startsWith('发送失败') ? null : f))
  }, [state.connected])

  /* ---- actions --------------------------------------------------------- */

  const newSession = useCallback(async () => {
    try {
      // Seed the session from saved defaults so the first message does not
      // silently fall back to the engine's config when the user just set one.
      const body = {}
      if (savedDefaults?.model) {
        const [providerID, modelID] = savedDefaults.model.split('/')
        if (providerID && modelID) body.model = { providerID, modelID }
      }
      if (savedDefaults?.default_agent) body.agent = savedDefaults.default_agent
      const s = await api.createSession(body)
      dispatch({ type: 'setActive', id: s.id })
      hydratedFor.current = s.id
      dispatch({ type: 'hydrate', id: s.id, messages: [] })
      dispatch({ type: 'setSessions', sessions: [s, ...state.sessions.filter((x) => x.id !== s.id)] })
    } catch (e) {
      setFatal(`新建会话失败：${e.message}`)
    }
  }, [dispatch, state.sessions, savedDefaults])

  const deleteSession = useCallback(
    async (id) => {
      if (!confirm('删除这个会话？该操作不可撤销。')) return
      try {
        await api.deleteSession(id)
        const next = state.sessions.filter((s) => s.id !== id)
        dispatch({ type: 'setSessions', sessions: next })
        if (state.activeId === id) {
          hydratedFor.current = null
          dispatch({ type: 'setActive', id: next[0]?.id ?? null })
        }
      } catch (e) {
        setToast(`删除失败：${e.message}`)
      }
    },
    [dispatch, state.activeId, state.sessions],
  )

  /**
   * Fire the prompt and let SSE drive the rendering.
   *
   * While a turn is running the message joins a local queue instead of
   * fighting the engine. Queue items can be edited, deleted, or jumped to
   * the front; the first item is sent automatically when the session goes idle.
   */
  const deliver = useCallback(
    (text, attachments = []) => {
      const id = state.activeId
      if (!id) return
      const parts = []
      if (text) parts.push({ type: 'text', text })
      parts.push(...toFileParts(attachments))
      if (!parts.length) return
      const body = { parts, harness }
      if (model) body.model = { providerID: model.providerID, modelID: model.modelID }
      if (agent) body.agent = agent

      dispatch({ type: 'clearError', id })
      setFatal(null)
      maybeAutoTitle(id, text, attachments.length)
      api.sendMessage(id, body).catch((e) => setFatal(`发送失败：${e.message}`))
    },
    [state.activeId, model, agent, harness, maybeAutoTitle],
  )

  const busy = Boolean(state.activeId && state.status[state.activeId] === 'busy')

  const send = useCallback(
    (text, attachments = []) => {
      if (!state.activeId) return
      if (!text?.trim() && !attachments?.length) return
      if (busy) {
        setSendQueue((q) => [
          ...q,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            text: text || '',
            attachments: attachments || [],
          },
        ])
        setToast('已加入待发送队列')
        return
      }
      deliver(text, attachments)
    },
    [busy, deliver, state.activeId],
  )

  /* Queue ops ---------------------------------------------------------------- */

  const removeFromQueue = useCallback((qid) => {
    setSendQueue((q) => q.filter((x) => x.id !== qid))
  }, [])

  const jumpQueue = useCallback((qid) => {
    setSendQueue((q) => {
      const i = q.findIndex((x) => x.id === qid)
      if (i <= 0) return q
      const next = [...q]
      const [item] = next.splice(i, 1)
      return [item, ...next]
    })
  }, [])

  const clearQueue = useCallback(() => setSendQueue([]), [])

  const editFromQueue = useCallback((qid) => {
    setSendQueue((q) => {
      const item = q.find((x) => x.id === qid)
      if (item) {
        window.dispatchEvent(
          new CustomEvent('mimo:composer-set', {
            detail: { text: item.text, attachments: item.attachments || [] },
          }),
        )
      }
      return q.filter((x) => x.id !== qid)
    })
  }, [])

  /** Auto-send the head of the queue when the engine goes idle. */
  useEffect(() => {
    if (busy || !sendQueue.length || flushingRef.current) return
    flushingRef.current = true
    const [head, ...rest] = sendQueue
    // Defer one frame so React state settles before the POST.
    const t = setTimeout(() => {
      setSendQueue(rest)
      deliver(head.text, head.attachments)
      flushingRef.current = false
    }, 50)
    return () => {
      clearTimeout(t)
      flushingRef.current = false
    }
  }, [busy, sendQueue, deliver])

  /** Copy a session onto a fresh one. Wedged sessions usually stay wedged,
   *  but a fork costs nothing and sometimes clears transient runner state. */
  const forkSession = useCallback(
    async (id) => {
      try {
        const forked = await api.fork(id, '重开的会话')
        dispatch({ type: 'setActive', id: forked.id })
        hydratedFor.current = forked.id
        dispatch({ type: 'hydrate', id: forked.id, messages: [] })
        await api.listMessages(forked.id).then((m) => dispatch({ type: 'hydrate', id: forked.id, messages: m }))
        setDismissWedged(false)
        setToast('已分叉出新会话')
      } catch (e) {
        setToast(`分叉失败：${e.message}`)
      }
    },
    [dispatch],
  )

  const abort = useCallback(() => {
    if (state.activeId) api.abort(state.activeId).catch(() => {})
  }, [state.activeId])

  /* ---- next-prompt suggestions ----------------------------------------- */

  const suggestions = useMemo(
    () => buildSuggestions(messages, enginePrediction),
    [messages, enginePrediction],
  )

  // Pull next-step suggestions once a turn finishes (idle after busy).
  //
  // The trigger is the last assistant message, NOT the message count. Keying
  // on the count re-ran the effect on every message, and the cleanup cancelled
  // the response of a request that was already in flight — so the good
  // prediction was thrown away and the generic local filler was shown
  // instead. A request counter guards against out-of-order replies.
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.info?.role === 'assistant') return messages[i].info.id
    }
    return null
  }, [messages])

  const suggestSeq = useRef(0)
  useEffect(() => {
    if (busy || !state.activeId || !lastAssistantId) return
    const session = state.activeId
    const seq = ++suggestSeq.current
    // Small delay so the session has fully settled.
    const t = setTimeout(() => {
      api
        .suggest(session)
        .then((d) => {
          const list = Array.isArray(d?.suggestions) ? d.suggestions : []
          if (seq !== suggestSeq.current) return
          if (!list.length) return // keep what we had rather than degrade
          setEnginePrediction(list)
        })
        .catch(() => {})
    }, 800)
    return () => clearTimeout(t)
  }, [busy, state.activeId, lastAssistantId])

  const pickSuggestion = useCallback((text) => {
    window.dispatchEvent(
      new CustomEvent('mimo:composer-set', { detail: { text, attachments: [] } }),
    )
  }, [])

  /*
   * 1 / 2 / 3 pick the matching suggestion.
   *
   * Only when the composer is empty or the focus is elsewhere: a stray digit
   * typed into a half-written prompt must never be swallowed.
   */
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement
      const typing =
        el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && el.value.trim() !== ''
      if (typing) return
      const n = Number(e.key)
      if (!Number.isInteger(n) || n < 1 || n > 3) return
      const item = suggestions[n - 1]
      if (!item) return
      e.preventDefault()
      pickSuggestion(item)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [suggestions, pickSuggestion])

  /* ---- render ---------------------------------------------------------- */

  const metrics = state.activeId ? state.metrics[state.activeId] : null
  const activeSession = state.sessions.find((s) => s.id === state.activeId && !s.parentID)
  const stats = useMemo(() => sessionStats(messages), [messages])

  return (
    <div className="app">
      <Sidebar
        sessions={visibleSessions(state.sessions)}
        activeId={state.activeId}
        busy={state.status}
        onSelect={(id) => {
          if (id !== state.activeId) hydratedFor.current = null
          dispatch({ type: 'setActive', id })
        }}
        onNew={newSession}
        onDelete={deleteSession}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="main">
        {/* Conversation header — title + live session rollup, not OS chrome. */}
        <header className="chat-head">
          <div className="chat-head-main">
            <h1 className="chat-title">
              {activeSession?.title &&
              !/^(untitled|未命名会话?)$/i.test(activeSession.title.trim())
                ? activeSession.title
                : activeSession
                  ? '未命名会话'
                  : '未选择会话'}
            </h1>
            {activeSession?.directory && (
              <div className="chat-sub" title={activeSession.directory}>
                <span className="mono">{activeSession.directory}</span>
              </div>
            )}
            {stats && (
              <div
                className="chat-stats mono"
                title="本会话累计：用户轮数 · 助手步数 · 输出吞吐 · 总 token · 缓存命中 · 当前上下文 · 花费"
              >
                {stats.parts.map((part, i) => (
                  <span key={part + i}>
                    {i > 0 && <span className="chat-stats-sep">·</span>}
                    {part}
                  </span>
                ))}
                {metrics?.ttft_ms != null && (
                  <span>
                    <span className="chat-stats-sep">·</span>
                    ttft {metrics.ttft_ms}ms
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="chat-head-meta">
            {metrics?.model_id && (
              <span className="mono dim" title="上一次模型">
                {metrics.model_id}
              </span>
            )}
            <span className={`conn ${state.connected ? 'on' : 'off'}`}>
              <i />
              {state.connected ? '已连接' : '断开'}
            </span>
          </div>
        </header>

        {wedged && !dismissWedged && (
          <div className="banner bad">
            <span>这个会话已经卡死：引擎留下了一轮没有收尾的任务，再发消息也不会有结果。</span>
            <button className="retry" onClick={newSession}>
              新建会话继续
            </button>
            <button
              className="retry"
              onClick={() => {
                if (!state.activeId) return
                forkSession(state.activeId)
              }}
            >
              分叉一份试试
            </button>
            <button
              className="retry"
              onClick={() => state.activeId && deleteSession(state.activeId)}
            >
              删除
            </button>
            <button className="x" onClick={() => setDismissWedged(true)} aria-label="知道了">
              ×
            </button>
          </div>
        )}
        {fatal && (
          <div className="banner bad">
            <span>{fatal}</span>
            {!state.connected && (
              <button className="retry" onClick={() => window.location.reload()}>
                重新连接
              </button>
            )}
            <button className="x" onClick={() => setFatal(null)} aria-label="关闭">
              ×
            </button>
          </div>
        )}
        {state.errors[state.activeId] && (
          <div className="banner bad">
            <span>{formatError(state.errors[state.activeId])}</span>
            <button className="x" onClick={() => dispatch({ type: 'clearError', id: state.activeId })} aria-label="关闭">
              ×
            </button>
          </div>
        )}
        {toast && (
          <div className="banner">
            <span>{toast}</span>
            <button className="x" onClick={() => setToast(null)} aria-label="关闭">
              ×
            </button>
          </div>
        )}

        <div className="stream-wrap">
        <div className="stream" ref={scrollRef} onScroll={onStreamScroll}>
          {messages.length === 0 && (
            <div className="welcome">
              <h1>Mimo Shell</h1>
              <p>
                这是 Mimo Shell —— MiMo Code 引擎的桌面外壳。后端跑的是 <code>mimo serve</code>，
                和你终端里那份是同一个引擎。
              </p>
              <p className="dim">新建一个会话，或从左侧挑一个历史会话开始。</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <MessageItem key={msg?.info?.id || `pending-${i}`} msg={msg} />
          ))}
          {busy && (
            <div className="working">
              <span className="spinner" /> 正在工作…
            </div>
          )}
          </div>
          <IndexRail messages={messages} streamRef={scrollRef} />
        </div>

        <SuggestionChips
          items={suggestions}
          onPick={pickSuggestion}
          disabled={busy}
        />

        <QueuePanel
          items={sendQueue}
          onEdit={editFromQueue}
          onDelete={removeFromQueue}
          onJump={jumpQueue}
          onClear={clearQueue}
        />

        <AskPanel
          items={asks}
          onChanged={() => {
            refreshAsks()
            setToast('已回复，Agent 继续')
          }}
          onError={(msg) => setToast(`回复失败：${msg}`)}
        />

        <Composer
          onSend={send}
          onAbort={abort}
          busy={busy}
          disabled={!state.activeId}
          sessionId={state.activeId || ''}
          modelOptions={modelOptions}
          agents={agents}
          model={model}
          agent={agent}
          harness={harness}
          onModelChange={setModel}
          onAgentChange={setAgent}
          onHarnessChange={setHarness}
        />
      </main>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        modelOptions={modelOptions}
        agentNames={agents.map((a) => a.name)}
        onSaved={(settings) => {
          setSavedDefaults(settings)
          setToast('设置已保存')
        }}
      />
    </div>
  )
}
