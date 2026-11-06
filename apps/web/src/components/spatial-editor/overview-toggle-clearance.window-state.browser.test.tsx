// On a phone the overview's corner button stands just above the dock, and a
// note the editor has just made and brought into view must not land under
// it — its selection handles end up beneath the button, where a press means
// the overview instead of a resize.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { HistoryCluster } from '../../components/history-cluster/HistoryCluster.js'
import { writeMinimapOpen } from '../../lib/minimap-visibility.js'
import { emulateCoarsePointer } from '../../test-utils/coarse-pointer.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import '../../index.css'
import { bottomChromeOcclusionPx } from './ToolPalette.js'

beforeEach(() => writeMinimapOpen(false))
afterEach(async () => {
  await emulateCoarsePointer(false)
  cleanup()
})

const column: SpatialCanvas = {
  nodes: [0, 1, 2, 3, 4].map((row) =>
    textNode({ id: `n${row}`, x: 0, y: row * 140, width: 200, height: 100, text: `N${row}` }),
  ),
  edges: [],
}

const PHONE_PROPS = {
  fileRefOptions: [],
  onAddImage: async () => ({ ok: true as const, ref: 'asset:test' }),
  paletteLeading: <HistoryCluster onUndo={() => {}} onRedo={() => {}} canUndo canRedo />,
}

it('counts the overview button in the strip placement and reveal keep clear', async () => {
  await emulateCoarsePointer(true)
  const { Host } = makeEditorHost({
    initial: column,
    size: { width: 412, height: 839 },
    editorProps: PHONE_PROPS,
  })
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  await expect.element(page.getByTestId('minimap-toggle')).toBeVisible()
  const toggle = container.querySelector('[data-testid="minimap-toggle-wrap"]') as HTMLElement
  const reach = root.getBoundingClientRect().bottom - toggle.getBoundingClientRect().top
  expect(reach).toBeGreaterThan(0)
  expect(bottomChromeOcclusionPx(root)).toBeGreaterThan(reach)
})

/**
 * Two columns filling an upright phone's view but for one slot at the bottom
 * right — the corner the overview's button stands in — so that slot is where
 * a placement that ignores the button puts a new note.
 */
const fullButCorner: SpatialCanvas = {
  nodes: [10, 160, 310, 460, 650].flatMap((y) =>
    [0, 220]
      .filter((x) => !(x === 220 && y === 650))
      .map((x) => textNode({ id: `c${x}-${y}`, x, y, width: 190, height: 100, text: `${x},${y}` })),
  ),
  edges: [],
}

it('brings a new note into view clear of the overview button', async () => {
  await emulateCoarsePointer(true)
  const { Host, latest } = makeEditorHost({
    initial: fullButCorner,
    size: { width: 412, height: 839 },
    editorProps: PHONE_PROPS,
  })
  const { container } = render(<Host />)
  await expect.element(page.getByTestId('minimap-toggle')).toBeVisible()
  await userEvent.click(page.getByTestId('add-button'))
  await userEvent.click(page.getByRole('menuitem', { name: 'Note' }))
  await expect.poll(() => latest.canvas.nodes.length).toBe(fullButCorner.nodes.length + 1)
  const made = latest.canvas.nodes.at(-1)?.id ?? ''
  // Kept, so the editor closes and the overview's button comes back.
  await userEvent.keyboard('Golgi{Control>}{Enter}{/Control}')
  await expect.element(page.getByTestId('minimap-toggle')).toBeVisible()
  const toggle = container.querySelector('[data-testid="minimap-toggle-wrap"]') as HTMLElement
  const noteRect = () =>
    [...container.querySelectorAll<SVGGElement>('g[data-wb-key]')]
      .find((g) => g.dataset.wbKey?.split('#')[0] === made)
      ?.getBoundingClientRect()
  await expect.poll(() => noteRect() !== undefined).toBe(true)
  // The handles sit on the box's corners and reach a few pixels past them.
  const box = noteRect() as DOMRect
  const handles = new DOMRect(box.x - 8, box.y - 8, box.width + 16, box.height + 16)
  const button = toggle.getBoundingClientRect()
  const overlaps = !(
    handles.right <= button.left ||
    handles.left >= button.right ||
    handles.bottom <= button.top ||
    handles.top >= button.bottom
  )
  expect(overlaps, `note ${JSON.stringify(box)} vs button ${JSON.stringify(button)}`).toBe(false)
})
