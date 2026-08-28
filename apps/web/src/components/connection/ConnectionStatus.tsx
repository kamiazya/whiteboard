/**
 * The ONE connection-state affordance. A small header
 * chip signals the state; every sentence-shaped explanation and recovery
 * action lives in its popover — no standing banners.
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
import { cn } from '@/lib/utils'
import { StateDot, type StateDotTone } from '../StateDot.js'
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
  readonly state: ConnectionState
  /** Shown in the synced popover so the user knows which daemon holds the data. */
  readonly daemonBaseUrl?: string
  /** sync-off only: starts the pairing grant flow on the daemon's /pair page. */
  readonly onRepair?: () => void
  /** sync-off only: switches to the documents kept in this browser. */
  readonly onWorkInBrowser?: () => void
  /** browser only: page-supplied popover extras (daemon detection, capability hint). */
  readonly children?: ReactNode
}

// Meaning, not paint — StateDot owns the palette (DESIGN.md's closed set).
const SESSION_CHIP: Record<SessionHealth, { label: string; tone: StateDotTone }> = {
  synced: { label: 'Synced', tone: 'safe' },
  reconnecting: { label: 'Reconnecting', tone: 'attention' },
  'sync-off': { label: 'Sync off', tone: 'attention' },
}

const BROWSER_CHIP = { label: 'Browser', tone: 'neutral' } as const

export function ConnectionStatus({
  state,
  daemonBaseUrl,
  onRepair,
  onWorkInBrowser,
  children,
}: ConnectionStatusProps) {
  const chip = state.keeper === 'browser' ? BROWSER_CHIP : SESSION_CHIP[state.session]
  const syncOff = isSyncOff(state)
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
          data-testid="connection-chip"
          className={cn(
            'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent',
            'duration-(--motion-duration-normal) ease-(--motion-ease-out)',
            syncOff && 'border-amber-500/40 bg-amber-500/10 text-amber-700',
          )}
        >
          <StateDot
            tone={chip.tone}
            // One-shot attention echo behind the dot: mounts exactly when the
            // chip enters sync-off, pulses twice, then rests. Finite by
            // design — a standing ping would be noise, not guidance.
            pulse={syncOff}
            pulseTestId="connection-chip-pulse"
          />
          {chip.label}
        </button>
      </PopoverTrigger>
      <PopoverContent data-testid="connection-popover">
        {state.keeper === 'daemon' && state.session === 'synced' && (
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
        {state.keeper === 'daemon' && state.session === 'reconnecting' && (
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium">Live sync is not running</p>
            <p className="text-muted-foreground">
              This document is not receiving changes from the daemon right now. Your edits are kept
              and sent when the connection returns. Reload the page if it does not recover.
            </p>
          </div>
        )}
        {state.keeper === 'browser' && (
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
