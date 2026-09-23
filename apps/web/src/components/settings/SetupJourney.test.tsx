import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { SetupJourney } from './SetupJourney.js'

// The journey is the durability ladder AND the storage report: each step
// carries its own measured evidence (user decision, 2026-09-01 — no separate
// Storage tab; the step-form stays the one place).

function renderJourney(over?: Partial<Parameters<typeof SetupJourney>[0]>) {
  return render(
    <MemoryRouter>
      <SetupJourney
        persist="todo"
        protecting={false}
        onProtect={() => {}}
        install="not-captured"
        onInstall={() => {}}
        daemonConnected={false}
        {...over}
      />
    </MemoryRouter>,
  )
}

describe('SetupJourney — storage evidence on the steps', () => {
  it('the Protect step states measured usage and quota when an estimate is available', () => {
    renderJourney({ estimate: { usageBytes: 2_621_440, quotaBytes: 107_374_182_400 } })
    const detail = document.querySelector('[data-journey-detail="protect"]')
    expect(detail).not.toBeNull()
    expect(detail?.textContent).toMatch(/2\.5 MiB used/)
    expect(detail?.textContent).toMatch(/100\.0 GiB available/)
  })

  it('the Protect step keeps its evidence after the grant (done variant)', () => {
    renderJourney({
      persist: 'granted',
      estimate: { usageBytes: 2_621_440, quotaBytes: 107_374_182_400 },
    })
    const detail = document.querySelector('[data-journey-detail="protect"]')
    expect(detail?.textContent).toMatch(/2\.5 MiB used/)
  })

  it('offers Protect only while it can still be asked for, and names who granted it', () => {
    // The two done states are not interchangeable: `granted` is this site's
    // own permission and `browser-managed` is a browser that decides for
    // itself, and a reader acting on the wrong one would look for a setting
    // that is not theirs to change. Neither offers the button, because
    // there is nothing left to ask.
    renderJourney({ persist: 'granted' })
    expect(screen.getByText('granted')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Protect' })).toBeNull()

    renderJourney({ persist: 'browser-managed' })
    expect(screen.getByText('managed by the browser')).toBeTruthy()

    // ...and `todo` is the one state that CAN be asked.
    renderJourney({ persist: 'todo' })
    expect(screen.getByRole('button', { name: 'Protect' })).toBeTruthy()
  })

  it('renders no usage line when the estimate is unavailable', () => {
    renderJourney({ estimate: null })
    // Subject presence: the step itself rendered — absence on an empty page
    // would prove nothing.
    expect(screen.getByText('Protect your data')).toBeTruthy()
    expect(document.querySelector('[data-journey-detail="protect"]')).toBeNull()
  })

  it('the connected companion step states what it keeps, linking to the breakdown', () => {
    renderJourney({ daemonConnected: true, daemonStorageBytes: 108_003_328 })
    const detail = document.querySelector('[data-journey-detail="daemon"]')
    expect(detail).not.toBeNull()
    expect(detail?.textContent).toMatch(/103\.0 MiB on this computer/)
    const link = screen.getByRole('link', { name: /breakdown/i })
    expect(link.getAttribute('href')).toBe('/settings/connections')
  })

  it('a connected step without a report shows plain connected, no dangling line', () => {
    renderJourney({ daemonConnected: true, daemonStorageBytes: null })
    expect(screen.getByText('connected')).toBeTruthy()
    expect(document.querySelector('[data-journey-detail="daemon"]')).toBeNull()
  })

  it('shows no companion figure while disconnected even if a stale value is passed', () => {
    renderJourney({ daemonConnected: false, daemonStorageBytes: 108_003_328 })
    expect(document.querySelector('[data-journey-detail="daemon"]')).toBeNull()
  })
})
