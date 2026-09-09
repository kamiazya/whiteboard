/**
 * The settings dot has to hang off the GEAR, not off the button's corner.
 *
 * The button is 32px on a mouse and 44px on a finger, while the glyph
 * inside it stays 16px — so a dot pinned to the button's corner drifts
 * further from the thing it is about as the button grows. Measured on a
 * Pixel 7: the dot sat 4px above and 4px right of the gear, and 3.5px from
 * the row's own top edge, which reads as a badge on the corner of the
 * SCREEN rather than a mark on the gear.
 *
 * The size that drifts is the coarse one, and no test can render it (the
 * runner emulates no `pointer: coarse`). So the claim here is the one that
 * makes the drift impossible at any size rather than a measurement at the
 * size that happens to look fine: the dot is positioned against the glyph,
 * so the button's height cannot move it.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, expect, it } from 'vitest'
import '../index.css'
import { AppShell } from './AppShell.js'

afterEach(cleanup)

function renderShell() {
  // `daemon={false}` is itself a reason for the nudge, so the dot is drawn.
  render(
    <RouterProvider
      router={createMemoryRouter([{ path: '*', element: <AppShell daemon={false} /> }], {
        initialEntries: ['/settings'],
      })}
    />,
  )
}

it('hangs the settings dot off the gear, so the button size cannot move it', async () => {
  renderShell()
  const dot = await screen.findByTestId('settings-nudge')
  const button = screen.getByTestId('shell-settings')
  const glyph = button.querySelector('svg') as SVGElement

  // What it is positioned against. A dot offset from the BUTTON is a dot
  // whose distance from the gear is whatever the button's height happens to
  // be; offset from the glyph, it lands in the same place at 32px and 44px.
  expect(dot.offsetParent).not.toBe(button)
  expect(glyph.parentElement?.contains(dot)).toBe(true)

  // And it is on the gear rather than beside it: the two boxes overlap.
  const d = dot.getBoundingClientRect()
  const g = glyph.getBoundingClientRect()
  expect(d.left).toBeLessThan(g.right)
  expect(d.bottom).toBeGreaterThan(g.top)
})
