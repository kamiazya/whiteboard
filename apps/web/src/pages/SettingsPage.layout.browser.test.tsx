import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { findVisibleJourneyBadge } from '../components/settings/SetupJourney.js'
import { setViewport } from '../test-utils/viewport.js'
import { SettingsPage } from './SettingsPage.js'

// Real browser, because every claim here is about LAYOUT: which `sm:` class
// wins at a given width, and whether an element is laid out at all
// (`offsetParent`). jsdom computes neither, so the page's whole reason for
// switching on CSS rather than JS is untestable there.
//
// Unmount between runs: vitest --repeats (CI's stress job) re-executes the
// body in the same page, so a render left mounted accumulates one duplicate
// page per repeat.
afterEach(cleanup)

const WIDE = [1024, 800] as const
const NARROW = [420, 800] as const

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsPage />
    </MemoryRouter>,
  )
}

const laidOut = (el: Element | null | undefined): boolean =>
  el instanceof HTMLElement && el.offsetParent !== null

describe('the settings page, laid out', () => {
  it('draws one copy of a section at either width', async () => {
    await setViewport(...WIDE)
    renderAt('/settings/data')
    expect(await screen.findAllByText('Protect your data')).toHaveLength(1)
    expect(document.querySelectorAll('[data-journey-badge="protect"]')).toHaveLength(1)

    cleanup()
    await setViewport(...NARROW)
    renderAt('/settings/data')
    expect(await screen.findAllByText('Protect your data')).toHaveLength(1)
  })

  // The confetti origin. One badge now, so the question is no longer which of
  // two to pick but whether the one there is actually laid out.
  it('finds the badge to fire confetti from', async () => {
    await setViewport(...WIDE)
    renderAt('/settings/data')
    await screen.findByText('Protect your data')
    expect(laidOut(findVisibleJourneyBadge('protect'))).toBe(true)
  })

  it('shows the sidebar when wide and the back-to-settings row when narrow', async () => {
    await setViewport(...WIDE)
    renderAt('/settings/data')
    await screen.findByText('Protect your data')
    expect(laidOut(screen.getByTestId('settings-nav-desktop'))).toBe(true)
    // queryByRole, and null rather than merely un-laid-out: `display: none`
    // takes it out of the accessibility tree too, so a screen reader at this
    // width is not offered a way back to a list this width does not have.
    expect(screen.queryByRole('link', { name: 'Back to settings' })).toBeNull()

    cleanup()
    await setViewport(...NARROW)
    renderAt('/settings/data')
    await screen.findByText('Protect your data')
    expect(laidOut(screen.getByTestId('settings-nav-desktop'))).toBe(false)
    expect(laidOut(screen.getByRole('link', { name: 'Back to settings' }))).toBe(true)
  })

  it('shows the section list only when narrow, and a section beside it when wide', async () => {
    await setViewport(...NARROW)
    renderAt('/settings')
    expect(laidOut(await screen.findByTestId('settings-nav-mobile'))).toBe(true)
    expect(laidOut(screen.getByTestId('settings-section'))).toBe(false)

    cleanup()
    await setViewport(...WIDE)
    renderAt('/settings')
    expect(laidOut(await screen.findByTestId('settings-section'))).toBe(true)
    expect(laidOut(screen.getByTestId('settings-nav-mobile'))).toBe(false)
  })
})
