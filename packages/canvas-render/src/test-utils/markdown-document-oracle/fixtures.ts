import type { CanvasEdge, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, groupNode, linkNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { FragmentEntry } from '../../fragment-ask.js'
import type { ReferenceWire } from '../../references/wire.js'
import type { MarkdownTables } from './oracle.js'

/**
 * What the markdown-document recordings point at, as data: the documents a
 * note links and embeds (`REFERENCES`, a `ReferenceWire`), the rendered
 * fragments a web preview hands as its table, and the workspace's tag
 * library. A record carries the wire and the table it was laid out with, so a
 * replay rebuilds the seams from the record alone.
 */

const edge = (id: string, from: string, to: string, extra: Partial<CanvasEdge> = {}): CanvasEdge =>
  ({ id, from: { node: from }, to: { node: to, end: 'arrow' }, ...extra }) as CanvasEdge

/** A board with a frame, tagged boxes the library colours, display math, labelled edges and a file node back to the note. */
const BOARD: SpatialCanvas = {
  nodes: [
    groupNode({ id: 'g', x: 0, y: 0, width: 520, height: 260, label: 'Group A' }),
    textNode({ id: 'a', x: 30, y: 50, width: 180, height: 80, text: '# API', tags: ['health:ok'] }),
    textNode({
      id: 'b',
      x: 300,
      y: 50,
      width: 180,
      height: 80,
      text: 'Store **rows**',
      tags: ['health:failing'],
    }),
    textNode({ id: 'c', x: 30, y: 400, width: 200, height: 90, text: '日本語のメモです。' }),
    fileNode({ id: 'f', x: 320, y: 380, width: 220, height: 140, file: 'note' }),
    linkNode({ id: 'l', x: 600, y: 60, width: 160, height: 60, url: 'https://example.com' }),
    textNode({ id: 'm', x: 600, y: 200, width: 200, height: 120, text: '$$\nx^2 + y^2\n$$' }),
  ],
  edges: [
    edge('ab', 'a', 'b', { label: 'writes' }),
    edge('bc', 'b', 'c'),
    edge('cf', 'c', 'f', { label: 'see the note' }),
  ],
}

/** The same board drawn in a theme that names its own family, so `fonts` decides what is declared. */
const SKETCH_BOARD: SpatialCanvas = {
  ...BOARD,
  facets: { 'visual.theme/v0': { theme: 'visual.sketch' } },
}

/** Boxes of one kind whose colour only the library's key explains, so the board carries a legend. */
const LEGEND_BOARD: SpatialCanvas = {
  nodes: ['ok', 'failing', 'ok', 'failing', 'ok'].map((value, i) =>
    textNode({
      id: `t${i}`,
      x: (i % 3) * 220,
      y: Math.floor(i / 3) * 140,
      width: 180,
      height: 90,
      text: `Service ${i}`,
      tags: [`health:${value}`],
    }),
  ),
  edges: [edge('t01', 't0', 't1'), edge('t12', 't1', 't2', { label: 'calls' })],
}

const deep = (n: number): string => `# Level ${n}\n\n![[deep-${n + 1}]]`

/**
 * Every reference the corpus names: a note (with math, a code fence and an
 * embedded board), boards plain and themed, a note embedding itself, a chain
 * past the depth cap, a name with no content, a picture, and a key looked up
 * and found to name nothing.
 */
const REFERENCES: ReferenceWire = {
  entries: [
    [
      'note',
      {
        documentId: 'D-NOTE',
        name: 'Design note',
        body: '# Note\n\nIntro with $a+b$.\n\n## Part two\n\n$$\ne^{i\\pi}\n$$\n\n```ts\nconst x = 1\n```\n\n![[board]]',
      },
    ],
    ['board', { documentId: 'D-BOARD', name: 'Board', canvas: BOARD }],
    ['sketch', { documentId: 'D-SKETCH', name: 'Sketch', canvas: SKETCH_BOARD }],
    ['legend', { documentId: 'D-LEGEND', name: 'Health', canvas: LEGEND_BOARD }],
    ['self', { documentId: 'D-SELF', name: 'Self', body: 'Before\n\n![[self]]\n\nAfter' }],
    ['deep-1', { documentId: 'D-1', body: deep(1) }],
    ['deep-2', { documentId: 'D-2', body: deep(2) }],
    ['deep-3', { documentId: 'D-3', body: deep(3) }],
    ['deep-4', { documentId: 'D-4', body: deep(4) }],
    ['deep-5', { documentId: 'D-5', body: '# Bottom' }],
    ['named', { documentId: 'D-NAMED', name: 'Only a name' }],
    ['empty-board', { documentId: 'D-EMPTY', name: 'Empty', canvas: { nodes: [], edges: [] } }],
    ['missing', null],
  ],
  aliases: [
    ['Some Page', 'D-NOTE'],
    ['Board Alias', 'D-BOARD'],
  ],
  titles: [
    ['D-NOTE', 'Design note (title table)'],
    ['D-1', 'Deep one'],
  ],
  extras: [
    ['pic.png', { image: { href: 'img:pic', width: 320, height: 180 } }],
    ['wide.png', { image: { href: 'img:wide', alt: 'wide' } }],
    ['gone', { missing: true }],
  ],
}

/** The table a web preview hands: some sources rendered, the rest asked for. */
const FRAGMENTS: readonly FragmentEntry[] = [
  ['math:x^2 + y^2', { svg: '<g data-sum/>', width: 120, height: 32 }],
  ['fence:mermaid:graph TD\n  A --> B', { svg: '<g data-graph/>', width: 200, height: 140 }],
  [String.raw`math:e^{i\pi}`, { svg: '<g data-euler/>', height: 24 }],
  ['fence:math:x^2 + y^2', { svg: '<g data-fence/>', width: 2000, height: 50 }],
  [String.raw`math:\frac{1}{2}`, { svg: '<g data-half/>' }],
]

const LIBRARY: TagLibrary = {
  health: { values: { failing: { color: '1' }, ok: { color: '4' } } },
}

/** The tables every markdown-document file's meta line holds. */
export const MARKDOWN_TABLES: MarkdownTables = {
  references: REFERENCES,
  fragments: FRAGMENTS,
  library: LIBRARY,
}
