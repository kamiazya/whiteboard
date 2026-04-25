import React, { Component, type ErrorInfo, type ReactNode } from 'react'

// React error boundary for the whiteboard surface.
// Keep the app recoverable instead of letting an Excalidraw, Loro, or routing error blank the whole root.
// This is intentionally minimal; richer recovery actions can be added later if needed.

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

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Best-effort observability. There is no daemon reporting path yet.
    // eslint-disable-next-line no-console
    console.error('[whiteboard] ErrorBoundary caught:', error, info.componentStack)
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
        <pre
          style={{
            margin: '0 0 16px',
            padding: '12px',
            background: '#f5f5f5',
            borderRadius: '4px',
            fontSize: '12px',
            overflow: 'auto',
            maxHeight: '160px',
          }}
        >
          {error.message}
          {error.stack ? `\n\n${error.stack}` : ''}
        </pre>
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
