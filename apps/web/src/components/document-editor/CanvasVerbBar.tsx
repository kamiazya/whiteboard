import { hasCoarsePointer } from '../../lib/platform.js'
import { useActiveMarkdownEditor } from '../markdown-editor/active-markdown-editor.js'
import { MarkdownVerbBar } from '../markdown-editor/MarkdownVerbBar.js'
import { DESKTOP_BAR_HEIGHT_PX } from '../markdown-editor/verb-bar-layout.js'

/**
 * The editing verbs while a node's text is open on the canvas — a strip
 * under the header, for the duration of the edit and no longer.
 *
 * Under the header rather than under the node, which is where the touch bar
 * would put it. Screen space, so it neither counter-scales with zoom nor
 * flips above a node near the bottom edge; it does not fight the exit hint
 * for the tier directly below the node; and it lands in the same place as
 * the document editor's own verbs, so the two surfaces read alike.
 *
 * An overlay, not a row: inserting a row would resize the canvas the moment
 * an edit begins, moving the very node being edited out from under the
 * caret. Keyboard avoidance is told about the strip instead
 * (`use-keyboard-avoidance.ts`), so a node opened beneath it is panned clear.
 *
 * Fine pointers only — a coarse one gets `TouchFormattingBar`, docked to the
 * keyboard where the thumb is. There is no ⋯ here: the canvas has no verb
 * catalog to open, so a window too narrow for all sixteen (under ~490px,
 * which on a touch device would be the other bar's job anyway) simply shows
 * the highest-priority ones.
 */
export function CanvasVerbBar() {
  const editor = useActiveMarkdownEditor()
  if (editor === null || hasCoarsePointer()) return null
  return (
    <div
      data-testid="canvas-verb-bar"
      className="border-border bg-background/95 absolute inset-x-0 top-0 z-30 flex items-center border-b px-2 backdrop-blur-sm"
      style={{ height: DESKTOP_BAR_HEIGHT_PX }}
    >
      <MarkdownVerbBar
        run={(command) => editor.run(command)}
        openLinkPicker={editor.openLinkPicker}
      />
    </div>
  )
}
