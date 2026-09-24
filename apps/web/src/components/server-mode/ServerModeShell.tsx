/**
 * The chrome around a workspace in the web app a server-mode keeper serves
 * (ADR-0047). The daemon's own shell assumes a paired local daemon throughout
 * — re-pairing, "work in browser", a replica notice — none of which a
 * server keeper has, so this is its own and says only what applies: the way
 * back to the workspace list, the open document's sync state, and who is
 * signed in.
 */
import { useState, useSyncExternalStore } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { isSyncOff } from '../../lib/connection-state.js'
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

export function ServerModeShell({ displayName, fetchFn }: { displayName: string; fetchFn: Fetch }) {
  const connection = useSyncExternalStore(subscribeShellStatus, getShellConnection)
  const label = connectionLabel(connection?.state ?? null)
  // Spoken only when sync goes off, as the daemon shell's ConnectionStatus
  // does: a reconnect blip read aloud mid-sentence is noise.
  const announcement = connection !== null && isSyncOff(connection.state) ? 'Live sync off' : ''
  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b bg-background px-chrome text-sm pointer-coarse:h-12">
      <Link to="/" className="text-muted-foreground hover:text-foreground">
        All workspaces
      </Link>
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
