// Whether a bind host or a URL hostname names this machine. Exposure
// validation and the database location both read it, so one definition
// governs what counts as loopback. Both spellings of the IPv6 address are
// listed because a bind host is written `::1` and `URL.hostname` keeps the
// brackets.

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}
