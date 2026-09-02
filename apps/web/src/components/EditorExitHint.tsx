import { Check, X } from 'lucide-react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '@/lib/utils'
import { hasCoarsePointer, isMacPlatform } from '../lib/platform.js'
import { DOCK_BUTTON_CLASS } from './ui/dock-button.js'

/** Header-height icon button (32px) for the 40px full-screen editor bar. */
const DENSE_ICON_BUTTON_CLASS =
  'flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground'

const KBD =
  'rounded border border-border bg-background px-1 py-px font-sans text-[10px] text-muted-foreground'

interface EditorExitHintProps {
  readonly className?: string
  readonly style?: CSSProperties
  /**
   * Both handlers turn the strip into real controls on a coarse pointer. A
   * finger has no chord to press, so naming one there is noise — and the
   * keyboard it does have is the software one, which offers no Escape.
   */
  readonly onDone?: () => void
  readonly onCancel?: () => void
  /** Header-height controls (32px) for a strip that lives in a 40px bar. */
  readonly dense?: boolean
  /**
   * The strip sits inside the spatial canvas root, which refuses native
   * touch and captures pointers everywhere EXCEPT inside
   * `[data-editor-overlay]` — a tap on an unmarked button there never
   * becomes a click. The full-screen editor's header is outside that root
   * and must NOT carry the marker: the overlay's own Escape handler treats
   * any marked element as an open popup and stands down.
   */
  readonly canvasOverlay?: boolean
}

/**
 * A text-editor overlay's exit semantics, said where the typing happens:
 * mod+Enter commits, Escape cancels. Blur also commits, but blur is what a
 * hand finds by accident — this strip answers "how do I say done?", the
 * question the shortcut catalog records someone failing to answer while an
 * editor was open (shortcuts.ts, `commit-text-edit`).
 *
 * On a fine pointer it is decoration by design: `aria-hidden` (the editors
 * carry the same chord in `aria-keyshortcuts`), no pointer target, never
 * focusable. On a coarse pointer, given handlers, it is the two buttons.
 */
export function EditorExitHint({
  className,
  style,
  onDone,
  onCancel,
  dense = false,
  canvasOverlay = false,
}: EditorExitHintProps) {
  if (onDone !== undefined && onCancel !== undefined && hasCoarsePointer()) {
    // The editors commit on blur. A tap that moved focus here would commit
    // BEFORE the click could cancel, so Cancel would silently mean Done —
    // cancelling pointerdown keeps focus in the editor until the click lands.
    const keepEditorFocus = (event: ReactPointerEvent) => {
      event.preventDefault()
    }
    // Icons, not words: the same pill language as the dock and the node
    // toolbar. The verbs live in the accessible names.
    const button = dense ? DENSE_ICON_BUTTON_CLASS : DOCK_BUTTON_CLASS
    const icon = dense ? 'size-4' : 'size-5'
    return (
      <div
        data-testid="editor-exit-hint"
        data-editor-overlay={canvasOverlay ? true : undefined}
        className={cn(
          'bg-background border-border inline-flex items-center gap-0.5 rounded-lg border p-0.5 shadow-sm select-none',
          className,
        )}
        style={style}
      >
        <button
          type="button"
          aria-label="Done"
          title="Done"
          onPointerDown={keepEditorFocus}
          onClick={onDone}
          className={cn(button, 'text-foreground')}
        >
          <Check aria-hidden="true" className={icon} />
        </button>
        <span aria-hidden="true" className="bg-border h-5 w-px" />
        <button
          type="button"
          aria-label="Cancel"
          title="Cancel"
          onPointerDown={keepEditorFocus}
          onClick={onCancel}
          className={button}
        >
          <X aria-hidden="true" className={icon} />
        </button>
      </div>
    )
  }
  return (
    <span
      aria-hidden="true"
      data-testid="editor-exit-hint"
      className={cn(
        'text-muted-foreground pointer-events-none inline-flex items-center gap-1 text-[11px] leading-none whitespace-nowrap select-none',
        className,
      )}
      style={style}
    >
      <kbd className={KBD}>{isMacPlatform() ? '⌘↩' : 'Ctrl+↩'}</kbd>
      <span>Done</span>
      <span className="opacity-60">·</span>
      <kbd className={KBD}>esc</kbd>
      <span>Cancel</span>
    </span>
  )
}
