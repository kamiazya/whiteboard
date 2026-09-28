import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { settingsPath } from '../lib/app-routes.js'
import { BrowserCapacityNotice } from './BrowserCapacityNotice.js'

const capacity = { bandStartsAt: 3, limit: 5 }

function renderAt(documentCount: number) {
  return render(
    <MemoryRouter>
      <BrowserCapacityNotice documentCount={documentCount} capacity={capacity} />
    </MemoryRouter>,
  )
}

describe('BrowserCapacityNotice', () => {
  it('says nothing while there is room', () => {
    const { container } = renderAt(2)
    expect(container.textContent).toBe('')
  })

  it('in the band, offers the move before adding is refused', () => {
    renderAt(3)
    const notice = screen.getByRole('status')
    expect(notice.textContent).toMatch(/3 documents/)
    expect(notice.textContent).toMatch(/up to 5/)
    expect(screen.getByRole('link', { name: /move this workspace/i }).getAttribute('href')).toBe(
      settingsPath('connections'),
    )
  })

  it('at the limit, says adding is refused and where to move it', () => {
    renderAt(5)
    expect(screen.getByRole('status').textContent).toMatch(/cannot add/i)
    expect(screen.getByRole('link', { name: /move this workspace/i })).toBeTruthy()
  })
})
