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
  })

  it('normalizes a thrown non-Error value so fallbacks can rely on Error fields', () => {
    console.error = vi.fn()
    function StringBomb(): JSX.Element {
      // Anything can be thrown in JS; a string here reached custom fallbacks
      // typed as Error and crashed on .message access.
      throw 'plain string failure'
    }
    const fallback = vi.fn(({ error }: { error: Error; reset: () => void }) => (
      <div data-testid="custom-fallback">{error.message}</div>
    ))
    render(
      <ErrorBoundary fallback={fallback}>
        <StringBomb />
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('custom-fallback').textContent).toBe('plain string failure')
  })

  it('does not leak the raw error message or stack into the default fallback UI', () => {
    console.error = vi.fn()
    render(
      <ErrorBoundary>
        <Bomb trigger />
      </ErrorBoundary>,
    )
    expect(screen.queryByText(/boom/)).toBeNull()
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

  // The seam is routed through app-logger's `reportCrash` channel (see
  // ErrorBoundary.tsx), which is deliberately NOT gated by the dev/prod
  // no-op that every other app-logger level uses. These tests lock in that
  // a caught render crash is surfaced in BOTH dev and prod builds, rather
  // than regressing silently the next time app-logger's channels change.
  describe('app-logger crash-report gate', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('forwards the caught error to console in a dev build (real seam, not mocked)', () => {
      vi.stubGlobal('import.meta', { env: { DEV: true } })
      const spy = vi.fn()
      console.error = spy
      render(
        <ErrorBoundary>
          <Bomb trigger />
        </ErrorBoundary>,
      )
      const call = spy.mock.calls.find((c) => String(c[0]).includes('ErrorBoundary caught:'))
      expect(call).toBeTruthy()
      expect(call?.[0]).toContain('[error-boundary]')
    })

    it('still reports the caught error in a prod build (reportCrash survives production on purpose)', () => {
      vi.stubGlobal('import.meta', { env: { DEV: false } })
      const spy = vi.fn()
      console.error = spy
      render(
        <ErrorBoundary>
          <Bomb trigger />
        </ErrorBoundary>,
      )
      const call = spy.mock.calls.find((c) => String(c[0]).includes('ErrorBoundary caught:'))
      expect(call).toBeTruthy()
      expect(call?.[0]).toContain('[error-boundary]')
      const context = call?.[1] as { error: Error; componentStack?: string | null }
      expect(context.error).toBeInstanceOf(Error)
      expect(context.error.message).toBe('boom')
      expect(context.componentStack).toBeTruthy()
    })
  })
})
