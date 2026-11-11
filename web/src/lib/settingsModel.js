/**
 * Field definitions for the four settings sections.
 *
 * Defaults mirror `mimo`'s config schema so an empty mimocode.jsonc shows the
 * same values the engine would actually use.
 */

export const SECTIONS = [
  { id: 'general', label: '通用' },
  { id: 'session', label: '会话行为' },
  { id: 'tools', label: '工具' },
  { id: 'feishu', label: '飞书' },
  { id: 'engine', label: '引擎' },
]

/** Tools the primary agents actually ship with (from `mimo debug agent build`). */
export const KNOWN_TOOLS = [
  { id: 'bash', label: 'bash', hint: '在 shell 里执行命令' },
  { id: 'read', label: 'read', hint: '读取文件' },
  { id: 'edit', label: 'edit', hint: '编辑文件' },
  { id: 'write', label: 'write', hint: '写入 / 创建文件' },
  { id: 'glob', label: 'glob', hint: '按路径模式找文件' },
  { id: 'grep', label: 'grep', hint: '按内容搜索' },
  { id: 'webfetch', label: 'webfetch', hint: '抓取网页' },
  { id: 'task', label: 'task', hint: '拆分并跟踪多步任务' },
  { id: 'actor', label: 'actor', hint: '派生子 agent' },
  { id: 'skill', label: 'skill', hint: '加载技能' },
  { id: 'skill_search', label: 'skill_search', hint: '搜索技能' },
  { id: 'memory', label: 'memory', hint: '检索持久记忆' },
  { id: 'history', label: 'history', hint: '检索历史轨迹' },
  { id: 'cron', label: 'cron', hint: '定时任务' },
  { id: 'question', label: 'question', hint: '向用户提问' },
  { id: 'notebook_edit', label: 'notebook_edit', hint: '编辑 Jupyter notebook' },
]

export const SHARE_OPTIONS = [
  { value: 'manual', label: '手动（默认）', hint: '只有你显式分享时才会生成链接' },
  { value: 'auto', label: '自动', hint: '新会话自动可分享' },
  { value: 'disabled', label: '禁用', hint: '完全关闭分享' },
]

export const AUTOUPDATE_OPTIONS = [
  { value: true, label: '自动更新', hint: '后台静默升级' },
  { value: 'notify', label: '仅提醒', hint: '有新版本时提示，不自动装' },
  { value: false, label: '关闭', hint: '永不检查更新' },
]

export const PERMISSION_OPTIONS = [
  { value: 'ask', label: '询问', hint: '每次弹窗让你确认' },
  { value: 'allow', label: '允许', hint: '不询问，直接执行' },
  { value: 'deny', label: '拒绝', hint: '直接禁止该类操作' },
]

export const LOG_LEVELS = ['INFO', 'DEBUG', 'WARN', 'ERROR']

export const THEME_OPTIONS = [
  { value: 'system', label: '跟随系统', hint: '随 macOS 外观自动切浅色 / 深色' },
  { value: 'light', label: '浅色（纸面）', hint: '始终使用暖纸浅色主题' },
  { value: 'dark', label: '深色（墨纸）', hint: '始终使用暖墨深色主题' },
]

export const emptyDraft = () => ({
  model: '',
  small_model: '',
  vision_model: '',
  default_agent: '',
  share: 'manual',
  autoupdate: true,
  logLevel: 'INFO',
  compaction: {
    auto: true,
    prune: true,
    tail_turns: 2,
    max_context: '',
  },
  permission: {
    read: 'ask',
    edit: 'ask',
    bash: 'ask',
  },
  tool: {
    invocation_style: 'json',
  },
  tools: {},
  feishu: {
    appId: '',
    appSecret: '',
    enabled: true,
    tools: 'preset.default',
    language: 'zh',
    configured: false,
  },
})

/** Normalize a server payload into the draft shape (fills missing keys). */
export function normalizeSettings(s) {
  const base = emptyDraft()
  if (!s || typeof s !== 'object') return base
  return {
    ...base,
    ...s,
    compaction: { ...base.compaction, ...(s.compaction || {}) },
    permission: { ...base.permission, ...(s.permission || {}) },
    tool: { ...base.tool, ...(s.tool || {}) },
    tools: { ...(s.tools || {}) },
    feishu: { ...base.feishu, ...(s.feishu || {}), appSecret: '' },
  }
}

/** Shallow field equal-check used to light the footer save button. */
export function draftsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}
