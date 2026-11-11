/**
 * Minimal Markdown renderer.
 *
 * Escape-first: the source text is HTML-escaped before any markup is applied,
 * so a model response containing `<script>` renders as text and nothing else.
 * Deliberately not a full CommonMark implementation — it covers what coding
 * assistants actually emit (fences, inline code, emphasis, lists, headings,
 * blockquotes, rules) and degrades to plain text otherwise.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPES[c])
}

function inline(s) {
  return s
    .replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
}

/**
 * @param {string} src raw markdown
 * @returns {string} HTML safe to inject
 */
export function renderMarkdown(src) {
  if (!src) return ''
  const lines = String(src).replace(/\r\n/g, '\n').split('\n')
  const out = []
  let fence = null
  let list = null
  let para = []

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(escapeHtml(para.join('\n'))).replace(/\n/g, '<br/>')}</p>`)
      para = []
    }
  }
  const flushList = () => {
    if (list) {
      out.push(`<ul>${list.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`)
      list = null
    }
  }

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*```(\w*)\s*$/)

    if (fence) {
      if (fenceMatch) {
        out.push(
          `<pre class="code"><code data-lang="${escapeHtml(fence)}">${escapeHtml(fenceBuf.join('\n'))}</code></pre>`,
        )
        fence = null
        fenceBuf = []
      } else {
        fenceBuf.push(line)
      }
      continue
    }

    if (fenceMatch) {
      flushPara()
      flushList()
      fence = fenceMatch[1] || 'text'
      var fenceBuf = []
      continue
    }

    if (!line.trim()) {
      flushPara()
      flushList()
      continue
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      flushPara()
      flushList()
      const level = heading[1].length + 2
      out.push(`<h${level}>${inline(escapeHtml(heading[2]))}</h${level}>`)
      continue
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      flushPara()
      flushList()
      out.push('<hr/>')
      continue
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/)
    if (bullet) {
      flushPara()
      list = list || []
      list.push(escapeHtml(bullet[1]))
      continue
    }

    const quote = line.match(/^\s*>\s?(.*)$/)
    if (quote) {
      flushPara()
      flushList()
      out.push(`<blockquote>${inline(escapeHtml(quote[1]))}</blockquote>`)
      continue
    }

    list && flushList()
    para.push(line)
  }

  if (fence) {
    // Unterminated fence: still emit the buffer rather than swallowing it.
    out.push(`<pre class="code"><code>${escapeHtml((fenceBuf || []).join('\n'))}</code></pre>`)
  }
  flushPara()
  flushList()
  return out.join('')
}

/** Compact one-line preview for the session list. */
export function preview(text, max = 90) {
  const flat = String(text || '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}
