/**
 * The pairing grant's return leg, recognised without loading the pairing
 * machinery: every cold load asks whether its address carries one, and only
 * a load that does needs the rest (`pairing-grant.ts`).
 */
const GRANT_FRAGMENT_PREFIX = '#wb-grant='

export function parseGrantFragment(
  hash: string,
): { code: string; state: string; identity: string | null } | null {
  if (!hash.startsWith(GRANT_FRAGMENT_PREFIX)) return null
  const params = new URLSearchParams(hash.slice(1))
  const code = params.get('wb-grant')
  const state = params.get('state')
  if (!code || !state) return null
  // The daemon-served consent page embeds the daemon's public key here —
  // learned over the SAME top-level navigation the user just approved on,
  // which is the trust anchor the pin inherits. Absent on legacy daemons.
  return { code, state, identity: params.get('identity') }
}
