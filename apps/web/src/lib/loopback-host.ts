/**
 * Whether a `URL.hostname` names this machine. `URL.hostname` keeps an IPv6
 * literal's brackets, so the set spells `[::1]` rather than `::1`. The
 * hostname is compared whole: `localhost.evil.example` is not loopback.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname)
}
