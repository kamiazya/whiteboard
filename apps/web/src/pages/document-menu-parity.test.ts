// @vitest-environment node
/**
 * What each KEEPER contributes to the document menu, and why the other one
 * does not.
 *
 * `DocumentPage` is one shell over two keepers: it draws the menu itself
 * (Export, and Bookmark where versions are enabled) and each keeper fills
 * `slots.menuItems` with the rows that are its own. Those rows are the whole
 * subject here — a row the shell draws is not a parity question, because both
 * keepers get it by construction.
 *
 * The class this catches is `.claude/rules/coverage-ledger.md`'s, on the axis
 * `keeper-parity.test.ts` structurally cannot see. That scan reads modules
 * that REACH THE DAEMON and asks what the browser does, so it catches a
 * browser gap behind a daemon feature and is silent on a daemon gap behind a
 * browser one — which is the direction this app actually drifted: measured
 * 2026-09-22, the browser keeper contributed three rows and the daemon keeper
 * contributed NONE, so a daemon-kept document could not be duplicated or
 * deleted from the document page at all. Nothing was red, because no test had
 * ever been asked to exist.
 *
 * Derived from BOTH sides rather than grepped from one. The issue this came
 * from was filed, published and corrected within the hour because it searched
 * `DaemonDocumentPage.tsx` for the names the browser implementation happens to
 * use (`isDuplicating`, `handleDuplicate`) and read their absence as the
 * verb's: **an absence found by grepping one implementation's names is not an
 * absence.** A row's LABEL is what a person sees and what both keepers must
 * spell the same way to mean the same thing, so the label is the key.
 */

import { describe, expect, it } from 'vitest'
import { assertScannedLedger } from '../test-utils/coverage-ledger.js'

type MenuParity =
  /** Both keepers contribute this row. */
  | { readonly reach: 'both' }
  /** Only one keeper has it, and that is the right answer. `keeper` is who. */
  | { readonly reach: 'one-keeper'; readonly keeper: Keeper; readonly why: string }
  /** Only one keeper has it, and the other should — with the follow-up. */
  | {
      readonly reach: 'gap'
      readonly keeper: Keeper
      readonly missing: string
      readonly followUp: string
    }

type Keeper = 'browser' | 'daemon'

const DOCUMENT_ACTIONS_FOLLOW_UP = 'issues/daemon-document-page-offers-no-document-actions'

const MENU_PARITY: Record<string, MenuParity> = {
  // Recorded as deliberate when this ledger landed, on the ground that the
  // daemon keeper would have to decode a snapshot for this row alone. That
  // reason is FALSE and the code says so: `DaemonDocumentPage` holds
  // `canvasValue`, a decoded SpatialCanvas, at the very place it builds its
  // slots. So the row is missing rather than declined — which is the whole
  // reason a `one-keeper` answer owes a reason a reader can check.
  'Copy as JSON Canvas': {
    reach: 'gap',
    keeper: 'browser',
    missing:
      "a daemon-kept spatial document cannot be copied to the clipboard as JSON Canvas from its own page, though the page already holds the decoded canvas the row would serialise — the same `serializeSpatial(canvas, 'extended')` the browser keeper writes",
    followUp: DOCUMENT_ACTIONS_FOLLOW_UP,
  },
  // Was a `gap` when this ledger landed, and closing it is what made the
  // entry fail — which is the direction the file exists for.
  Duplicate: { reach: 'both' },
  // Was a `gap` too; the same entry failing is what reported the closure.
  Delete: { reach: 'both' },
}

// `?raw` rather than node:fs — apps/web is browser-only and must not import a
// Node builtin (`web-app-boundary.test.ts` pins that).
const sources = import.meta.glob(
  ['/src/pages/*DocumentPage.tsx', '/src/pages/use-document-actions.tsx'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
) as Record<string, string>

/**
 * What each keeper RENDERS: the page, plus whatever bundle supplies its rows
 * — the same concatenation `scoped-screen-state.test.ts` reads, for the same
 * reason. A row extracted out of a page is still that keeper's row, and a
 * scan reading the page alone would report the extraction as the keeper
 * LOSING the verb.
 *
 * When both pages take the same bundle, both lists hold it and every row in
 * it is `both` by construction. That is the intended end state rather than a
 * loophole: two keepers rendering one component cannot differ.
 */
const PAGES: Record<Keeper, readonly string[]> = {
  browser: ['/src/pages/BrowserDocumentPage.tsx'],
  daemon: ['/src/pages/DaemonDocumentPage.tsx', '/src/pages/use-document-actions.tsx'],
}

/**
 * Comments go first, JSX ones included: the browser page explains in prose
 * why one row is spatial-only, and a ledger that answers for a row somebody
 * merely DESCRIBED teaches people to write entries that shut the scan up.
 */
function code(text: string): string {
  return text
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * The label a row shows: its element text, with nested tags and every `{...}`
 * expression removed so an icon does not become part of the name.
 *
 * The open tag is walked rather than matched, tracking brace depth, because
 * `onSelect={() => …}` contains a `>` of its own — a non-greedy
 * `<DropdownMenuItem[\s\S]*?>` ends THERE and reads the rest of the handler
 * as the label. Measured while writing this: the first version answered
 * `"{ void navigator.clipboard ?.writeText(…) }} > Copy as JSON Canvas"`,
 * which is a label no ledger entry could ever match and which would have made
 * the scan report three permanent strangers.
 */
function labelsFrom(source: string): string[] {
  const text = code(source)
  const labels = new Set<string>()
  const OPEN = '<DropdownMenuItem'
  const CLOSE = '</DropdownMenuItem>'
  for (let at = text.indexOf(OPEN); at !== -1; at = text.indexOf(OPEN, at + OPEN.length)) {
    let cursor = at + OPEN.length
    let depth = 0
    while (cursor < text.length) {
      const char = text[cursor]
      if (char === '{') depth += 1
      else if (char === '}') depth -= 1
      else if (char === '>' && depth === 0) break
      cursor += 1
    }
    if (text[cursor - 1] === '/') continue
    const end = text.indexOf(CLOSE, cursor)
    if (end === -1) continue
    const label = text
      .slice(cursor + 1, end)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\{[^{}]*\}/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (label !== '') labels.add(label)
  }
  return [...labels].sort()
}

function menuLabels(keeper: Keeper): string[] {
  const labels = new Set<string>()
  for (const path of PAGES[keeper]) {
    const source = sources[path]
    // A renamed or moved file must FAIL rather than read as a keeper that
    // contributes nothing: every entry below says a row is on the browser
    // side and not on the daemon side, so an empty daemon source satisfies
    // all of them at once. The same reason `purity-guard` and
    // `file-size-budget` check that the paths they hold still exist.
    if (source === undefined) throw new Error(`no such source: ${path}`)
    for (const label of labelsFrom(source)) labels.add(label)
  }
  return [...labels].sort()
}

/**
 * The extraction's own guard, over a fixture rather than over the pages: both
 * of the shapes it handles are shapes no page happens to contain today, so
 * measured against the real files the handling is code that cannot fail.
 */
describe('a row is read from its label, whatever surrounds it', () => {
  // `count > 1` as well as the arrow: a walk that stopped at any `>` is
  // caught by either, but one that special-cased `=>` would pass on the arrow
  // alone. A comparison inside braces is the shape that leaves no way to read
  // the open tag except by counting braces.
  it('ignores a row that is only described in a comment, and reads one past an arrow handler', () => {
    const fixture = `
      {/* A commented row: <DropdownMenuItem>Ghost</DropdownMenuItem> */}
      // <DropdownMenuItem>Line comment</DropdownMenuItem>
      <DropdownMenuItem disabled={count > 1} onSelect={() => void go()}>
        <Copy aria-hidden="true" className="size-3.5" />
        Duplicate
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => setOpen(true)}>Delete</DropdownMenuItem>
    `
    expect(labelsFrom(fixture)).toEqual(['Delete', 'Duplicate'])
  })
})

describe('each row a keeper contributes to the document menu says what the other keeper does', () => {
  const offered: Record<Keeper, string[]> = {
    browser: menuLabels('browser'),
    daemon: menuLabels('daemon'),
  }
  const scanned = [...new Set([...offered.browser, ...offered.daemon])].sort()

  it('finds the rows at all', () => {
    // A regex that stopped matching would otherwise report itself below as
    // "every entry is stale", sending the reader to the wrong file entirely.
    expect(offered.browser.length).toBeGreaterThanOrEqual(3)
  })

  it('classifies every row, and names none that has stopped being offered', () => {
    assertScannedLedger(scanned, MENU_PARITY, {
      unclassified:
        'these document-menu rows are contributed by a keeper and MENU_PARITY does not say what the other keeper does — add an entry: both, one-keeper (with why the other has none), or gap (with the follow-up that closes it)',
      stale:
        'these MENU_PARITY entries name rows no keeper contributes any more — delete the entry',
    })
  })

  describe('and the answer is checked against the scan, so none is a word in front of an omission', () => {
    const entries = Object.entries(MENU_PARITY)

    it.each(entries.filter(([, e]) => e.reach === 'both'))('%s really is on both', (label) => {
      expect(offered.browser).toContain(label)
      expect(offered.daemon).toContain(label)
    })

    // The direction that matters most: a filled gap makes its OWN entry fail,
    // so closing one is what forces the entry to stop claiming it is open —
    // rather than the gap being quietly rediscovered by the next person who
    // looks for the row and cannot find it.
    it.each(
      entries.filter(([, e]) => e.reach !== 'both'),
    )('%s really is on one keeper only', (label, entry) => {
      if (entry.reach === 'both') return
      const other: Keeper = entry.keeper === 'browser' ? 'daemon' : 'browser'
      expect(offered[entry.keeper]).toContain(label)
      expect(
        offered[other],
        `${label} is recorded as ${entry.keeper}-only and the ${other} keeper now contributes it too — change the entry to { reach: 'both' }`,
      ).not.toContain(label)
    })

    it.each(
      entries.filter(([, e]) => e.reach === 'gap'),
    )('%s names a follow-up that can be picked up', (_label, entry) => {
      if (entry.reach !== 'gap') return
      // Same two forms `keeper-parity.test.ts` accepts: the live Task board,
      // or a durable whiteboard document under issues/.
      expect(entry.followUp).toMatch(/#\d+|issues\/[a-z0-9]+(-[a-z0-9]+)+/)
      expect(entry.missing.split(/\s+/).length).toBeGreaterThan(8)
    })

    it.each(
      entries.filter(([, e]) => e.reach === 'one-keeper'),
    )('%s says why the other keeper has none', (_label, entry) => {
      if (entry.reach !== 'one-keeper') return
      expect(entry.why.split(/\s+/).length).toBeGreaterThan(8)
    })
  })
})
