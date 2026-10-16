/**
 * The chrome around a workspace in the web app a server-mode keeper serves
 * (ADR-0047). The daemon's own shell assumes a local daemon throughout
 * — "work in browser", a replica notice — none of which a
 * server keeper has, so this is its own and says only what applies: the way
 * back to the workspace list, the open document's sync state, and who is
 * signed in.
 */
import {
  authSignOutUrl,
  signInPageUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import { useState, useSyncExternalStore } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  type ShellWorkspaceRows,
  useShellWorkspaceRows,
} from '../../hooks/use-shell-workspace-rows.js'
import { parseWorkspaceRoute, workspacePath } from '../../lib/app-routes.js'
import { givenUpAnnouncement } from '../../lib/connection-state.js'
import { getShellConnection, subscribeShellStatus } from '../../lib/shell-status-store.js'
import { workspaceHandle, workspaceLabel } from '../../lib/workspace-handle.js'
import type { KeeperWorkspaces } from '../../lib/workspace-switcher-source.js'
import { connectionLabel } from '../connection/ConnectionStatus.js'
import { WorkspaceIdentityFields } from '../shell/WorkspaceIdentityFields.js'
import { Button } from '../ui/button.js'

type Fetch = typeof globalThis.fetch

/** Signs this browser out, and stays put — saying so — if the keeper refuses. */
export function SignOutControl({ fetchFn }: { fetchFn: Fetch }) {
  const navigate = useNavigate()
  const [failed, setFailed] = useState(false)
  const signOut = async () => {
    const res = await fetchFn(authSignOutUrl(), { method: 'POST' }).catch(() => null)
    if (res?.ok) navigate(signInPageUrl(), { replace: true })
    else setFailed(true)
  }
  // Stacked, so the refusal reads as a line under the button wherever the
  // control sits rather than as one more item in its row.
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" onClick={() => void signOut()}>
        Sign out
      </Button>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          Could not sign out. Try again.
        </p>
      )}
    </div>
  )
}

/** A list that failed, said where the switcher would be, with the way to ask again. */
function PickerUnavailable({ onRetry }: Readonly<{ onRetry: () => void }>) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span role="alert" className="truncate text-destructive">
        Could not load your workspaces.
      </span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </span>
  )
}

/**
 * The person's other workspaces, one step away: links behind a native
 * disclosure. Not a select — a closed select changes on every arrow key in
 * some browsers, and navigating on change would open each workspace a
 * keyboard user merely passed through. The list is read again each time it
 * opens, so a workspace made or renamed elsewhere is there when it is used.
 * Absent when there is nothing to switch to.
 *
 * Built on the same rows as the rename beside it, so a rename lands in its
 * label at once rather than when it is next opened.
 */
function WorkspacePicker({ shell }: Readonly<{ shell: ShellWorkspaceRows }>) {
  const { rows, handleInAddress, listFailed, reload } = shell
  const [open, setOpen] = useState(false)
  if (listFailed) return <PickerUnavailable onRetry={reload} />
  if (rows.length < 2) return null
  // The address may name a workspace by its id rather than its segment.
  const here = rows.find(
    (w) => w.workspaceId === handleInAddress || workspaceHandle(w) === handleInAddress,
  )
  const label = here === undefined ? 'Workspaces' : workspaceLabel(here)
  return (
    <details
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open
        setOpen(next)
        if (next) reload()
      }}
      className="relative min-w-0"
    >
      <summary
        title={label}
        className="max-w-48 cursor-pointer truncate rounded-md border px-2 py-1 text-foreground"
      >
        {label}
      </summary>
      <ul className="absolute left-0 top-full z-50 mt-1 flex min-w-48 flex-col rounded-md border bg-background p-1 shadow-md">
        {rows.map((w) => (
          <li key={w.workspaceId}>
            <Link
              to={workspacePath(w.workspaceId)}
              title={workspaceLabel(w)}
              aria-current={w === here ? 'page' : undefined}
              onClick={() => setOpen(false)}
              className="block truncate rounded px-2 py-1 hover:bg-muted aria-[current=page]:font-medium"
            >
              {workspaceLabel(w)}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  )
}

/**
 * The open workspace's name and address, edited where the other shells edit
 * them. The keeper is the authority on who may rename: a refusal is shown as
 * it was said, and nothing about the row changes until the keeper answers.
 *
 * The fields are always in the document and the disclosure only hides them,
 * so a rename in flight is not torn down by closing it. Absent until the
 * list has said which row the address names, and for a keeper with no rename.
 */
function WorkspaceRenameDisclosure({
  workspaces,
  shell,
}: Readonly<{ workspaces: KeeperWorkspaces; shell: ShellWorkspaceRows }>) {
  const { handleInAddress, activeRow, applyRename } = shell
  if (activeRow === undefined || workspaces.source.rename === undefined) return null
  return (
    <details className="relative min-w-0">
      <summary className="cursor-pointer rounded-md border px-2 py-1 text-foreground">
        Rename
      </summary>
      <WorkspaceIdentityFields
        className="absolute left-0 top-full z-50 mt-1 flex w-64 flex-col gap-1 rounded-md border bg-background p-2 shadow-md"
        active={activeRow}
        current={handleInAddress}
        rename={workspaces.source.rename}
        onRenamed={applyRename}
        onSwitch={workspaces.onSwitch}
      />
    </details>
  )
}

/** The open workspace's people: who is in it, and for an owner, who may be. */
function WorkspacePeopleLink() {
  const current = parseWorkspaceRoute(useLocation().pathname)?.workspace
  if (current === undefined) return null
  return (
    <Link
      to={`/people/w/${encodeURIComponent(current)}`}
      className="text-muted-foreground hover:text-foreground"
    >
      People
    </Link>
  )
}

export function ServerModeShell({
  displayName,
  fetchFn,
  workspaces,
}: Readonly<{
  displayName: string
  fetchFn: Fetch
  /** The keeper's workspace seam; without it the shell offers no switcher and no rename. */
  workspaces?: KeeperWorkspaces
}>) {
  // One list for the switcher and the rename, so neither can name a workspace
  // the other has already renamed.
  const shell = useShellWorkspaceRows(workspaces, useLocation().pathname)
  const connection = useSyncExternalStore(subscribeShellStatus, getShellConnection)
  const label = connectionLabel(connection?.state ?? null)
  const announcement = givenUpAnnouncement(connection?.state ?? null)
  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b bg-background px-chrome text-sm pointer-coarse:h-12">
      <Link to="/" className="text-muted-foreground hover:text-foreground">
        All workspaces
      </Link>
      {workspaces !== undefined && <WorkspacePicker shell={shell} />}
      {workspaces !== undefined && (
        <WorkspaceRenameDisclosure workspaces={workspaces} shell={shell} />
      )}
      <WorkspacePeopleLink />
      <span className="text-muted-foreground">{label ?? ''}</span>
      {/* Mounted even when empty: a live region inserted with its text
          already in it is not announced. */}
      <span role="status" className="sr-only">
        {announcement}
      </span>
      <span className="min-w-0 flex-1" />
      <span className="truncate text-muted-foreground">Signed in as {displayName}</span>
      <SignOutControl fetchFn={fetchFn} />
    </header>
  )
}
