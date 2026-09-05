/**
 * The host's wire is wider than the canvas: it carries the references of a
 * body being drafted in the editor overlay, so the overlay's preview
 * resolves a link before the commit. Rows the canvas cannot read must not
 * lay it out again — measured by the synchronous render, which the editor
 * memoizes on the seams' identity, the same identity the worker request
 * and the content cache key on.
 */
import { referenceWire } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as sceneRender from '../../lib/spatial/scene-render.js'
import { SpatialEditor } from './SpatialEditor.js'

vi.mock('../../lib/spatial/scene-render.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/spatial/scene-render.js')>()
  return { ...actual, renderCanvasToSvg: vi.fn(actual.renderCanvasToSvg) }
})

afterEach(cleanup)

const NOTE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const canvas: SpatialCanvas = {
  nodes: [
    { id: 't', type: 'text', x: 40, y: 40, width: 320, height: 200, text: `Plan:\n\n![[${NOTE}]]` },
  ],
  edges: [],
}
const wireWith = (entries: [string, { body: string }][]) =>
  referenceWire(
    new Map(entries.map(([key, entry]) => [key, { documentId: key, name: key, ...entry }])),
  )

const svgText = (container: HTMLElement) =>
  [...container.querySelectorAll('svg text')].map((node) => node.textContent ?? '').join(' ')

describe('the wire the canvas lays out against', () => {
  it('does not re-lay out for rows the canvas cannot read, and does for one it can', async () => {
    const renders = vi.mocked(sceneRender.renderCanvasToSvg)
    const base = wireWith([[NOTE, { body: 'THE NOTE' }]])
    const { container, rerender } = render(
      <SpatialEditor canvas={canvas} onChange={() => {}} references={base} />,
    )
    await waitFor(() => expect(svgText(container)).toContain('THE NOTE'))
    const before = renders.mock.calls.length

    // A draft beside the canvas named another note and the host loaded it.
    const grown = wireWith([
      [NOTE, { body: 'THE NOTE' }],
      ['01BX5ZZKBKACTAV9WEVGEMMVRZ', { body: 'DRAFTED BESIDE THE CANVAS' }],
    ])
    rerender(<SpatialEditor canvas={canvas} onChange={() => {}} references={grown} />)
    expect(renders.mock.calls.length).toBe(before)

    // The note the canvas embeds was edited elsewhere: that is a re-layout.
    const edited = wireWith([[NOTE, { body: 'THE NOTE, REVISED' }]])
    rerender(<SpatialEditor canvas={canvas} onChange={() => {}} references={edited} />)
    await waitFor(() => expect(svgText(container)).toContain('THE NOTE, REVISED'))
    expect(renders.mock.calls.length).toBeGreaterThan(before)
  })
})
