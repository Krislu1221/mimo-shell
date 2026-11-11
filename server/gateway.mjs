/**
 * The HTTP gateway, as a reusable factory.
 *
 * Two consumers:
 *   - `server/index.mjs` (CLI): starts it on a port and blocks.
 *   - The Electron main process: runs it in-process, so the packaged app needs
 *     no Node runtime and no separate server process.
 *
 * Zero runtime dependencies on purpose — node built-ins only.
 */

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname, resolve, normalize } from 'node:path'
import { readConfig, writeConfig, projectSettings, applyDraft, configPath } from './settings.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
])

/**
 * @param {object} options
 * @param {string} options.upstream  mimo serve origin, e.g. http://127.0.0.1:4096
 * @param {string} options.root      directory containing the built SPA
 * @param {number} [options.port]    0 = OS-assigned
 * @param {string} [options.host]    default 127.0.0.1
 * @param {string} [options.token]   optional shared-secret gate
 * @param {() => Promise<object>|object} [options.meta]  shell meta for GET /api/settings
 * @param {() => Promise<boolean>|boolean} [options.restartEngine]  POST /api/shell/restart-engine
 * @returns {Promise<{server: import('node:http').Server, port: number, url: string, close: () => Promise<void>}>}
 */

/* ------------------------------------------------------------------ *
 * Next-step suggestions.
 *
 * The engine exposes POST /session/:id/predict, which returns ONE string and
 * an empty string when the prediction is "disabled or unavailable" — in
 * practice it comes back empty often enough that the UI would fall back to
 * generic filler ("继续", "换个思路再试一次"), which is not worth showing.
 *
 * So the chain is: engine prediction first (it is free and contextual), and
 * when it is empty, ask the model directly for 2-3 complete next steps. The
 * model call goes straight to the provider, never through the session, so it
 * does not show up in the transcript and does not touch the session's state.
 *
 * The API key comes from the engine's own provider config, which resolves
 * "{env:VAR}" placeholders for us.
 * ------------------------------------------------------------------ */

const SUGGEST_PROVIDER = process.env.SUGGEST_PROVIDER || 'mimo-coding-plan'
const SUGGEST_MODEL = process.env.SUGGEST_MODEL || 'mimo-v2.6-flash'

async function upstreamJson(upstream, path, init) {
  const res = await fetch(new URL(path, upstream), {
    ...init,
    signal: AbortSignal.timeout(init?.timeout || 15000),
  })
  if (!res.ok) throw new Error(`upstream ${path} -> ${res.status}`)
  return res.json()
}

const SUGGEST_SYSTEM = `你是一个编程助手的「下一步建议」组件。
阅读下面的对话，推测用户接下来最可能要做的 2 到 3 件事。
每条建议必须是一条**可以直接发出去的完整指令**，说清楚要做什么、涉及什么，
不要用「那个」「它」「上面说的」这类指代，也不要写成「继续」「好的」这种空话。
只输出 JSON 字符串数组，不要任何解释文字或代码块标记：
["...", "..."]`

function transcriptOf(messages) {
  const out = []
  for (const m of (messages || []).slice(-8)) {
    const role = m.info?.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = (m.parts || [])
      .filter((p) => p.type === 'text' && p.text && p.text.trim())
      .map((p) => p.text.trim())
      .join('\n')
    if (text) out.push({ role, content: text.slice(0, 600) })
  }
  return out
}

function parseStringArray(raw) {
  const text = String(raw || '').trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('[')
  const end = body.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let arr
  try {
    arr = JSON.parse(body.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  return arr
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim())
    .filter((x) => x.length >= 3 && x.length <= 120)
    .slice(0, 3)
}

async function handleSuggest(req, res, upstream) {
  let sessionId
  try {
    const chunks = []
    for await (const c of req) chunks.push(c)
    sessionId = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').sessionId
  } catch {
    return json(res, 400, { error: 'bad_request' })
  }
  if (!sessionId) return json(res, 400, { error: 'sessionId required' })

  const out = []
  try {
    /*
     * The engine persists a turn's messages asynchronously, and the SSE events
     * that put them on screen arrive first. Reading the message log too early
     * yields an empty or one-sided transcript, and the prediction comes back
     * blank. So: try, and if we got nothing, wait for the log to catch up and
     * try once more.
     */
    await collectSuggestions(upstream, sessionId, out)
    json(res, 200, { suggestions: out.slice(0, 3) })
  } catch (e) {
    // Suggestions are a nicety; never let them break the app.
    json(res, 200, { suggestions: out.slice(0, 3), error: String(e.message || e) })
  }
}

async function collectSuggestions(upstream, sessionId, out) {
  {
    /*
     * The engine's own POST /session/:id/predict is a perfectly good
     * prediction, but it is itself a model call (5-15s measured) and it
     * returns a single string. Asking the model directly returns all three
     * items in one call, so the engine's version is kept only as a fallback
     * for when the direct call fails — running both cost ~20s.
     */
    const enginePrediction = async () => {
      try {
        const r = await upstreamJson(upstream, `/session/${encodeURIComponent(sessionId)}/predict`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          timeout: 20000,
        })
        return String(r?.prediction || '').trim()
      } catch {
        return ''
      }
    }

    // 2) fall back to asking the model directly.
    //
    // The engine persists a turn's messages asynchronously and the SSE events
    // that put them on screen arrive first, so reading the log too early
    // yields a one-sided transcript and a blank prediction. Wait for the log
    // to catch up *before* spending a model call on it.
    if (out.length < 2) {
      let transcript = []
      for (let i = 0; i < 3; i++) {
        const messages = await upstreamJson(upstream, `/session/${encodeURIComponent(sessionId)}/message`)
        transcript = transcriptOf(messages)
        if (transcript.length >= 2) break
        if (i < 2) await new Promise((r) => setTimeout(r, 900))
      }
      if (transcript.length) {
        const providers = await upstreamJson(upstream, '/config/providers')
        const provider = (providers.providers || []).find((p) => p.id === SUGGEST_PROVIDER)
        const options = provider?.options || {}
        const baseURL = options.baseURL
        const apiKey = typeof options.apiKey === 'string' ? options.apiKey : ''
        const model =
          provider?.models?.[SUGGEST_MODEL] ? SUGGEST_MODEL : Object.keys(provider?.models || {})[0]
        if (baseURL && apiKey && model) {
          const call = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model,
              messages: [{ role: 'system', content: SUGGEST_SYSTEM }, ...transcript],
              max_tokens: 220,
              temperature: 0.3,
              // MiMo models emit a reasoning trace by default; for a short list
              // of next steps that is pure latency. Measured on the Coding Plan
              // endpoint: baseline 5.4s with 84 reasoning tokens, this 2.6s with
              // none. `reasoning_effort` and `thinking.type` also silence it but
              // measured far slower, so this is the one to use.
              chat_template_kwargs: { enable_thinking: false },
            }),
            signal: AbortSignal.timeout(30000),
          })
          if (call.ok) {
            const data = await call.json()
            for (const s of parseStringArray(data?.choices?.[0]?.message?.content)) {
              if (!out.includes(s)) out.push(s)
            }
          }
          // Fall back to the engine's prediction only if the model gave us nothing.
          if (!out.length) {
            const engine = await enginePrediction()
            if (engine) out.push(engine)
          }
        }
      }
    }
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
}

export async function startGateway({ upstream, root, port = 0, host = '127.0.0.1', token = '', meta = null, restartEngine = null }) {
  const UPSTREAM = new URL(upstream)
  const ROOT = resolve(root)

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': MIME['.json'] })
    res.end(JSON.stringify(body))
  }

  /** Local settings API — not forwarded to mimo serve. */
  const handleLocal = async (req, res) => {
    if (req.url === '/api/settings' && req.method === 'GET') {
      try {
        const { path, config } = await readConfig()
        const shell = meta ? await meta() : {}
        return json(res, 200, {
          path,
          settings: projectSettings(config),
          shell,
        })
      } catch (e) {
        return json(res, 500, { error: 'settings_read_failed', message: e.message })
      }
    }

    if (req.url === '/api/settings' && req.method === 'PUT') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      await new Promise((ok) => req.on('end', ok))
      try {
        const draft = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        const { config } = await readConfig()
        const next = applyDraft(config, draft)
        const path = await writeConfig(next)
        return json(res, 200, {
          ok: true,
          path,
          settings: projectSettings(next),
        })
      } catch (e) {
        return json(res, 500, { error: 'settings_write_failed', message: e.message })
      }
    }

    if (req.url === '/api/shell/restart-engine' && req.method === 'POST') {
      if (!restartEngine) return json(res, 501, { error: 'not_supported' })
      try {
        const ok = await restartEngine()
        return json(res, ok === false ? 500 : 200, { ok: ok !== false })
      } catch (e) {
        return json(res, 500, { error: 'restart_failed', message: e.message })
      }
    }

    if (req.url === '/api/shell/config-path' && req.method === 'GET') {
      return json(res, 200, { path: configPath() })
    }

    return null
  }

  const forwardHeaders = (req) => {
    const out = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v
    }
    out.connection = 'keep-alive'
    return out
  }

  /**
   * Reverse-proxy one request to the MiMo server.
   *
   * Bodies are piped both ways with no buffering of our own, so MiMo's SSE
   * frames and the whitespace heartbeats on POST /session/:id/message pass
   * through as they arrive.
   */
  const proxy = (req, res) => {
    const path = req.url.replace(/^\/api/, '') || '/'
    const upstreamReq = http.request(
      {
        protocol: UPSTREAM.protocol,
        hostname: UPSTREAM.hostname,
        port: UPSTREAM.port || 80,
        path,
        method: req.method,
        headers: forwardHeaders(req),
      },
      (upstreamRes) => {
        // The browser may already be gone (window closed, page reloaded).
        // Drain the response so the turn can finish upstream instead of
        // leaving the connection half-open.
        if (res.destroyed || res.writableEnded) {
          upstreamRes.resume()
          return
        }
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
        upstreamRes.pipe(res)
        upstreamRes.on('error', () => res.destroy())
      },
    )
    upstreamReq.on('error', (err) => {
      if (res.headersSent) return res.destroy()
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        error: 'upstream_unreachable',
        message: `无法连接 MiMo 服务 ${UPSTREAM.origin}：${err.message}`,
        hint: '请确认 `mimo serve --port ' + (UPSTREAM.port || 80) + '` 正在运行。',
      }))
    })
    /*
     * Do NOT destroy the upstream request when the browser goes away.
     *
     * MiMo Code deliberately keeps an admitted turn alive in its runner scope
     * ("Disconnect only detaches this stream ... do NOT session.cancel").
     * Destroying the socket here cancelled it, so closing or reloading the
     * window mid-turn produced a MessageAbortedError with nothing on screen.
     *
     * Buffer the (small JSON) body, send it, then let the upstream finish on
     * its own regardless of what the client does.
     */
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => upstreamReq.end(Buffer.concat(chunks)))
    req.on('error', () => {})
    req.on('aborted', () => {})
    res.on('error', () => {})
  }

  /** Resolve a request path inside root, refusing traversal. */
  const safeAsset = (urlPath) => {
    const clean = decodeURIComponent(urlPath.split('?')[0])
    const rel = normalize(clean).replace(/^(\.\.[/\\])+/, '')
    const abs = resolve(ROOT, `.${rel.startsWith('/') ? rel : '/' + rel}`)
    return abs.startsWith(ROOT) ? abs : null
  }

  const serveStatic = async (req, res) => {
    const abs = safeAsset(req.url)
    if (abs) {
      try {
        const body = await readFile(abs)
        res.writeHead(200, {
          'content-type': MIME[extname(abs)] || 'application/octet-stream',
          'cache-control': /\/assets\//.test(abs)
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        })
        return res.end(body)
      } catch {
        /* fall through to the SPA shell */
      }
    }
    try {
      const shell = await readFile(join(ROOT, 'index.html'))
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' })
      res.end(shell)
    } catch {
      res.writeHead(500, { 'content-type': MIME['.html'] })
      res.end('<h1>前端未构建</h1><p>先运行 <code>npm run build</code>。</p>')
    }
  }

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')

    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': MIME['.json'] })
      return res.end(JSON.stringify({ ok: true, upstream: UPSTREAM.origin }))
    }

    if (token) {
      const presented =
        req.headers['x-mimo-token'] || new URL(req.url, 'http://x').searchParams.get('token')
      if (presented !== token) {
        res.writeHead(401, { 'content-type': MIME['.json'] })
        return res.end(JSON.stringify({ error: 'unauthorized' }))
      }
    }

    // Settings / shell endpoints are owned by this gateway, never proxied.
    if (req.url === '/api/settings' || req.url.startsWith('/api/shell/')) {
      handleLocal(req, res).catch((e) => {
        if (!res.headersSent) json(res, 500, { error: 'local_failed', message: e.message })
      })
      return
    }

    if (req.url === '/api/suggest' && req.method === 'POST') return handleSuggest(req, res, UPSTREAM)
    if (req.url === '/api' || req.url.startsWith('/api/')) return proxy(req, res)
    return serveStatic(req, res)
  })

  // SSE connections are long-lived; the defaults would cut them off mid-answer.
  server.keepAliveTimeout = 0
  server.headersTimeout = 0
  server.requestTimeout = 0

  await new Promise((ok, err) => {
    server.once('error', err)
    server.listen(port, host, ok)
  })

  const actualPort = server.address().port
  return {
    server,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: () => new Promise((ok) => server.close(() => ok())),
  }
}
