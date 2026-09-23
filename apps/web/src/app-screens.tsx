import { lazy, Suspense } from 'react'
import type { AppShellProps } from './components/AppShell.js'
import { AppShellLazy } from './components/AppShellLazy.js'
import { DocumentPageSkeleton } from './components/DocumentPageSkeleton.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'
import type { WorkspaceRoute } from './lib/app-routes.js'
import type { ConnectedDaemon } from './lib/daemon-auth-fetch.js'
import type { ReplicaMatch } from './lib/replicas.js'
import type { SessionBanner } from './lib/session-keeper.js'

// Every page below is lazy for the reason its own comment gives, and they are
// declared HERE rather than in App.tsx because this module is the one that
// mounts them. `App.lazy-coverage.test.ts` reads both files, so a page moving
// between them does not fall out of its coverage.

// Lazy so the daemon stack (DaemonBackend, ws-protocol, api client) stays out
// of the entry chunk — sessions arriving via a #wb= pairing fragment AND
// sessions with a runtime-config daemon provider state pay for it;
// pure browser sessions never import it, keeping that entry under the
// bundle-size budget.
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
// path (no daemon, no pairing fragment) — so it was the one making
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
        {children}
      </div>
    </ErrorBoundary>
  )
}

/**
 * A daemon-kept workspace: its gallery, or one document open in the editor.
 *
 * ONE component for both arrivals — a `#wb=` pairing link resolved into a
 * grant, and a runtime-config daemon provider state. They differ in where the
 * address and the token come from and in nothing else, which is exactly why
 * the two copies had drifted: the pairing branch's container had lost the
 * `overflow-hidden` both shipped with, so a document that overflowed there
 * scrolled the shell instead of the pane.
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

/** A `#wb=` pairing link that could not be turned into a connection. */
export function PairingFailedScreen({ onWorkInBrowser }: { onWorkInBrowser: () => void }) {
  return (
    <ErrorBoundary>
      <div
        role="alert"
        aria-live="assertive"
        className="flex h-dvh flex-col items-center justify-center gap-4 p-6 text-center"
      >
        <p className="max-w-md text-sm text-destructive">
          The daemon pairing link could not be used. You can continue without a daemon connection.
        </p>
        <button
          type="button"
          onClick={onWorkInBrowser}
          className="rounded-md border bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent"
        >
          Work in this browser instead
        </button>
      </div>
    </ErrorBoundary>
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

/** An in-flow banner the user can put away for the rest of the session. */
function DismissibleAlert({
  label,
  onDismiss,
  children,
}: {
  label: string
  onDismiss: () => void
  children: React.ReactNode
}) {
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center justify-between gap-2 bg-destructive/10 px-chrome py-1.5 text-xs text-destructive"
    >
      <span>{children}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={label}
        className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-background/60"
      >
        Dismiss
      </button>
    </div>
  )
}

/**
 * Fail-closed renewal refusal: a PINNED daemon answered with a wrong or
 * missing identity signature. Either the daemon rotated its key (delete +
 * regenerate) or something else is on its port — both need a fresh human
 * approval on the daemon's consent page.
 */
function IdentityMismatchBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <DismissibleAlert label="Dismiss identity warning" onDismiss={onDismiss}>
      This daemon's identity changed — automatic reconnection was refused. If you rotated or
      reinstalled the daemon, re-approve it from "Check for local daemon"; otherwise treat this as a
      warning that something else may be answering on its port.
    </DismissibleAlert>
  )
}

/**
 * The user just clicked Approve on the daemon's consent page — landing back
 * here on the browser with no explanation was a silent dead end. The likeliest
 * cause on a hosted origin is the browser's local-network permission still
 * being closed.
 */
function PairingErrorBanner({ detail, onDismiss }: { detail: string; onDismiss: () => void }) {
  return (
    <DismissibleAlert label="Dismiss pairing error" onDismiss={onDismiss}>
      Pairing didn't complete: {detail}. If your browser asked for permission to reach local
      devices, allow it and try again from "Check for local daemon".
    </DismissibleAlert>
  )
}

/**
 * ADR-0023's offline read: the addressed workspace is daemon-kept, the daemon
 * answered the renewal with nothing usable, and this browser holds a replica.
 */
function ReplicaReadScreen({
  replica,
  renewal,
  onReconnect,
}: {
  replica: ReplicaMatch
  renewal: 'refused' | 'unreachable'
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
 * The browser's own workspace: its document list, or one document open —
 * plus the two session banners that only this keeper's shell shows.
 *
 * Owns the viewport as a flex column so an in-flow banner sits ABOVE the
 * canvas. Pages size to the height this shell allots them (h-full), so a
 * banner displaces the canvas instead of clipping its bottom edge — the tool
 * palette used to vanish behind the viewport on phones exactly because the
 * page claimed h-dvh underneath an in-flow banner.
 */
export function BrowserWorkspaceScreen({
  workspaces,
  banner,
  onDismissBanner,
  replica,
  onReconnect,
  path,
  onOpenDocument,
  revision,
}: {
  workspaces?: AppShellProps['workspaces']
  banner: SessionBanner
  onDismissBanner: () => void
  replica: { match: ReplicaMatch; renewal: 'refused' | 'unreachable' } | null
  onReconnect: () => void | Promise<void>
  path?: string
  onOpenDocument: (path: string) => void
  revision: unknown
}) {
  return (
    <ShellFrame daemon={false} workspaces={workspaces}>
      {banner.kind === 'identity-mismatch' && (
        <IdentityMismatchBanner onDismiss={onDismissBanner} />
      )}
      {banner.kind === 'pairing-error' && (
        <PairingErrorBanner detail={banner.detail} onDismiss={onDismissBanner} />
      )}
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
