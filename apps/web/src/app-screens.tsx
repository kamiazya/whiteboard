import { lazy, Suspense } from 'react'
import type { AppShellProps } from './components/AppShell.js'
import { AppShellLazy } from './components/AppShellLazy.js'
import { UnsavedChangesNotice } from './components/connection/UnsavedChangesNotice.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import { LazyPageFallback } from './components/LazyPageFallback.js'
import type { WorkspaceRoute } from './lib/app-routes.js'
import type { ConnectedDaemon } from './lib/daemon-auth-fetch.js'
import type { ReplicaMatch } from './lib/replicas.js'

// Every page below is lazy for the reason its own comment gives, and they are
// declared HERE rather than in App.tsx because this module is the one that
// mounts them. `App.lazy-coverage.test.ts` reads both files, so a page moving
// between them does not fall out of its coverage.

// Lazy so the daemon stack (DaemonBackend, api client) stays out of the entry
// chunk — only a session with a daemon pays for it; pure browser sessions
// never import it, keeping that entry under the bundle-size budget.
const DaemonDocumentPage = lazy(() =>
  import('./pages/DaemonDocumentPage.js').then((m) => ({ default: m.DaemonDocumentPage })),
)

// Same lazy-chunk rationale as DaemonDocumentPage above — the gallery only
// matters once a daemon connection exists.
const DaemonIndexPage = lazy(() =>
  import('./pages/DaemonIndexPage.js').then((m) => ({ default: m.DaemonIndexPage })),
)

// Lazy for the same reason: BrowserDocumentPage statically imports
// useDocumentSync (which imports loro-crdt), and it is the default render
// path (no daemon) — so it was the one making
// loro-crdt part of every session's initial paint even though
// DaemonDocumentPage above was already lazy.
const BrowserDocumentPage = lazy(() =>
  import('./pages/BrowserDocumentPage.js').then((m) => ({
    default: m.BrowserDocumentPage,
  })),
)

// Lazy so the list stays outside the loro-crdt chunk the editor drags in.
const BrowserIndexPage = lazy(() =>
  import('./pages/BrowserIndexPage.js').then((m) => ({ default: m.BrowserIndexPage })),
)

// ADR-0023's offline read: mounted only when the daemon is unreachable and
// a replica of the addressed workspace exists — the rarest branch, and the
// heaviest (loro-adapter + the canvas viewer), so it stays a chunk.
const ReplicaReadPage = lazy(() =>
  import('./pages/ReplicaReadPage.js').then((m) => ({ default: m.ReplicaReadPage })),
)

// Lazy: the not-found page renders on rare, dead-end navigations only —
// it must not ride the critical-path bundle.
const NotFoundPage = lazy(() =>
  import('./components/status/NotFoundPage.js').then((m) => ({ default: m.NotFoundPage })),
)

// Lazy for the same reason as the other secondary surfaces above: /settings
// is a rare, dedicated navigation (not part of the canvas critical path).
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage.js').then((m) => ({ default: m.SettingsPage })),
)

/**
 * The frame every full-window screen below shares: the shell chrome over a
 * flex column that owns the viewport.
 *
 * ErrorBoundary sits OUTSIDE Suspense on purpose: a lazy-chunk load failure
 * propagates through Suspense's own error path to the nearest boundary, and
 * without one here a rejected import unmounts the root.
 */
function ShellFrame({
  daemon,
  workspaces,
  onWorkInBrowser,
  children,
}: {
  daemon: boolean
  // REQUIRED, though the value may be absent: a screen with no workspace to
  // name says so by writing `undefined`, rather than by leaving the prop off
  // and opening the switcher onto nothing (App.shell-workspaces-surface).
  workspaces: AppShellProps['workspaces'] | undefined
  onWorkInBrowser?: () => void
  children: React.ReactNode
}) {
  return (
    <ErrorBoundary>
      <div className="flex h-dvh flex-col">
        <AppShellLazy
          daemon={daemon}
          {...(workspaces === undefined ? {} : { workspaces })}
          {...(onWorkInBrowser === undefined ? {} : { onWorkInBrowser })}
        />
        <UnsavedChangesNotice />
        {children}
      </div>
    </ErrorBoundary>
  )
}

/**
 * A daemon-kept workspace: its gallery, or one document open in the editor.
 *
 * ONE component for both arrivals — a reconnection through the extension, and
 * a runtime-config daemon provider state. They differ in where the address
 * comes from and in nothing else.
 *
 * `key` on the document mount forces a clean remount (fresh
 * controller/backend) on every index -> document transition instead of
 * reusing a previous document's identity.
 */
export function DaemonWorkspaceScreen({
  daemonBaseUrl,
  token,
  view,
  onView,
  onWorkInBrowser,
  workspaces,
}: {
  daemonBaseUrl: string
  token?: string
  view: WorkspaceRoute
  onView: (view: WorkspaceRoute) => void
  onWorkInBrowser: () => void
  workspaces?: AppShellProps['workspaces']
}) {
  return (
    <ShellFrame daemon={true} workspaces={workspaces} onWorkInBrowser={onWorkInBrowser}>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense
          fallback={<LazyPageFallback heightClass="h-full" message="Connecting to daemon…" />}
        >
          {view.kind === 'index' ? (
            <DaemonIndexPage
              daemonBaseUrl={daemonBaseUrl}
              token={token}
              workspace={view.workspace}
              onWorkspaceResolved={(workspace) => onView({ kind: 'index', workspace })}
              onOpenDocument={(workspace, path) => onView({ kind: 'document', workspace, path })}
            />
          ) : (
            <DaemonDocumentPage
              key={`${view.workspace}:${view.path}`}
              daemonBaseUrl={daemonBaseUrl}
              workspaceId={view.workspace}
              path={view.path}
              token={token}
              onNavigateBack={() => onView({ kind: 'index', workspace: view.workspace })}
            />
          )}
        </Suspense>
      </div>
    </ShellFrame>
  )
}

/**
 * /settings, on its own route ahead of the daemon/browser branch.
 *
 * The switcher belongs here for the reason the shell states about its own
 * mark: it opens on every page, so there is always something for the popover
 * to say. Without a source this route was the exception — every child of that
 * popover is conditional, and here they were all false at once, because only
 * DOCUMENT pages publish shell status so the connection is null too. The
 * control opened onto nothing.
 *
 * `daemon` is keyed off the SAME value the page takes, so the two cannot
 * answer different keepers for one render.
 */
export function SettingsScreen({
  daemon,
  workspaceId,
  onDisconnected,
  daemonWorkspaces,
  browserWorkspaces,
}: {
  daemon?: ConnectedDaemon
  workspaceId?: string
  onDisconnected: () => void
  daemonWorkspaces?: AppShellProps['workspaces']
  browserWorkspaces?: AppShellProps['workspaces']
}) {
  return (
    <ShellFrame
      daemon={daemon !== undefined}
      workspaces={daemon === undefined ? browserWorkspaces : daemonWorkspaces}
    >
      <div className="min-h-0 flex-1">
        <Suspense fallback={<LazyPageFallback heightClass="h-full" message="Loading…" />}>
          <SettingsPage
            daemon={daemon}
            onDisconnected={onDisconnected}
            workspaceId={daemon === undefined ? undefined : workspaceId}
          />
        </Suspense>
      </div>
    </ShellFrame>
  )
}

/**
 * Outside the closed route set: say so instead of silently falling through to
 * the default view — a mistyped or stale link should read as "not here", not
 * as a mysteriously empty gallery.
 */
export function NotFoundScreen({ onBack }: { onBack: () => void }) {
  return (
    <div className="h-dvh">
      <ErrorBoundary>
        <Suspense fallback={null}>
          <NotFoundPage onBack={onBack} />
        </Suspense>
      </ErrorBoundary>
    </div>
  )
}

/**
 * A remembered daemon is being reconnected through the extension. Rendering
 * the browser's own workspaces meanwhile would flash the WRONG keeper's
 * documents for as long as the native host takes to start.
 */
export function ConnectingScreen() {
  return (
    <div className="flex h-dvh items-center justify-center p-6">
      <p className="text-sm text-muted-foreground">Connecting to the daemon…</p>
    </div>
  )
}

/** Runtime config this app cannot act on, stated rather than worked around. */
export function InvalidConfigScreen({ message }: { message: string }) {
  return (
    <ErrorBoundary>
      <main data-provider="invalid-config">
        <p>{message}</p>
      </main>
    </ErrorBoundary>
  )
}

/**
 * ADR-0023's offline read: the addressed workspace is daemon-kept, the daemon
 * did not answer the reconnection, and this browser holds a replica.
 */
function ReplicaReadScreen({
  replica,
  renewal,
  onReconnect,
}: {
  replica: ReplicaMatch
  renewal: 'unreachable'
  onReconnect: () => void | Promise<void>
}) {
  return (
    <ReplicaReadPage
      workspaceId={replica.workspaceId}
      {...(replica.displayName === undefined ? {} : { displayName: replica.displayName })}
      syncedAt={replica.syncedAt}
      daemonBaseUrl={replica.daemonBaseUrl}
      renewal={renewal}
      onReconnect={onReconnect}
    />
  )
}

/**
 * The browser's own workspace: its document list, or one document open, or
 * the offline read of a daemon workspace this browser holds a replica of.
 */
export function BrowserWorkspaceScreen({
  workspaces,
  replica,
  onReconnect,
  path,
  onOpenDocument,
  revision,
}: {
  workspaces?: AppShellProps['workspaces']
  replica: { match: ReplicaMatch; renewal: 'unreachable' } | null
  onReconnect: () => void | Promise<void>
  path?: string
  onOpenDocument: (path: string) => void
  revision: unknown
}) {
  return (
    <ShellFrame daemon={false} workspaces={workspaces}>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<LazyPageFallback heightClass="h-full" message="Loading…" />}>
          {replica !== null ? (
            <ReplicaReadScreen
              replica={replica.match}
              renewal={replica.renewal}
              onReconnect={onReconnect}
            />
          ) : (
            <BrowserWorkspaceContent
              path={path}
              onOpenDocument={onOpenDocument}
              revision={revision}
            />
          )}
        </Suspense>
      </div>
    </ShellFrame>
  )
}

/** The browser's own workspace: its document list, or one document open. */
function BrowserWorkspaceContent({
  path,
  onOpenDocument,
  revision,
}: {
  path?: string
  onOpenDocument: (path: string) => void
  revision: unknown
}) {
  if (path !== undefined) return <BrowserDocumentPage initialPath={path} />
  // An index route lands on the document list. The editor mounts only for a
  // document route, whose in-editor switching it keeps owning — App re-routes
  // solely when the URL crosses the list/editor boundary.
  return <BrowserIndexPage onOpenDocument={onOpenDocument} revision={revision} />
}
