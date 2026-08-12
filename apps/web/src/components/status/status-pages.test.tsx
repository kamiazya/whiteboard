import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorFallback } from './ErrorFallback.js'
import { NotFoundPage } from './NotFoundPage.js'

afterEach(cleanup)

describe('ErrorFallback', () => {
  it('renders the external scribble mark and both recovery actions', () => {
    const onRetry = vi.fn()
    render(<ErrorFallback onRetry={onRetry} />)
    const mark = document.querySelector('svg[data-mark="scribble"]')
    expect(mark?.querySelector('.wb-scribble')).toBeTruthy()
    screen.getByRole('button', { name: 'Try again' }).click()
    expect(onRetry).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
  })
})

describe('NotFoundPage', () => {
  it('renders the external wandering-squiggle mark and the back action', () => {
    const onBack = vi.fn()
    render(<NotFoundPage onBack={onBack} />)
    const mark = document.querySelector('svg[data-mark="not-found"]')
    expect(mark).toBeTruthy()
    screen.getByRole('button', { name: 'Back to canvases' }).click()
    expect(onBack).toHaveBeenCalled()
  })
})
