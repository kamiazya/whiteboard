/**
 * Every icon control in the two chrome rows wears one class set.
 *
 * Measured before this guard: five spellings in one header row. Raw
 * `<button>` beside shadcn `Button`; `p-1` beside `p-1.5`; `size-7` beside
 * `size-8`; `rounded` beside `rounded-md`; a 14px glyph beside 16px ones; a
 * toggle look on some toggles and not others. None of it was a decision —
 * each control was written in the file that first needed it, in whatever
 * spelling that file already had. The row that reads as "restless" is this
 * table, and nothing was red.
 *
 * `ui/header-button.ts` is the one spelling now, the way `ui/dock-button.ts`
 * is for the bottom chrome — and for the same reason that module gives: a
 * `pointer-coarse` step that lands on one side of a row and not the other
 * puts a 44px control next to a 32px one. The header had NO coarse step at
 * all while the dock had one, so on a phone the top and bottom of the same
 * screen answered the finger differently.
 *
 * Assert-a-rule, not a ledger (see `.claude/rules/coverage-ledger.md`):
 * nothing models these controls, so a per-item table would be the
 * hand-kept list this file exists to replace. The count per file is pinned
 * by equality from both sides, so a header control added in a fresh
 * spelling fails here until it is filed as one of the shared ones.
 */

import { describe, expect, it } from 'vitest'

const sources = import.meta.glob('./**/*.tsx', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

/**
 * The files whose icon controls sit in a chrome row, and how many of them
 * wear a shared header class. Adding a control to one of these files, or a
 * ninth file to the rows, changes a number here — on purpose.
 */
const HEADER_SURFACES: Record<string, number> = {
  './components/AppShell.tsx': 1,
  './components/WorkspaceTopBar.tsx': 2,
  './components/workspace-top-bar/TopBarSecondaryActions.tsx': 2,
  './components/workspace-top-bar/DocumentMenu.tsx': 1,
  './components/document-properties/DocumentProperties.tsx': 1,
  './components/spatial-editor/CanvasDisplaySettings.tsx': 1,
  './components/annotations/CommentsRailChrome.tsx': 1,
  './components/connections/ConnectionsChip.tsx': 1,
  './components/document-editor/InspectorPanel.tsx': 1,
}

const HEADER_CLASS = /\bHEADER_(?:WIDE_)?(?:BUTTON|TOGGLE)_CLASS\b/g

/**
 * Usages only. The import line names every constant a file uses once more,
 * so counting it would make the pinned number "controls plus one" and the
 * first reader would pin the wrong thing.
 */
function withoutImports(source: string): string {
  return source.replace(/^import[^\n]*\n/gm, '')
}

/**
 * The five spellings this replaced, as they appeared on an icon control's
 * opening tag. Kept as a denylist rather than derived, because the point is
 * that these exact strings are what a reader will reach for by habit.
 */
const LEGACY_SPELLINGS = [
  /rounded(?:-md)? p-1(?:\.5)?\b/,
  /\bsize-7\b/,
  /className="size-8 p-0"/,
  /variant="ghost"\s+size="sm"/,
]

describe('header icon controls', () => {
  it('scanned the files this rule is about', () => {
    // A path that stops matching would otherwise read as "zero controls",
    // which is the same number a file that lost its header controls shows.
    for (const path of Object.keys(HEADER_SURFACES)) {
      expect(sources[path], `${path} is no longer where the scan looks`).toBeDefined()
    }
  })

  it('wear the shared header class, exactly as many times as declared', () => {
    const found = Object.fromEntries(
      Object.keys(HEADER_SURFACES).map((path) => [
        path,
        (withoutImports(sources[path] ?? '').match(HEADER_CLASS) ?? []).length,
      ]),
    )
    expect(found).toEqual(HEADER_SURFACES)
  })

  it('carry none of the spellings the shared class replaced', () => {
    const offenders = Object.keys(HEADER_SURFACES).flatMap((path) => {
      const source = sources[path] ?? ''
      return LEGACY_SPELLINGS.filter((legacy) => legacy.test(source)).map(
        (legacy) => `${path}: ${legacy.source}`,
      )
    })
    expect(offenders).toEqual([])
  })
})
