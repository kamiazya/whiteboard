import { z } from 'zod'
import { coreFacetsSchema, extensionFacetsSchema, facetsRawSchema } from './generated/okf.zod.js'

export { EXTENSION_FACET_KEY_PATTERN, RESERVED_ROOT_KEYS } from './facet-keys.js'
export type { CoreFacets, ExtensionFacets, FacetsRaw } from './generated/okf.zod.js'
export { coreFacetsSchema, extensionFacetsSchema, facetsRawSchema }

/**
 * NAMED in zod's registry, so it is emitted into `$defs` once and `$ref`ed at
 * each site instead of inlined there.
 *
 * Safe by the rule the tool-surface skill measured: only a COMPOSITE may be
 * registered, because a description ON a registered schema is DROPPED from
 * `$defs` while one INSIDE a registered object survives. This schema carries
 * no `.describe()` — its prose is a source comment, which never reaches the
 * wire — so registering it deletes nothing a model was reading.
 *
 * It was listed as the last remaining safe registration and left unspent at
 * four sites and ~99 bytes each, which was the right call then. Converging
 * `wb_canvas_edit`'s node input on the model's fields put `facets` at four
 * more sites and took the table UP 169 visible bytes; this is what pays that
 * back and more.
 */
z.globalRegistry.add(extensionFacetsSchema, { id: 'ExtensionFacets' })

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
