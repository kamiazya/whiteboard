import type { SpatialNode } from '@kamiazya/whiteboard-model'
import {
  applyStencil,
  resolveNodeStencil,
  resolveNodeSymbol,
  VISUAL_STENCILS,
} from '@kamiazya/whiteboard-plugin-visual'
import { visualRenderContribution } from '@kamiazya/whiteboard-plugin-visual/render'
import type { SceneNode } from '@kamiazya/whiteboard-scene'
import type { SpatialAppearanceResolver } from '../../theme/spatial-appearance.js'

/**
 * The decorations drawn over a node after its content (`composeDecorations` in
 * `spatial-canvas.ts`), which are the bundled visual plugin's: what a node
 * wearing a stencil, a symbol, both or neither draws, in boxes either side of
 * the height a badge needs, under each theme. The node's facets are recorded,
 * which the Rust badge reads through its own readers, and beside them which
 * stencil and symbol the plugin's readers here answer for them.
 */

type ThemeName = 'light' | 'dark' | 'sketch'

export interface DecorationRecord {
  readonly kind: 'decoration'
  readonly id: string
  readonly node: {
    readonly id: string
    readonly box: readonly string[]
    readonly facets?: SpatialNode['facets']
  }
  readonly theme: ThemeName
  readonly stencil: string | null
  readonly symbol: { readonly kind: string; readonly name?: string; readonly char?: string } | null
  readonly scene: string
}

const STENCIL = Object.keys(VISUAL_STENCILS)[0]
if (STENCIL === undefined) throw new Error('compose-node-oracle: no bundled stencil')

const plain = (id: string): SpatialNode => ({
  id,
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  resource: { mimeType: 'text/markdown', content: 'Box' },
})

function dressed(id: string): SpatialNode {
  const node = applyStencil(plain(id), `visual.${STENCIL}`)
  if (node === undefined)
    throw new Error(`compose-node-oracle: visual.${STENCIL} is not registered`)
  return node
}

/** Facets by name: none, a symbol alone, a stencil, and a stencil whose symbol changed or went. */
const MARKS: Readonly<Record<string, (id: string) => SpatialNode>> = {
  plain,
  symbol: (id) => ({
    ...plain(id),
    facets: { 'visual.symbol/v0': { kind: 'icon', name: 'star' } },
  }),
  stencil: dressed,
  'stencil-emoji': (id) => {
    const node = dressed(id)
    return { ...node, facets: { ...node.facets, 'visual.symbol/v0': { kind: 'emoji', char: '★' } } }
  },
  'stencil-bare': (id) => {
    const { 'visual.symbol/v0': _gone, ...facets } = dressed(id).facets ?? {}
    return { ...dressed(id), facets }
  },
}

/** `[x, y, w, h]`: roomy, exactly the height a badge needs, just under it, and non-finite. */
const BOXES: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 200, 100],
  [10.5, 20, 120, 48],
  [10, -20, 120, 47.75],
  [-5, 5, -40, 60],
  [0, 0, 30, Number.NaN],
]

const THEMES: readonly ThemeName[] = ['light', 'dark', 'sketch']

/** Every record, from the recording's own helpers: how a double is written and a scene dumped. */
export function decorationRecords(
  hex: (value: number) => string,
  dump: (nodes: readonly SceneNode[]) => string,
  appearanceOf: (theme: ThemeName) => SpatialAppearanceResolver,
): readonly DecorationRecord[] {
  const records: DecorationRecord[] = []
  for (const [mark, make] of Object.entries(MARKS)) {
    for (const [at, [x, y, width, height]] of BOXES.entries()) {
      for (const theme of THEMES) {
        const node = { ...make(`d-${mark}-${at}`), x, y, width, height }
        const symbol = resolveNodeSymbol(node)
        const label = appearanceOf(theme).resolveLabel()
        const bounds = { x, y, w: width, h: height }
        const drawn = (visualRenderContribution.decorations ?? []).flatMap((decorate) =>
          decorate(node, { bounds, label }),
        )
        records.push({
          kind: 'decoration',
          id: `${node.id}/${theme}`,
          node: {
            id: node.id,
            box: [x, y, width, height].map(hex),
            ...(node.facets === undefined ? {} : { facets: node.facets }),
          },
          theme,
          stencil: resolveNodeStencil(node) ?? null,
          symbol: symbol === undefined ? null : { ...symbol },
          scene: dump(drawn),
        })
      }
    }
  }
  return records
}
