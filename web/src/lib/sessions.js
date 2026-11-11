/**
 * Sidebar-visible sessions only.
 *
 * The engine also returns child sessions used for bookkeeping
 * (checkpoint-writer, title generation, …). They have parentID set and
 * titles like "checkpoint-writer: …" — noise if listed as chats.
 * Empty "Untitled" husks from aborted title-gen are hidden too.
 */
export function visibleSessions(list) {
  return (list || []).filter((s) => {
    if (!s?.id) return false
    if (s.parentID) return false
    const t = String(s.title || '').trim()
    if (!t) return false
    if (/^(untitled|未命名会话?)$/i.test(t) && s.titleSource !== 'user') return false
    if (/^checkpoint-writer:/i.test(t)) return false
    if (/^(title|summary|distill|dream|compaction)[:\-]/i.test(t) && s.titleSource !== 'user') return false
    return true
  })
}
