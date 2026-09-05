/**
 * The ONE connection-state affordance. The SIGNATURE MARK signals the state;
 * every sentence-shaped explanation and recovery action lives in its popover
 * — no standing banners.
 *
 * The mark, and not a chip beside it, because the row had no subject: the
 * mark meant "home" and nothing else while a separate chip on the right
 * answered "is my work safe" about a workspace nothing on screen named. One
 * carrier now answers both, and the row reads left to right as "this
 * workspace" rather than as two unrelated widgets. `ShellMark` owns the paint
 * and the motion; this file owns what the popover says and offers.
 *
 * Keeper `browser` — the workspace is kept in this browser and nowhere else.
 * `children` hosts page-supplied extras (daemon detection, capability hint)
 * inside the popover.
 *
 * Keeper `daemon` reports the live session's health on top:
 * - `synced`   — live sync running.
 * - `reconnecting` — live sync is not running: the transport has not come up
 *                yet, dropped, or failed. Edits made meanwhile are not lost:
 *                the session re-sends the whole document when the transport
 *                returns, which is what makes that claim true — a backend
 *                whose socket is closed drops the delta it was handed.
 * - `sync-off` — the session was rejected. The chip turns attention-colored
 *                and the popover carries the two ways forward (re-pair / work
 *                in the browser). A polite sr-only live region announces the
 *                transition so dropping the old role="alert" banner loses no
 *                assistive-tech signal.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { settingsPath } from '@/lib/app-routes'
import { type ConnectionState, isSyncOff, type SessionHealth } from '../../lib/connection-state.js'
import { ShellMark } from '../shell/ShellMark.js'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js'

export interface ConnectionStatusProps {
  /**
   * `null` on a page that holds no live session. The mark still opens —
   * the workspace is a fact on every page, so there is always something to
   * say — it simply has no session word to carry.
   */
  readonly state: ConnectionState | null
  /** Shown in the synced popover so the user knows which daemon holds the data. */
  readonly daemonBaseUrl?: string
  /** sync-off only: starts the pairing grant flow on the daemon's /pair page. */
  readonly onRepair?: () => void
  /** sync-off only: switches to the documents kept in this browser. */
  readonly onWorkInBrowser?: () => void
  /** browser only: page-supplied popover extras (daemon detection, capability hint). */
  readonly children?: ReactNode
  /** What the mark's accessible name states. The popover's head is the menu's own. */
  readonly workspaceName?: string
  /** The workspace section, composed by the shell and rendered above the session's own. */
  readonly workspaceMenu?: ReactNode
}

/**
 * The word the mark cannot say.
 *
 * A chip carried its label beside its dot; a 26x16 signature has room for
 * neither. The label therefore moves into the accessible name and the
 * popover's header — which is load-bearing rather than tidy, because
 * `reconnecting` and `sync-off` share the `attention` tone and the chip's
 * word was what told them apart for a sighted reader. The mark separates
 * them by motion instead; assistive tech reads this.
 */
const SESSION_LABEL: Record<SessionHealth, string> = {
  synced: 'Synced',
  reconnecting: 'Reconnecting',
  'sync-off': 'Sync off',
}

/**
 * The word the mark cannot say, for whoever needs to render it. Exported
 * because the popover's head moved into `WorkspaceMenu` — the head is an
 * editable name now — and the session word sits on that same row.
 */
export function connectionLabel(state: ConnectionState | null): string | null {
  if (state === null) return null
  return state.keeper === 'browser' ? 'Browser' : SESSION_LABEL[state.session]
}

export function ConnectionStatus({
  state,
  daemonBaseUrl,
  onRepair,
  onWorkInBrowser,
  children,
  workspaceName,
  workspaceMenu,
}: ConnectionStatusProps) {
  const label = connectionLabel(state)
  const syncOff = state !== null && isSyncOff(state)
  // Empty while sync is on: the region has to exist BEFORE the message, but
  // an empty one must not claim a name either.
  const syncOffAnnouncement = syncOff ? 'Live sync off' : ''

  return (
    <Popover>
      {/* Always mounted, for the same reason as the busy line in
          WorkspaceTopBar: sync going off is a CHANGE, and a live region that
          appears together with its first message may never be announced. */}
      <span role="status" aria-label={syncOffAnnouncement || undefined} className="sr-only">
        {syncOffAnnouncement}
      </span>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="shell-mark-trigger"
          // The state has no word on screen, so the accessible name carries
          // it — the one place a colour-and-motion signal must not be the
          // only signal.
          // The workspace's NAME rather than the bare word: the design
          // record puts the name here precisely so the shell states it
          // without drawing it, and the session word joins it when a page
          // published one.
          aria-label={
            workspaceName === undefined
              ? `Workspace${label === null ? '' : ` — ${label}`}`
              : `Workspace: ${workspaceName}${label === null ? '' : ` — ${label}`}`
          }
          {...(label === null ? {} : { title: label })}
          className="flex shrink-0 items-center justify-center rounded-md p-1 text-foreground/70 transition-colors duration-(--motion-duration-normal) ease-(--motion-ease-out) hover:bg-accent hover:text-foreground"
        >
          {state === null ? <ShellMark /> : <ShellMark state={state} />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" data-testid="shell-mark-popover">
        {/* The workspace block comes FIRST and carries its own head, because
            that head is an editable name and editing belongs to the component
            that owns the rename. Without one — no workspace known — the
            session word still needs stating, so the bare head stands in. */}
        {workspaceMenu === undefined ? (
          label !== null && (
            <p className="mb-2 border-b pb-2 text-xs font-medium text-muted-foreground">{label}</p>
          )
        ) : (
          <div className="mb-2 text-sm">{workspaceMenu}</div>
        )}
        {state?.keeper === 'daemon' && state.session === 'synced' && (
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium">Live sync is on</p>
            <p className="text-muted-foreground">
              Changes are saved to the daemon on this machine
              {daemonBaseUrl ? (
                <>
                  {' at '}
                  <span className="font-mono text-xs">
                    {daemonBaseUrl.replace(/^https?:\/\//, '')}
                  </span>
                </>
              ) : null}
              .
            </p>
            {/* The chip reports; it does not manage. Changing which daemon
                this browser uses is something you go looking for, so it
                lives in Settings and this only points at it. */}
            {children}
            <Link
              to={settingsPath('connections')}
              className="mt-1 text-xs font-medium text-primary hover:underline"
            >
              Manage in Settings
            </Link>
          </div>
        )}
        {state?.keeper === 'daemon' && state.session === 'reconnecting' && (
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium">Live sync is not running</p>
            <p className="text-muted-foreground">
              This document is not receiving changes from the daemon right now. Your edits are kept
              and sent when the connection returns. Reload the page if it does not recover.
            </p>
          </div>
        )}
        {state?.keeper === 'browser' && (
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-medium">Kept in this browser</p>
            <p className="text-muted-foreground">
              Your documents live in this browser's storage. Other browsers cannot see them, and
              clearing site data removes them.
            </p>
            {children}
          </div>
        )}
        {syncOff && (
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
        )}
      </PopoverContent>
    </Popover>
  )
}
