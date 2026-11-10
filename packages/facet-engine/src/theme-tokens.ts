/**
 * The engine's THEME TOKEN CONTRACT (ADR-0030 decision 3): the one shape a
 * registered theme asset has. A document never carries these values — it
 * names an asset by id (`<plugin>.<name>`), and the asset supplies them.
 *
 * Declared in the engine, rather than in the renderer that consumes it, so
 * that it is a PREFIX of ADR-0013 decision 8's token contract: when views and
 * slots land, the type does not move and neither does any asset. The renderer
 * maps these tokens onto its own palette type through `z.infer`; it never
 * re-declares them.
 *
 * Every colour is six-digit hex. Not a stylistic choice: the PNG export path
 * (resvg) parses no `oklch()`, and an 8-digit alpha hex is not SVG 1.1, so a
 * theme authored in the app's CSS colour space would export wrong. The
 * medium-neutral contract is the one every medium here can read.
 *
 * The schemas are GENERATED from `contracts/facets/engine`, beside the Rust
 * types of `crates/core/facet-engine`; this module is their public name and
 * the input types a plugin writes. `themeEdgeRoutingSchema` is the model's
 * `edgeRoutingStyleSchema` spelled again because this package depends on zod
 * alone; the renderer's tests pin that the two agree.
 */
import type { z } from 'zod'
import {
  groupFrameTokensSchema,
  iconAssetSchema,
  namespacedIdSchema,
  paletteTokensSchema,
  themeEdgeRoutingSchema,
  themeTokensSchema,
} from './generated/engine.zod.js'

export type { IconAsset, PaletteTokens, ThemeTokens } from './generated/engine.zod.js'
export {
  groupFrameTokensSchema,
  iconAssetSchema,
  namespacedIdSchema,
  paletteTokensSchema,
  themeEdgeRoutingSchema,
  themeTokensSchema,
}

/** What a plugin WRITES: `defaults` may be omitted, and the registry fills it in. */
export type ThemeTokensInput = z.input<typeof themeTokensSchema>
