import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportCrash } from '../lib/app-logger.js'

// React error boundary for the whiteboard surface.
// Keep the app recoverable instead of letting an Excalidraw, Loro, or routing error blank the whole root.
// This is intentionally minimal; richer recovery actions can be added later if needed.

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
  children: ReactNode
  // Optional custom fallback for callers that want a different recovery UI.
  fallback?: (args: { error: Error; reset: () => void }) => ReactNode
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
      <div
        role="alert"
        style={{
          padding: '24px',
          maxWidth: '720px',
          margin: '64px auto',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          color: '#1a1a1a',
          background: '#fff',
          border: '1px solid #fecaca',
          borderRadius: '8px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
        }}
      >
        <h2 style={{ margin: '0 0 12px', fontSize: '18px', color: '#dc2626' }}>
          Something went wrong
        </h2>
        <p style={{ margin: '0 0 16px', fontSize: '14px', color: '#525252' }}>
          The whiteboard hit an unexpected error. Try recovering, or reload the page.
        </p>
        {/*
          Deliberately no error.message / error.stack here: the default fallback is
          shown to end users, and raw error text can leak implementation details
          (file paths, function names, internal identifiers). componentDidCatch
          already reports the full error + stack through errorBoundaryLog for
          diagnostics; callers that need the message visible to the user can pass
          a custom `fallback` prop that renders `error.message` deliberately.
        */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            onClick={this.reset}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              border: '1px solid #d4d4d4',
              borderRadius: '4px',
              background: '#fff',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 16px',
              fontSize: '14px',
              border: 'none',
              borderRadius: '4px',
              background: '#dc2626',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            Reload page
          </button>
        </div>
      </div>
    )
  }
}

export default ErrorBoundary
