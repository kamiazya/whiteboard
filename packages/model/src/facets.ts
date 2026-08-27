import { z } from 'zod'

export const coreFacetsSchema = z.object({
  type: z.string().min(1),
  title: z.string().optional(),
  /**
   * OKF §4.1: "A single sentence summarizing the concept. Used by `index.md`
   * generators, search snippets, and previews." One sentence is guidance to
   * the author, not a constraint to enforce — a schema that policed it would
   * reject a two-sentence summary that reads perfectly well.
   */
  description: z.string().optional(),
  /**
   * OKF §4.1: "A URI that uniquely identifies the underlying asset the
   * concept describes. Absent for concepts that describe abstract ideas
   * rather than physical resources."
   *
   * Not validated as a URL. §6.2 makes every path-valued field accept an
   * absolute URL, a bundle-relative path beginning with `/`, or an ordinary
   * relative path, so `../computations/revenue.md` is as conformant as
   * `https://…` and a URL check would reject it.
   */
  resource: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /**
   * OKF's explicit default-View override: which extension facet a reader
   * should render when a DOCUMENT carries several. (A canvas is the spatial
   * surface and carries no facets at all — ADR-0009.)
   *
   * **Nothing reads it, and no tool writes it.** It round-trips through
   * `writeCoreFacets`/`readCoreFacets` and stops there: core facets have no
   * setter tool, and no renderer selects a template. Whether `view` becomes
   * the selection key is an open question with a write path attached to it,
   * so the field stays declared — dropping it would lose an author's value
   * on the next save — while claiming a mechanism it does not have would be
   * worse than saying nothing.
   */
  view: z.string().optional(),
})

export type CoreFacets = z.infer<typeof coreFacetsSchema>

export const EXTENSION_FACET_KEY_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\/v[0-9]+$/

/**
 * Extension facets live under the reserved root key `facets`, keyed by
 * `{namespace}.{name}/v{n}` (e.g. `visual.shape/v0`) per ADR-0013. The
 * namespace is the owning plugin's id — every facet belongs to a plugin,
 * so an unnamespaced key is unrepresentable (there is no privileged core
 * namespace; k8s's unprefixed legacy group is the debt this avoids).
 * `v0` marks an unstable facet whose payload may still change shape;
 * `v1`+ bumps only on breaking change. Values are intentionally
 * `z.unknown()` — an unknown facet's payload round-trips unvalidated so
 * this package doesn't need to know every plugin ever registered.
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
        message: `extension facet key "${key}" must match {namespace}.{name}/v{n}, e.g. "visual.shape/v0"`,
        path: [key],
      })
    }
  }
})

export type ExtensionFacets = z.infer<typeof extensionFacetsSchema>

/**
 * Root-level frontmatter keys that are NOT free for `facetsRaw` to preserve:
 * the core facet fields, the `facets` extension bucket itself, and the OKF
 * v0.2 trust family (`trust.ts`), which this codebase models rather than
 * merely carrying. Keeping this list exported means both `coreFacetsSchema`
 * consumers and `facetsRawSchema` share one definition of "reserved", so a
 * key can never legally live in two buckets at once.
 *
 * A key joins this list the moment something INTERPRETS it. Until then
 * `facetsRaw` is the right home: preserved verbatim, and never
 * half-understood.
 */
export const RESERVED_ROOT_KEYS = [
  'type',
  'title',
  'description',
  'resource',
  'tags',
  'view',
  'facets',
  'generated',
  'verified',
] as const

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
 * `readFacets` in crdt) so one domain's CRDT merge never
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
