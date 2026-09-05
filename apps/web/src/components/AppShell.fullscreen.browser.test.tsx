/**
 * The shell's fullscreen, in a real browser: which affordance it offers
 * (jsdom implements no part of the Fullscreen API, so the capability
 * decision can only be stated here), and what the app's ground is once the
 * request is granted.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { AppShell } from './AppShell.js'
import '../index.css'

afterEach(async () => {
  if (document.fullscreenElement !== null) await document.exitFullscreen()
  cleanup()
  vi.restoreAllMocks()
})

function stubFullscreenEnabled(value: boolean) {
  vi.spyOn(document, 'fullscreenEnabled', 'get').mockReturnValue(value)
  // A browser that answers `false` on the standard property and offers no
  // prefixed one is the iPhone Safari shape.
  Object.defineProperty(document, 'webkitFullscreenEnabled', {
    configurable: true,
    get: () => undefined,
  })
}

function makeRouter() {
  return createMemoryRouter([{ path: '*', element: <AppShell daemon={false} /> }], {
    initialEntries: ['/settings'],
  })
}

function renderShell() {
  render(<RouterProvider router={makeRouter()} />)
}

it('offers Fullscreen in the shell row where the browser supports it', () => {
  stubFullscreenEnabled(true)
  renderShell()
  expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeTruthy()
})

it('hides Fullscreen where the browser has none', () => {
  stubFullscreenEnabled(false)
  renderShell()
  expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull()
  // …and the gear keeps its place: the row is not emptied with it.
  expect(screen.getByTestId('shell-settings')).toBeTruthy()
})

it('hides Fullscreen on the real iPhone shape: no element API at all', () => {
  // The shape that shipped the first version of this bug. iPhone Safari's
  // Fullscreen API is video-only: documentElement has no
  // requestFullscreen, AND `fullscreenEnabled` is not implemented either
  // — so a check that only rejected an explicit `false` let the button
  // through on exactly the device it was hidden for.
  const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: unknown }
  const original = Object.getOwnPropertyDescriptor(Element.prototype, 'requestFullscreen')
  Object.defineProperty(root, 'requestFullscreen', { configurable: true, value: undefined })
  Object.defineProperty(root, 'webkitRequestFullscreen', { configurable: true, value: undefined })
  try {
    renderShell()
    expect(screen.queryByRole('button', { name: 'Fullscreen' })).toBeNull()
  } finally {
    delete (root as { requestFullscreen?: unknown }).requestFullscreen
    delete (root as { webkitRequestFullscreen?: unknown }).webkitRequestFullscreen
    expect(original).toBeDefined()
  }
})

it('fullscreens the ROOT, which takes no black backdrop the way an element does', async () => {
  render(<RouterProvider router={makeRouter()} />)
  // A real click carries the user activation requestFullscreen requires.
  await userEvent.click(await screen.findByRole('button', { name: 'Fullscreen' }))
  await vi.waitFor(() => expect(document.fullscreenElement).toBe(document.documentElement))

  // The measured reason the pages carry no fullscreen ground any more. The
  // Fullscreen spec paints a black `::backdrop` behind `:not(:root)`, so a
  // page's `<main>` promoted to the top layer sat over black and had to
  // paint `bg-background` itself — which is what turned the canvas area
  // black under a light theme when it did not. The ROOT is excluded from
  // that rule, and the body's ground propagates to the canvas.
  expect(getComputedStyle(document.documentElement, '::backdrop').backgroundColor).toBe(
    'rgba(0, 0, 0, 0)',
  )
  expect(getComputedStyle(document.body).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')

  // The counterfactual, in the same run rather than from the spec text: an
  // ELEMENT really does get the black slab this target avoids.
  // `findBy`, not `getBy`: leaving fullscreen restores the row on the
  // document's own `fullscreenchange`, which is a render AFTER
  // exitFullscreen() resolves — so the control is not there yet on the very
  // next line.
  await document.exitFullscreen()
  await userEvent.click(await screen.findByRole('button', { name: 'Fullscreen' }))
  const element = document.createElement('div')
  document.body.append(element)
  try {
    await element.requestFullscreen()
    expect(getComputedStyle(element, '::backdrop').backgroundColor).toBe('rgb(0, 0, 0)')
  } finally {
    element.remove()
  }
})
