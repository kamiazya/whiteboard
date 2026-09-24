/**
 * A workspace opened in the web app a server-mode keeper serves (ADR-0047).
 *
 * The editor is the daemon's, unchanged: the keeper IS the daemon, reached at
 * this page's own origin. Three things differ from a paired local daemon, and
 * each is carried by what this hands the pages rather than by a branch inside
 * them: no token (the session cookie authenticates), no WebSocket (the keeper
 * serves SSE only), and no replica of the server's data in this browser.
 */
import { lazy, type ReactNode, Suspense } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { LazyPageFallback } from '../components/LazyPageFallback.js'
import { parseWorkspaceRoute, type WorkspaceRoute, workspaceRoutePath } from '../lib/app-routes.js'

const DaemonIndexPage = lazy(() =>
  import('./DaemonIndexPage.js').then((m) => ({ default: m.DaemonIndexPage })),
)
const DaemonDocumentPage = lazy(() =>
  import('./DaemonDocumentPage.js').then((m) => ({ default: m.DaemonDocumentPage })),
)

export function ServerModeWorkspace({ shell }: { shell: ReactNode }) {
  const navigate = useNavigate()
  const view = parseWorkspaceRoute(useLocation().pathname)
  const onView = (next: WorkspaceRoute) => navigate(workspaceRoutePath(next))
  const origin = window.location.origin
  if (view === null) return null
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {shell}
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<LazyPageFallback heightClass="h-full" message="Opening workspace…" />}>
          {view.kind === 'index' ? (
            <DaemonIndexPage
              daemonBaseUrl={origin}
              workspace={view.workspace}
              serverMode
              onWorkspaceResolved={(workspace) => onView({ kind: 'index', workspace })}
              onOpenDocument={(workspace, path) => onView({ kind: 'document', workspace, path })}
            />
          ) : (
            <DaemonDocumentPage
              key={`${view.workspace}:${view.path}`}
              daemonBaseUrl={origin}
              workspaceId={view.workspace}
              path={view.path}
              serverMode
              onNavigateBack={() => onView({ kind: 'index', workspace: view.workspace })}
            />
          )}
        </Suspense>
      </div>
    </div>
  )
}
