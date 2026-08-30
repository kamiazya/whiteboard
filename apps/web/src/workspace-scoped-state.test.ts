/**
 * Every piece of React state on a workspace-scoped screen, classified
 * against one question: **does it name a document?**
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
  ['./components/workspace-files/WorkspaceFilesPanel.tsx', './pages/DaemonIndexPage.tsx'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>

type WorkspaceScope =
  /** Dropped when the workspace changes, because it names a document. */
  | 'cleared on switch'
  /**
   * Names no document, so it survives a switch harmlessly. The reason has to
   * say WHY — "it's only a boolean" is exactly what was true of
   * `duplicatingPath` until you notice it is a path.
   */
  | `no document: ${string}`

const PANEL = './components/workspace-files/WorkspaceFilesPanel.tsx'
const DAEMON_INDEX = './pages/DaemonIndexPage.tsx'

const PANEL_STATE: Record<string, WorkspaceScope> = {
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

  listStatus: 'no document: a load outcome for the list as a whole, reset by the same effect',
  folder:
    'no document: an address WITHIN a workspace, reset separately and only on a real identity change — see the effect’s own note on StrictMode',
  columns: 'no document: how you look, not what at; deliberately persisted across everything',
  createError:
    'no document: a refused create, carrying a kind and the store’s words — no path of its own',
  creating: 'no document: an in-flight flag for this screen’s own submit',
  query: 'no document: what was typed; the results it produces are `hits`, which IS cleared',
}

const DAEMON_INDEX_STATE: Record<string, WorkspaceScope> = {
  rows: 'cleared on switch',
  pendingDelete: 'cleared on switch',
  deleteError: 'cleared on switch',
  duplicatingPath: 'cleared on switch',

  workspaces: 'no document: the list of workspaces, which a switch does not invalidate',
  workspacesLoaded: 'no document: whether that list has settled',
  selectedWorkspace: 'no document: it IS the workspace — the thing every clear is keyed on',
  trashCount: 'no document: a count, reset by the same effect',
  loaded: 'no document: whether this workspace’s documents have settled',
  loadError: 'no document: a load outcome for the workspace, reset by the same effect',
  createError: 'no document: a refused create; no path of its own',
  duplicateError: 'no document: a refused duplicate; the path it was about is `duplicatingPath`',
  creating: 'no document: an in-flight flag for this screen’s own submit',
  deleting: 'no document: an in-flight flag; the path it is about is `pendingDelete`',
}

/** Names every `const [x, setX] = useState` declares, in source order. */
function stateNames(source: string): string[] {
  return [...source.matchAll(/const \[(\w+), set\w+\]\s*=\s*useState/g)].map((m) => m[1])
}

const CASES = [
  { file: PANEL, ledger: PANEL_STATE, label: 'WorkspaceFilesPanel' },
  { file: DAEMON_INDEX, ledger: DAEMON_INDEX_STATE, label: 'DaemonIndexPage' },
] as const

describe('workspace-scoped screen state is classified', () => {
  it.each(CASES)('$label: the scan reaches a plausible amount of state', ({ file }) => {
    // A regex that stops matching reports every entry as stale, which sends
    // the reader to the wrong file entirely.
    expect(sources[file], `${file} was not globbed`).toBeDefined()
    expect(stateNames(sources[file]).length).toBeGreaterThan(8)
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
  it.each(CASES)('$label: everything marked cleared has a setter that clears it', ({
    file,
    ledger,
  }) => {
    const source = sources[file]
    const unbacked = Object.entries(ledger)
      .filter(([, scope]) => scope === 'cleared on switch')
      .map(([name]) => name)
      .filter((name) => {
        const setter = `set${name[0].toUpperCase()}${name.slice(1)}`
        // A reset to the empty value, in any of the shapes these screens use.
        return !new RegExp(`${setter}\\((null|\\[\\]|false|0)\\)`).test(source)
      })
    expect(
      unbacked,
      'marked "cleared on switch" but no reset call exists for it — either clear it or reclassify',
    ).toEqual([])
  })
})
