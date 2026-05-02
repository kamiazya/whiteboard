// Per-test setup applied to every *.docs-snapshot.test.tsx via the
// `setupFiles` option in vitest.docs-snapshots.config.ts. Pinning
// Math.random globally keeps any Excalidraw-internal id generation +
// rough.js hand-drawn wobble byte-stable across regenerations — the
// alternative is each test remembering to call seedMathRandom() in
// beforeEach, which is easy to forget when adding new scenes.

import { afterEach, beforeEach } from 'vitest'
import { seedMathRandom } from './_helpers.js'

let restoreMathRandom: (() => void) | null = null
let injectedStyleEl: HTMLStyleElement | null = null

// Excalidraw paints a few transient affordances that flip pixels between
// otherwise identical runs (undo/redo button enabled state, hover focus
// rings, scroll-back-to-content prompt, etc.). For doc images, hide
// them globally so byte-stable regenerations are achievable.
const STABILISE_STYLE = `
  .undo-redo-buttons,
  .scroll-back-to-content,
  .help-icon,
  .Stack__row .ToolIcon:focus,
  *:focus-visible { outline: none !important; }
  .undo-redo-buttons { visibility: hidden !important; }
  .scroll-back-to-content,
  .help-icon { display: none !important; }
`

let restoreCaret: (() => void) | null = null

beforeEach(() => {
  restoreMathRandom = seedMathRandom()
  if (typeof document !== 'undefined') {
    injectedStyleEl = document.createElement('style')
    injectedStyleEl.dataset.docsSnapshotStabilise = 'true'
    injectedStyleEl.textContent = STABILISE_STYLE
    document.head.appendChild(injectedStyleEl)
    // Hide the text caret too — a focused input would otherwise blink at
    // 500 ms and the screenshot may catch it on or off.
    const caretStyle = document.createElement('style')
    caretStyle.dataset.docsSnapshotCaret = 'true'
    caretStyle.textContent = `* { caret-color: transparent !important; }`
    document.head.appendChild(caretStyle)
    restoreCaret = () => caretStyle.remove()
  }
})

afterEach(() => {
  restoreMathRandom?.()
  restoreMathRandom = null
  injectedStyleEl?.remove()
  injectedStyleEl = null
  restoreCaret?.()
  restoreCaret = null
})
