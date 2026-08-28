// Loopback-host policy for the local-daemon binding contract.
// Server-mode exposure validation imports this so the same definition
// governs both the pre-startup guard and the per-request check.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

// server.listen() wants the bare IPv6 address; the URI-bracketed form the
// guard accepts ('[::1]') makes it throw EINVAL. Strip brackets before bind.
export function normalizeBindHost(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1)
  return host
}

// The inverse of normalizeBindHost: a bare IPv6 literal (what server.listen()
// wants, and what normalizeBindHost produces) is not valid inside a URL
// authority — `new URL('http://::1:3099')` throws Invalid URL because the
// colons are indistinguishable from a port separator. RFC 3986 §3.2.2
// requires the bracketed form there. A colon-free host (IPv4 or a hostname)
// never needs bracketing.
export function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

// The one place http-server.ts composes wb_pairing_link_create's
// daemonBaseUrl, pulled out of that call site so the exact expression
// (including the formatHostForUrl bracketing) is reachable from a unit test
// without needing a real socket bind — startHttpServer's own IPv6 bind is
// unavailable on hosts/containers with IPv6 disabled, which this function
// does not depend on.
export function buildDaemonBaseUrl(host: string, port: number): string {
  return `http://${formatHostForUrl(host)}:${port}`
}

export type LoopbackBindGuardResult = { ok: true } | { ok: false; code: 'bind_host_not_loopback' }

// Pre-startup guard: called before the HTTP server binds, so a local-daemon
// invocation with e.g. --host=0.0.0.0 is refused instead of quietly exposing
// an unauthenticated daemon beyond loopback.
export function assertLoopbackBindHost(host: string): LoopbackBindGuardResult {
  if (isLoopbackHost(host)) return { ok: true }
  return { ok: false, code: 'bind_host_not_loopback' }
}
