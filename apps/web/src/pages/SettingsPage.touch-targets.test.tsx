import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsPage } from './SettingsPage.js'

afterEach(cleanup)

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsPage />
    </MemoryRouter>,
  )
}

describe('SettingsPage back controls on touch', () => {
  it('make the section list Back a 44px target', () => {
    renderAt('/settings')
    const back = within(screen.getByTestId('settings-nav-mobile')).getByRole('button', {
      name: 'Back',
    })
    expect(back.className).toMatch(/pointer-coarse:min-h-11/)
    expect(back.className).toMatch(/pointer-coarse:min-w-11/)
  })

  it('make Back to settings a 44px target', () => {
    renderAt('/settings/data')
    const back = screen.getByRole('link', { name: 'Back to settings' })
    expect(back.className).toMatch(/pointer-coarse:min-h-11/)
    expect(back.className).toMatch(/pointer-coarse:min-w-11/)
  })
})
