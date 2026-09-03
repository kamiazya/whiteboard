import type { LucideIcon } from 'lucide-react'
import { BookOpen, Columns2, MoreHorizontal, PenLine, Redo2, Undo2 } from 'lucide-react'
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
  /**
   * Step back and forward through the source pane's own history. Absent
   * where there is no source pane to act on (Read mode), for the reason
   * `catalogAvailable` is.
   */
  readonly onUndo?: () => void
  readonly onRedo?: () => void
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
 * The markdown editor's one chrome strip: **how this document is shown**
 * (word count + view mode), the step pair, and the doorway to everything
 * else that CHANGES the document.
 *
 * The doorway's name is "Editing actions" rather than the generic "More
 * actions" the app shell's own ⋯ uses: two controls with the same accessible
 * name on one screen are indistinguishable to anyone reading it aloud.
 *
 * Formatting buttons used to sit here and no longer do. They were redundant
 * for the audience that could reach them (⌘B already exists) and out of
 * reach for the one that needed them — a 28px target at the top edge is the
 * worst place on a phone. Verbs live in the catalog behind ⋯, which opens
 * as a bottom sheet exactly where a thumb already is.
 *
 * Undo and redo are here anyway, and the difference is the half of that
 * reasoning that inverts. Formatting had TWO paths and lost the worse one;
 * undo had exactly one, a chord, so a touch device had no way to take back
 * a keystroke at all. And the catalog is the wrong vessel for it either
 * way: undo is pressed repeatedly, and a sheet that must be reopened per
 * press is not an undo affordance.
 *
 * The top edge is still the worse place for a thumb, and the canvas answers
 * this better — a persistent pair in the bottom dock. When the markdown
 * editor grows a bottom surface of its own, these two belong in it.
 */
/**
 * One step control. Always enabled: CodeMirror's `undo` declines when its
 * history is empty, so an exhausted direction is a press that does nothing
 * rather than a lie. Tracking the depth would mean re-rendering this strip
 * on every keystroke to keep two icons dim, which is a worse trade than the
 * no-op it replaces.
 */
function StepButton({
  label,
  shortcut,
  onPress,
  icon: Icon,
}: {
  label: string
  shortcut: string
  onPress: () => void
  icon: LucideIcon
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onPress}
          className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Icon aria-hidden className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{`${label} (${shortcut})`}</TooltipContent>
    </Tooltip>
  )
}

export function EditorToolbar({
  mode,
  onModeChange,
  splitAvailable,
  wordCount,
  onOpenCatalog,
  catalogAvailable,
  onUndo,
  onRedo,
}: EditorToolbarProps) {
  return (
    <div className="border-border bg-background flex h-10 shrink-0 items-center gap-1 border-b px-2">
      <div className="ml-auto flex items-center gap-3">
        {onUndo && onRedo && (
          <div className="flex items-center gap-0.5">
            <StepButton label="Undo" shortcut="⌘/Ctrl+Z" onPress={onUndo} icon={Undo2} />
            <StepButton label="Redo" shortcut="⌘/Ctrl+⇧Z" onPress={onRedo} icon={Redo2} />
          </div>
        )}
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
