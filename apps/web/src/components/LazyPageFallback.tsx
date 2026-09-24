import { DocumentPageSkeleton } from './DocumentPageSkeleton.js'

// Suspense fallback shared by every lazy page chunk (DaemonDocumentPage and
// BrowserDocumentPage). Reuses the structural DocumentPageSkeleton so the
// chunk-load state and the page's own connecting state are one continuous
// pulse instead of a text line snapping to a skeleton. The height class
// differs by mount site (root fills the viewport; the in-banner branches
// fill the flex row under it), so it's a prop; message becomes the
// accessible label so daemon-specific and backend-agnostic mount sites
// announce accurate copy.
export function LazyPageFallback({
  heightClass,
  message,
}: {
  heightClass: string
  message: string
}) {
  return (
    <div className={heightClass}>
      <DocumentPageSkeleton label={message} />
    </div>
  )
}
