import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportCrash } from '../lib/app-logger.js'
import { ErrorFallback } from './status/ErrorFallback.js'

// React error boundary: keeps the app recoverable instead of letting a render
// throw or a rejected lazy chunk unmount the whole root. Place it OUTSIDE a
// Suspense — a chunk failure propagates through Suspense to the nearest
// boundary. Each screen frame holds one, and boot.ts wraps the root in one as
// the floor for anything mounted outside a frame.

// Module-local logging seam: kept separate from the boundary's render logic so
// componentDidCatch has a single, mockable call site. Routed through
// app-logger's `reportCrash` channel, which — unlike every other app-logger
// level — is NOT a dev-only no-op: once React has torn down the tree and
// shown the fallback UI, this is the user's last chance to get a stack trace
// they can paste into a bug report. This is still not a substitute for a
// production error-reporting integration (Sentry or similar), should one be
// added later. Exposed as an object (not a bare function) so tests can
// `vi.spyOn` the property — spying a same-module function binding does not
// intercept direct calls.
export const errorBoundaryLog = {
  report(message: string, context: Record<string, unknown>): void {
    reportCrash('error-boundary', message, context)
  },
}

interface ErrorBoundaryState {
  error: Error | null
}

interface ErrorBoundaryProps {
  children?: ReactNode
  // Optional custom fallback for callers that want a different recovery UI.
  fallback?: (args: { error: Error; reset: () => void }) => ReactNode
  // A caught error is cleared when this changes, so a frame that stays
  // mounted across navigation (a route-driven view) leaves its fallback once
  // the person goes somewhere else. A healthy subtree is not remounted by it.
  resetKey?: unknown
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    // Anything can be thrown in JS (strings, plain objects, null). Normalize
    // to a real Error so the fallback contract ({ error: Error }) holds and
    // consumers can safely read .message.
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    errorBoundaryLog.report('ErrorBoundary caught:', { error, componentStack: info.componentStack })
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.reset()
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) {
      return this.props.fallback({ error, reset: this.reset })
    }
    return (
      <div role="alert" className="h-full min-h-dvh">
        <ErrorFallback onRetry={this.reset} />
      </div>
    )
  }
}
