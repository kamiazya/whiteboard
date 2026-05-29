// Loopback-host policy for the local-daemon binding contract.
// Server-mode exposure validation imports this so the same definition
// governs both the pre-startup guard and the per-request check.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}
