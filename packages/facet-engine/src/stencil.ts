/**
 * The engine's STENCIL CONTRACT ([ADR-0034](../../../docs/contributing/adr/0034-stencil-and-recipe.md)):
 * the one shape a registered stencil asset has. A stencil is a named bundle
 * of appearance a document applies to ONE node — "a database", "an EC2
 * instance" — so that a vocabulary is authored once and used many times
 * instead of invented per drawing.
 *
 * Declared here for the reason the theme token contract is: the engine owns
 * the CONTRACT and knows nothing about what the appearance means. A stencil
 * carries facet payloads keyed by the facet key that owns them, so the
 * engine validates each through the schema its plugin registered and never
 * learns what a silhouette or a badge is.
 *
 * `color` is the one exception and it is deliberate: a node's colour is a
 * JSON Canvas CORE field rather than a facet, so there is no schema to
 * delegate to. The engine passes the string through untouched — the format
 * decides what `"5"` means, and a format that spells colour differently
 * puts its own value here.
 *
 * What a stencil may NOT carry is the load-bearing half (ADR-0034 decision
 * 3): no position, and no text. Position would make a stencil a second
 * producer of geometry, and text is what the drawing is ABOUT — a stencil
 * supplies the vocabulary, never the sentence.
 */
import { z } from 'zod'

/**
 * A facet key exactly as ADR-0013 decision 2 grammars it. Re-stated rather
 * than imported from the registry's own parser because this is a SCHEMA —
 * the message a stencil author sees when they typo a key is worth as much
 * as the check itself.
 */
const facetKeySchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\/v[0-9]+$/,
    'must be a facet key like "visual.shape/v0"',
  )

export const stencilAssetSchema = z
  .object({
    /** What a picker calls it. The id stays machine-only, as everywhere else. */
    displayName: z.string().min(1),
    /**
     * The node's colour, passed through uninterpreted (see the module doc).
     * Absent means the stencil says nothing about colour, which is a
     * legitimate vocabulary: a set distinguishing purely by silhouette is not
     * a worse one, and ADR-0034's columns judge whether the distinctions land,
     * never how many channels were spent.
     */
    color: z.string().min(1).optional(),
    /**
     * Facet payloads by key, each validated against the schema its own plugin
     * registered — at REGISTRY BUILD rather than at `definePlugin`, because a
     * stencil may legitimately name another plugin's facet. That is not the
     * cross-plugin coupling ADR-0013 decision 3 refuses for `views`: a view
     * READS another plugin's data behind its back, while a stencil WRITES a
     * facet the target object was always free to carry.
     */
    facets: z.record(facetKeySchema, z.unknown()).default({}),
  })
  // STRICT, so decision 3's "no position, no text" is enforced rather than
  // assumed. A non-strict object would STRIP an `x` or a `text` a library
  // author wrote and register the stencil anyway — accepted, dropped,
  // nothing said, and the author left believing their stencil places the
  // box. The same shape cost `node.add` a silently discarded `stencil`
  // (2026-09-11); it is the worst of the three outcomes because neither the
  // author nor a test that reads what was stored can see it.
  .strict()

export type StencilAsset = z.infer<typeof stencilAssetSchema>
export type StencilAssetInput = z.input<typeof stencilAssetSchema>
