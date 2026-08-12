import type { JSX } from 'react'
import NotFoundMark from '../../brand/not-found-mark.svg?react'
import { StatusPageButton, StatusPageLayout } from './StatusPageLayout.js'

/**
 * Shown for any path outside the app's closed route set: the signature
 * wandered off its board. Lazy-loaded from App so this rare page stays off
 * the critical-path bundle.
 */
export function NotFoundPage({ onBack }: { onBack: () => void }): JSX.Element {
  return (
    <StatusPageLayout
      mark={<NotFoundMark className="text-muted-foreground" />}
      title="There's nothing here"
      description="The link may be wrong, or what it pointed at has moved."
      actions={<StatusPageButton label="Back to canvases" onClick={onBack} primary />}
    />
  )
}
