import type { StateCommand } from '@codemirror/state'
import type { LucideIcon } from 'lucide-react'
import { BookOpen, Columns2, MoreHorizontal, PenLine } from 'lucide-react'
import { cn } from '../../lib/utils.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'
import { MarkdownVerbBar } from './MarkdownVerbBar.js'

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
  /** Runs a verb from the inline bar. Absent in read mode, where there is no source. */
  readonly runVerb?: (command: StateCommand) => void
  readonly openLinkPicker?: () => boolean
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
 * The doorway's name is "Editing actions" rather than the generic "More
 * actions" the app shell's own ⋯ uses: two controls with the same accessible
 * name on one screen are indistinguishable to anyone reading it aloud.
 *
 * Formatting buttons sat here, were removed, and are back — the removal's
 * two reasons have both expired. They were "redundant beside ⌘B", which was
 * true of six verbs that mostly had chords and is not true of sixteen, ten
 * of which have none; and a 28px target at the top edge was "the worst
 * place on a phone", which mattered while it was the phone's ONLY path and
 * stopped mattering when the phone got its own keyboard-docked bar.
 *
 * So the verbs are shown where there is room for them and folded into ⋯
 * where there is not — `MarkdownVerbBar` decides which from its own measured
 * width. On a phone the catalog behind ⋯ still opens as a bottom sheet,
 * exactly where a thumb already is.
 */
export function EditorToolbar({
  mode,
  onModeChange,
  splitAvailable,
  wordCount,
  onOpenCatalog,
  catalogAvailable,
  runVerb,
  openLinkPicker,
}: EditorToolbarProps) {
  return (
    <div className="border-border bg-background flex h-10 shrink-0 items-center gap-1 border-b px-2">
      {catalogAvailable && runVerb !== undefined ? (
        // No overflow doorway of its own: ⋯ beside the view modes is the
        // complete catalog and stays. It is not the same list twice — the
        // catalog offers the heading LEVELS directly, where the bar has one
        // slot that cycles them.
        <MarkdownVerbBar run={runVerb} openLinkPicker={openLinkPicker} />
      ) : (
        <div className="flex-1" />
      )}
      <div className="flex items-center gap-3">
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
                aria-label="Editing actions"
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
            <TooltipContent>Editing actions</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
