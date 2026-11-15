import type { CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { SpatialLayoutOptions } from '../../layout/layout-options.js'
import type { FragmentEntry } from '../../layout/nodes/fragment-ask.js'
import { type ReferenceWire, referenceSeamsFromWire } from '../../references/wire.js'

/**
 * Math blocks and diagram fences answered from a table of rendered fragments
 * (`SpatialLayoutOptions.fragments`): the table full, partial and empty, over
 * display math, inline math (never asked for), a mermaid fence, a fence the
 * default highlighter colours (asked for as a diagram first), a ```math fence
 * keyed apart from the same source as display math, a source repeated, an
 * embedded note's math and a file node's, and a comment's opening message.
 */

const fence = (lang: string, value: string) => `\`\`\`${lang}\n${value}\n\`\`\``

const BODIES = [
  '$$\nx^2 + y^2\n$$\n\nand inline $a+b$ too',
  fence('mermaid', 'graph TD\n  A --> B'),
  fence('ts', 'const x = 1'),
  `${fence('math', 'x^2 + y^2')}\n\n$$\nx^2 + y^2\n$$`,
  '![[note]]',
  '$$\n\\frac{1}{2}\n$$\n\n$$\n\\sum\n$$',
]

const NOTE_WIRE: ReferenceWire = {
  entries: [['note', { documentId: 'D-NOTE', name: 'Note', body: '# Note\n\n$$\ne^{i\\pi}\n$$' }]],
  aliases: [],
  titles: [],
  extras: [],
}

function mathBoard(): SpatialCanvas {
  const nodes = BODIES.map((text, i) =>
    textNode({
      id: `m${i}`,
      x: (i % 3) * 300,
      y: Math.floor(i / 3) * 320,
      width: 280,
      height: 300,
      text,
    }),
  )
  return {
    nodes: [
      ...nodes,
      {
        id: 'mf',
        x: 0,
        y: 700,
        width: 280,
        height: 200,
        resource: { mimeType: 'application/octet-stream', location: 'note' },
      },
    ],
    edges: [],
  }
}

const THREAD: CommentThread = {
  id: 't',
  anchor: { kind: 'spatial', x: 40, y: 40, nodeId: 'm0' } as CommentThread['anchor'],
  status: 'open',
  messages: [{ id: 't-m0', body: 'see\n\n$$\nq\n$$' } as CommentThread['messages'][number]],
}

/** Rendered rows: a fragment sized both ways, one width only, one wider than its column, one bare. */
const FULL: readonly FragmentEntry[] = [
  ['math:x^2 + y^2', { svg: '<g data-sum/>', width: 120, height: 32 }],
  ['fence:mermaid:graph TD\n  A --> B', { svg: '<g data-graph/>', width: 200, height: 140 }],
  ['fence:ts:const x = 1', { svg: '<g data-ts/>', width: 90 }],
  ['fence:math:x^2 + y^2', { svg: '<g data-fence/>', width: 2000, height: 50 }],
  [String.raw`math:e^{i\pi}`, { svg: '<g data-euler/>', height: 24 }],
  [String.raw`math:\frac{1}{2}`, { svg: '<g data-half/>' }],
  [String.raw`math:\sum`, { svg: '<g data-sum-sign/>', width: 30, height: 30 }],
  ['math:q', { svg: '<g data-q/>', width: 10, height: 12 }],
]

const TABLES: readonly (readonly [string, readonly FragmentEntry[]])[] = [
  ['full', FULL],
  ['partial', FULL.filter((_, i) => i % 2 === 0)],
  ['empty', []],
]

/** The math board under each table, light and with its file node open. */
export function mathCases(
  light: SpatialLayoutOptions,
): { name: string; canvas: SpatialCanvas; options: SpatialLayoutOptions }[] {
  const references = referenceSeamsFromWire(NOTE_WIRE)
  return TABLES.map(([table, fragments]) => ({
    name: `math and diagrams, ${table} table`,
    canvas: mathBoard(),
    options: { ...light, references, expandFileNode: () => true, threads: [THREAD], fragments },
  }))
}
