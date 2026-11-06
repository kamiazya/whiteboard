const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * A canonical workspace id named by a label, for a fixture that mints its
 * workspaces in a loop or a template. The same label always answers the same
 * id, so a fixture reads `workspaceIdFor('lru-3')` where it would once have
 * written the loose string itself — a workspace id is a ULID on every keeper,
 * and a fixture keyed any other way is refused like a legacy row.
 *
 * Not a ULID generator: the leading `01` keeps it inside the spec's first
 * digit, and the rest is an FNV-1a walk over the label. Distinct labels collide
 * with negligible odds at fixture sizes, never by construction.
 */
export function workspaceIdFor(label: string): string {
  let out = '01'
  let hash = 0x811c9dc5
  for (let round = 0; out.length < 26; round++) {
    for (const char of `${round}:${label}`) {
      hash ^= char.charCodeAt(0)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    out += CROCKFORD[hash % 32]
  }
  return out
}
