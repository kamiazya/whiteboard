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
import { ShellMark } from '../shell/ShellMark.js'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js'

/** Health of the live document session a daemon-kept page runs. */
export type SessionHealth = 'synced' | 'reconnecting' | 'sync-off'

/**
 * Two axes, not one enum: WHO KEEPS the workspace, and — daemon-kept only —
 * whether the live session is healthy. They used to share one four-value
 * union, which made `browser` and `reconnecting` alternatives of each other
 * and so could not say "daemon-kept, but the daemon is unreachable while the
 * browser holds the live replica" — the resting state promotion (a browser
 * workspace merged into a daemon) leaves behind. A browser-kept workspace has
 * no daemon session, so the browser arm carries no health field at all.
 */
export type ConnectionState =
  | { readonly keeper: 'browser' }
  | { readonly keeper: 'daemon'; readonly session: SessionHealth }

/**
 * The one state whose only exit is re-pairing — what the shell's attention
 * dot keys on. A transient reconnect is not it: that recovers on its own.
 */
export function isSyncOff(state: ConnectionState): boolean {
  return state.keeper === 'daemon' && state.session === 'sync-off'
}

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
  /** What the popover's head calls this workspace, and what the mark's accessible name states. */
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

export function ConnectionStatus({
  state,
  daemonBaseUrl,
  onRepair,
  onWorkInBrowser,
  children,
  workspaceName,
  workspaceMenu,
}: ConnectionStatusProps) {
  const label =
    state === null ? null : state.keeper === 'browser' ? 'Browser' : SESSION_LABEL[state.session]
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
        {/* The head: what this workspace is called, and the state's word
            beside it. The mark can say neither — it has room for a 26x16
            signature and nothing else — and two of the four states share a
            tone, so the word is the only thing that separates them. */}
        <div className="mb-2 flex items-baseline justify-between gap-2 border-b pb-2">
          {workspaceName !== undefined && (
            <span data-testid="shell-workspace-name" className="truncate text-sm font-semibold">
              {workspaceName}
            </span>
          )}
          {label !== null && (
            <span className="shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
          )}
        </div>
        {workspaceMenu !== undefined && <div className="mb-2 text-sm">{workspaceMenu}</div>}
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
        {/* Going home was the mark's whole job before it became this
            trigger. It keeps it, one level in, rather than leaving the shell
            with no way back to the index. */}
        <div role="menu" aria-label="Go to" className="mt-3 border-t pt-2">
          <Link
            to="/"
            role="menuitem"
            data-testid="shell-mark-home"
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
          >
            <span aria-hidden="true" className="w-3.5 shrink-0 text-muted-foreground">
              ⌂
            </span>
            All documents
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  )
}
