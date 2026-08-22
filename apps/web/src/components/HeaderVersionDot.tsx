import type { JSX } from 'react'
import { StateDot } from '@/components/StateDot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * "You have edits no version holds yet" — as subtle as a mail-style unread dot.
 *
 * NOT a save indicator, however much it once looked like one. What feeds it is
 * `useDirtyState`, which counts edits since the last NAMED VERSION; whether
 * content reached storage is a different question, answered by the save-state
 * chip in browser-local and by the connection chip on a daemon. Wearing the
 * same filled amber as the save dot is what made one shape mean two things
 * depending on which mode you were in, so this one is a RING: a state the
 * document is not in yet, rather than one it is in.
 *
 * - clean: show nothing
 * - dirty: the ring; clicking it takes a version
 * - saving: the same ring, turning
 *
 * The header intentionally has no separate Save button. Cmd/Ctrl+S is the
 * primary action and this doubles as state display plus a small click target.
 */
export interface HeaderVersionDotProps {
  dirty: boolean
  saving: boolean
  onSave: () => void | Promise<void>
  // Hint text for aria/title. The caller decides the OS-specific shortcut text.
  shortcutHint?: string
}

export function HeaderVersionDot({
  dirty,
  saving,
  onSave,
  shortcutHint,
}: HeaderVersionDotProps): JSX.Element | null {
  if (!dirty && !saving) {
    // Remove the node entirely while clean. The parent does not reserve fixed width here.
    return null
  }
  const label = saving ? 'Saving a version…' : 'No version saved yet'
  const tip = shortcutHint ? `${label} · ${shortcutHint}` : label
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          // Native `disabled` inside a Radix TooltipTrigger swallows the
          // pointer events the tooltip needs, hiding the in-flight status on
          // hover — gate the click instead and expose state via aria-disabled.
          onClick={() => {
            if (saving) return
            void onSave()
          }}
          aria-disabled={saving}
          aria-label={label}
          data-testid="header-version-dot"
          className={cn(
            'relative inline-flex size-4 shrink-0 items-center justify-center rounded-full',
            // Appears only when there is something to save — a soft
            // fade+scale entrance keeps the dot from popping into the header.
            'animate-in fade-in-0 zoom-in-75 duration-(--motion-duration-fast) ease-(--motion-ease-out)',
            'transition-transform hover:scale-110 focus-visible:outline-none',
            'focus-visible:ring-2 focus-visible:ring-primary/50',
            saving ? 'cursor-progress' : 'cursor-pointer',
          )}
        >
          <StateDot tone="attention" shape={saving ? 'spinner' : 'ring'} className="size-2.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}
