import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUserSettingsStore } from '../lib/user-settings-store.js'
import { BetaBanner } from './BetaBanner.js'

afterEach(cleanup)

describe('BetaBanner', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('renders the beta message when not dismissed', () => {
    render(
      <BetaBanner
        store={createUserSettingsStore()}
        message="Beta preview — your data is stored only in this browser."
      />,
    )
    expect(
      screen.getByText('Beta preview — your data is stored only in this browser.'),
    ).toBeTruthy()
  })

  it('hides itself and records the dismissal in the settings store when dismissed', () => {
    const store = createUserSettingsStore()
    render(
      <BetaBanner
        store={store}
        message="Beta preview — your data is stored only in this browser."
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))

    expect(
      screen.queryByText('Beta preview — your data is stored only in this browser.'),
    ).toBeNull()
    expect(store.load().storage.dismissedBetaBannerAt).toEqual(expect.any(String))
  })

  it('stays hidden across a fresh instance after dismissal (reload simulation)', () => {
    const store = createUserSettingsStore()
    render(
      <BetaBanner
        store={store}
        message="Beta preview — your data is stored only in this browser."
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    cleanup()

    render(
      <BetaBanner
        store={createUserSettingsStore()}
        message="Beta preview — your data is stored only in this browser."
      />,
    )
    expect(
      screen.queryByText('Beta preview — your data is stored only in this browser.'),
    ).toBeNull()
  })

  it('does not render when the store already has a dismissal recorded', () => {
    const store = createUserSettingsStore()
    store.update((current) => ({
      ...current,
      storage: { ...current.storage, dismissedBetaBannerAt: '2026-07-05T00:00:00.000Z' },
    }))

    render(
      <BetaBanner
        store={store}
        message="Beta preview — your data is stored only in this browser."
      />,
    )
    expect(
      screen.queryByText('Beta preview — your data is stored only in this browser.'),
    ).toBeNull()
  })
})
