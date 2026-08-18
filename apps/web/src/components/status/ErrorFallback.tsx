import type { JSX } from 'react'
import ErrorMark from '../../brand/error-mark.svg?react'
import { StatusPageButton, StatusPageLayout } from './StatusPageLayout.js'

/**
 * The ErrorBoundary's default fallback: the signature scribbled out (the
 * wb-scribble one-shot animation lives in index.css; the mark follows the
 * theme via currentColor). Deliberately free of error details: raw error
 * text can leak implementation internals, and the boundary already
 * reported the full error through its logging seam.
 */
export function ErrorFallback({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <StatusPageLayout
      mark={<ErrorMark className="text-muted-foreground" />}
      title="Something went wrong"
      description="The whiteboard hit an error it couldn't recover from. Your saved documents are safe."
      actions={
        <>
          <StatusPageButton label="Try again" onClick={onRetry} primary />
          <StatusPageButton label="Reload" onClick={() => window.location.reload()} />
        </>
      }
    />
  )
}
