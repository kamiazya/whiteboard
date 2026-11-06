// The overview and the dock share the editor's bottom edge. The dock is
// centred and its width is whatever its tools add up to — on touch, with the
// Draw and Eraser tools, it ran about 530px and an upright iPad's overview sat
// 30px under its right end. Whatever the dock's width, the two stay clear.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'

afterEach(cleanup)

const spread: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 100, height: 60, text: 'A' }),
    textNode({ id: 'b', x: 2000, y: 1200, width: 100, height: 60, text: 'B' }),
  ],
  edges: [],
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

it('lifts the overview clear of a dock wide enough to reach under it', async () => {
  const { Host } = makeEditorHost({ initial: spread, size: { width: 800, height: 600 } })
  const { container } = render(<Host />)
  const minimap = () => container.querySelector('[data-testid="minimap"]') as HTMLElement
  const dock = container.querySelector('[data-testid="tool-palette"]') as HTMLElement
  expect(minimap()).toBeTruthy()
  expect(dock).toBeTruthy()
  const restingBottom = minimap().getBoundingClientRect().bottom

  // The touch dock's width, which the fine pointer's dock does not reach.
  dock.style.minWidth = '560px'
  expect(dock.getBoundingClientRect().right).toBeGreaterThan(minimap().getBoundingClientRect().left)
  await expect
    .poll(() => overlaps(minimap().getBoundingClientRect(), dock.getBoundingClientRect()))
    .toBe(false)
  expect(minimap().getBoundingClientRect().bottom).toBeLessThan(dock.getBoundingClientRect().top)

  // And back down once the dock no longer reaches it.
  dock.style.minWidth = ''
  await expect.poll(() => minimap().getBoundingClientRect().bottom).toBe(restingBottom)
})

it('stands clear of the Draw options strip as well as the dock', async () => {
  const { Host } = makeEditorHost({
    initial: spread,
    tool: 'draw',
    size: { width: 800, height: 600 },
  })
  const { container } = render(<Host />)
  const minimap = () => container.querySelector('[data-testid="minimap"]') as HTMLElement
  const dock = container.querySelector('[data-testid="tool-palette"]') as HTMLElement
  const strip = container.querySelector('[data-testid="draw-options"]') as HTMLElement
  expect(strip).toBeTruthy()
  // A sibling, which is what lets the overview notice the strip arriving
  // with the tool by watching its own parent's children.
  expect(strip.parentElement).toBe(minimap().parentElement)
  // Touch widths: the dock's, and the strip's 44px cells.
  dock.style.minWidth = '560px'
  strip.style.minWidth = '560px'
  await expect
    .poll(() =>
      [dock, strip].some((chrome) =>
        overlaps(minimap().getBoundingClientRect(), chrome.getBoundingClientRect()),
      ),
    )
    .toBe(false)
  expect(minimap().getBoundingClientRect().bottom).toBeLessThan(strip.getBoundingClientRect().top)
})
