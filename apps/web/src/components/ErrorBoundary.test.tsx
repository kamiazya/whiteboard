import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary, errorBoundaryLog } from './ErrorBoundary.js'

// Verify that ErrorBoundary renders its fallback on throw and allows recovery via "Try again".

function Bomb({ trigger }: { trigger: boolean }): JSX.Element {
  if (trigger) throw new Error('boom')
  return <div data-testid="bomb-ok">ok</div>
}

describe('ErrorBoundary', () => {
  // Suppress jsdom's console.error noise for intentional throws.
  const originalError = console.error
  afterEach(() => {
    cleanup()
    console.error = originalError
  })

  it('shows the fallback when a child throws', () => {
    console.error = vi.fn()
    render(
      <ErrorBoundary>
        <Bomb trigger />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('Something went wrong')).toBeTruthy()
    expect(screen.getByText(/boom/)).toBeTruthy()
  })

  it('resets on "Try again" and re-renders the child once the error is gone', () => {
    console.error = vi.fn()
    function Holder({ trigger }: { trigger: boolean }) {
      return (
        <ErrorBoundary>
          <Bomb trigger={trigger} />
        </ErrorBoundary>
      )
    }
    const { rerender } = render(<Holder trigger />)
    expect(screen.getByRole('alert')).toBeTruthy()
    // Clear the parent trigger, then click Try again.
    rerender(<Holder trigger={false} />)
    fireEvent.click(screen.getByText('Try again'))
    expect(screen.getByTestId('bomb-ok')).toBeTruthy()
  })

  it('allows the fallback prop to override the UI', () => {
    console.error = vi.fn()
    render(
      <ErrorBoundary
        fallback={({ error, reset }) => (
          <div data-testid="custom-fallback">
            custom: {error.message}
            <button type="button" onClick={reset}>
              custom reset
            </button>
          </div>
        )}
      >
        <Bomb trigger />
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('custom-fallback')).toBeTruthy()
    expect(screen.getByText('custom: boom')).toBeTruthy()
  })

  it('reports the caught error through the module-local logging seam', () => {
    const seamSpy = vi.spyOn(errorBoundaryLog, 'report').mockImplementation(() => {})
    console.error = vi.fn()
    render(
      <ErrorBoundary>
        <Bomb trigger />
      </ErrorBoundary>,
    )
    expect(seamSpy).toHaveBeenCalledTimes(1)
    const [message, context] = seamSpy.mock.calls[0]
    expect(message).toBe('ErrorBoundary caught:')
    expect((context as { error: Error }).error.message).toBe('boom')
    seamSpy.mockRestore()
  })
})
