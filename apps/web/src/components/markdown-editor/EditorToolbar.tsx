import type { LucideIcon } from 'lucide-react'
import { BookOpen, Columns2, MoreHorizontal, PenLine } from 'lucide-react'
import { cn } from '../../lib/utils.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'

export type MarkdownViewMode = 'write' | 'split' | 'read'

export interface EditorToolbarProps {
  readonly mode: MarkdownViewMode
  readonly onModeChange: (mode: MarkdownViewMode) => void
  /** Split needs room for two columns; narrow containers drop the option. */
  readonly splitAvailable: boolean
  readonly wordCount: number
  /** Opens the editing catalog, anchored under the ⋯ trigger. */
  readonly onOpenCatalog: (anchor: { x: number; y: number }) => void
  /**
   * Read mode has no source pane, so there is nothing for the catalog's
   * verbs to act on — the doorway goes away rather than opening onto
   * disabled entries.
   */
  readonly catalogAvailable: boolean
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

/**
 * The markdown editor's one chrome strip, and it holds exactly one kind of
 * thing: **how this document is shown** (word count + view mode), plus the
 * doorway to everything that CHANGES the document.
 *
 * Formatting buttons used to sit here and no longer do. They were redundant
 * for the audience that could reach them (⌘B already exists) and out of
 * reach for the one that needed them — a 28px target at the top edge is the
 * worst place on a phone. Verbs live in the catalog behind ⋯, which opens
 * as a bottom sheet exactly where a thumb already is.
 */
export function EditorToolbar({
  mode,
  onModeChange,
  splitAvailable,
  wordCount,
  onOpenCatalog,
  catalogAvailable,
}: EditorToolbarProps) {
  return (
    <div className="border-border bg-background flex h-10 shrink-0 items-center gap-1 border-b px-2">
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
        {catalogAvailable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="More actions"
                aria-haspopup="menu"
                data-testid="editor-catalog-trigger"
                // Keep focus (and therefore the caret) in the source pane: the
                // catalog's verbs resolve their scope from it, and a focused
                // trigger would move the caret out of the word being acted on.
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  onOpenCatalog({ x: rect.left, y: rect.bottom })
                }}
                className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring inline-flex size-7 items-center justify-center rounded-md transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:outline-none"
              >
                <MoreHorizontal aria-hidden className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>More actions</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
