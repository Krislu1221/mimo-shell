import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import {
  SECTIONS,
  KNOWN_TOOLS,
  SHARE_OPTIONS,
  AUTOUPDATE_OPTIONS,
  PERMISSION_OPTIONS,
  LOG_LEVELS,
  THEME_OPTIONS,
  emptyDraft,
  normalizeSettings,
  draftsEqual,
} from '../lib/settingsModel.js'
import { getThemePref, setThemePref } from '../lib/theme.js'
import FeishuSection from './FeishuSection.jsx'

/* ------------------------------------------------------------------ bits */

export function Field({ label, hint, children, overridden }) {
  return (
    <label className="sf-field">
      <div className="sf-label-row">
        <span className="sf-label">{label}</span>
        {overridden && <span className="sf-badge">已覆盖</span>}
      </div>
      {hint && <div className="sf-hint">{hint}</div>}
      {children}
    </label>
  )
}

export function Select({ value, onChange, options, disabled }) {
  return (
    <select
      className="sf-select"
      value={String(value)}
      disabled={disabled}
      onChange={(e) => {
        const raw = e.target.value
        const hit = options.find((o) => String(o.value) === raw)
        onChange(hit ? hit.value : raw)
      }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function Toggle({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`sf-toggle ${checked ? 'on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <i />
    </button>
  )
}

function TextInput({ value, onChange, placeholder, disabled, mono }) {
  return (
    <input
      className={`sf-input ${mono ? 'mono' : ''}`}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function SectionTitle({ title, desc }) {
  return (
    <div className="sf-section-title">
      <h3>{title}</h3>
      {desc && <p>{desc}</p>}
    </div>
  )
}

/* -------------------------------------------------------------- sections */

function GeneralSection({ draft, set, modelOptions, agentNames, busy }) {
  const [theme, setThemeLocal] = useState(() => getThemePref())
  const modelOpts = [
    { value: '', label: '引擎默认' },
    ...modelOptions.map((m) => ({ value: m.key, label: m.label })),
  ]
  const agentOpts = [
    { value: '', label: '引擎默认（build）' },
    ...agentNames.map((n) => ({ value: n, label: n })),
  ]

  return (
    <>
      <SectionTitle
        title="通用"
        desc="外观、新会话默认模型与 Agent，以及分享 / 更新策略。"
      />

      <Field label="外观" hint="只影响本界面，立即生效，不写入引擎配置。">
        <Select
          value={theme}
          onChange={(v) => {
            setThemeLocal(setThemePref(v))
          }}
          options={THEME_OPTIONS}
          disabled={busy}
        />
      </Field>

      <Field label="默认模型" hint="留空则用引擎当前配置。新建会话时生效。">
        <Select
          value={draft.model}
          onChange={(v) => set({ model: v })}
          options={modelOpts}
          disabled={busy}
        />
      </Field>

      <Field label="小模型" hint="标题生成、压缩摘要等轻量任务。留空跟默认模型。">
        <TextInput
          value={draft.small_model}
          onChange={(v) => set({ small_model: v })}
          placeholder="provider/model 或留空"
          disabled={busy}
          mono
        />
      </Field>

      <Field label="视觉模型" hint="图像理解。留空跟默认模型。">
        <TextInput
          value={draft.vision_model}
          onChange={(v) => set({ vision_model: v })}
          placeholder="provider/model 或留空"
          disabled={busy}
          mono
        />
      </Field>

      <Field label="默认 Agent" hint="必须是 primary agent。留空用 build。">
        <Select
          value={draft.default_agent}
          onChange={(v) => set({ default_agent: v })}
          options={agentOpts}
          disabled={busy}
        />
      </Field>

      <Field label="会话分享">
        <Select
          value={draft.share}
          onChange={(v) => set({ share: v })}
          options={SHARE_OPTIONS}
          disabled={busy}
        />
      </Field>

      <Field label="自动更新">
        <Select
          value={draft.autoupdate}
          onChange={(v) => set({ autoupdate: v })}
          options={AUTOUPDATE_OPTIONS}
          disabled={busy}
        />
      </Field>

      <Field label="日志级别" hint="引擎进程日志。改完需重启引擎。">
        <Select
          value={draft.logLevel}
          onChange={(v) => set({ logLevel: v })}
          options={LOG_LEVELS.map((l) => ({ value: l, label: l }))}
          disabled={busy}
        />
      </Field>
    </>
  )
}

function SessionSection({ draft, set, busy }) {
  const c = draft.compaction
  const p = draft.permission

  return (
    <>
      <SectionTitle
        title="会话行为"
        desc="上下文压缩与权限默认。下一条消息即按新值执行。"
      />

      <h4 className="sf-group">上下文压缩</h4>

      <Field
        label="自动压缩"
        hint="上下文接近窗口上限时自动摘要压缩。关掉可能直接报上下文溢出。"
        overridden={c.auto === false}
      >
        <Toggle
          label="自动压缩"
          checked={c.auto}
          disabled={busy}
          onChange={(v) => set({ compaction: { ...c, auto: v } })}
        />
      </Field>

      <Field
        label="裁剪旧工具输出"
        hint="压缩时丢掉过老的工具输出，只保留文本轨迹。"
        overridden={c.prune === false}
      >
        <Toggle
          label="裁剪旧工具输出"
          checked={c.prune}
          disabled={busy}
          onChange={(v) => set({ compaction: { ...c, prune: v } })}
        />
      </Field>

      <Field
        label="保留最近轮数"
        hint="压缩时逐字保留的最近用户轮数。默认 2。"
        overridden={c.tail_turns !== 2}
      >
        <TextInput
          value={String(c.tail_turns)}
          onChange={(v) => set({ compaction: { ...c, tail_turns: v === '' ? 2 : Number(v) || 0 } })}
          placeholder="2"
          disabled={busy}
          mono
        />
      </Field>

      <Field
        label="压缩触发阈值"
        hint='比模型窗口更早触发。可填 token 数（300000）或简写（"300K"、"50%"）。留空用模型真实窗口。'
        overridden={Boolean(c.max_context)}
      >
        <TextInput
          value={c.max_context}
          onChange={(v) => set({ compaction: { ...c, max_context: v } })}
          placeholder="留空 = 模型窗口"
          disabled={busy}
          mono
        />
      </Field>

      <h4 className="sf-group">权限默认</h4>
      <p className="sf-group-desc">
        全局兜底。Agent 自带的 permission 规则优先级更高，这里改的是没有专门规则时的行为。
      </p>

      {['read', 'edit', 'bash'].map((k) => (
        <Field key={k} label={k === 'bash' ? '命令执行 (bash)' : k === 'edit' ? '写文件 (edit/write)' : '读文件 (read)'}>
          <Select
            value={p[k]}
            onChange={(v) => set({ permission: { ...p, [k]: v } })}
            options={PERMISSION_OPTIONS}
            disabled={busy}
          />
        </Field>
      ))}
    </>
  )
}

function ToolsSection({ draft, set, busy }) {
  const tools = draft.tools || {}
  const style = draft.tool?.invocation_style || 'json'

  const effective = (id) => (typeof tools[id] === 'boolean' ? tools[id] : true)

  return (
    <>
      <SectionTitle
        title="工具"
        desc="工具调用风格，以及按工具开关。未列出的工具保持引擎默认。"
      />

      <Field
        label="调用风格"
        hint="json 暴露完整 schema；shell 把参数收成一条 script。多数模型用 json。"
      >
        <Select
          value={style}
          disabled={busy}
          onChange={(v) => set({ tool: { ...draft.tool, invocation_style: v } })}
          options={[
            { value: 'json', label: 'JSON schema（默认）' },
            { value: 'shell', label: 'Shell 脚本' },
          ]}
        />
      </Field>

      <h4 className="sf-group">按工具开关</h4>
      <p className="sf-group-desc">关掉的工具不会出现在下一轮的工具列表里。</p>

      <div className="sf-tools">
        {KNOWN_TOOLS.map((t) => {
          const on = effective(t.id)
          const overridden = typeof tools[t.id] === 'boolean'
          return (
            <div key={t.id} className={`sf-tool-row ${on ? '' : 'off'}`}>
              <div className="sf-tool-info">
                <div className="sf-tool-name">
                  {t.label}
                  {overridden && <span className="sf-badge">已覆盖</span>}
                  {!on && <span className="sf-badge off">已关闭</span>}
                </div>
                <div className="sf-hint">{t.hint}</div>
              </div>
              <Toggle
                label={t.label}
                checked={on}
                disabled={busy}
                onChange={(v) => set({ tools: { ...tools, [t.id]: v } })}
              />
            </div>
          )
        })}
      </div>
    </>
  )
}

function EngineSection({ shell, configPath, onRestart, restartBusy, restartMsg }) {
  const rows = [
    { k: '引擎版本', v: shell?.version || '—', mono: true },
    { k: '工作目录', v: shell?.workdir || '—', mono: true },
    { k: '引擎地址', v: shell ? `${shell.engineHost}:${shell.enginePort}` : '—', mono: true },
    {
      k: '引擎归属',
      v: shell?.weStartedEngine ? '本应用拉起（可一键重启）' : '外部进程（本应用不会替你重启）',
    },
    { k: '标题栏', v: shell?.titlebar === 'default' ? '原生' : '一体（无顶栏）' },
    { k: '配置文件', v: configPath || '—', mono: true },
  ]

  return (
    <>
      <SectionTitle
        title="引擎"
        desc="当前运行状态，只读。引擎级改动（如日志级别）需重启后生效。"
      />

      <div className="sf-meta">
        {rows.map((r) => (
          <div key={r.k} className="sf-meta-row">
            <span className="sf-meta-k">{r.k}</span>
            <span className={`sf-meta-v ${r.mono ? 'mono' : ''}`} title={r.v}>
              {r.v}
            </span>
          </div>
        ))}
      </div>

      <div className="sf-restart">
        <button
          type="button"
          className="primary"
          disabled={restartBusy || !shell?.weStartedEngine}
          onClick={onRestart}
          title={
            shell?.weStartedEngine
              ? '停掉并重新拉起 mimo serve，使配置完整生效'
              : '引擎不是本应用启动的，无法从这里重启'
          }
        >
          {restartBusy ? '重启中…' : '重启引擎'}
        </button>
        <span className="sf-hint">
          {restartMsg ||
            (shell?.weStartedEngine
              ? '保存设置后点这里，让引擎级配置立即生效。'
              : '检测到 4096 端口上已有引擎，不是本应用启动的，所以这里不会替你重启。')}
        </span>
      </div>
    </>
  )
}

/* ----------------------------------------------------------------- panel */

export default function SettingsPanel({ open, onClose, modelOptions, agentNames, onSaved }) {
  const [section, setSection] = useState('general')
  const [draft, setDraft] = useState(emptyDraft)
  const [baseline, setBaseline] = useState(emptyDraft)
  const [shell, setShell] = useState(null)
  const [configPath, setConfigPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [restartBusy, setRestartBusy] = useState(false)
  const [restartMsg, setRestartMsg] = useState('')

  const dirty = useMemo(() => !draftsEqual(draft, baseline), [draft, baseline])

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const data = await api.getSettings()
      const next = normalizeSettings(data.settings)
      setDraft(next)
      setBaseline(next)
      setShell(data.shell || null)
      setConfigPath(data.path || '')
    } catch (e) {
      setError(`读取设置失败：${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setStatus('')
    setRestartMsg('')
    load()
  }, [open])

  // Cmd+, / menu event
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        if (open) onClose()
        else window.dispatchEvent(new CustomEvent('mimo:settings-open'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }))

  const save = async () => {
    setSaving(true)
    setError('')
    setStatus('')
    try {
      const res = await api.saveSettings(draft)
      const next = normalizeSettings(res.settings)
      setDraft(next)
      setBaseline(next)
      setStatus('已保存到 mimocode.jsonc')
      onSaved?.(next)
    } catch (e) {
      setError(`保存失败：${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  const restart = async () => {
    setRestartBusy(true)
    setRestartMsg('')
    setError('')
    try {
      const res = await api.restartEngine()
      if (res.ok) {
        setRestartMsg('引擎已重启')
        // Refresh shell meta (ownership / port) after the bounce.
        const data = await api.getSettings().catch(() => null)
        if (data?.shell) setShell(data.shell)
      } else {
        setRestartMsg('引擎不是本应用拉起的，未能重启。配置已写入磁盘。')
      }
    } catch (e) {
      setError(`重启失败：${e.message}`)
    } finally {
      setRestartBusy(false)
    }
  }

  if (!open) return null

  return (
    <div className="settings-overlay" onClick={onClose} role="presentation">
      <div
        className="settings-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="设置"
      >
        <aside className="settings-nav">
          <div className="settings-nav-title">设置</div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`settings-nav-item ${section === s.id ? 'active' : ''}`}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
          <div className="spacer" />
          <button type="button" className="settings-close-ghost" onClick={onClose}>
            关闭
          </button>
        </aside>

        <div className="settings-body">
          <header className="settings-header">
            <div className="settings-header-title">
              {SECTIONS.find((s) => s.id === section)?.label}
            </div>
            <button type="button" className="x" onClick={onClose} aria-label="关闭">
              ×
            </button>
          </header>

          <div className="settings-content">
            {loading && <div className="dim">加载中…</div>}
            {error && <div className="banner bad settings-banner">{error}</div>}
            {status && !error && <div className="settings-ok">{status}</div>}

            {!loading && section === 'general' && (
              <GeneralSection
                draft={draft}
                set={set}
                modelOptions={modelOptions}
                agentNames={agentNames}
                busy={saving}
              />
            )}
            {!loading && section === 'session' && (
              <SessionSection draft={draft} set={set} busy={saving} />
            )}
            {!loading && section === 'tools' && (
              <ToolsSection draft={draft} set={set} busy={saving} />
            )}
            {!loading && section === 'feishu' && (
              <FeishuSection draft={draft} set={set} busy={saving} />
            )}
            {!loading && section === 'engine' && (
              <EngineSection
                shell={shell}
                configPath={configPath}
                onRestart={restart}
                restartBusy={restartBusy}
                restartMsg={restartMsg}
              />
            )}
          </div>

          {section !== 'engine' && (
            // feishu is saved with the same footer as other sections
            true
          ) && (
            <footer className="settings-footer">
              <span className="sf-hint">
                {dirty ? '有未保存的修改' : '与磁盘配置一致'}
              </span>
              <div className="spacer" />
              <button
                type="button"
                className="ghost"
                disabled={!dirty || saving}
                onClick={() => {
                  setDraft(baseline)
                  setStatus('')
                  setError('')
                }}
              >
                放弃修改
              </button>
              <button type="button" className="primary" disabled={!dirty || saving} onClick={save}>
                {saving ? '保存中…' : '保存'}
              </button>
            </footer>
          )}
        </div>
      </div>
    </div>
  )
}
