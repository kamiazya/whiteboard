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
import type { BrowserLocalPersistenceState } from '../pages/use-browser-local-document-controller.js'
import { StateDot, type StateDotTone } from './StateDot.js'
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

// Meaning, not paint — StateDot owns the palette (DESIGN.md's closed set).
const DOT_TONE: Record<BrowserLocalPersistenceState['kind'], StateDotTone> = {
  saved: 'safe',
  saving: 'attention',
  pending: 'attention',
  degraded: 'attention',
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
              <StateDot
                tone={DOT_TONE[state.kind]}
                // One-shot attention echo, same treatment as the connection
                // chip's sync-off: pulses twice on entry, then rests.
                pulse={state.kind === 'degraded'}
                pulseTestId="save-status-chip-pulse"
              />
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
