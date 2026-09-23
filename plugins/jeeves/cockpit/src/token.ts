// The backend gates /api and /pty on a local token. It's handed to the browser
// once via ?token= in the URL the server prints on boot; we stash it in
// localStorage and strip it from the address bar so a reload keeps working.
const KEY = 'jeeves-cockpit-token'

function capture(): string {
  try {
    const u = new URL(location.href)
    const q = u.searchParams.get('token')
    if (q) {
      localStorage.setItem(KEY, q)
      u.searchParams.delete('token')
      history.replaceState(null, '', u.pathname + u.search + u.hash)
      return q
    }
    return localStorage.getItem(KEY) || ''
  } catch {
    return ''
  }
}

// A live binding: importers see the new value after setToken.
export let TOKEN = capture()

// Adopt a rotated token: new requests and reconnects use it, and a reload keeps it.
export function setToken(t: string): void {
  TOKEN = t
  try { localStorage.setItem(KEY, t) } catch {}
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return TOKEN ? { ...extra, authorization: 'Bearer ' + TOKEN } : extra
}

// WebSockets can't carry an Authorization header from the browser, so the token
// rides in the query string there.
export function withToken(qs: string): string {
  if (!TOKEN) return qs
  return qs + (qs.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN)
}
