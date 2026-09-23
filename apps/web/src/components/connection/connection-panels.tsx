/**
 * What the connection popover EXPLAINS, one component per state it can be in.
 *
 * They are siblings rather than one switch because `syncOff` is not exclusive
 * with a keeper panel — a browser-kept document whose daemon session was
 * rejected states both — and each answers `null` for a state that is not its
 * own, so the order they render in is the order they are written in.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { settingsPath } from '../../lib/app-routes.js'
import type { ConnectionState } from '../../lib/connection-state.js'

/**
 * A wall-clock time for the popover: `10:32`, in the reader's locale.
 *
 * A save time in the status popover is read as a clock time beside the
 * reader's own, not as an age — "written at 10:32", never "written 4m ago" —
 * so it is not formatRelative's stamp.
 */
function formatWrittenAt(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  // time-format-is-deliberate: a clock time, not an age
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * The daemon is keeping this document and the session is live.
 *
 * The chip REPORTS; it does not manage. Changing which daemon this browser
 * uses is something you go looking for, so it lives in Settings and this
 * only points at it.
 */
export function DaemonSyncedPanel({
  state,
  daemonBaseUrl,
  children,
}: {
  state: ConnectionState | null
  daemonBaseUrl: string | undefined
  children: ReactNode
}) {
  if (state?.keeper !== 'daemon' || state.session !== 'synced') return null
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="font-medium">Live sync is on</p>
      <p className="text-muted-foreground">
        Changes are saved to the daemon on this machine
        {daemonBaseUrl ? (
          <>
            {' at '}
            <span className="font-mono text-xs">{daemonBaseUrl.replace(/^https?:\/\//, '')}</span>
          </>
        ) : null}
        .
      </p>
      {children}
      <Link
        to={settingsPath('connections')}
        className="mt-1 text-xs font-medium text-primary hover:underline"
      >
        Manage in Settings
      </Link>
    </div>
  )
}

/** The daemon is keeping it, and the socket is down — edits are held and resent. */
export function DaemonReconnectingPanel({ state }: { state: ConnectionState | null }) {
  if (state?.keeper !== 'daemon' || state.session !== 'reconnecting') return null
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="font-medium">Live sync is not running</p>
      <p className="text-muted-foreground">
        This document is not receiving changes from the daemon right now. Your edits are kept and
        sent when the connection returns. Reload the page if it does not recover.
      </p>
    </div>
  )
}

/**
 * The browser is keeping it, in whichever of its three storage healths.
 *
 * A TIME rather than a bare "saved", because "saved" is true of a document
 * never written too.
 */
export function BrowserStoragePanel({
  state,
  lastWrittenAt,
  children,
}: {
  state: ConnectionState | null
  lastWrittenAt: string | null | undefined
  children: ReactNode
}) {
  if (state?.keeper !== 'browser') return null
  if (state.storage === 'ok') {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p className="font-medium">Kept in this browser</p>
        <p className="text-muted-foreground">
          {lastWrittenAt ? `Written at ${formatWrittenAt(lastWrittenAt)}. ` : ''}
          Your documents live in this browser's storage. Other browsers cannot see them, and
          clearing site data removes them.
        </p>
        {children}
      </div>
    )
  }
  if (state.storage === 'stuck') {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p className="font-medium">Still writing to this browser</p>
        <p className="text-muted-foreground">
          Your latest edits have not reached this browser's storage yet. They are kept in this tab
          meanwhile; if this does not clear, reload the page.
        </p>
      </div>
    )
  }
  if (state.storage !== 'failed') return null
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="font-medium">This browser could not be written to</p>
      <p className="text-muted-foreground">
        {lastWrittenAt
          ? `Edits since ${formatWrittenAt(lastWrittenAt)} are in this tab only. `
          : 'Your edits are in this tab only. '}
        Export the document before closing the tab, or reload to try again.
      </p>
    </div>
  )
}

/** The daemon rejected the session: re-pairing is the only way back. */
export function SyncOffPanel({
  show,
  onRepair,
  onWorkInBrowser,
}: {
  show: boolean
  onRepair: (() => void) | undefined
  onWorkInBrowser: (() => void) | undefined
}) {
  if (!show) return null
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="font-medium">Live sync is off</p>
      <p className="text-muted-foreground">
        The daemon rejected this session, so edits stay in this browser until you re-pair.
      </p>
      <div className="mt-1 flex flex-col gap-1.5">
        {onRepair && (
          <button
            type="button"
            onClick={onRepair}
            className="rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
          >
            Re-pair with the daemon
          </button>
        )}
        {onWorkInBrowser && (
          <button
            type="button"
            onClick={onWorkInBrowser}
            className="rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
          >
            Work in this browser instead
          </button>
        )}
      </div>
    </div>
  )
}
