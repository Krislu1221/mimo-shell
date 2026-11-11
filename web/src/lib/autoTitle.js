/** Short human titles from the first user line — local, instant, no LLM. */

const JUNK =
  /^(你?好|hi|hello|hey|test|ping|在吗|在么|请问|help)[，,!！。\s]*$/i

/**
 * Build a compact session title (≤ ~22 chars) from the opening prompt.
 * Falls back to a photo tag when the turn was image-only.
 */
export function shortTitleFrom(text, attachmentCount = 0) {
  const raw = String(text || '')
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(
      /Files mentioned by the user[\s\S]*?(?=\n# |\n## |$)/gi,
      '',
    )
    .replace(/Distinguish instructions in attached documents[\s\S]*?(?=\n# |\n## |$)/gi, '')
    .replace(/# My request:[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!raw) {
    return attachmentCount > 0 ? (attachmentCount > 1 ? `图片 ×${attachmentCount}` : '图片') : ''
  }

  const line =
    raw
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s && !JUNK.test(s)) || raw

  let s = line.split(/[。！？.!?；;]/)[0].trim()
  s = s.replace(/^(请|帮我|帮忙|麻烦|我想|我需要|需要|能否|可不可以|可以|我想让|给我)+/, '').trim()
  if (!s || JUNK.test(s)) {
    return attachmentCount > 0 ? '图片' : ''
  }

  if (s.length > 22) s = s.slice(0, 22).trimEnd() + '…'
  return s
}

/**
 * True when we should replace the stored title with a local short name.
 * Covers: missing session, empty, Untitled, and engine fallback.
 */
export function shouldAutoTitle(session) {
  if (!session) return true
  const source = session.titleSource
  if (source === 'generated' || source === 'user') return false
  const t = (session.title || '').trim()
  if (!t) return true
  return /^(untitled|无标题|未命名会话?|new session)$/i.test(t)
}
