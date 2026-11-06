// The Draw options strip on a narrow editor, in a real browser: it sits on
// one row rather than wrapping into a half-empty second one, and a pick made
// by pointer looks the same in the colour row as in the width row.

import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { PenStyle } from '../../lib/spatial/pen-style.js'
import { DrawOptions } from './DrawOptions.js'

afterEach(cleanup)

/**
 * An editor with room for the whole strip but less than twice its width. A
 * box centred with `left: 50%` shrinks to fit the half of its container right
 * of that line, which is what wrapped the strip on an upright iPad (820px,
 * with the 44px touch cells) while half the panel stood empty; here the fine
 * pointer's smaller cells (about 400px) meet the same limit at 700.
 */
function Tablet({ pen, onChange }: { pen: PenStyle; onChange: (pen: PenStyle) => void }) {
  return (
    <div style={{ position: 'relative', width: 700, height: 400 }}>
      <DrawOptions pen={pen} palette={SPATIAL_LIGHT_PALETTE} onChange={onChange} />
    </div>
  )
}

it('keeps every draw option on one row when the editor has room for them', async () => {
  render(<Tablet pen={{ width: 'thin' }} onChange={() => {}} />)
  await expect.element(page.getByRole('group', { name: 'Draw options' })).toBeVisible()
  const strip = page.getByTestId('draw-options').element() as HTMLElement
  const tops = new Set(
    [...strip.querySelectorAll('label')].map((label) =>
      Math.round(label.getBoundingClientRect().top),
    ),
  )
  expect(strip.querySelectorAll('label').length).toBe(10)
  expect([...tops]).toHaveLength(1)
})

it('marks a pointer-picked colour and width with the same selected look', async () => {
  let pen: PenStyle = { width: 'thin' }
  const view = render(
    <Tablet
      pen={pen}
      onChange={(next) => {
        pen = next
        view.rerender(<Tablet pen={pen} onChange={() => {}} />)
      }}
    />,
  )
  const options = page.getByRole('group', { name: 'Draw options' })
  await userEvent.click(options.getByTitle('Purple'))
  view.rerender(
    <Tablet
      pen={pen}
      onChange={(next) => {
        pen = next
        view.rerender(<Tablet pen={pen} onChange={() => {}} />)
      }}
    />,
  )
  await userEvent.click(options.getByTitle('Thick'))
  await expect.element(options.getByRole('radio', { name: 'Thick' })).toBeChecked()
  await expect.element(options.getByRole('radio', { name: 'Purple' })).toBeChecked()

  const look = (title: string) => {
    const style = getComputedStyle(options.getByTitle(title).element())
    return { outline: style.outlineStyle, background: style.backgroundColor }
  }
  // The width was picked last, so it holds focus: a pointer's focus draws no ring.
  expect(look('Thick')).toEqual(look('Purple'))
})

it('still rings the draw option a keyboard reaches', async () => {
  render(<Tablet pen={{ width: 'thin' }} onChange={() => {}} />)
  const options = page.getByRole('group', { name: 'Draw options' })
  await expect.element(options).toBeVisible()
  await userEvent.keyboard('{Tab}')
  await expect.element(options.getByRole('radio', { name: 'Default' })).toHaveFocus()
  expect(getComputedStyle(options.getByTitle('Default').element()).outlineStyle).toBe('solid')
})
