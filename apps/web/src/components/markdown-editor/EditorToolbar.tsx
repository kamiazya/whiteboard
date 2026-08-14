import type { LucideIcon } from 'lucide-react'
import { Bold, BookOpen, Code, Columns2, Italic, PenLine } from 'lucide-react'
import { cn } from '../../lib/utils.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'

export type MarkdownViewMode = 'write' | 'split' | 'read'

export interface EditorToolbarProps {
  readonly mode: MarkdownViewMode
  readonly onModeChange: (mode: MarkdownViewMode) => void
  /** Split needs room for two columns; narrow containers drop the option. */
  readonly splitAvailable: boolean
  readonly wordCount: number
  /** Wraps the current source selection (same commands as Mod-b / Mod-i). */
  readonly onFormat: (delimiter: string) => void
  /** Formatting targets the source pane, so Read mode disables it. */
  readonly formattingEnabled: boolean
}

interface ModeOption {
  readonly mode: MarkdownViewMode
  readonly label: string
  readonly icon: LucideIcon
}

const MODE_OPTIONS: readonly ModeOption[] = [
  { mode: 'write', label: 'Write', icon: PenLine },
  { mode: 'split', label: 'Split', icon: Columns2 },
  { mode: 'read', label: 'Read', icon: BookOpen },
]

interface FormatAction {
  readonly label: string
  readonly delimiter: string
  readonly icon: LucideIcon
  readonly shortcut: string
}

const FORMAT_ACTIONS: readonly FormatAction[] = [
  { label: 'Bold', delimiter: '**', icon: Bold, shortcut: '⌘B' },
  { label: 'Italic', delimiter: '*', icon: Italic, shortcut: '⌘I' },
  { label: 'Code', delimiter: '`', icon: Code, shortcut: '' },
]

/**
 * The markdown editor's one chrome strip: formatting on the left, word
 * count + view mode on the right. Deliberately shallow — no heading/list
 * menus, no insert gallery — because the source pane is the real editing
 * surface and this row must recede next to it (quiet-tool rule).
 */
export function EditorToolbar({
  mode,
  onModeChange,
  splitAvailable,
  wordCount,
  onFormat,
  formattingEnabled,
}: EditorToolbarProps) {
  return (
    <div className="border-border bg-background flex h-10 shrink-0 items-center gap-1 border-b px-2">
      <fieldset className="flex items-center gap-0.5" aria-label="Formatting">
        {FORMAT_ACTIONS.map(({ label, delimiter, icon: Icon, shortcut }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={label}
                disabled={!formattingEnabled}
                // Keep focus (and therefore the selection) in the source
                // pane: a focused toolbar button would collapse the very
                // selection the command is about to wrap.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onFormat(delimiter)}
                className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring inline-flex size-7 items-center justify-center rounded-md transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40"
              >
                <Icon aria-hidden className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{shortcut === '' ? label : `${label} ${shortcut}`}</TooltipContent>
          </Tooltip>
        ))}
      </fieldset>

      <div className="ml-auto flex items-center gap-3">
        <span
          data-testid="markdown-word-count"
          className="text-muted-foreground hidden text-xs tabular-nums sm:block"
        >
          {wordCount === 1 ? '1 word' : `${wordCount} words`}
        </span>
        <fieldset
          className="bg-muted flex items-center gap-0.5 rounded-lg p-0.5"
          aria-label="View mode"
        >
          {MODE_OPTIONS.map(({ mode: option, label, icon: Icon }) => {
            if (option === 'split' && !splitAvailable) return null
            const active = option === mode
            return (
              <Tooltip key={option}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={label}
                    aria-pressed={active}
                    onClick={() => onModeChange(option)}
                    className={cn(
                      'focus-visible:ring-ring inline-flex h-6 items-center justify-center rounded-md px-2 transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:outline-none',
                      active
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Icon aria-hidden className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            )
          })}
        </fieldset>
      </div>
    </div>
  )
}
