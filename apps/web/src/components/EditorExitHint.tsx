import { Check, X } from 'lucide-react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '@/lib/utils'
import { hasCoarsePointer, isMacPlatform } from '../lib/platform.js'

const KBD =
  'rounded border border-border bg-background px-1 py-px font-sans text-[10px] text-muted-foreground'

/**
 * One slot of the touch pill, in screen px — the node-tools pill's slot
 * (SelectionOverlay), so the two clusters attached to a node read as one
 * family: 24px slots, 6px radius, background fill, border-coloured edge,
 * muted 1.5px glyphs, no shadow. Visually 24px; the hit area is widened by
 * the pseudo-element below, since a 24px target is under the touch floor.
 * The glyph stroke is ABSOLUTE: lucide's strokeWidth is in 24-unit viewBox
 * units, so at 14px a nominal 1.5 draws 0.9px and reads thinner than the
 * node-tools arrow beside it.
 */
const SLOT_CLASS =
  'relative flex size-6 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring after:absolute after:-inset-y-2 after:content-[""]'

/**
 * Where the strip goes, in the coordinates of the layer it renders into.
 * The touch pill right-aligns to `right` (mirroring node-tools, which hangs
 * off the node's top-right corner); the decorative strip left-aligns to
 * `left`. `scale` counter-scales a canvas-space layer's zoom so the pill
 * keeps its screen size — a tap target has a screen size, not a canvas one.
 */
export interface EditorExitHintPlacement {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly scale?: number
}

interface EditorExitHintProps {
  readonly className?: string
  readonly style?: CSSProperties
  readonly placement?: EditorExitHintPlacement
  /**
   * Both handlers turn the strip into real controls on a coarse pointer. A
   * finger has no chord to press, so naming one there is noise — and the
   * keyboard it does have is the software one, which offers no Escape.
   */
  readonly onDone?: () => void
  readonly onCancel?: () => void
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
 * focusable. On a coarse pointer, given handlers, it is the two buttons —
 * icons, not words, in the node-tools pill language; the verbs live in the
 * accessible names.
 */
export function EditorExitHint({
  className,
  style,
  placement,
  onDone,
  onCancel,
  canvasOverlay = false,
}: EditorExitHintProps) {
  const scale = placement?.scale === undefined ? undefined : `scale(${placement.scale})`
  if (onDone !== undefined && onCancel !== undefined && hasCoarsePointer()) {
    // The editors commit on blur. A tap that moved focus here would commit
    // BEFORE the click could cancel, so Cancel would silently mean Done —
    // cancelling pointerdown keeps focus in the editor until the click lands.
    const keepEditorFocus = (event: ReactPointerEvent) => {
      event.preventDefault()
    }
    const pill = (
      <div
        data-testid="editor-exit-hint"
        data-editor-overlay={canvasOverlay ? true : undefined}
        className={cn(
          'bg-background border-border inline-flex items-center rounded-[6px] border select-none',
          placement === undefined && className,
        )}
        style={
          placement === undefined
            ? style
            : {
                position: 'absolute',
                right: 0,
                top: 0,
                transform: scale,
                transformOrigin: 'top right',
              }
        }
      >
        <button
          type="button"
          aria-label="Done"
          title="Done"
          onPointerDown={keepEditorFocus}
          onClick={onDone}
          className={cn(SLOT_CLASS, 'after:right-0 after:-left-2')}
        >
          <Check aria-hidden="true" className="size-3.5" strokeWidth={1.5} absoluteStrokeWidth />
        </button>
        <span aria-hidden="true" className="bg-border h-3.5 w-px" />
        <button
          type="button"
          aria-label="Cancel"
          title="Cancel"
          onPointerDown={keepEditorFocus}
          onClick={onCancel}
          className={cn(SLOT_CLASS, 'after:left-0 after:-right-2')}
        >
          <X aria-hidden="true" className="size-3.5" strokeWidth={1.5} absoluteStrokeWidth />
        </button>
      </div>
    )
    if (placement === undefined) return pill
    // A zero-size anchor at the node's right edge; the pill hangs off it
    // leftwards, and scaling about its top-right corner keeps that edge put.
    return (
      <div
        className={className}
        style={{
          position: 'absolute',
          left: placement.right,
          top: placement.top,
          width: 0,
          height: 0,
        }}
      >
        {pill}
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
      style={
        placement === undefined
          ? style
          : {
              position: 'absolute',
              left: placement.left,
              top: placement.top,
              transform: scale,
              transformOrigin: 'top left',
            }
      }
    >
      <kbd className={KBD}>{isMacPlatform() ? '⌘↩' : 'Ctrl+↩'}</kbd>
      <span>Done</span>
      <span className="opacity-60">·</span>
      <kbd className={KBD}>esc</kbd>
      <span>Cancel</span>
    </span>
  )
}
