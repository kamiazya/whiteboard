/**
 * The ONE connection-state affordance. A small header
 * chip signals the state; every sentence-shaped explanation and recovery
 * action lives in its popover — no standing banners.
 *
 * States:
 * - `synced`   — daemon-backed page with live sync running.
 * - `browser`  — the workspace is kept in this browser and nowhere else.
 *                `children` hosts page-supplied extras (daemon detection,
 *                capability hint) inside the popover.
 * - `reconnecting` — live sync is not running: the transport has not come up
 *                yet, dropped, or failed. Edits made meanwhile are not lost:
 *                the session re-sends the whole document when the transport
 *                returns, which is what makes that claim true — a backend
 *                whose socket is closed drops the delta it was handed.
 * - `sync-off` — daemon-backed page whose session was rejected. The chip
 *                turns attention-colored and the popover carries the two
 *                ways forward (re-pair / work in the browser). A polite
 *                sr-only live region announces the transition so dropping
 *                the old role="alert" banner loses no assistive-tech signal.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { settingsPath } from '@/lib/app-routes'
import { cn } from '@/lib/utils'
import { StateDot, type StateDotTone } from '../StateDot.js'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js'

/**
 * Two different questions share this type, and only one of them survives
 * navigation: `browser` names WHO KEEPS the workspace, while the other three
 * report whether a live session is healthy. Splitting them is its own slice;
 * this one only stops the keeper from being called "local", which a daemon
 * running on the same machine is too.
 */
export type ConnectionState = 'synced' | 'browser' | 'reconnecting' | 'sync-off'

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

const CHIP_LABEL: Record<ConnectionState, string> = {
  synced: 'Synced',
  browser: 'Browser',
  reconnecting: 'Reconnecting',
  'sync-off': 'Sync off',
}

// Meaning, not paint — StateDot owns the palette (DESIGN.md's closed set).
const DOT_TONE: Record<ConnectionState, StateDotTone> = {
  synced: 'safe',
  browser: 'neutral',
  reconnecting: 'attention',
  'sync-off': 'attention',
}

export function ConnectionStatus({
  state,
  daemonBaseUrl,
  onRepair,
  onWorkInBrowser,
  children,
}: ConnectionStatusProps) {
  // Empty while sync is on: the region has to exist BEFORE the message, but
  // an empty one must not claim a name either.
  const syncOffAnnouncement = state === 'sync-off' ? 'Live sync off' : ''

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
            state === 'sync-off' && 'border-amber-500/40 bg-amber-500/10 text-amber-700',
          )}
        >
          <StateDot
            tone={DOT_TONE[state]}
            // One-shot attention echo behind the dot: mounts exactly when the
            // chip enters sync-off, pulses twice, then rests. Finite by
            // design — a standing ping would be noise, not guidance.
            pulse={state === 'sync-off'}
            pulseTestId="connection-chip-pulse"
          />
          {CHIP_LABEL[state]}
        </button>
      </PopoverTrigger>
      <PopoverContent data-testid="connection-popover">
        {state === 'synced' && (
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
        {state === 'reconnecting' && (
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium">Live sync is not running</p>
            <p className="text-muted-foreground">
              This document is not receiving changes from the daemon right now. Your edits are kept
              and sent when the connection returns. Reload the page if it does not recover.
            </p>
          </div>
        )}
        {state === 'browser' && (
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-medium">Kept in this browser</p>
            <p className="text-muted-foreground">
              Your documents live in this browser's storage. Other browsers cannot see them, and
              clearing site data removes them.
            </p>
            {children}
          </div>
        )}
        {state === 'sync-off' && (
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
