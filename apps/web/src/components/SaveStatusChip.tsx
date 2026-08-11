/**
 * Browser-local autosave state as a header chip, the visual sibling of the
 * connection chip: colored dot PLUS visible text (color never carries the
 * state alone), explanation on demand in a popover. Distinct from
 * HeaderSaveDot on purpose — that dot tracks "no named VERSION taken yet"
 * on daemon-backed pages; this chip tracks whether the last write to this
 * browser's storage actually landed, including the degraded failure state
 * the version dot has no equivalent of.
 */
import { cn } from '@/lib/utils'
import type { BrowserLocalPersistenceState } from '../pages/use-browser-local-canvas-controller.js'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js'

export interface SaveStatusChipProps {
  readonly state: BrowserLocalPersistenceState
}

const LABEL: Record<Exclude<BrowserLocalPersistenceState['kind'], 'degraded'>, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  pending: 'Unsaved changes',
}

const DOT_CLASS: Record<BrowserLocalPersistenceState['kind'], string> = {
  saved: 'bg-emerald-500',
  saving: 'bg-amber-500',
  pending: 'bg-amber-500',
  degraded: 'bg-amber-500',
}

const EXPLANATION: Record<BrowserLocalPersistenceState['kind'], string> = {
  saved: 'All changes are saved in this browser.',
  saving: 'Writing your latest changes to this browser now.',
  pending: 'Changes are waiting to be written to this browser.',
  degraded: 'The last write to this browser failed. Your edits stay in memory for this session.',
}

export function SaveStatusChip({ state }: SaveStatusChipProps) {
  const label = state.kind === 'degraded' ? state.message : LABEL[state.kind]
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="save-status-chip"
          className={cn(
            'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent',
            'duration-(--motion-duration-normal) ease-(--motion-ease-out)',
            state.kind === 'degraded' && 'border-amber-500/40 bg-amber-500/10 text-amber-700',
          )}
        >
          <span aria-hidden="true" className="relative inline-flex size-2">
            {state.kind === 'degraded' && (
              // One-shot attention echo, same treatment as the connection
              // chip's sync-off: pulses twice on entry, then rests.
              <span
                data-testid="save-status-chip-pulse"
                className="absolute inset-0 rounded-full bg-amber-500 animate-[attention-pulse_900ms_var(--motion-ease-out)_2]"
              />
            )}
            <span className={cn('absolute inset-0 rounded-full', DOT_CLASS[state.kind])} />
          </span>
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent data-testid="save-status-popover">
        <div className="flex flex-col gap-1 text-sm">
          <p className="font-medium">{label}</p>
          <p className="text-muted-foreground">{EXPLANATION[state.kind]}</p>
        </div>
      </PopoverContent>
    </Popover>
  )
}
