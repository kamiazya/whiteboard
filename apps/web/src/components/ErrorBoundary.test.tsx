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

  // The seam is routed through app-logger (see ErrorBoundary.tsx), so a caught
  // render crash is only visible in dev builds. These two tests lock in that
  // deliberate choice: dev builds must still surface the crash, and prod
  // builds must not leak console noise, rather than either regressing
  // silently the next time app-logger's dev/prod gate changes.
  describe('app-logger dev/prod gate', () => {
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

    it('stays silent in a prod build (app-logger no-ops there)', () => {
      vi.stubGlobal('import.meta', { env: { DEV: false } })
      const spy = vi.fn()
      console.error = spy
      render(
        <ErrorBoundary>
          <Bomb trigger />
        </ErrorBoundary>,
      )
      // React's own error-boundary dev warning also calls console.error and
      // is outside this seam's control — only assert that OUR seam (tagged
      // '[error-boundary]') stayed silent.
      const ownCall = spy.mock.calls.find((c) => String(c[0]).includes('[error-boundary]'))
      expect(ownCall).toBeUndefined()
    })
  })
})
