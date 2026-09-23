/**
 * What the daemon index LISTS, as screens: the failed-load recovery, the
 * empty daemon, the loading skeleton, onboarding, and the panel. Its own file
 * because the page was over the 800-line budget once each screen became a
 * component, and a page is about deciding WHICH screen, not about drawing
 * them.
 */
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { EmptyWorkspaceState } from '../components/workspace-files/EmptyWorkspaceState.js'
import { WorkspaceFilesPanel } from '../components/workspace-files/WorkspaceFilesPanel.js'
import type { useRoutedFolder } from '../hooks/useRoutedFolder.js'
import type { createDaemonFilesSource } from '../lib/daemon-files-source.js'
import type { DaemonIndexPageProps } from './DaemonIndexPage.js'
import type { DocumentRow, PendingDelete } from './daemon-index-actions.js'

/**
 * A failed list load must not dead-end the page: the POST needs no rows and
 * success navigates away, so creating remains a recovery path around the
 * broken list.
 *
 * WHICH list failed decides which recovery is real. Creating needs a
 * workspace to create INTO, so when the WORKSPACE list is what failed there
 * is nothing selected and creating would return at its first line — the
 * button would sit there doing nothing. Offer the request that failed
 * instead.
 */
interface LoadErrorRecoveryProps {
  loadError: string
  creating: boolean
  selectedWorkspace: string | null
  onCreate: (kind: DocumentKind) => void | Promise<void>
  onRetryWorkspaces: () => void | Promise<void>
}

function LoadErrorRecovery(props: LoadErrorRecoveryProps) {
  return (
    // A failed list load must not dead-end the page: the POST needs no
    // rows and success navigates away, so props.creating remains a recovery
    // path around the broken list. The transient loading state below
    // deliberately has no create control — deriving a path from rows
    // that are still in flight invites a collision the loaded states
    // cannot produce.
    //
    // Which failed decides which recovery is real. Creating needs a
    // workspace to create INTO, so when the WORKSPACE list is what
    // failed there is nothing selected and `handleCreate` returns at its
    // first line — the button would sit there doing nothing. Offer the
    // request that failed instead.
    <div className="flex flex-col items-start gap-3">
      <div role="alert" className="text-sm text-destructive">
        {props.loadError}
      </div>
      {props.selectedWorkspace ? (
        <button
          type="button"
          disabled={props.creating}
          onClick={() => void props.onCreate('spatial')}
          className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
        >
          Create a canvas
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void props.onRetryWorkspaces()}
          className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
        >
          Try again
        </button>
      )}
    </div>
  )
}

/**
 * A daemon that holds no workspaces at all. Nothing is selected, so the
 * documents fetch that ends the loading state never runs and the skeleton
 * would spin for as long as the page stays open.
 *
 * Creation is offered by the SWITCHER, not here — one carrier, the same one
 * every other page uses. This state points at it rather than growing a second
 * create control beside it.
 */
function NoWorkspacesYet({ onRetryWorkspaces }: { onRetryWorkspaces: () => void | Promise<void> }) {
  return (
    // A daemon that holds no workspaces at all. Nothing is selected, so
    // the documents fetch that ends the loading state never runs and the
    // skeleton below would spin for as long as the page stays open.
    //
    // Creation is offered by the SWITCHER, not here — one carrier, the
    // same one every other page uses. This state points at it rather
    // than growing a second create control beside it.
    //
    // It used to say the write was someone else's, and that was true
    // while every create path addressed a (workspace, path) pair this
    // page could not name. `POST /api/workspaces` retired that: the
    // daemon mints the id and derives the address from a display name,
    // so the client no longer has to guess an identifier the daemon
    // would agree with.
    <div className="flex flex-col items-start gap-3">
      <div>
        <p className="text-sm font-medium">This daemon has no workspaces.</p>
        <p className="text-sm text-muted-foreground">
          Create one from the workspace menu in the header — or one appears on its own once an agent
          over MCP, or the whiteboard CLI, writes a document.
        </p>
      </div>
      <button
        type="button"
        onClick={() => void onRetryWorkspaces()}
        className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent"
      >
        Check again
      </button>
    </div>
  )
}

/** Mounted while the documents fetch is in flight; rows=[] alone cannot say so. */
function DocumentsSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading documents"
      className="skeleton-appear grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
    >
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="animate-pulse rounded-lg border p-2">
          <div className="aspect-[4/3] rounded-md bg-muted" />
          <div className="mt-2 h-4 w-2/3 rounded bg-muted" />
        </div>
      ))}
    </div>
  )
}

/** The panel itself, once a workspace is selected and its source exists. */
interface DaemonFilesSectionProps {
  selectedWorkspace: string
  filesSource: NonNullable<ReturnType<typeof createDaemonFilesSource>>
  rows: DocumentRow[]
  routedFolder: ReturnType<typeof useRoutedFolder>['folder']
  setRoutedFolder: ReturnType<typeof useRoutedFolder>['setFolder']
  onOpenDocument: DaemonIndexPageProps['onOpenDocument']
  onDuplicate: (path: string) => void | Promise<void>
  onRequestDelete: (pending: PendingDelete) => void
}

function DaemonFilesSection(props: DaemonFilesSectionProps) {
  return (
    // Mounts when the skeleton unmounts: the fade carries the
    // skeleton-to-content handoff instead of an instant swap.
    <div className="animate-in fade-in-0 duration-(--motion-duration-normal) ease-(--motion-ease-out)">
      <WorkspaceFilesPanel
        source={props.filesSource}
        // The handle the address carries, which is exactly what a
        // document's URL under this workspace is built from.
        workspace={props.selectedWorkspace}
        initialFolder={props.routedFolder}
        onFolderChange={props.setRoutedFolder}
        onOpenDocument={(path) => props.onOpenDocument(props.selectedWorkspace, path)}
        onDuplicateDocument={(path) => void props.onDuplicate(path)}
        onRequestDelete={(path, displayName, kind) =>
          props.onRequestDelete({ paths: [path], displayName, kind })
        }
        onRequestDeleteMany={(paths) =>
          props.onRequestDelete({ paths, displayName: `${paths.length} documents` })
        }
        // A new array on every successful read, which is exactly the
        // signal the panel needs: the page reloads this list after a
        // duplicate and after a delete, both of which it performs on
        // the panel's behalf.
        revision={props.rows}
      />
    </div>
  )
}

interface DaemonIndexBodyProps {
  loadError: string | null
  loaded: boolean
  rows: DocumentRow[]
  trashCount: number
  creating: boolean
  selectedWorkspace: string | null
  filesSource: ReturnType<typeof createDaemonFilesSource> | null
  routedFolder: ReturnType<typeof useRoutedFolder>['folder']
  setRoutedFolder: ReturnType<typeof useRoutedFolder>['setFolder']
  onOpenDocument: DaemonIndexPageProps['onOpenDocument']
  workspacesLoaded: boolean
  workspaceCount: number
  onCreate: (kind: DocumentKind) => void | Promise<void>
  onDuplicate: (path: string) => void | Promise<void>
  onRequestDelete: (pending: PendingDelete) => void
  onRetryWorkspaces: () => void | Promise<void>
}

export function DaemonIndexBody(props: DaemonIndexBodyProps) {
  if (props.loadError) {
    return (
      <LoadErrorRecovery
        loadError={props.loadError}
        creating={props.creating}
        selectedWorkspace={props.selectedWorkspace}
        onCreate={props.onCreate}
        onRetryWorkspaces={props.onRetryWorkspaces}
      />
    )
  }
  if (props.workspacesLoaded && props.workspaceCount === 0) {
    return <NoWorkspacesYet onRetryWorkspaces={props.onRetryWorkspaces} />
  }
  if (!props.loaded) {
    return <DocumentsSkeleton />
  }
  if (props.rows.length === 0 && props.trashCount === 0) {
    return (
      // The onboarding state renders INSTEAD of the panel: a three-pane
      // browser of nothing teaches less than one sentence and one
      // button, and this button also OPENS what it creates (ADR-0006 —
      // naming happens in the opened document's own top bar).
      <EmptyWorkspaceState
        onCreate={(kind) => void props.onCreate(kind)}
        disabled={props.creating}
        subtitle="Documents live in this workspace, kept by your local daemon."
      />
    )
  }
  if (props.selectedWorkspace && props.filesSource) {
    return (
      <DaemonFilesSection
        selectedWorkspace={props.selectedWorkspace}
        filesSource={props.filesSource}
        rows={props.rows}
        routedFolder={props.routedFolder}
        setRoutedFolder={props.setRoutedFolder}
        onOpenDocument={props.onOpenDocument}
        onDuplicate={props.onDuplicate}
        onRequestDelete={props.onRequestDelete}
      />
    )
  }
  return <p className="text-sm text-muted-foreground">No workspace selected.</p>
}
