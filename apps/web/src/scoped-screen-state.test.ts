/**
 * Every piece of React state on a SCOPED screen, classified against one
 * question: **does it name something that belongs to the scope?**
 *
 * A screen is scoped when it stays mounted while the thing it is about
 * changes underneath it — a workspace switch on the two browsers, a document
 * switch on the top bar's chip and timeline. Both are in-SPA route changes
 * (ADR-0019), so nothing remounts and every captured entry survives.
 *
 * A document belongs to exactly one workspace, and paths collide freely
 * across them — `untitled` is the first document in most. So state that
 * names one, held across a workspace switch, pairs a departed path with the
 * store now on screen. Both screens already knew this in part:
 * `DaemonIndexPage`'s switch effect says in its own comment that leaving old
 * rows visible "lets a click pair the new workspace id with an old
 * workspace's path", and `WorkspaceFilesPanel`'s `revision` effect
 * re-resolves `selected` and `cardMenu` against a fresh list. Neither list
 * was complete, and nothing made the next one complete.
 *
 * What that cost, measured before the clears were added:
 *
 *   - a delete dialog left open across a switch sent
 *     `DELETE ws-b/untitled` — a document nobody selected, in a workspace
 *     the person had navigated away from the one they chose it in
 *   - a rename dialog left open across a switch called `setDocumentName`
 *     on the NEW workspace's store with the OLD workspace's entry
 *
 * A modal does not make either unreachable: ADR-0019 makes a workspace
 * switch an in-SPA route change, and browser Back is not blocked by a Radix
 * dialog.
 *
 * This is the source-scan variant from `.claude/rules/coverage-ledger.md`:
 * `useState` calls are not a union, so the key set comes from the source.
 * The classification is what a new piece of state cannot avoid answering —
 * adding one fails this file until someone says which it is.
 *
 * Source comes from `?raw` at build time, not `node:fs`: apps/web is
 * browser-only and `web-app-boundary.test.ts` enforces it.
 */
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob(
  [
    './components/workspace-files/WorkspaceFilesPanel.tsx',
    './pages/DaemonIndexPage.tsx',
    './components/HeaderBranchChip.tsx',
    './components/VersionTimeline.tsx',
    './pages/use-markdown-document.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>

type ScopeCoverage =
  /** Dropped when the scope changes, because it names something inside it. */
  | 'cleared on switch'
  /**
   * IS scope-bound and knowingly still survives. A first-class permanent
   * answer, like `not modelled:` in the other ledgers — what it forbids is
   * the UNDECIDED member, not the uncleared one. The reason has to say what
   * would be needed, because "we'll get to it" is the omission with a
   * sentence in front of it.
   */
  | `survives: ${string}`
  /**
   * Names no document, so it survives a switch harmlessly. The reason has to
   * say WHY — "it's only a boolean" is exactly what was true of
   * `duplicatingPath` until you notice it is a path.
   */
  | `no subject: ${string}`

const PANEL = './components/workspace-files/WorkspaceFilesPanel.tsx'
const DAEMON_INDEX = './pages/DaemonIndexPage.tsx'
const BRANCH_CHIP = './components/HeaderBranchChip.tsx'
const VERSION_TIMELINE = './components/VersionTimeline.tsx'
const MARKDOWN_DOCUMENT = './pages/use-markdown-document.ts'

const PANEL_STATE: Record<string, ScopeCoverage> = {
  documents: 'cleared on switch',
  selected: 'cleared on switch',
  cardMenu: 'cleared on switch',
  renaming: 'cleared on switch',
  renameError: 'cleared on switch',
  renameBusy: 'cleared on switch',
  hits: 'cleared on switch',
  searchDegraded: 'cleared on switch',
  refreshError: 'cleared on switch',
  pinError: 'cleared on switch',

  listStatus: 'no subject: a load outcome for the list as a whole, reset by the same effect',
  folder:
    'no subject: an address WITHIN a workspace, reset separately and only on a real identity change — see the effect’s own note on StrictMode',
  columns: 'no subject: how you look, not what at; deliberately persisted across everything',
  createError:
    'no subject: a refused create, carrying a kind and the store’s words — no path of its own',
  creating: 'no subject: an in-flight flag for this screen’s own submit',
  query: 'no subject: what was typed; the results it produces are `hits`, which IS cleared',
}

const DAEMON_INDEX_STATE: Record<string, ScopeCoverage> = {
  rows: 'cleared on switch',
  pendingDelete: 'cleared on switch',
  deleteError: 'cleared on switch',
  duplicatingPath: 'cleared on switch',

  workspaces: 'no subject: the list of workspaces, which a switch does not invalidate',
  workspacesLoaded: 'no subject: whether that list has settled',
  selectedWorkspace: 'no subject: it IS the workspace — the thing every clear is keyed on',
  trashCount: 'no subject: a count, reset by the same effect',
  loaded: 'no subject: whether this workspace’s documents have settled',
  loadError: 'no subject: a load outcome for the workspace, reset by the same effect',
  createError: 'no subject: a refused create; no path of its own',
  duplicateError: 'no subject: a refused duplicate; the path it was about is `duplicatingPath`',
  creating: 'no subject: an in-flight flag for this screen’s own submit',
  deleting: 'no subject: an in-flight flag; the path it is about is `pendingDelete`',
}

/** An empty value, in any of the shapes these screens reset to. */
const EMPTY = '(null|\\[\\]|false|0|\'\'|"")'

/**
 * What a name is called and how a reset to it would read.
 *
 * The setter is taken from the DECLARATION rather than derived as
 * `set${Name}`, because that convention does not hold: `use-markdown-document`
 * declares `[body, setBodyState]` and `[coreFacets, setCoreMetaState]`, since
 * `setBody` is already the hook's public writer. A guard that assumed the
 * convention would have reported both as unbacked claims and sent the reader
 * looking for a bug in the fix.
 */
interface Slot {
  name: string
  reset: RegExp
}

/** Every `const [x, setX] = useState` a source declares, in source order. */
function stateNames(source: string): Slot[] {
  return [...source.matchAll(/const \[(\w+), (set\w+)\]\s*=\s*useState/g)].map((m) => ({
    name: m[1],
    reset: new RegExp(`${m[2]}\\(${EMPTY}\\)`),
  }))
}

/**
 * Names every `const x = useRef` declares.
 *
 * Opt-in per case, and the reason it exists at all is that a REF held the
 * worst defect of the three this ledger has now covered: `hostRef` in
 * `use-markdown-document` kept the departed document's write handle through
 * the next one's load, so a keystroke under one document was saved into
 * another. Scanning only `useState` would never have asked about it.
 *
 * The four screen cases do not scan refs yet — 3 to 5 each, none of them read
 * closely enough here to classify honestly, and a wrong `no subject:` in a
 * guard people trust is worse than an absent one. Turning it on for them is a
 * one-word change per case and its own increment.
 */
function refNames(source: string): Slot[] {
  return [...source.matchAll(/const (\w+) = useRef/g)].map((m) => ({
    name: m[1],
    // A ref has no setter: clearing one is an assignment to `.current`.
    reset: new RegExp(`${m[1]}\\.current\\s*=\\s*${EMPTY}`),
  }))
}

/**
 * Marks the effect that runs when the screen's SCOPE changes. Each screen
 * carries it on the line above that effect.
 */
const SCOPE_RESET_MARKER = '// SCOPE RESET'

/**
 * The body of the scope-reset effect, from its marker to its dependency
 * array.
 *
 * Reading the WHOLE FILE instead is what this replaces, and the difference is
 * not academic: measured, a mutation that deleted two setter lines out of the
 * effect left the guard green, because both setters still appeared in a
 * dialog's own close handler further down. The claim being checked is
 * "cleared WHEN THE SCOPE CHANGES", and only this block can answer it.
 */
function scopeResetBlock(source: string): string {
  const start = source.indexOf(SCOPE_RESET_MARKER)
  if (start === -1) return ''
  const end = source.indexOf('}, [', start)
  return end === -1 ? '' : source.slice(start, end)
}

// Scoped on the DOCUMENT rather than the workspace: both live in the top bar
// and take `path` as a prop, so a document switch changes what they are about
// without remounting them.
const BRANCH_CHIP_STATE: Record<string, ScopeCoverage> = {
  pendingDelete: 'cleared on switch',
  pendingStats: 'cleared on switch',
  deleting: 'cleared on switch',
  renameOpen: 'cleared on switch',
  renameTarget: 'cleared on switch',
  renameDraft: 'cleared on switch',
  pendingMerge: 'cleared on switch',
  errorMessage: 'cleared on switch',

  createOpen: 'no subject: a disclosure for the inline create form',
  newName:
    'no subject: free text for a variation that does not exist yet, so it cannot address the wrong one — creating it here creates it HERE',
  chipTooltipOpen: 'no subject: hover state on the chip itself',
}

const VERSION_TIMELINE_STATE: Record<string, ScopeCoverage> = {
  versions: 'cleared on switch',
  pendingRestore: 'cleared on switch',
  restoreError: 'cleared on switch',
  isRestoring: 'cleared on switch',

  loading: 'no subject: an in-flight flag for this screen’s own fetch',
}

// Scoped on the DOCUMENT, and the one case that scans REFS too — see
// `refNames` for why.
const MARKDOWN_DOCUMENT_STATE: Record<string, ScopeCoverage> = {
  doc: 'cleared on switch',
  body: 'cleared on switch',
  coreFacets: 'cleared on switch',
  hostRef: 'cleared on switch',

  saveState:
    'survives: it describes the DEPARTED document’s last save. Resetting it alone would not settle the question — the outgoing flush reports asynchronously through the same setter, so its result lands after any reset. Needs its own reproduction before a fix, the way the write path got one',

  loroRef: 'no subject: mirrors the `loro` prop, reassigned on every render',
  scheduleSaveRef: 'no subject: mirrors the current `scheduleSave`, reassigned on every render',
  setSaveStateRef: 'no subject: mirrors the state setter, reassigned on every render',
  schedulerRef:
    'no subject: keyed BY the document id — `schedulerFor` replaces it whenever the id differs, so it corrects itself rather than going stale',
}

const CASES = [
  { file: PANEL, ledger: PANEL_STATE, label: 'WorkspaceFilesPanel', scanRefs: false },
  { file: DAEMON_INDEX, ledger: DAEMON_INDEX_STATE, label: 'DaemonIndexPage', scanRefs: false },
  { file: BRANCH_CHIP, ledger: BRANCH_CHIP_STATE, label: 'HeaderBranchChip', scanRefs: false },
  {
    file: VERSION_TIMELINE,
    ledger: VERSION_TIMELINE_STATE,
    label: 'VersionTimeline',
    scanRefs: false,
  },
  {
    file: MARKDOWN_DOCUMENT,
    ledger: MARKDOWN_DOCUMENT_STATE,
    label: 'useMarkdownDocument',
    scanRefs: true,
  },
] as const

/** Everything a case's ledger has to account for. */
function scanned(source: string, scanRefs: boolean): Slot[] {
  return scanRefs ? [...stateNames(source), ...refNames(source)] : stateNames(source)
}

describe('scoped screen state is classified', () => {
  it.each(CASES)('$label: the scan reaches a plausible amount of state', ({ file, scanRefs }) => {
    // A regex that stops matching reports every entry as stale, which sends
    // the reader to the wrong file entirely.
    expect(sources[file], `${file} was not globbed`).toBeDefined()
    expect(scanned(sources[file], scanRefs).length).toBeGreaterThan(4)
  })

  it.each(CASES)('$label: every piece of state is classified', ({ file, ledger, scanRefs }) => {
    const unclassified = scanned(sources[file], scanRefs)
      .map((slot) => slot.name)
      .filter((name) => !(name in ledger))
    expect(
      unclassified,
      'new state or ref must say whether it is bound to this screen\'s SCOPE — the workspace for a browser, the document for the top bar and the markdown hook. If it is, reset it in the // SCOPE RESET effect and mark it "cleared on switch"; if it is not, say why; if it is and stays anyway, say `survives:` and what a fix would need. A path, an entry or a write handle always is',
    ).toEqual([])
  })

  it.each(CASES)('$label: every classified name still exists', ({ file, ledger, scanRefs }) => {
    const present = new Set(scanned(sources[file], scanRefs).map((slot) => slot.name))
    const stale = Object.keys(ledger).filter((name) => !present.has(name))
    expect(stale, 'these entries name state the screen no longer holds').toEqual([])
  })

  // The half that makes this more than a list of names. An entry claiming to
  // be cleared must have its setter called somewhere — a claim nothing backs
  // is the decoration this ledger exists to replace.
  it.each(CASES)('$label: carries a scope-reset effect to check against', ({ file }) => {
    // Without the marker the block is empty and every `cleared` entry below
    // fails at once — loud, but pointing at the wrong thing. Say it here.
    expect(
      scopeResetBlock(sources[file]).length,
      `no ${SCOPE_RESET_MARKER} marker: the guard cannot tell what this screen drops when its scope changes`,
    ).toBeGreaterThan(0)
  })

  it.each(CASES)('$label: everything marked cleared is reset IN that effect', ({
    file,
    ledger,
    scanRefs,
  }) => {
    const block = scopeResetBlock(sources[file])
    const cleared = new Set(
      Object.entries(ledger)
        .filter(([, scope]) => scope === 'cleared on switch')
        .map(([name]) => name),
    )
    const unbacked = scanned(sources[file], scanRefs)
      .filter((slot) => cleared.has(slot.name))
      .filter((slot) => !slot.reset.test(block))
      .map((slot) => slot.name)
    expect(
      unbacked,
      'marked "cleared on switch" but the scope-reset effect does not reset it — either clear it there or reclassify',
    ).toEqual([])
  })
})
