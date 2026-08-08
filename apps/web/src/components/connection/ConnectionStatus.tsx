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
 * - `sync-off` — daemon-backed page whose session was rejected. The chip
 *                turns attention-colored and the popover carries the two
 *                ways forward (re-pair / continue browser-local). A polite
 *                sr-only live region announces the transition so dropping
 *                the old role="alert" banner loses no assistive-tech signal.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.js'

export type ConnectionState = 'synced' | 'local' | 'sync-off'

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
}

const CHIP_LABEL: Record<ConnectionState, string> = {
  synced: 'Synced',
  local: 'Local',
  'sync-off': 'Sync off',
}

const DOT_CLASS: Record<ConnectionState, string> = {
  synced: 'bg-emerald-500',
  local: 'bg-muted-foreground/60',
  'sync-off': 'bg-amber-500',
}

export function ConnectionStatus({
  state,
  daemonBaseUrl,
  onRepair,
  onContinueBrowserLocal,
  children,
}: ConnectionStatusProps) {
  return (
    <Popover>
      {state === 'sync-off' && (
        <span role="status" aria-label="Live sync off" className="sr-only">
          Live sync off
        </span>
      )}
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="connection-chip"
          className={cn(
            'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent',
            state === 'sync-off' && 'border-amber-500/40 bg-amber-500/10 text-amber-700',
          )}
        >
          <span aria-hidden="true" className={cn('size-2 rounded-full', DOT_CLASS[state])} />
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
