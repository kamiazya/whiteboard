// The Draw tool's options in a real browser: the strip shows while the pen
// is armed, a pick reaches the next stroke, and the choice outlives the
// editor that made it for the rest of the tab. A pick clicks the option's
// LABEL, which is what a hand presses: the radio itself is clipped to a pixel.

import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { VISUAL_STROKE_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { touch } from '../../test-utils/spatial-editor-pointer.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

// The pen's key alone: storage is the origin's, shared with every file
// running beside this one.
afterEach(() => {
  cleanup()
  sessionStorage.removeItem('wb.pen')
})

const empty: SpatialCanvas = { nodes: [], edges: [] }

function mouseStroke(root: HTMLElement, path: readonly (readonly [number, number])[]) {
  const r = root.getBoundingClientRect()
  const at = (x: number, y: number) => ({ clientX: r.left + x, clientY: r.top + y })
  const [first, ...rest] = path as [readonly [number, number], ...(readonly [number, number])[]]
  root.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, button: 0, ...at(...first) }),
  )
  for (const [x, y] of rest) {
    root.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerId: 9, buttons: 1, ...at(x, y) }),
    )
  }
  const last = path[path.length - 1] as readonly [number, number]
  root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9, ...at(...last) }))
}

const WAVE = [
  [120, 400],
  [240, 180],
  [380, 420],
  [520, 200],
] as const

it('draws the next stroke in the colour and width picked in the strip', async () => {
  const { Host, latest } = makeEditorHost({ initial: empty, tool: 'draw' })
  const { container } = render(<Host />)

  const options = page.getByRole('group', { name: 'Draw options' })
  await expect.element(options).toBeVisible()
  await userEvent.click(options.getByTitle('Green'))
  await userEvent.click(options.getByTitle('Thick'))
  await expect.element(options.getByRole('radio', { name: 'Thick' })).toBeChecked()

  mouseStroke(rootOf(container), WAVE)

  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(1)
  const line = latest.canvas.lines?.[0]
  expect(line?.color).toBe('4')
  expect(line?.facets?.[VISUAL_STROKE_KEY]).toEqual({ width: 'thick' })
})

it('draws by touch with the width picked in the strip', async () => {
  const { Host, latest } = makeEditorHost({ initial: empty, tool: 'draw' })
  const { container } = render(<Host />)

  const options = page.getByRole('group', { name: 'Draw options' })
  await userEvent.click(options.getByTitle('Medium'))
  const root = rootOf(container)
  touch(root, 'pointerdown', 120, 400)
  for (const [x, y] of WAVE.slice(1)) touch(root, 'pointermove', x, y)
  touch(root, 'pointerup', 520, 200)

  await expect.poll(() => latest.canvas.lines?.length ?? 0).toBe(1)
  expect(latest.canvas.lines?.[0]?.facets?.[VISUAL_STROKE_KEY]).toEqual({ width: 'medium' })
  expect(latest.canvas.lines?.[0]).not.toHaveProperty('color')
})

it('remembers the pen for the tab, across a fresh editor', async () => {
  const first = makeEditorHost({ initial: empty, tool: 'draw' })
  const { unmount } = render(<first.Host />)
  await userEvent.click(page.getByRole('group', { name: 'Draw options' }).getByTitle('Purple'))
  unmount()

  const second = makeEditorHost({ initial: empty, tool: 'draw' })
  render(<second.Host />)
  await expect
    .element(
      page.getByRole('group', { name: 'Draw options' }).getByRole('radio', { name: 'Purple' }),
    )
    .toBeChecked()
})

it('shows the stroke under the pen in the colour and width it will land in', async () => {
  const { Host } = makeEditorHost({ initial: empty, tool: 'draw' })
  const { container } = render(<Host />)
  const options = page.getByRole('group', { name: 'Draw options' })
  await userEvent.click(options.getByTitle('Green'))
  await userEvent.click(options.getByTitle('Thick'))

  const root = rootOf(container)
  touch(root, 'pointerdown', 120, 400)
  touch(root, 'pointermove', 240, 180)
  await expect.element(page.getByTestId('ink-draft')).toBeInTheDocument()
  const draft = page.getByTestId('ink-draft').element().querySelector('polyline')
  expect(draft?.getAttribute('stroke')).toBe(SPATIAL_LIGHT_PALETTE.presets['4'].stroke)
  expect(Number(draft?.getAttribute('stroke-width'))).toBe(5)
  touch(root, 'pointerup', 380, 420)
})

it('shows no draw options while another tool is armed', async () => {
  const { Host } = makeEditorHost({ initial: empty, tool: 'select' })
  render(<Host />)
  await expect.element(page.getByTestId('tool-palette')).toBeVisible()
  expect(page.getByRole('group', { name: 'Draw options' }).query()).toBeNull()
})
