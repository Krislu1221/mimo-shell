import { useState } from 'react'
import { Field, Select, SectionTitle } from './SettingsPanel.jsx'

const TOOL_PRESETS = [
  { value: 'preset.default', label: '默认工具集', hint: '消息、通讯录等常用 OpenAPI' },
  { value: 'preset.im', label: '即时消息', hint: '偏重发消息 / 群 / 会话' },
  { value: 'preset.doc', label: '文档知识库', hint: '偏重云文档 / 知识库' },
]

/**
 * Feishu / Lark via @larksuiteoapi/lark-mcp.
 * Secret is stored in mimocode.jsonc mcp.lark.command (local machine only).
 */
export default function FeishuSection({ draft, set, busy }) {
  const f = draft.feishu || {}
  const [reveal, setReveal] = useState(false)

  return (
    <>
      <SectionTitle
        title="飞书"
        desc="通过官方向 MCP（lark-mcp）连接飞书。保存后写入引擎 mcp.lark，重启引擎即可使用。"
      />

      {f.configured && (
        <div className="settings-ok">
          已配置飞书 MCP{f.appId ? `（App ID ${f.appId.slice(0, 6)}…）` : ''}
          {f.enabled === false ? ' · 已停用' : ''}
        </div>
      )}

      <Field label="App ID" hint="飞书开放平台 → 企业自建应用 → 凭证与基础信息">
        <input
          className="sf-input mono"
          value={f.appId || ''}
          disabled={busy}
          placeholder="cli_xxxxxxxx"
          onChange={(e) => set({ feishu: { ...f, appId: e.target.value } })}
        />
      </Field>

      <Field
        label="App Secret"
        hint={
          f.configured && !f.appSecret
            ? '已保存过 Secret。留空表示保持不变；填入新值则覆盖。'
            : '只保存在本机 mimocode.jsonc 的 mcp 配置里，请勿把该文件同步到公开仓库。'
        }
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="sf-input mono"
            type={reveal ? 'text' : 'password'}
            value={f.appSecret || ''}
            disabled={busy}
            placeholder={f.configured ? '••••••••（留空不改）' : '粘贴 App Secret'}
            autoComplete="off"
            onChange={(e) => set({ feishu: { ...f, appSecret: e.target.value } })}
          />
          <button
            type="button"
            className="ghost"
            style={{ padding: '0 12px', flex: '0 0 auto' }}
            disabled={busy}
            onClick={() => setReveal((v) => !v)}
          >
            {reveal ? '隐藏' : '显示'}
          </button>
        </div>
      </Field>

      <Field label="工具预设" hint="决定 lark-mcp 默认暴露哪些飞书 API 工具">
        <Select
          value={f.tools || 'preset.default'}
          disabled={busy}
          options={TOOL_PRESETS}
          onChange={(v) => set({ feishu: { ...f, tools: v } })}
        />
      </Field>

      <Field label="工具语言">
        <Select
          value={f.language === 'en' ? 'en' : 'zh'}
          disabled={busy}
          options={[
            { value: 'zh', label: '中文' },
            { value: 'en', label: 'English' },
          ]}
          onChange={(v) => set({ feishu: { ...f, language: v } })}
        />
      </Field>

      <Field label="启用" hint="关闭则保留配置但不让引擎加载该 MCP">
        <ToggleLike
          checked={f.enabled !== false}
          disabled={busy}
          onChange={(v) => set({ feishu: { ...f, enabled: v } })}
        />
      </Field>

      <div className="sf-group-desc" style={{ marginTop: 8 }}>
        保存后到「引擎」区点重启引擎。之后在对话里可直接让 Agent 调飞书工具（发消息、查文档等，取决于你在开放平台勾选的权限）。
      </div>

      {f.configured && (
        <div style={{ marginTop: 4 }}>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => set({ feishu: { clear: true, configured: false, appId: '', appSecret: '' } })}
          >
            清除飞书配置
          </button>
        </div>
      )}
    </>
  )
}

function ToggleLike({ checked, disabled, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`sf-toggle ${checked ? 'on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <i />
    </button>
  )
}
