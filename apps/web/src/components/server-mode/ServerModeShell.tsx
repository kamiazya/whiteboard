/**
 * The chrome around a workspace in the web app a server-mode keeper serves
 * (ADR-0047). The daemon's own shell assumes a paired local daemon throughout
 * — re-pairing, "work in browser", a replica notice — none of which a
 * server keeper has, so this is its own and says only what applies: the way
 * back to the workspace list, the open document's sync state, and who is
 * signed in.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { parseWorkspaceRoute, workspacePath } from '../../lib/app-routes.js'
import { notKeepingAnnouncement } from '../../lib/connection-state.js'
import { listMemberWorkspaces, type MemberWorkspace } from '../../lib/member-workspaces.js'
import { getShellConnection, subscribeShellStatus } from '../../lib/shell-status-store.js'
import { connectionLabel } from '../connection/ConnectionStatus.js'
import { Button } from '../ui/button.js'

type Fetch = typeof globalThis.fetch

/** Signs this browser out, and stays put — saying so — if the keeper refuses. */
export function SignOutControl({ fetchFn }: { fetchFn: Fetch }) {
  const navigate = useNavigate()
  const [failed, setFailed] = useState(false)
  const signOut = async () => {
    const res = await fetchFn('/auth/sign-out', { method: 'POST' }).catch(() => null)
    if (res?.ok) navigate('/sign-in', { replace: true })
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

/**
 * The person's other workspaces, one step away: links behind a native
 * disclosure. Not a select — a closed select changes on every arrow key in
 * some browsers, and navigating on change would open each workspace a
 * keyboard user merely passed through. The list is read again each time it
 * opens, so a workspace made or renamed elsewhere is there when it is used.
 * Absent when there is nothing to switch to.
 */
function WorkspacePicker({ fetchFn }: { fetchFn: Fetch }) {
  const current = parseWorkspaceRoute(useLocation().pathname)?.workspace
  const [workspaces, setWorkspaces] = useState<MemberWorkspace[]>([])
  const [open, setOpen] = useState(false)
  const load = useCallback(() => {
    void listMemberWorkspaces(fetchFn).then((list) => {
      if (list !== 'unavailable') setWorkspaces(list)
    })
  }, [fetchFn])
  useEffect(load, [load])
  if (workspaces.length < 2) return null
  // The address may name a workspace by its segment rather than its id.
  const here = workspaces.find((w) => w.workspaceId === current || w.segment === current)
  const label = here?.name ?? 'Workspaces'
  return (
    <details
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open
        setOpen(next)
        if (next) load()
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
        {workspaces.map((w) => (
          <li key={w.workspaceId}>
            <Link
              to={workspacePath(w.workspaceId)}
              title={w.name}
              aria-current={w === here ? 'page' : undefined}
              onClick={() => setOpen(false)}
              className="block truncate rounded px-2 py-1 hover:bg-muted aria-[current=page]:font-medium"
            >
              {w.name}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  )
}

export function ServerModeShell({ displayName, fetchFn }: { displayName: string; fetchFn: Fetch }) {
  const connection = useSyncExternalStore(subscribeShellStatus, getShellConnection)
  const label = connectionLabel(connection?.state ?? null)
  const announcement = notKeepingAnnouncement(connection?.state ?? null)
  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b bg-background px-chrome text-sm pointer-coarse:h-12">
      <Link to="/" className="text-muted-foreground hover:text-foreground">
        All workspaces
      </Link>
      <WorkspacePicker fetchFn={fetchFn} />
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
