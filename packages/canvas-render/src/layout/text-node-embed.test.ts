/**
 * A text node's body is markdown like a note's, so what it writes in the
 * reference grammar resolves the same way: `![[id]]` draws the document,
 * `[[id]]` is labelled by its title. Nothing did this before — the composer
 * parsed the body and laid the literal brackets out — and the wire to the
 * layout worker only made the omission visible on both threads at once.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { referenceSeams } from '../references/seams.js'
import type { SceneNode } from '../scene-graph.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'

const NOTE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const APPEARANCE = { resolveNode: () => ({}), resolveEdge: () => ({}), resolveLabel: () => ({}) }

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

const canvas: SpatialCanvas = {
  nodes: [
    {
      id: 't',
      type: 'text',
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      text: `See [[${NOTE}]]\n\n![[${NOTE}]]`,
    },
  ],
  edges: [],
}

describe('a text node body in the reference grammar', () => {
  it('embeds the document and labels the link through the reference bundle', () => {
    const scene = layoutSpatialCanvas(canvas, {
      measure: createFakeMeasure(),
      appearance: APPEARANCE,
      references: referenceSeams(
        new Map([[NOTE, { documentId: NOTE, name: 'Note', body: 'PROSE FROM THE NOTE' }]]),
      ),
    })
    const text = textOf(scene.nodes).join(' ')
    expect(text).toContain('PROSE FROM THE NOTE')
    expect(text).toContain('Note')
    expect(text).not.toContain('![[')
  })

  it('keeps a target nobody resolves as the literal text the author wrote', () => {
    const literal: SpatialCanvas = {
      nodes: [
        { id: 't', type: 'text', x: 0, y: 0, width: 400, height: 100, text: 'See [[nowhere]]' },
      ],
      edges: [],
    }
    const scene = layoutSpatialCanvas(literal, {
      measure: createFakeMeasure(),
      appearance: APPEARANCE,
    })
    expect(textOf(scene.nodes).join(' ')).toContain('[[nowhere]]')
  })
})
