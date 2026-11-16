import type { SpatialLayoutOptions } from '../../layout/layout-options.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { TAG_LIBRARY } from '../compose-canvas-oracle/corpus.js'
import { createFakeMeasure } from '../fake-measure.js'
import { testLayoutCore } from '../test-layout-core.js'

/**
 * The boards the query recordings (ADR-0054 step 7, S18a) are drawn over,
 * each with an edge, and the editor's view of one: the options its drag
 * layers and label editors hand canvas-render (apps/web's `editorLayoutBase`
 * restated as data — the app theme, `style: 'document'`, the families the
 * realm holds, the workspace's tag library), and the committed layout a
 * gesture starts from.
 */

export interface EditorProfile {
  readonly mode: 'light' | 'dark'
  /** The families `fontAvailable` answers yes for. */
  readonly fonts: readonly string[]
  /** Whether the workspace's tag library is handed. */
  readonly library?: true
}
export function editorOptions(profile: EditorProfile): SpatialLayoutOptions {
  const fonts = new Set(profile.fonts)
  return {
    core: testLayoutCore(),
    measure: createFakeMeasure(),
    appearance: createSpatialTheme({ mode: profile.mode }),
    style: 'document',
    fontAvailable: (family) => fonts.has(family),
    ...(profile.library === true ? { tagLibrary: TAG_LIBRARY } : {}),
  }
}
