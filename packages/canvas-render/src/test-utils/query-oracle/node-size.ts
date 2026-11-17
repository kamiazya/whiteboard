import type { SpatialNode } from '@kamiazya/whiteboard-model'
import type { FragmentEntry } from '../../fragment-ask.js'

/**
 * The recorded answers of the two node-sizing queries (ADR-0054 step 7,
 * S18a): `fittedTextNodeHeight` as `wb_canvas_edit` asks it (the MCP light
 * appearance, the ratio floor) and as the editor asks it (the app theme, no
 * floor), and `naturalNodeContentSize` under the options a layout carries —
 * the theme, the style, the families held and a fragment table. The nodes
 * are text nodes over the markdown corpus at widths from narrower than a
 * word to a page, each bundled silhouette, a frame, a link and a file.
 * Every double is the hex of its bits.
 */

type NodeSizeInput =
  | {
      readonly kind: 'fitted'
      readonly id: string
      readonly node: SpatialNode
      readonly mode: 'light' | 'dark'
      readonly floor: 'ratio' | 'none'
    }
  | {
      readonly kind: 'natural'
      readonly id: string
      readonly node: SpatialNode
      readonly mode: 'light' | 'dark'
      readonly style?: string
      readonly fonts?: readonly string[]
      /** A table of rendered fragments, as the editor hands one. */
      readonly fragments?: readonly FragmentEntry[]
    }

export type NodeSizeRecord = NodeSizeInput & { readonly answer: readonly string[] }
