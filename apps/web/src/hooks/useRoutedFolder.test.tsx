// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { useRoutedFolder } from './useRoutedFolder.js'

function Probe() {
  const { folder, setFolder } = useRoutedFolder()
  const location = useLocation()
  const navigationType = useNavigationType()
  return (
    <div>
      <span data-testid="folder">{folder}</span>
      <span data-testid="search">{location.search}</span>
      <span data-testid="nav-type">{navigationType}</span>
      <button type="button" onClick={() => setFolder('design')}>
        go design
      </button>
      <button type="button" onClick={() => setFolder('')}>
        go root
      </button>
    </div>
  )
}

describe('useRoutedFolder', () => {
  it('reads the folder out of the address', () => {
    render(
      <MemoryRouter initialEntries={['/?folder=design/login']}>
        <Probe />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('folder').textContent).toBe('design/login')
  })

  it('drops the parameter entirely at the root, rather than leaving ?folder=', () => {
    render(
      <MemoryRouter initialEntries={['/?folder=design']}>
        <Probe />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'go root' }))
    expect(screen.getByTestId('search').textContent).toBe('')
  })

  // The invariant the panel's design rests on. `initialFolder` seeds the
  // panel's own state and is not re-read, so the panel cannot follow a Back
  // that changes only the query string — and REPLACE is what guarantees no
  // such history entry is ever created. Switch this to a push and the URL
  // and the UI can disagree with nothing to notice it.
  it('replaces rather than pushes, so a folder move is never its own history entry', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Probe />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'go design' }))

    expect(screen.getByTestId('search').textContent).toBe('?folder=design')
    // `location.key` is NOT the discriminator — react-router mints a fresh
    // one for a replace too (measured: 'default' -> '1gpnmn5o'). The
    // navigation type is what actually distinguishes them.
    expect(screen.getByTestId('nav-type').textContent).toBe('REPLACE')
  })
})
