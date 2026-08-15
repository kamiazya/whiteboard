/**
 * The ONE connection-state affordance. A small header
 * chip signals the state; every sentence-shaped explanation and recovery
 * action lives in its popover — no standing banners.
 *
 * States:
 * - `synced`   — daemon-backed page with live sync running.
 * - `local`    — browser-local page; data exists only in this browser.
 *                `children` hosts page-supplied extras (daemon detection,
 *                capability hint) inside the popover.
 * - `reconnecting` — live sync is not running: the transport has not come up
 *                yet, dropped, or failed. Edits made meanwhile are not lost:
 *                the session re-sends the whole document when the transport
 *                returns, which is what makes that claim true — a backend
 *                whose socket is closed drops the delta it was handed.
 * - `sync-off` — daemon-backed page whose session was rejected. The chip
 *                turns attention-colored and the popover carries the two
 *                ways forward (re-pair / continue browser-local). A polite
 *                sr-only live region announces the transition so dropping
 *                the old role="alert" banner loses no assistive-tech signal.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js'

export type ConnectionState = 'synced' | 'local' | 'reconnecting' | 'sync-off'

export interface ConnectionStatusProps {
  readonly state: ConnectionState
  /** Shown in the synced popover so the user knows which daemon holds the data. */
  readonly daemonBaseUrl?: string
  /** sync-off only: starts the pairing grant flow on the daemon's /pair page. */
  readonly onRepair?: () => void
  /** sync-off only: switches this canvas to the browser-local flow. */
  readonly onContinueBrowserLocal?: () => void
  /** local only: page-supplied popover extras (daemon detection, capability hint). */
  readonly children?: ReactNode
  /**
   * synced only: stop using this daemon in this browser. It does NOT unpair
   * and does NOT touch anything stored on the daemon — the copy says so,
   * because "disconnect" reads like a destructive word.
   */
  readonly onDisconnect?: () => void
}

const CHIP_LABEL: Record<ConnectionState, string> = {
  synced: 'Synced',
  local: 'Local',
  reconnecting: 'Reconnecting',
  'sync-off': 'Sync off',
}

const DOT_CLASS: Record<ConnectionState, string> = {
  synced: 'bg-emerald-500',
  local: 'bg-muted-foreground/60',
  reconnecting: 'bg-amber-500',
  'sync-off': 'bg-amber-500',
}

export function ConnectionStatus({
  state,
  daemonBaseUrl,
  onRepair,
  onContinueBrowserLocal,
  onDisconnect,
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
          <span aria-hidden="true" className="relative inline-flex size-2">
            {state === 'sync-off' && (
              // One-shot attention echo behind the dot: mounts exactly when
              // the chip enters sync-off, pulses twice, then rests. Finite
              // by design — a standing ping would be noise, not guidance.
              <span
                data-testid="connection-chip-pulse"
                className="absolute inset-0 rounded-full bg-amber-500 animate-[attention-pulse_900ms_var(--motion-ease-out)_2]"
              />
            )}
            <span className={cn('absolute inset-0 rounded-full', DOT_CLASS[state])} />
          </span>
          {CHIP_LABEL[state]}
        </button>
      </PopoverTrigger>
      <PopoverContent data-testid="connection-popover">
        {state === 'synced' && (
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium">Live sync is on</p>
            <p className="text-muted-foreground">
              Changes are saved to your local daemon
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
            {onDisconnect && (
              <div className="mt-1 flex flex-col gap-1.5">
                <button
                  type="button"
                  data-testid="connection-disconnect"
                  onClick={onDisconnect}
                  className="text-left font-medium underline"
                >
                  Disconnect from this daemon
                </button>
                <p className="text-xs text-muted-foreground">
                  This browser stops using it and stops looking for it. Your data stays on the
                  daemon and is not deleted; pairing is not revoked.
                </p>
              </div>
            )}
          </div>
        )}
        {state === 'reconnecting' && (
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium">Live sync is not running</p>
            <p className="text-muted-foreground">
              This canvas is not receiving changes from your local daemon right now. Your edits are
              kept and sent when the connection returns. Reload the page if it does not recover.
            </p>
          </div>
        )}
        {state === 'local' && (
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-medium">Browser-local canvas</p>
            <p className="text-muted-foreground">Your data is stored only in this browser.</p>
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
              {onContinueBrowserLocal && (
                <button
                  type="button"
                  onClick={onContinueBrowserLocal}
                  className="rounded-md border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
                >
                  Continue in browser-local
                </button>
              )}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
