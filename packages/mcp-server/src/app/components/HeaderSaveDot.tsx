import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip.js'

// Keep save state as subtle as a mail-style unread dot.
// - dirty=false: show nothing
// - dirty=true: show only the amber dot; click runs onSave
// - saving=true: swap to a thin spinner ring
//
// The header intentionally has no separate Save button.
// Cmd+S is the primary action, and the dot doubles as state display plus a small click target.

export interface HeaderSaveDotProps {
  dirty: boolean
  saving: boolean
  onSave: () => void | Promise<void>
  // Hint text for aria/title. The caller decides the OS-specific shortcut text.
  shortcutHint?: string
}

export function HeaderSaveDot({
  dirty,
  saving,
  onSave,
  shortcutHint,
}: HeaderSaveDotProps): JSX.Element | null {
  if (!dirty && !saving) {
    // Remove the node entirely while clean. The parent does not reserve fixed width here.
    return null
  }
  const label = saving ? 'Saving…' : 'Unsaved changes'
  const tip = shortcutHint ? `${label} · ${shortcutHint}` : label
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={saving}
          aria-label={label}
          data-testid="header-save-dot"
          className={cn(
            'relative inline-flex size-4 shrink-0 items-center justify-center rounded-full',
            'transition-transform hover:scale-110 focus-visible:outline-none',
            'focus-visible:ring-2 focus-visible:ring-primary/50',
            saving ? 'cursor-progress' : 'cursor-pointer',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'block size-2.5 rounded-full',
              saving
                ? 'border-2 border-amber-500 border-t-transparent animate-spin'
                : 'bg-amber-500',
            )}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}

export default HeaderSaveDot
