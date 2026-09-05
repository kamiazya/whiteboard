/**
 * The verified user flow, locked in: a text node whose body embeds a note
 * draws that note's prose inside the node, the way the markdown preview
 * draws it — through the reference bundle the editor builds from the wire
 * it also posts to the layout worker.
 *
 * Both paths a committed scene can take are covered: a small canvas lays
 * out synchronously, and a canvas past the offload threshold goes through
 * the worker on its first change. The prose has to appear either way, and
 * it did not before the wire existed — a function cannot cross
 * `postMessage`, so the worker drew a placeholder, and for parity the main
 * thread did too.
 */
import { referenceWire } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

const NOTE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

const embeddingNode: SpatialNode = {
  id: 't',
  type: 'text',
  x: 40,
  y: 40,
  width: 320,
  height: 220,
  text: `Plan:\n\n![[${NOTE}]]`,
}

/** Enough bystanders to cross the worker's offload threshold (12 elements). */
const bystanders = (count: number): SpatialNode[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `b${i}`,
    type: 'text' as const,
    x: 500,
    y: 40 + i * 60,
    width: 120,
    height: 40,
    text: `bystander ${i}`,
  }))

const references = referenceWire(
  new Map([[NOTE, { documentId: NOTE, name: 'Note', body: 'PROSE FROM THE NOTE' }]]),
)

const svgText = (container: HTMLElement) =>
  [...container.querySelectorAll('svg text')].map((node) => node.textContent ?? '').join(' ')

afterEach(cleanup)

describe('a text node embedding a note', () => {
  it('draws the note prose inside the node on the synchronous path', async () => {
    const canvas: SpatialCanvas = { nodes: [embeddingNode], edges: [] }
    const { container } = render(
      <SpatialEditor canvas={canvas} onChange={() => {}} references={references} />,
    )
    await waitFor(() => expect(svgText(container)).toContain('PROSE FROM THE NOTE'))
  })

  it('keeps drawing it after a change that lays the canvas out in the worker', async () => {
    const canvas: SpatialCanvas = { nodes: [embeddingNode, ...bystanders(12)], edges: [] }
    const { container, rerender } = render(
      <SpatialEditor canvas={canvas} onChange={() => {}} references={references} />,
    )
    await waitFor(() => expect(svgText(container)).toContain('PROSE FROM THE NOTE'))
    // A committed change past the threshold is what the worker lays out.
    const changed: SpatialCanvas = {
      ...canvas,
      nodes: [...canvas.nodes, ...bystanders(13).slice(12)],
    }
    rerender(<SpatialEditor canvas={changed} onChange={() => {}} references={references} />)
    await waitFor(() => expect(svgText(container)).toContain('bystander 12'))
    expect(svgText(container)).toContain('PROSE FROM THE NOTE')
  })
})
