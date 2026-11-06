// A selected path's more-actions chip must leave the path's own handles
// grabbable. Its home is above the top-right corner of the selection, and a
// stroke that ends at that corner put its end handle right under the chip —
// on a finger, whose press target is 44px, the two shared most of their area.

import type { CanvasLine, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { freehandLine } from '../../lib/spatial/freehand.js'
import { tick } from '../../test-utils/async.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { touch } from '../../test-utils/spatial-editor-pointer.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

/** A rising stroke whose END is its top-right extreme. */
const samples = Array.from({ length: 31 }, (_, i) => ({
  x: 150 + i * 10,
  y: Math.round(320 - i * 6 - 30 * Math.sin((i / 30) * Math.PI)),
}))
const drawing = freehandLine('ink1', samples, 1) as CanvasLine
const board: SpatialCanvas = { nodes: [], edges: [], lines: [drawing] }
const onStroke = drawing.bends?.[Math.floor((drawing.bends?.length ?? 0) / 2)] as {
  x: number
  y: number
}

/** A ruled line whose bend is its top-right extreme. */
const ruled: SpatialCanvas = {
  nodes: [],
  edges: [],
  lines: [
    {
      id: 'rule',
      from: { kind: 'point', point: { x: 150, y: 320 }, end: 'none' },
      to: { kind: 'point', point: { x: 300, y: 320 }, end: 'none' },
      bends: [{ x: 450, y: 140 }],
    },
  ],
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

async function selectAndFindChip(container: HTMLElement, at: { x: number; y: number }) {
  const root = rootOf(container)
  touch(root, 'pointerdown', at.x, at.y)
  await tick()
  touch(root, 'pointerup', at.x, at.y)
  await tick()
  return vi.waitFor(() => {
    const chip = container.querySelector('[data-testid="path-more-actions"]')
    expect(chip).not.toBeNull()
    return chip as Element
  })
}

async function withCoarsePointer(run: () => Promise<void>) {
  const realMatchMedia = window.matchMedia
  window.matchMedia = (query: string) =>
    query === '(pointer: coarse)'
      ? ({ matches: true, media: query } as MediaQueryList)
      : realMatchMedia.call(window, query)
  try {
    await run()
  } finally {
    window.matchMedia = realMatchMedia
  }
}

it("keeps the more-actions chip off a drawing's end handle", async () => {
  const { Host } = makeEditorHost({ initial: board })
  const { container } = render(<Host />)
  const chip = await selectAndFindChip(container, onStroke)
  const end = container.querySelector('[data-testid="edge-end-handle-to"]') as Element
  expect(end).not.toBeNull()
  expect(overlaps(chip.getBoundingClientRect(), end.getBoundingClientRect())).toBe(false)
})

it("keeps the chip off a drawing's end press target on touch", async () => {
  await withCoarsePointer(async () => {
    const { Host } = makeEditorHost({ initial: board })
    const { container } = render(<Host />)
    const chip = await selectAndFindChip(container, onStroke)
    const hits = [...container.querySelectorAll('[data-testid^="edge-end-hit-"]')]
    expect(hits).toHaveLength(2)
    for (const hit of hits) {
      expect(overlaps(chip.getBoundingClientRect(), hit.getBoundingClientRect())).toBe(false)
    }
  })
})

it("keeps the chip off a ruled line's bend handle", async () => {
  const { Host } = makeEditorHost({ initial: ruled })
  const { container } = render(<Host />)
  const chip = await selectAndFindChip(container, { x: 375, y: 230 })
  const bends = [...container.querySelectorAll('[data-testid="edge-bend-handle"]')]
  expect(bends.length).toBeGreaterThan(0)
  for (const bend of bends) {
    expect(overlaps(chip.getBoundingClientRect(), bend.getBoundingClientRect())).toBe(false)
  }
})
