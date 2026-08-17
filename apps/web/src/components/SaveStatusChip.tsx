/**
 * Browser-local autosave state as a colored DOT beside the canvas title
 * (owner decision: routine save state should not spend words — color at a
 * glance, the label on hover, the sentence in a popover on click). The
 * accessible name always carries the label, so the dot is color-only for
 * sighted glances, never for assistive tech. Deliberately distinct from
 * HeaderSaveDot — that dot tracks "no named VERSION taken yet" on
 * daemon-backed pages; this one tracks whether the last write to this
 * browser's storage actually landed, including the degraded failure state
 * the version dot has no equivalent of.
 */
import { cn } from '@/lib/utils'
import type { BrowserLocalPersistenceState } from '../pages/use-browser-local-document-controller.js'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.js'

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
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="save-status-chip"
              aria-label={label}
              className="flex shrink-0 items-center justify-center rounded-full p-1.5 transition-colors duration-(--motion-duration-normal) ease-(--motion-ease-out) hover:bg-accent"
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
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent data-testid="save-status-popover">
        <div className="flex flex-col gap-1 text-sm">
          <p className="font-medium">{label}</p>
          <p className="text-muted-foreground">{EXPLANATION[state.kind]}</p>
        </div>
      </PopoverContent>
    </Popover>
  )
}
