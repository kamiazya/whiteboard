/**
 * A note's math blocks and diagram fences, typeset — the same hook the
 * canvas editor uses, because the question is the same: which sources does
 * THIS layout ask for. The seams record every source they cannot answer yet,
 * so the preview's own layout is the one that learns the asks (an embedded
 * note's and an embedded board's included), and a surface that lays nothing
 * out — the editor's Write mode — asks for nothing and loads no engine.
 */

import { useCanvasFragments } from '../components/spatial-editor/use-canvas-fragments.js'
import type { FragmentLoaders, FragmentSeams } from '../lib/fragment-requests.js'
import { FRAGMENT_ENGINES } from '../lib/markdown-fragment-renderers.js'

/** @param loaders Injection seam for tests; defaults to the real MathJax/mermaid loaders. */
export function useMarkdownFragments(loaders: FragmentLoaders = FRAGMENT_ENGINES): FragmentSeams {
  return useCanvasFragments(loaders).seams
}
