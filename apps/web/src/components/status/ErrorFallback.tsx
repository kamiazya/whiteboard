import type { JSX } from 'react'
import { StatusPageButton, StatusPageLayout } from './StatusPageLayout.js'

/**
 * The ErrorBoundary's default fallback: the signature scribbled out (the
 * mark asset carries its own one-shot animation — see
 * public/error-mark.svg). Deliberately free of error details: raw error
 * text can leak implementation internals, and the boundary already
 * reported the full error through its logging seam.
 */
export function ErrorFallback({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <StatusPageLayout
      mark={<img data-mark="scribble" src="/error-mark.svg" alt="" width="132" height="84" />}
      title="Something went wrong"
      description="The whiteboard hit an error it couldn't recover from. Your saved canvases are safe."
      actions={
        <>
          <StatusPageButton label="Try again" onClick={onRetry} primary />
          <StatusPageButton label="Reload" onClick={() => window.location.reload()} />
        </>
      }
    />
  )
}
