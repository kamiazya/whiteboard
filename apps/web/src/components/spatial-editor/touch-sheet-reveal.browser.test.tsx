/**
 * The long-press sheet on a coarse pointer must not bury what was pressed:
 * the node sits low on the canvas, the sheet takes at most half of it, and
 * the viewport pans so the node ends up above the sheet's top edge.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rightClick } from '../../test-utils/spatial-editor-pointer.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const board: SpatialCanvas = {
  nodes: [textNode({ id: 'low', x: 100, y: 430, width: 200, height: 80, text: 'Events Queue' })],
  edges: [],
}

it('pans the pressed node above the sheet and names the sheet for it', async () => {
  const realMatchMedia = window.matchMedia.bind(window)
  vi.stubGlobal('matchMedia', (query: string) =>
    query.includes('pointer: coarse')
      ? ({ ...realMatchMedia('all'), matches: true } as MediaQueryList)
      : realMatchMedia(query),
  )
  const host = makeEditorHost({ initial: board, size: { width: 400, height: 640 } })
  const { container } = render(<host.Host />)
  const root = rootOf(container)
  const nodeEl = () =>
    container.querySelector('[data-testid="viewport-transform"] svg rect') as SVGElement
  const node = nodeEl().getBoundingClientRect()
  const rootBox = root.getBoundingClientRect()
  rightClick(root, node.left - rootBox.left + 20, node.top - rootBox.top + 20)

  await expect
    .element(page.getByRole('menu', { name: 'Actions for Note: Events Queue' }))
    .toBeVisible()
  const sheetTop =
    document.querySelector('[data-testid="context-menu"]')?.getBoundingClientRect().top ?? 0
  await vi.waitFor(() =>
    expect(nodeEl().getBoundingClientRect().bottom).toBeLessThanOrEqual(sheetTop),
  )
})
