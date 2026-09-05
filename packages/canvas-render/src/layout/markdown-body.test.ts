// The PUBLIC markdown layout lays a canvas-targeted `![[embed]]` out as a
// miniature WITHOUT the caller wiring a composer — the default, not an
// opt-in, for the lowlight reason recorded in architecture-map.md: a seam
// four call sites have to remember is one a call site forgets, and the
// surface that forgets draws a placeholder where the others draw the canvas.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { describe, expect, it } from 'vitest'
import { type LoadedReference, layoutMdastBlocks, referenceSeams } from '../index.js'
import type { SceneNode } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'

const A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

const canvas: SpatialCanvas = {
  nodes: [
    { id: 'n1', type: 'text', x: 0, y: 0, width: 2000, height: 400, text: 'WIDE NODE' },
    { id: 'n2', type: 'text', x: 0, y: 500, width: 400, height: 200, text: 'LOW NODE' },
  ],
  edges: [],
}

const body: MdastRoot = {
  type: 'root',
  children: [{ type: 'paragraph', children: [{ type: 'embed', documentId: A }] }],
}

function textOf(nodes: readonly SceneNode[]): string[] {
  const out: string[] = []
  const visit = (node: SceneNode) => {
    const entry = node as {
      kind: string
      text?: string
      runs?: readonly SceneNode[]
      children?: readonly SceneNode[]
    }
    if (entry.kind === 'textRun' && entry.text !== undefined) out.push(entry.text)
    for (const run of entry.runs ?? []) visit(run)
    for (const child of entry.children ?? []) visit(child)
  }
  for (const node of nodes) visit(node)
  return out
}

describe('layoutMdastBlocks (public) — canvas embeds', () => {
  it('a file node inside the embedded canvas draws the document it references', () => {
    // The note's layout reads two seams; the canvas it embeds reads a third
    // (`resolveReference`, for its file nodes). Forwarding two by hand is
    // how the nested canvas drew every file node as an empty card.
    const NOTE = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
    const withFile: SpatialCanvas = {
      nodes: [{ id: 'f', type: 'file', x: 0, y: 0, width: 400, height: 300, file: NOTE }],
      edges: [],
    }
    const scene = layoutMdastBlocks(body, {
      measure: createFakeMeasure(),
      maxWidth: 600,
      fontFamily: 'sans-serif',
      references: referenceSeams(
        new Map<string, LoadedReference>([
          [A, { documentId: A, name: 'Board', canvas: withFile }],
          [NOTE, { documentId: NOTE, name: 'Note', body: 'PROSE FROM THE NOTE' }],
        ]),
      ),
    })
    const embed = scene.nodes[0]
    if (embed?.kind !== 'embedResolved') throw new Error('expected an embedResolved block')
    expect(textOf(embed.children)).toContain('PROSE FROM THE NOTE')
  })

  it('draws the embedded canvas scaled into the column with no composer supplied', () => {
    const maxWidth = 600
    const scene = layoutMdastBlocks(body, {
      measure: createFakeMeasure(),
      maxWidth,
      fontFamily: 'sans-serif',
      resolveEmbed: (id) => (id === A ? { title: 'Board', canvas } : undefined),
    })
    const embed = scene.nodes[0]
    if (embed?.kind !== 'embedResolved') throw new Error('expected an embedResolved block')
    expect(textOf(embed.children)).toEqual(['Board', 'WIDE NODE', 'LOW NODE'])
    // A 2000px-wide canvas fits the column: nothing inside the frame reaches
    // past it, and the frame is the column's width.
    const frame = embed.children[0]
    if (frame?.kind !== 'shape') throw new Error('expected the frame first')
    expect(frame.bbox.w).toBe(maxWidth)
    for (const child of embed.children) {
      if (!('bbox' in child)) continue
      expect(child.bbox.x + child.bbox.w).toBeLessThanOrEqual(frame.bbox.x + frame.bbox.w + 1e-6)
      expect(child.bbox.y + child.bbox.h).toBeLessThanOrEqual(frame.bbox.y + frame.bbox.h + 1e-6)
    }
  })
})
