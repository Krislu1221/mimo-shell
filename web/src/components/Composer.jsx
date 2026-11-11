import { useEffect, useRef, useState } from 'react'
import {
  MAX_IMAGES,
  filesToAttachments,
  pasteToAttachments,
  dropToAttachments,
} from '../lib/attachments.js'

/**
 * Flatten /config/providers into one selectable list.
 * MiMo returns providers[] each carrying a models{} map.
 */
export function buildModelOptions(providers) {
  const out = []
  for (const p of providers || []) {
    for (const m of Object.values(p.models || {})) {
      out.push({
        key: `${p.id}/${m.id}`,
        providerID: p.id,
        modelID: m.id,
        label: `${p.name || p.id} · ${m.name || m.id}`,
        provider: p.name || p.id,
      })
    }
  }
  return out
}

/**
 * Only primary, non-hidden agents belong in a session-mode picker.
 *
 * `GET /agent` returns three kinds mixed together:
 *   - mode=primary              → build / plan / compose  (user-switchable)
 *   - mode=subagent, hidden     → checkpoint-writer, compaction, distill,
 *                                  dream, summary, title   (engine internals)
 *   - mode=subagent, visible    → explore / general       (spawned *by* the
 *                                  primary agent, not a session mode)
 * Dumping all of them makes the picker look like a dumping ground.
 */
export function buildAgentOptions(agents) {
  return (agents || [])
    .filter((a) => a.mode === 'primary' && a.hidden !== true)
    .map((a) => ({
      name: a.name,
      description: a.description || '',
      deprecated: /\(deprecated\)/i.test(a.description || ''),
    }))
}

export default function Composer({
  onSend,
  onAbort,
  busy,
  disabled,
  sessionId,
  modelOptions,
  agents,
  model,
  agent,
  harness,
  onModelChange,
  onAgentChange,
  onHarnessChange,
}) {
  const [text, setText] = useState('')
  const [images, setImages] = useState([])
  const [attachErr, setAttachErr] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const areaRef = useRef(null)
  const fileRef = useRef(null)
  /** sessionId -> { text, images } — per-thread drafts, restored on return. */
  const draftsRef = useRef({})
  const sessionIdRef = useRef(sessionId)

  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 260) + 'px'
  }, [text])

  // Save the outgoing draft, restore the incoming one. Never leak text
  // across threads; coming back to a thread keeps what you typed there.
  useEffect(() => {
    const prev = sessionIdRef.current
    if (prev && prev !== sessionId) {
      draftsRef.current[prev] = { text, images }
    }
    sessionIdRef.current = sessionId
    const next = draftsRef.current[sessionId]
    setText(next?.text || '')
    setImages(next?.images || [])
    setAttachErr('')
    // text/images intentionally omitted: we only react to session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Edit-from-queue: App dispatches mimo:composer-set with draft content.
  useEffect(() => {
    const onSet = (e) => {
      setText(e.detail?.text || '')
      setImages(e.detail?.attachments || [])
      requestAnimationFrame(() => areaRef.current?.focus())
    }
    window.addEventListener('mimo:composer-set', onSet)
    return () => window.removeEventListener('mimo:composer-set', onSet)
  }, [])

  const canSend = Boolean(text.trim() || images.length)

  const addFiles = async (list) => {
    setAttachErr('')
    const { added, error } = await filesToAttachments(list, images)
    if (added.length) setImages((prev) => [...prev, ...added].slice(0, MAX_IMAGES))
    if (error) setAttachErr(error)
  }

  const onPaste = async (e) => {
    // Plain-text paste must still land in the textarea; only intercept when
    // the clipboard actually carries image files.
    const hasImage = Array.from(e.clipboardData?.items || []).some(
      (it) => it.kind === 'file' && it.type.startsWith('image/'),
    )
    if (!hasImage) return
    e.preventDefault()
    setAttachErr('')
    const { added, error } = await pasteToAttachments(e, images)
    if (added.length) setImages((prev) => [...prev, ...added].slice(0, MAX_IMAGES))
    if (error) setAttachErr(error)
  }

  const onDrop = async (e) => {
    e.preventDefault()
    setDragOver(false)
    if (disabled) return
    setAttachErr('')
    const { added, error } = await dropToAttachments(e, images)
    if (added.length) setImages((prev) => [...prev, ...added].slice(0, MAX_IMAGES))
    if (error) setAttachErr(error)
  }

  const removeImage = (id) => {
    setImages((prev) => prev.filter((x) => x.id !== id))
  }

  /**
   * Always hand the draft to App — App decides deliver vs queue.
   * Early-returning on `busy` left the "加入队列" button dead.
   */
  const submit = () => {
    if (disabled) return
    const value = text.trim()
    if (!value && !images.length) return
    onSend(value, images)
    setText('')
    setImages([])
    setAttachErr('')
  }

  const onKeyDown = (e) => {
    // Enter sends, Shift+Enter breaks the line — the convention every chat UI uses.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="composer">
      <div className="composer-inner">
        <div
          className={`composer-box ${dragOver ? 'drag-over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false)
          }}
          onDrop={onDrop}
        >
          <div className="controls">
            <select
              value={model?.key || ''}
              onChange={(e) => onModelChange(modelOptions.find((m) => m.key === e.target.value))}
              disabled={busy}
              title="模型"
            >
              <option value="">默认模型</option>
              {modelOptions.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>

            <select
              value={agent || ''}
              onChange={(e) => onAgentChange(e.target.value)}
              disabled={busy}
              title="Agent"
            >
              <option value="">默认 Agent</option>
              {agents.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                  {a.description ? ` — ${a.description}` : ''}
                  {a.deprecated ? '（已废弃）' : ''}
                </option>
              ))}
            </select>

            <select
              value={harness}
              onChange={(e) => onHarnessChange(e.target.value)}
              disabled={busy}
              title="Harness 模式：auto 保留模型自身的工具协议推断，default 强制使用原生工具 schema"
            >
              <option value="auto">Harness · 自动</option>
              <option value="default">Harness · 默认 schema</option>
              <option value="codex">Harness · Codex</option>
            </select>
          </div>

          {images.length > 0 && (
            <div className="attach-row" role="list" aria-label="待发送图片">
              {images.map((img) => (
                <div className="attach-thumb" key={img.id} role="listitem">
                  <img src={img.url} alt={img.filename} />
                  <button
                    type="button"
                    className="attach-x"
                    title="移除"
                    aria-label={`移除 ${img.filename}`}
                    onClick={() => removeImage(img.id)}
                    disabled={busy}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={areaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={
              images.length
                ? '补充说明图片，或直接发送…'
                : '给 MiMo Code 下达任务…（可粘贴 / 拖入图片）'
            }
            rows={1}
            disabled={disabled}
          />

          <div className="cbar">
            <button
              type="button"
              className="attach-btn"
              title={`添加图片（最多 ${MAX_IMAGES} 张）`}
              aria-label="添加图片"
              disabled={busy || disabled || images.length >= MAX_IMAGES}
              onClick={() => fileRef.current?.click()}
            >
              图片
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                addFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <span className={`kbd-hint ${attachErr ? 'err' : ''}`}>
              {attachErr || '↩ 发送 · ⇧↩ 换行 · ⌘V 粘贴图片'}
            </span>
            <span className="spacer" />
            {busy && (
              <button className="danger" onClick={onAbort}>
                停止
              </button>
            )}
            <button
              className="primary"
              onClick={submit}
              disabled={!canSend || disabled}
              title={busy ? '当前回合进行中，加入待发送队列' : '发送'}
            >
              {busy ? '加入队列' : '发送'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
