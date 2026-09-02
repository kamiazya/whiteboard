import { lazy, Suspense } from 'react'
import { hasCoarsePointer } from '../../lib/platform.js'
import { useActiveMarkdownEditor } from './active-markdown-editor.js'

const TouchFormattingBarPanel = lazy(() => import('./TouchFormattingBarPanel.js'))

/**
 * The formatting bar a phone gets in place of keyboard shortcuts: docked to
 * the bottom of the window and lifted onto the software keyboard's top edge
 * while a markdown editor holds the caret. Mounted once, beside the app; it
 * finds its editor through the active-editor registry and its position
 * through `trackKeyboardDock`, and renders nothing on a fine pointer or with
 * no editor — a hardware keyboard has the chords, so nothing changes there.
 *
 * It does NOT gate on the keyboard being up. Under
 * `interactive-widget=resizes-content` the keyboard is invisible to the page
 * by design (the layout viewport simply shrinks), so there is no occlusion
 * left to read; and a strip at the bottom of a touch screen is where a
 * formatting toolbar belongs whether or not a keyboard is covering the rest.
 * What that gate used to prevent — a bar floating mid-screen — is now
 * prevented by the geometry instead.
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
  if (editor === null || !hasCoarsePointer()) return null
  return (
    <Suspense fallback={null}>
      <TouchFormattingBarPanel />
    </Suspense>
  )
}
