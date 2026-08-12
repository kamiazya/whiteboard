import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrandStatusPage } from './BrandStatusPage.js'

afterEach(cleanup)

describe('BrandStatusPage', () => {
  it('renders the scribble mark for the error variant', () => {
    render(<BrandStatusPage variant="error" title="Something went wrong" description="d" />)
    expect(document.querySelector('[data-mark="scribble"]')).toBeTruthy()
    expect(screen.getByText('Something went wrong')).toBeTruthy()
  })

  it('renders the wandering-squiggle mark for the not-found variant', () => {
    render(<BrandStatusPage variant="not-found" title="Nothing here" description="d" />)
    expect(document.querySelector('[data-mark="not-found"]')).toBeTruthy()
  })

  it('renders provided actions', () => {
    const onClick = vi.fn()
    render(
      <BrandStatusPage
        variant="error"
        title="t"
        description="d"
        actions={[{ label: 'Reload', onClick }]}
      />,
    )
    screen.getByRole('button', { name: 'Reload' }).click()
    expect(onClick).toHaveBeenCalled()
  })
})
