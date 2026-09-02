import { lazy, Suspense } from 'react'
import { hasCoarsePointer } from '../../lib/platform.js'
import { useSoftwareKeyboard } from '../../lib/software-keyboard.js'
import { useActiveMarkdownEditor } from './active-markdown-editor.js'

const TouchFormattingBarPanel = lazy(() => import('./TouchFormattingBarPanel.js'))

/**
 * The formatting bar a phone gets in place of keyboard shortcuts: docked to
 * the top edge of the software keyboard while a markdown editor holds the
 * caret. Mounted once, beside the app; it finds its editor through the
 * active-editor registry and its position through the visual viewport, and
 * renders nothing on a fine pointer, with no editor, or with the keyboard
 * down — a hardware keyboard has the chords, so nothing changes there.
 *
 * The web cannot extend the keyboard itself (no accessory rows, no custom
 * keys); this bar is the app's own strip, glued to where the keyboard ends.
 *
 * This is only the gate. The bar itself (verbs, icons, the sheet) is
 * `TouchFormattingBarPanel`, loaded lazily the first time the gate opens:
 * it drags the CodeMirror command table in, and this component sits in the
 * entry chunk, where that table put the critical path 20 KB gzip over
 * budget when it was imported eagerly.
 */
export function TouchFormattingBar() {
  const editor = useActiveMarkdownEditor()
  const keyboard = useSoftwareKeyboard()
  const shown = editor !== null && keyboard.occludedBottomPx > 0 && hasCoarsePointer()
  if (!shown) return null
  return (
    <Suspense fallback={null}>
      <TouchFormattingBarPanel />
    </Suspense>
  )
}
