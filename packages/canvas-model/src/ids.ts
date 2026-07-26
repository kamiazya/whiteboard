import { z } from 'zod'

// Canonical ULID: 26 chars of Crockford base32 (excludes I, L, O, U to avoid
// visual confusion with 1, 1, 0, V). The first character is additionally
// restricted to 0-7 because a ULID packs a 48-bit timestamp + 80-bit
// randomness into 128 bits total; the leading base32 digit only ever
// contributes its low 3 bits to that 128-bit value, so 8-Z there would
// overflow the spec's bit layout. See https://github.com/ulid/spec.
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

/** Canvas identifiers are canonical ULIDs (sortable, collision-resistant). */
export const canvasIdSchema = z.string().regex(ULID_PATTERN, 'must be a canonical ULID')

/**
 * Node identifiers are nanoid-style strings. The charset is deliberately not
 * enforced here — nanoid's default alphabet may change or be swapped for a
 * custom one — only non-emptiness is a real invariant.
 */
export const nodeIdSchema = z.string().min(1, 'node id must not be empty')

export type CanvasId = z.infer<typeof canvasIdSchema>
export type NodeId = z.infer<typeof nodeIdSchema>
