/**
 * Whether a `URL.hostname` names this machine — the one definition both
 * composition roots read (the daemon's database location, the hosted app's
 * origin policy and send-transfer destination).
 *
 * `URL.hostname` keeps an IPv6 literal's brackets and normalises the other
 * spellings of loopback (`127.1`, `2130706433`, `LOCALHOST`, the long form of
 * `::1`) to the ones listed, so a bare `::1` is not something a URL ever
 * reports and is deliberately absent: a Host header and a URL both bracket it
 * too. The hostname is compared whole, so `localhost.evil.example` is not
 * loopback.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname)
}
