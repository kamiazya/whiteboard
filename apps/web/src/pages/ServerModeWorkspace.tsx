/**
 * A workspace opened in the web app a server-mode keeper serves (ADR-0047).
 *
 * The editor is the daemon's, unchanged: the keeper IS the daemon, reached at
 * this page's own origin. What differs from a daemon reached through the
 * extension is carried by what this hands the pages rather than by a branch
 * inside them: the session cookie authenticates each request, where the
 * extension's bridge authenticates the connection, and the server's data has
 * no replica in this browser.
 */
import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { KeeperNotices } from '../components/connection/KeeperNotices.js'
import { parseWorkspaceRoute, type WorkspaceRoute, workspaceRoutePath } from '../lib/app-routes.js'
import { DaemonWorkspacePages } from './DaemonWorkspacePages.js'

export function ServerModeWorkspace({ shell }: { shell: ReactNode }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const view = parseWorkspaceRoute(pathname)
  const onView = (next: WorkspaceRoute) => navigate(workspaceRoutePath(next))
  if (view === null) return null
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {shell}
      <KeeperNotices />
      <main className="min-h-0 flex-1 overflow-hidden">
        <DaemonWorkspacePages
          daemonBaseUrl={window.location.origin}
          view={view}
          onView={onView}
          serverMode
          waitingMessage="Opening workspace…"
        />
      </main>
    </div>
  )
}
