/**
 * A browser test may not WRITE the shared view-mode preference.
 *
 * `whiteboard.markdown-view-mode` is per-browser state in localStorage, which
 * browser test files share — one origin, files in parallel. A file that seeds
 * it poisons every concurrent mount that reads it: seeding 'read' hides the
 * source pane (`display:none`), `focus()` on an unrendered element is a
 * spec'd no-op, and eleven keymap tests in a DIFFERENT file fail with
 * `expected <body> to be <div …>`. An `afterEach` cleanup cannot help,
 * because the poisoning is concurrent, not residual.
 *
 * The isolation seam is `initialViewMode` on MarkdownEditor (and threaded
 * through NodeTextEditorOverlay): it detaches a mount from the shared
 * preference in both directions — the mount neither reads it nor writes it.
 * Reading the key, or asserting on it, stays legitimate; only browser-test
 * WRITES are the hazard, so only `setItem` is barred. The jsdom suite runs
 * files in isolated environments and keeps testing the persistence itself.
 *
 * Same shape as `shared-idb-version-games.test.ts`, for the same class of
 * failure one shared global over.
 */
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob('../../**/*.browser.test.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

// Two independent tells rather than one pattern: a file that names the key in
// a const and calls `setItem(KEY, …)` defeats any single-expression match —
// which is how such a file is actually written, and exactly the vacuity the
// shared-IDB guard's first version shipped with. Naming the key at all while
// also writing localStorage is the hazard; reading it stays legitimate in a
// file that never writes.
const NAMES_THE_KEY = /markdown-view-mode/
// Any `.setItem(` call, not one adjacent to the literal `localStorage`: a
// file can alias the storage object (`const storage = window.localStorage`)
// and the adjacency form goes blind — the same alias trap, one level up.
const WRITES_LOCAL_STORAGE = /\.\s*setItem\s*\(/

function offendingFiles(entries: Record<string, string>): string[] {
  return Object.entries(entries)
    .filter(([, source]) => NAMES_THE_KEY.test(source) && WRITES_LOCAL_STORAGE.test(source))
    .map(([path]) => path)
    .sort()
}

describe('the shared markdown view-mode preference', () => {
  it('scans a real population, so an empty result cannot mean the glob matched nothing', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20)
  })

  it('is never written by a browser test — initialViewMode is the seam', () => {
    expect(offendingFiles(sources)).toEqual([])
  })

  it('detects the pattern, so clean means clean rather than blind', () => {
    expect(
      offendingFiles({
        'x.browser.test.tsx':
          "window.localStorage.setItem('whiteboard.markdown-view-mode', 'read')",
      }),
    ).toEqual(['x.browser.test.tsx'])
    // The const-alias spelling is how such a file actually gets written; a
    // guard blind to it passed while the poisoning file sat in the tree.
    expect(
      offendingFiles({
        'x.browser.test.tsx':
          "const KEY = 'whiteboard.markdown-view-mode'\nlocalStorage.setItem(KEY, 'read')",
      }),
    ).toEqual(['x.browser.test.tsx'])
    // The storage OBJECT aliased, not just the key — the second tell must
    // not require the literal `localStorage` beside the call.
    expect(
      offendingFiles({
        'x.browser.test.tsx':
          "const storage = window.localStorage\nstorage.setItem('whiteboard.markdown-view-mode', 'read')",
      }),
    ).toEqual(['x.browser.test.tsx'])
    // Reading without writing stays clean.
    expect(
      offendingFiles({
        'x.browser.test.tsx':
          "expect(localStorage.getItem('whiteboard.markdown-view-mode')).toBe('split')",
      }),
    ).toEqual([])
  })
})
