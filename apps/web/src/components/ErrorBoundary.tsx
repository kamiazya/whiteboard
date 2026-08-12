import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportCrash } from '../lib/app-logger.js'
import { BrandStatusPage, reloadPage } from './BrandStatusPage.js'

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
      <div role="alert" className="h-full min-h-dvh">
        {/*
          Deliberately no error.message / error.stack here: the default
          fallback is shown to end users, and raw error text can leak
          implementation details. componentDidCatch already reports the full
          error + stack through errorBoundaryLog; callers that need the
          message visible can pass a custom `fallback`.
        */}
        <BrandStatusPage
          variant="error"
          title="Something went wrong"
          description="The whiteboard hit an error it couldn't recover from. Your saved canvases are safe."
          actions={[
            { label: 'Try again', onClick: this.reset, primary: true },
            { label: 'Reload', onClick: reloadPage },
          ]}
        />
      </div>
    )
  }
}
