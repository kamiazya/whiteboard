import type { CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { isMacPlatform } from '../lib/platform.js'

const KBD =
  'rounded border border-border bg-background px-1 py-px font-sans text-[10px] text-muted-foreground'

/**
 * A text-editor overlay's exit semantics, said where the typing happens:
 * mod+Enter commits, Escape cancels. Blur also commits, but blur is what a
 * hand finds by accident — this strip answers "how do I say done?", the
 * question the shortcut catalog records someone failing to answer while an
 * editor was open (shortcuts.ts, `commit-text-edit`).
 *
 * Decoration by design: `aria-hidden` (the editors carry the same chord in
 * `aria-keyshortcuts`), no pointer target, never focusable.
 */
export function EditorExitHint({
  className,
  style,
}: {
  readonly className?: string
  readonly style?: CSSProperties
}) {
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
