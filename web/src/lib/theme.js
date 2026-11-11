/** Resolve and persist the UI theme: system / light / dark. */

const KEY = 'mimo-ui-theme'

export function getThemePref() {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function applyTheme(pref) {
  const root = document.documentElement
  if (pref === 'light' || pref === 'dark') root.setAttribute('data-theme', pref)
  else root.removeAttribute('data-theme')
}

export function setThemePref(pref) {
  const next = pref === 'light' || pref === 'dark' ? pref : 'system'
  try {
    if (next === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch { /* private mode */ }
  applyTheme(next)
  return next
}

/** Call once before first paint (main.jsx). */
export function initTheme() {
  applyTheme(getThemePref())
}
