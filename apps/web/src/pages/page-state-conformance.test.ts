// @vitest-environment node
import { describe, expect, it } from 'vitest'

// Source-scan conformance for the shared page-state machine
// (document-page-state.ts): both document pages must derive their render
// state through their half of the machine and render the shared states
// through the shared views — never re-grow an inline cascade. Scanned as
// ?raw source (never node:fs; apps/web is browser-only and
// web-app-boundary.test.ts enforces it), the same shape as
// file-seam-conformance.test.ts next door.

const PAGES = import.meta.glob('./{Browser,Daemon}DocumentPage.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/**
 * A page's own module PLUS the sibling module it answers through. Each
 * page's terminal screens moved into its `*-document-slots.tsx` so the
 * page's own hook stays under the complexity budget; every rule below is
 * about what the PAGE does, and it does it there too — so a rule that read
 * one file and not the other would report a re-inlined cascade as clean, or
 * a shared view as missing.
 */
const PAGE_PARTS = import.meta.glob('./{browser,daemon}-document-slots.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const PARTS_OF: Record<'BrowserDocumentPage' | 'DaemonDocumentPage', readonly string[]> = {
  BrowserDocumentPage: ['./browser-document-slots.tsx'],
  DaemonDocumentPage: ['./daemon-document-slots.tsx'],
}

function readPage(name: 'BrowserDocumentPage' | 'DaemonDocumentPage'): string {
  const source = PAGES[`./${name}.tsx`]
  if (source === undefined) throw new Error(`page source not found: ${name}`)
  const parts = PARTS_OF[name].map((path) => {
    const part = PAGE_PARTS[path]
    if (part === undefined) throw new Error(`page part not found: ${path}`)
    return part
  })
  return [source, ...parts].join('\n')
}

function countOf(source: string, needle: string): number {
  return source.split(needle).length - 1
}

describe('page-state conformance', () => {
  it('found both page sources (the scan itself is plausible)', () => {
    expect(Object.keys(PAGES).sort()).toEqual([
      './BrowserDocumentPage.tsx',
      './DaemonDocumentPage.tsx',
    ])
    for (const source of Object.values(PAGES)) expect(source.length).toBeGreaterThan(5000)
  })

  it('each page derives its render state through its half of the shared machine, exactly once', () => {
    // The derive call is the single reader of the raw controller fields; a
    // second call (or none) means a branch has started reading them ad hoc.
    expect(countOf(readPage('BrowserDocumentPage'), 'derivePageState(')).toBe(1)
    expect(countOf(readPage('BrowserDocumentPage'), 'refineForContentReadFailure(')).toBe(1)
    expect(countOf(readPage('DaemonDocumentPage'), 'deriveDaemonPageState(')).toBe(1)
  })

  it('the daemon page reads controller.loadError only as the derive input', () => {
    // Before the machine, the JSX branched on controller.loadError directly.
    // One occurrence = the derive input; a second is an inline cascade
    // growing back.
    expect(countOf(readPage('DaemonDocumentPage'), 'controller.loadError')).toBe(1)
  })

  it('both pages render load-degraded through the shared LoadDegradedView, and neither re-inlines its markup', () => {
    for (const name of ['BrowserDocumentPage', 'DaemonDocumentPage'] as const) {
      const source = readPage(name)
      // Word-boundary: `<LoadDegradedView` must be followed by whitespace,
      // `/` or `>` so a longer component name cannot satisfy the count.
      const mounts = source.match(/<LoadDegradedView[\s/>]/g) ?? []
      expect(mounts, `${name} mounts LoadDegradedView once`).toHaveLength(1)
      // The load-failure paragraph's class lives only in the shared view; a
      // page containing it has re-inlined the state's markup.
      expect(countOf(source, 'max-w-md'), `${name} does not re-inline the view`).toBe(0)
      // The state is rendered FROM the machine: the branch names the shared
      // kind, not a controller field.
      expect(source.includes(".kind === 'load-degraded'"), `${name} branches on the kind`).toBe(
        true,
      )
    }
  })
})
