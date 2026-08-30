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
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>

type ScopeCoverage =
  /** Dropped when the scope changes, because it names something inside it. */
  | 'cleared on switch'
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

/** Names every `const [x, setX] = useState` declares, in source order. */
function stateNames(source: string): string[] {
  return [...source.matchAll(/const \[(\w+), set\w+\]\s*=\s*useState/g)].map((m) => m[1])
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

const CASES = [
  { file: PANEL, ledger: PANEL_STATE, label: 'WorkspaceFilesPanel' },
  { file: DAEMON_INDEX, ledger: DAEMON_INDEX_STATE, label: 'DaemonIndexPage' },
  { file: BRANCH_CHIP, ledger: BRANCH_CHIP_STATE, label: 'HeaderBranchChip' },
  { file: VERSION_TIMELINE, ledger: VERSION_TIMELINE_STATE, label: 'VersionTimeline' },
] as const

describe('scoped screen state is classified', () => {
  it.each(CASES)('$label: the scan reaches a plausible amount of state', ({ file }) => {
    // A regex that stops matching reports every entry as stale, which sends
    // the reader to the wrong file entirely.
    expect(sources[file], `${file} was not globbed`).toBeDefined()
    expect(stateNames(sources[file]).length).toBeGreaterThan(4)
  })

  it.each(CASES)('$label: every piece of state is classified', ({ file, ledger }) => {
    const unclassified = stateNames(sources[file]).filter((name) => !(name in ledger))
    expect(
      unclassified,
      'new screen state must say whether it NAMES A DOCUMENT. If it does, clear it in the workspace-switch effect and mark it "cleared on switch"; if it does not, say why — a path or an entry always does',
    ).toEqual([])
  })

  it.each(CASES)('$label: every classified name still exists', ({ file, ledger }) => {
    const present = new Set(stateNames(sources[file]))
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
  }) => {
    const block = scopeResetBlock(sources[file])
    const unbacked = Object.entries(ledger)
      .filter(([, scope]) => scope === 'cleared on switch')
      .map(([name]) => name)
      .filter((name) => {
        const setter = `set${name[0].toUpperCase()}${name.slice(1)}`
        // A reset to the empty value, in any of the shapes these screens use.
        // `''` is here because leaving it out is what this guard caught on its
        // own first run: `setRenameDraft('')` is a reset, and a rule that only
        // knows `null` reads it as an unbacked claim.
        return !new RegExp(`${setter}\\((null|\\[\\]|false|0|''|"")\\)`).test(block)
      })
    expect(
      unbacked,
      'marked "cleared on switch" but the scope-reset effect does not reset it — either clear it there or reclassify',
    ).toEqual([])
  })
})
