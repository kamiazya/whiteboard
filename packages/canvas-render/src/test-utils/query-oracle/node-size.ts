import type { SpatialNode } from '@kamiazya/whiteboard-model'
import { fileNode, groupNode, linkNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { fittedTextNodeHeight } from '../../layout/fitted-height.js'
import type { FragmentEntry } from '../../layout/nodes/fragment-ask.js'
import { BUNDLED_SHAPE_TABLE } from '../../layout/nodes/node-outline.js'
import { naturalNodeContentSize } from '../../layout/spatial-canvas.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { hex } from '../compose-canvas-oracle/oracle.js'
import { createFakeMeasure } from '../fake-measure.js'
import { BOUNDARY_BODIES, HAND_BODIES } from '../markdown-document-oracle/bodies.js'
import { viaJson } from './boards.js'

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

export type NodeSizeInput =
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

export function nodeSizeAnswer(input: NodeSizeInput): NodeSizeRecord {
  const measure = createFakeMeasure()
  const appearance = createSpatialTheme({ mode: input.mode })
  if (input.kind === 'fitted') {
    const h = fittedTextNodeHeight(input.node, { measure, appearance, floor: input.floor })
    return { ...input, answer: [hex(h)] }
  }
  const fonts = new Set(input.fonts ?? [])
  const { w, h } = naturalNodeContentSize(input.node, {
    measure,
    appearance,
    ...(input.style === undefined ? {} : { style: input.style }),
    ...(input.fonts === undefined ? {} : { fontAvailable: (family: string) => fonts.has(family) }),
    ...(input.fragments === undefined ? {} : { fragments: input.fragments }),
  })
  return { ...input, answer: [hex(w), hex(h)] }
}

const FRAGMENTS: readonly FragmentEntry[] = [
  ['math:x^2 + y^2', { svg: '<g data-sum/>', width: 120, height: 32 }],
  ['fence:mermaid:graph TD\n  A --> B', { svg: '<g data-graph/>', width: 200, height: 140 }],
]

/** From narrower than a word to a page; a fractional one; the editor's default. */
const WIDTHS = [24, 120, 240, 250.5, 400, 720]

/** The corpus bodies a node can hold whole: everything but the delimiter runs. */
const BODIES = [...HAND_BODIES, ...BOUNDARY_BODIES.filter(([name]) => !name.includes('delimiter'))]

function bodyNodes(): (readonly [string, SpatialNode])[] {
  return BODIES.flatMap(([name, text], b) =>
    [WIDTHS[b % WIDTHS.length], WIDTHS[(b + 3) % WIDTHS.length]].map(
      (width) =>
        [
          `${name}@${width}`,
          textNode({ id: 'n', x: 0, y: 0, width: width ?? 0, height: 80, text }),
        ] as const,
    ),
  )
}

function shapedNodes(): (readonly [string, SpatialNode])[] {
  return Object.keys(BUNDLED_SHAPE_TABLE).map((id) => {
    const kind = id.slice(id.indexOf('.') + 1)
    const node = textNode({
      id: 'n',
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      text: '# A shaped box\n\nwith a paragraph long enough to wrap inside it',
      facets: { 'visual.shape/v0': { kind } },
    })
    return [`shape ${id}`, node] as const
  })
}

const OTHER_NODES: readonly (readonly [string, SpatialNode])[] = [
  ['frame', groupNode({ id: 'n', x: 0, y: 0, width: 300, height: 200, label: 'A frame title' })],
  [
    'link',
    linkNode({ id: 'n', x: 0, y: 0, width: 200, height: 60, url: 'https://example.com/a/b' }),
  ],
  ['file', fileNode({ id: 'n', x: 0, y: 0, width: 240, height: 160, file: 'note' })],
  ['empty text', textNode({ id: 'n', x: 0, y: 0, width: 200, height: 60, text: '' })],
  ['zero width', textNode({ id: 'n', x: 0, y: 0, width: 0, height: 60, text: 'words here' })],
]

export function nodeSizeInputs(): readonly NodeSizeInput[] {
  const nodes = [...bodyNodes(), ...shapedNodes(), ...OTHER_NODES]
  const fitted = nodes.flatMap(([name, node], i) =>
    (['ratio', 'none'] as const).map(
      (floor): NodeSizeInput => ({
        kind: 'fitted',
        id: `fitted/${name}/${floor}`,
        node,
        mode: i % 2 === 0 ? 'light' : 'dark',
        floor,
      }),
    ),
  )
  const natural = nodes.flatMap(([name, node], i): NodeSizeInput[] => [
    { kind: 'natural', id: `natural/${name}`, node, mode: 'light' },
    {
      kind: 'natural',
      id: `natural/${name}/document`,
      node,
      mode: i % 2 === 0 ? 'dark' : 'light',
      style: i % 3 === 0 ? 'visual.sketch' : 'document',
      fonts: i % 4 === 0 ? ['Yomogi'] : [],
      fragments: FRAGMENTS,
    },
  ])
  return viaJson([...fitted, ...natural])
}
