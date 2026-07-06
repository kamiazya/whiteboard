// Loopback-host policy for the local-daemon binding contract.
// Server-mode exposure validation imports this so the same definition
// governs both the pre-startup guard and the per-request check.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

export type LoopbackBindGuardResult = { ok: true } | { ok: false; code: 'bind_host_not_loopback' }

// Pre-startup guard: called before the HTTP server binds, so a local-daemon
// invocation with e.g. --host=0.0.0.0 is refused instead of quietly exposing
// an unauthenticated daemon beyond loopback.
export function assertLoopbackBindHost(host: string): LoopbackBindGuardResult {
  if (isLoopbackHost(host)) return { ok: true }
  return { ok: false, code: 'bind_host_not_loopback' }
}
