/**
 * Read/write ~/.config/mimocode/mimocode.jsonc — the engine's user config.
 *
 * The settings panel edits a small high-frequency subset of keys and merges
 * them into whatever is already in the file. Provider credentials stay out of
 * this path on purpose (keychain is the source of truth for Coding Plan keys).
 */

import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const DEFAULT_PATH = join(homedir(), '.config', 'mimocode', 'mimocode.jsonc')

export function configPath() {
  return process.env.MIMO_CONFIG_PATH || DEFAULT_PATH
}

/**
 * Strip // and /* *\/ comments without touching string literals.
 * JSONC may put a URL in a string; a naive regex would corrupt it.
 */
export function stripJsonComments(text) {
  let out = ''
  let i = 0
  const n = text.length
  let inStr = false
  let inLine = false
  let inBlock = false
  while (i < n) {
    const c = text[i]
    const next = text[i + 1]
    if (inLine) {
      if (c === '\n') {
        inLine = false
        out += c
      }
      i++
      continue
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false
        i += 2
        continue
      }
      i++
      continue
    }
    if (inStr) {
      out += c
      if (c === '\\' && i + 1 < n) {
        out += text[i + 1]
        i += 2
        continue
      }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      i++
      continue
    }
    if (c === '/' && next === '/') {
      inLine = true
      i += 2
      continue
    }
    if (c === '/' && next === '*') {
      inBlock = true
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

export async function readConfig() {
  const path = configPath()
  if (!existsSync(path)) return { path, config: {}, existed: false }
  const raw = await readFile(path, 'utf8')
  let config = {}
  try {
    config = JSON.parse(stripJsonComments(raw)) || {}
  } catch (e) {
    throw new Error(`配置文件无法解析（${path}）：${e.message}`)
  }
  return { path, config, existed: true }
}

/**
 * Write the full config object back. Timestamped backup first — the file also
 * holds provider API keys we never want to lose to a bad merge.
 */
export async function writeConfig(config) {
  const path = configPath()
  await mkdir(dirname(path), { recursive: true })
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    await copyFile(path, `${path}.bak-${stamp}`)
  }
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', 'utf8')
  return path
}

function actionOf(v) {
  return v === 'allow' || v === 'deny' || v === 'ask' ? v : undefined
}

/** Flatten the high-frequency subset the settings panel edits. */
export function projectSettings(config) {
  const str = (v) => (typeof v === 'string' ? v : '')
  return {
    model: str(config.model),
    small_model: str(config.small_model),
    vision_model: str(config.vision_model),
    default_agent: str(config.default_agent),
    share: config.share === 'auto' || config.share === 'disabled' ? config.share : 'manual',
    autoupdate:
      config.autoupdate === 'notify' ? 'notify' : config.autoupdate === false ? false : true,
    logLevel: ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(config.logLevel) ? config.logLevel : 'INFO',
    compaction: {
      auto: config.compaction?.auto !== false,
      prune: config.compaction?.prune !== false,
      tail_turns: Number.isFinite(config.compaction?.tail_turns) ? config.compaction.tail_turns : 2,
      max_context:
        config.compaction?.max_context == null ? '' : String(config.compaction.max_context),
    },
    permission: {
      read: actionOf(config.permission?.read) || 'ask',
      edit: actionOf(config.permission?.edit) || 'ask',
      bash: actionOf(config.permission?.bash) || 'ask',
    },
    tool: {
      invocation_style: config.tool?.invocation_style === 'shell' ? 'shell' : 'json',
    },
    tools: config.tools && typeof config.tools === 'object' && !Array.isArray(config.tools) ? config.tools : {},
    feishu: projectFeishu(config),
  }
}

/** Read Feishu MCP presence from config.mcp.lark (secret never leaves the server). */
export function projectFeishu(config) {
  const mcp = config?.mcp?.lark
  if (!mcp || typeof mcp !== 'object') {
    return { configured: false, appId: '', enabled: false, tools: 'preset.default', language: 'zh' }
  }
  const cmd = Array.isArray(mcp.command) ? mcp.command.join(' ') : ''
  const appIdMatch = cmd.match(/(?:^|\s)-a\s+(\S+)/)
  return {
    configured: Boolean(appIdMatch || cmd.includes('lark-mcp')),
    appId: appIdMatch ? appIdMatch[1] : '',
    enabled: mcp.enabled !== false,
    tools: /-t\s+(\S+)/.exec(cmd)?.[1] || 'preset.default',
    language: /-l\s+(\S+)/.exec(cmd)?.[1] || 'zh',
  }
}

/** Write / update mcp.lark for @larksuiteoapi/lark-mcp. */
export function applyFeishu(config, feishu) {
  const next = { ...config }
  const d = feishu
  if (!d || typeof d !== 'object') return next

  if (d.clear) {
    if (next.mcp) {
      const mcp = { ...next.mcp }
      delete mcp.lark
      if (Object.keys(mcp).length) next.mcp = mcp
      else delete next.mcp
    }
    return next
  }

  const appId = String(d.appId || '').trim()
  const appSecret = String(d.appSecret || '').trim()
  if (!appId) return next

  // Keep an existing secret when the form leaves it blank (edit without re-paste).
  let secret = appSecret
  if (!secret) {
    const prev = Array.isArray(next.mcp?.lark?.command) ? next.mcp.lark.command.join(' ') : ''
    secret = /(?:^|\s)-s\s+(\S+)/.exec(prev)?.[1] || ''
  }
  if (!secret) return next

  const tools = String(d.tools || 'preset.default').trim() || 'preset.default'
  const language = d.language === 'en' ? 'en' : 'zh'
  const command = [
    'npx', '-y', '@larksuiteoapi/lark-mcp@latest', 'mcp',
    '-a', appId,
    '-s', secret,
    '-t', tools,
    '-l', language,
  ]

  next.mcp = {
    ...(next.mcp || {}),
    lark: {
      type: 'local',
      enabled: d.enabled !== false,
      command,
      timeout: 15000,
    },
  }
  return next
}

/**
 * Apply a panel draft onto the live config.
 *
 * Model / agent: empty string clears the override (engine default wins).
 * Compaction / permission / tools: write the draft values as-is when present;
 * omit nested blocks the draft never sent so untouched groups stay intact.
 */
export function applyDraft(config, draft) {
  const next = { ...config }
  const d = draft || {}

  const setModel = (key) => {
    const v = d[key]
    if (v === undefined) return
    const s = String(v || '').trim()
    if (s) next[key] = s
    else delete next[key]
  }
  setModel('model')
  setModel('small_model')
  setModel('vision_model')
  setModel('default_agent')

  if (d.share !== undefined) next.share = d.share
  if (d.autoupdate !== undefined) {
    if (d.autoupdate === true) delete next.autoupdate
    else next.autoupdate = d.autoupdate
  }
  if (d.logLevel !== undefined) next.logLevel = d.logLevel

  if (d.compaction && typeof d.compaction === 'object') {
    const c = d.compaction
    const block = { ...(next.compaction || {}) }
    if (c.auto !== undefined) {
      if (c.auto) delete block.auto
      else block.auto = false
    }
    if (c.prune !== undefined) {
      if (c.prune) delete block.prune
      else block.prune = false
    }
    if (c.tail_turns !== undefined) {
      const n = Number(c.tail_turns)
      if (Number.isFinite(n) && n !== 2) block.tail_turns = n
      else delete block.tail_turns
    }
    if (c.max_context !== undefined) {
      const s = String(c.max_context || '').trim()
      if (s) block.max_context = /^\d+$/.test(s) ? Number(s) : s
      else delete block.max_context
    }
    if (Object.keys(block).length) next.compaction = block
    else delete next.compaction
  }

  if (d.permission && typeof d.permission === 'object') {
    const p = { ...(next.permission && typeof next.permission === 'object' ? next.permission : {}) }
    for (const k of ['read', 'edit', 'bash']) {
      const v = d.permission[k]
      if (v === 'allow' || v === 'deny' || v === 'ask') p[k] = v
      else delete p[k]
    }
    if (Object.keys(p).length) next.permission = p
    else delete next.permission
  }

  if (d.tool && typeof d.tool === 'object' && d.tool.invocation_style) {
    if (d.tool.invocation_style === 'json') {
      if (next.tool) {
        const t = { ...next.tool }
        delete t.invocation_style
        if (Object.keys(t).length) next.tool = t
        else delete next.tool
      }
    } else {
      next.tool = { ...(next.tool || {}), invocation_style: d.tool.invocation_style }
    }
  }

  if (d.tools && typeof d.tools === 'object') {
    const t = { ...(next.tools || {}) }
    for (const [k, v] of Object.entries(d.tools)) {
      if (typeof v === 'boolean') t[k] = v
    }
    if (Object.keys(t).length) next.tools = t
    else delete next.tools
  }

  if (d.feishu && typeof d.feishu === 'object') {
    return applyFeishu(next, d.feishu)
  }

  return next
}
