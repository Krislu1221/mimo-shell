/**
 * Feishu bot bridge — Feishu DM → mimo serve → Feishu reply.
 *
 * Uses Feishu long-connection (WebSocket) so the desktop app needs no public
 * webhook URL. Credentials come from mcp.lark in mimocode.jsonc (written by
 * the settings panel). Model auth is whatever mimo serve already has.
 *
 * Started by the Electron main process when Feishu is configured & enabled.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(HERE, '..')
const require = createRequire(join(APP_ROOT, 'vendor', 'feishu', 'package.json'))

function log(...a) {
  console.log('[feishu]', ...a)
}

function readFeishuFromConfig(configPath) {
  // Light parse: avoid importing settings.mjs's JSONC into this child.
  // Parent already validated; we only need appId/appSecret.
  try {
    // Dynamic import of the shared parser keeps one source of truth.
    return import('./settings.mjs').then(async ({ readConfig }) => {
      const { config } = await readConfig()
      const cmd = Array.isArray(config?.mcp?.lark?.command) ? config.mcp.lark.command : []
      const idxA = cmd.indexOf('-a')
      const idxS = cmd.indexOf('-s')
      return {
        appId: idxA >= 0 ? cmd[idxA + 1] : '',
        appSecret: idxS >= 0 ? cmd[idxS + 1] : '',
        enabled: config?.mcp?.lark?.enabled !== false,
      }
    })
  } catch (e) {
    return Promise.resolve({ appId: '', appSecret: '', enabled: false, error: String(e) })
  }
}

function upstreamPort() {
  return Number(process.env.MIMO_PORT || 4096)
}

function httpJson(method, path, body, timeout = 60000) {
  const port = upstreamPort()
  const data = body ? JSON.stringify(body) : null
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'content-type': 'application/json',
          ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
        },
        timeout,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode >= 400) {
            reject(new Error(`${method} ${path} → ${res.statusCode} ${text.slice(0, 200)}`))
            return
          }
          try {
            resolve(text ? JSON.parse(text) : null)
          } catch {
            resolve(text)
          }
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('timeout'))
    })
    if (data) req.write(data)
    req.end()
  })
}

/** Poll until the assistant reply for `userMsgId` is ready. */
async function waitAssistantText(sessionId, userMsgId, budgetMs = 90000) {
  const start = Date.now()
  let last = ''
  while (Date.now() - start < budgetMs) {
    await new Promise((r) => setTimeout(r, 1200))
    let msgs = []
    try {
      msgs = await httpJson('GET', `/session/${sessionId}/message`, null, 15000)
    } catch {
      continue
    }
    const list = Array.isArray(msgs) ? msgs : []
    // Find assistant messages after the user message
    let seenUser = !userMsgId
    let acc = ''
    let busy = false
    for (const m of list) {
      const role = m.info?.role
      if (role === 'user' && m.info?.id === userMsgId) seenUser = true
      if (!seenUser) continue
      if (role === 'assistant') {
        const parts = Object.values(m.parts || {}).filter((p) => p.type === 'text')
        const text = parts.map((p) => p.text || '').join('').trim()
        if (text) acc = text
        if (!m.info?.time?.completed) busy = true
      }
    }
    if (acc && acc !== last) last = acc
    if (last && !busy) return last
  }
  return last || '（超时：引擎没有返回文本）'
}

async function ensureSession(chatId, titleMap) {
  const existing = titleMap.get(chatId)
  if (existing) {
    try {
      await httpJson('GET', `/session/${existing}`)
      return existing
    } catch {
      /* fall through */
    }
  }
  const s = await httpJson('POST', '/session', { title: `飞书 ${chatId.slice(-6)}` })
  const id = s.id || s.sessionID
  titleMap.set(chatId, id)
  return id
}

/**
 * Child-process entry: `node feishu-bridge.mjs`
 * Env: MIMO_PORT, optional FEISHU_APP_ID / FEISHU_APP_SECRET override.
 */
export async function startFeishuBridge({ configPath } = {}) {
  const cred = await readFeishuFromConfig(configPath)
  const appId = process.env.FEISHU_APP_ID || cred.appId
  const appSecret = process.env.FEISHU_APP_SECRET || cred.appSecret
  if (!cred.enabled || !appId || !appSecret) {
    log('未启用或缺少凭证，跳过')
    return { ok: false, reason: 'not_configured' }
  }

  let Lark
  try {
    Lark = require('@larksuiteoapi/node-sdk')
  } catch (e) {
    log('找不到 vendor/feishu SDK:', e.message)
    return { ok: false, reason: 'sdk_missing' }
  }

  const { WSClient, EventDispatcher, Client } = Lark
  const client = new Client({ appId, appSecret })
  const chatSessions = new Map()

  const dispatcher = new EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        const msg = data?.message
        if (!msg || msg.message_type !== 'text') return
        const raw = msg.content
        let text = ''
        try {
          text = JSON.parse(raw || '{}').text || ''
        } catch {
          text = String(raw || '')
        }
        text = String(text || '').trim()
        if (!text) return

        const chatId = msg.chat_id || data?.chat?.chat_id || 'unknown'
        const sessionId = await ensureSession(chatId, chatSessions)
        log('收到', chatId.slice(-6), JSON.stringify(text).slice(0, 80))

        // Fire the turn; do not wait for HTTP completion (engine holds it open).
        httpJson('POST', `/session/${sessionId}/message`, {
          parts: [{ type: 'text', text }],
          harness: 'auto',
        }).catch((e) => log('prompt 失败', e.message))

        // Reply later when assistant finishes.
        waitAssistantText(sessionId).then(async (reply) => {
          try {
            await client.im.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'text',
                content: JSON.stringify({ text: reply.slice(0, 4000) }),
              },
            })
            log('已回复', chatId.slice(-6))
          } catch (e) {
            log('回复失败', e.message)
          }
        })
      } catch (e) {
        log('事件处理失败', e.message)
      }
    },
  })

  const ws = new WSClient({ appId, appSecret, loggerLevel: 'warn' })
  void client
  await ws.start({ eventDispatcher: dispatcher })
  log('长连接已建立，可在飞书里给机器人发消息')
  return { ok: true }
}

// Allow `node server/feishu-bridge.mjs` for manual run.
if (process.argv[1] && process.argv[1].endsWith('feishu-bridge.mjs')) {
  startFeishuBridge().then((r) => log('result', r))
}
