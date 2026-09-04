// Per-test setup applied to every *.docs-snapshot.test.tsx via the
// `setupFiles` option in vitest.docs-snapshots.config.ts. Pinning
// Math.random globally keeps any component-internal id generation or
// display detail byte-stable across regenerations — the alternative is
// each test remembering to call seedMathRandom() in beforeEach, which is
// easy to forget when adding new scenes.

import { afterEach, beforeEach } from 'vitest'
import { BROWSER_DEFAULT_SEGMENT } from '../lib/browser-idb.js'
import { setBrowserWorkspaceIdForTests } from '../lib/browser-workspace-id.js'
import { seedMathRandom } from './_helpers.js'

// The synchronous workspace-id accessor throws until something resolves it;
// every other project's setup seeds this seam and this one was missed when
// the boot chain moved (the whole suite failed with "browser workspace id
// read before resolveBrowserWorkspaceId() completed"). A FIXED id, not a
// generated one: a snapshot regenerates byte-identical or not at all.
setBrowserWorkspaceIdForTests('01ARZ3NDEKTSV4RRFFQ69G5FAV', BROWSER_DEFAULT_SEGMENT)

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
