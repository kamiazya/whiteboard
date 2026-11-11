/**
 * The two theme ASSETS the bundled plugin ships (ADR-0030 decision 1), as
 * values of the engine's token contract. A document names one by id —
 * `visual.sketch`, `visual.neon` — through `visual.theme/v0`; nothing here
 * is stored in a document. The values are `assets/themes.json`, and what
 * each choice means is `assets/README.md`.
 */
import { type ThemeTokens, themeTokensSchema } from '@kamiazya/whiteboard-facet-engine'
import { assetTable } from './asset-table.js'
import themes from './assets/themes.json' with { type: 'json' }

/** The bundled theme assets by BARE name; the registry namespaces them to `visual.<name>`. */
export const VISUAL_THEMES: Readonly<Record<string, ThemeTokens>> = assetTable(
  'theme',
  themes,
  themeTokensSchema,
)
