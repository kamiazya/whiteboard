// Per-test setup applied to every *.docs-snapshot.test.tsx via the
// `setupFiles` option in vitest.docs-snapshots.config.ts. Pinning
// Math.random globally keeps any component-internal id generation or
// display detail byte-stable across regenerations — the alternative is
// each test remembering to call seedMathRandom() in beforeEach, which is
// easy to forget when adding new scenes.

import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { afterEach, beforeEach } from 'vitest'
import { BROWSER_DEFAULT_SEGMENT } from '../lib/browser-idb.js'
import { setBrowserWorkspaceIdForTests } from '../lib/browser-workspace-id.js'
import { seedMathRandom } from './_helpers.js'

// No snapshot test runs the boot chain that resolves the browser workspace
// id (see browser-workspace-id.ts), so anything that reads it — LocalStoreDouble,
// BrowserIndexPage — throws unless a fixed id is seeded up front. Same seam
// and rationale as test-utils/browser-setup.ts, which every non-docs browser
// test already relies on for this. The id itself never renders — a page
// that shows a workspace name gives its seeded workspace a displayName —
// so a freshly minted one (rather than a fixed literal) is fine here.
setBrowserWorkspaceIdForTests(generateDocumentId(), BROWSER_DEFAULT_SEGMENT)

let restoreMathRandom: (() => void) | null = null

// Hide focus rings globally so a stray :focus-visible outline (left over
// from a prior interaction in the same test) never flips pixels between
// otherwise identical regenerations.
const STABILISE_STYLE = `
  *:focus-visible { outline: none !important; }
`

let injectedStyleEl: HTMLStyleElement | null = null
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
