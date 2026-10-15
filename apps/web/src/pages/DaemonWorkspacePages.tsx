/**
 * A daemon-kept workspace's pages: its gallery, or one document open in the
 * editor. The same switch serves a daemon reached through the extension and
 * a server-mode keeper (ADR-0047) — the keeper IS the daemon in both, so they
 * differ only in the address, the `serverMode` flag and the waiting copy,
 * and one copy of the switch is what keeps a fix to it reaching both.
 *
 * The boundary sits OUTSIDE Suspense, because a rejected page chunk
 * propagates through Suspense to the nearest boundary, and INSIDE the
 * frame, so the header and the keeper's notices survive a page failure.
 * `resetKey` is the route: the frame stays mounted across navigation, so
 * without it a gallery that failed to load would hold its error screen over
 * the document the person opened next. A chunk that rejected stays rejected
 * for the life of the tab (React caches the lazy result), so on THAT route
 * the fallback's Reload is the recovery, not Try again.
 */
import { lazy, Suspense } from 'react'
import { ErrorBoundary } from '../components/ErrorBoundary.js'
import { LazyPageFallback } from '../components/LazyPageFallback.js'
import { type WorkspaceRoute, workspaceRoutePath } from '../lib/app-routes.js'

// Lazy so the daemon stack (SseBackend, api client) stays out of the entry
// chunk — only a session with a daemon pays for it; pure browser sessions
// never import it, keeping that entry under the bundle-size budget.
const DaemonDocumentPage = lazy(() =>
  import('./DaemonDocumentPage.js').then((m) => ({ default: m.DaemonDocumentPage })),
)

// Same lazy-chunk rationale as DaemonDocumentPage above — the gallery only
// matters once a daemon connection exists.
const DaemonIndexPage = lazy(() =>
  import('./DaemonIndexPage.js').then((m) => ({ default: m.DaemonIndexPage })),
)

/**
 * `key` on the document mount forces a clean remount (fresh
 * controller/backend) on every index -> document transition instead of
 * reusing a previous document's identity.
 */
export function DaemonWorkspacePages({
  daemonBaseUrl,
  view,
  onView,
  serverMode = false,
  waitingMessage,
}: {
  readonly daemonBaseUrl: string
  readonly view: WorkspaceRoute
  readonly onView: (view: WorkspaceRoute) => void
  readonly serverMode?: boolean
  readonly waitingMessage: string
}) {
  return (
    <ErrorBoundary resetKey={workspaceRoutePath(view)}>
      <Suspense fallback={<LazyPageFallback heightClass="h-full" message={waitingMessage} />}>
        {view.kind === 'index' ? (
          <DaemonIndexPage
            daemonBaseUrl={daemonBaseUrl}
            workspace={view.workspace}
            serverMode={serverMode}
            onWorkspaceResolved={(workspace) => onView({ kind: 'index', workspace })}
            onOpenDocument={(workspace, path) => onView({ kind: 'document', workspace, path })}
          />
        ) : (
          <DaemonDocumentPage
            key={`${view.workspace}:${view.path}`}
            daemonBaseUrl={daemonBaseUrl}
            workspaceId={view.workspace}
            path={view.path}
            serverMode={serverMode}
            onNavigateBack={() => onView({ kind: 'index', workspace: view.workspace })}
          />
        )}
      </Suspense>
    </ErrorBoundary>
  )
}
