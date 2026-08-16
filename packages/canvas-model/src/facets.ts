import { z } from 'zod'

export const coreFacetsSchema = z.object({
  type: z.string().min(1),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  // Explicit default-View override, used when multiple extension facets
  // apply to the same canvas and the reader must pick one deterministically.
  view: z.string().optional(),
})

export type CoreFacets = z.infer<typeof coreFacetsSchema>

const EXTENSION_FACET_KEY_PATTERN = /^[a-z][a-z0-9-]*\/[0-9]+$/

/**
 * Extension facets live under the reserved root key `facets`, keyed by
 * `{domain}/{version}` (e.g. `kanban/1`). Values are intentionally
 * `z.unknown()` — an unknown domain's payload round-trips unvalidated so
 * this package doesn't need to know every extension ever registered.
 *
 * A malformed key is rejected (via superRefine issuing a ZodError), not
 * silently dropped from the record: `z.record` with a validated key schema
 * can drop non-matching keys instead of failing, which would hide data
 * loss. Rejecting the whole parse instead makes the bug visible to the
 * caller.
 */
export const extensionFacetsSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  for (const key of Object.keys(value)) {
    if (!EXTENSION_FACET_KEY_PATTERN.test(key)) {
      ctx.addIssue({
        code: 'custom',
        message: `extension facet key "${key}" must match {domain}/{version}, e.g. "kanban/1"`,
        path: [key],
      })
    }
  }
})

export type ExtensionFacets = z.infer<typeof extensionFacetsSchema>

/**
 * Root-level frontmatter keys that are NOT free for `facetsRaw` to preserve:
 * the core facet fields plus the `facets` extension bucket itself. Keeping
 * this list exported means both `coreFacetsSchema` consumers and
 * `facetsRawSchema` share one definition of "reserved", so a key can never
 * legally live in two buckets at once.
 */
export const RESERVED_ROOT_KEYS = ['type', 'title', 'tags', 'view', 'facets'] as const

/**
 * Unknown root-level frontmatter keys are preserved verbatim as future
 * official keys (not extension facets — those live under `facets`).
 * Routing an arbitrary parsed frontmatter object's keys into this bucket
 * vs. `coreFacetsSchema`/`extensionFacetsSchema` is slice-2 parser
 * behavior; this schema only makes the reserved/non-reserved split
 * unrepresentable as an overlap.
 */
export const facetsRawSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  for (const key of Object.keys(value)) {
    if ((RESERVED_ROOT_KEYS as readonly string[]).includes(key)) {
      ctx.addIssue({
        code: 'custom',
        message: `"${key}" is a reserved root key and cannot appear in facetsRaw`,
        path: [key],
      })
    }
  }
})

export type FacetsRaw = z.infer<typeof facetsRawSchema>

/**
 * The persisted counterpart to `coreFacetsSchema`: the core OKF facets plus
 * the `facetsRaw` bucket, as a single shape a store can write/read as one
 * unit. Named for what it holds — facets are OKF frontmatter (ADR-0009
 * decision 3) — rather than for the canvas, which is a spatial surface and
 * carries none. `facets` (the extension bucket) is deliberately excluded — it has
 * its own storage key and its own read/write pair (`writeFacets`/
 * `readFacets` in canvas-workspace) so one domain's CRDT merge never
 * overwrites another's; folding it into this object would lose that
 * per-key merge granularity.
 *
 * `title` is omitted, and that omission is the whole point: a document's name
 * belongs to its place in the workspace, not to its content (ADR-0009
 * decision 2). The OKF frontmatter `title` is a PROJECTION of that name on
 * serialise and a write to it on parse — `coreFacetsSchema` keeps the field
 * because OKF has it, and this schema drops it because storage must not be a
 * second copy to keep in sync. Omitting it here is what makes the second copy
 * unrepresentable rather than merely discouraged.
 */
export const storedCoreFacetsSchema = coreFacetsSchema.omit({ title: true }).extend({
  facetsRaw: facetsRawSchema.optional(),
})

export type StoredCoreFacets = z.infer<typeof storedCoreFacetsSchema>
