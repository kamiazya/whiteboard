import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SquiggleLoader } from './SquiggleLoader.js'

afterEach(cleanup)

describe('SquiggleLoader', () => {
  it('renders the branded loader mark with an accessible status label', () => {
    render(<SquiggleLoader label="Loading…" />)
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('Loading…')
    expect(status.querySelector('[data-mark="loader"]')).toBeTruthy()
  })
})
