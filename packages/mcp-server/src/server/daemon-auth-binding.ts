// Loopback-host policy. Server-mode exposure validation reads it, so one
// definition governs what counts as a loopback bind.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}
