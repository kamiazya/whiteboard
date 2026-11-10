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
 * learns what a silhouette or a badge is. Those payloads are validated at
 * REGISTRY BUILD rather than at `definePlugin`, because a stencil may
 * legitimately name another plugin's facet: not the cross-plugin coupling
 * ADR-0013 decision 3 refuses for `views` (a view READS another plugin's
 * data behind its back), but a WRITE of a facet the target object was always
 * free to carry.
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
 * supplies the vocabulary, never the sentence. The schema is STRICT so that
 * is enforced rather than assumed: a non-strict object would strip an `x` or
 * a `text` a library author wrote and register the stencil anyway, leaving
 * the author believing it places the box.
 *
 * The schema is GENERATED from `contracts/facets/engine`.
 */
import type { z } from 'zod'
import { stencilAssetSchema } from './generated/engine.zod.js'

export type { StencilAsset } from './generated/engine.zod.js'
export { stencilAssetSchema }
export type StencilAssetInput = z.input<typeof stencilAssetSchema>
