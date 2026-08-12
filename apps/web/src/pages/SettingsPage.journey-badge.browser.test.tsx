import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { findVisibleJourneyBadge } from '@/components/settings/SetupJourney'
import { SettingsPage } from './SettingsPage.js'

// Real browser: the settings page renders the journey twice (hidden mobile +
// desktop structures, switched by `sm:` CSS), and findVisibleJourneyBadge
// disambiguates them via offsetParent — layout jsdom cannot compute, so the
// selection branch is only testable here.
describe('findVisibleJourneyBadge (real browser)', () => {
  it('picks the laid-out badge, not the display:none duplicate', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/data']}>
        <SettingsPage />
      </MemoryRouter>,
    )
    await screen.findAllByText('Protect your data')

    const badges = Array.from(
      document.querySelectorAll<HTMLElement>('[data-journey-badge="protect"]'),
    )
    expect(badges.length).toBe(2)

    const picked = findVisibleJourneyBadge('protect')
    expect(picked).toBeTruthy()
    // The browser-mode viewport is desktop-sized, so the visible instance is
    // the one inside the desktop pane; the mobile duplicate is display:none.
    expect(picked?.closest('[data-testid="settings-desktop"]')).toBeTruthy()
    const hidden = badges.find((el) => el !== picked)
    expect(hidden?.offsetParent).toBeNull()
  })
})
