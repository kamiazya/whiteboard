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
import { assertScannedLedger } from './test-utils/coverage-ledger.js'

const sources = import.meta.glob(
  [
    './components/workspace-files/WorkspaceFilesPanel.tsx',
    './components/workspace-files/use-browser-columns.ts',
    './components/workspace-files/use-debounced-document-search.ts',
    './pages/DaemonIndexPage.tsx',
    './components/HeaderBranchChip.tsx',
    './components/VersionTimeline.tsx',
    './pages/use-markdown-document.ts',
    './pages/BrowserDocumentPage.tsx',
    './pages/DaemonDocumentPage.tsx',
    './pages/DocumentPage.tsx',
    './pages/use-version-save-flow.ts',
    './hooks/use-comments-rail.ts',
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
// The panel's extracted hooks are part of the same SCREEN: its state moved
// there, not away, so the scan surface is the concatenation of all three.
const PANEL_COLUMNS_HOOK = './components/workspace-files/use-browser-columns.ts'
const PANEL_SEARCH_HOOK = './components/workspace-files/use-debounced-document-search.ts'
const DAEMON_INDEX = './pages/DaemonIndexPage.tsx'
const BRANCH_CHIP = './components/HeaderBranchChip.tsx'
const VERSION_TIMELINE = './components/VersionTimeline.tsx'
const MARKDOWN_DOCUMENT = './pages/use-markdown-document.ts'
const BROWSER_DOCUMENT_PAGE = './pages/BrowserDocumentPage.tsx'
const DAEMON_DOCUMENT_PAGE = './pages/DaemonDocumentPage.tsx'
// The shared page both keepers render through (ADR-0004 decision 1). The
// history column, the armed bookmark and the version being looked at moved
// HERE from both keeper pages, not away; the two hooks below moved with them.
const DOCUMENT_PAGE = './pages/DocumentPage.tsx'
// The save-a-version guard extracted to its own hook: part of the same
// SCREEN by the same rule the panel's search/columns hooks are — its state
// moved there, not away.
const VERSION_SAVE_FLOW_HOOK = './pages/use-version-save-flow.ts'
// The comments rail's screen state, extracted the same way — same rule.
const COMMENTS_RAIL_HOOK = './hooks/use-comments-rail.ts'

const PANEL_STATE: Record<string, ScopeCoverage> = {
  documents: 'cleared on switch',
  selected: 'cleared on switch',
  cardMenu: 'cleared on switch',
  peek: 'cleared on switch',
  // Reloaded from storage on every `workspace` change rather than emptied,
  // which is the same guarantee: what is on screen always belongs to the
  // workspace on screen. Its own effect, since the handle can arrive after
  // the source.
  recentIds: 'cleared on switch',
  // A COUNTER, not a subject: it names no document and no path, and its
  // only job is to tell the derived `changed` memo that this panel wrote a
  // baseline. Surviving a switch is harmless — the memo also keys on
  // `documents` and `workspace`, both of which change with the scope.
  seenRevision:
    'no subject: a bump counter for the changed-dot memo, naming nothing that belongs to a workspace',
  // Paths, and paths collide across workspaces — `untitled` is the first
  // document in most. A selection carried across a switch would address the
  // departed workspace's names into the store now on screen, in a BULK
  // delete, which is the worst place for that class of mistake.
  selection: 'cleared on switch',
  renaming: 'cleared on switch',
  renameError: 'cleared on switch',
  renameBusy: 'cleared on switch',
  hits: 'cleared on switch',
  searchDegraded: 'cleared on switch',
  refreshError: 'cleared on switch',
  pinError: 'cleared on switch',

  listStatus: 'no subject: a load outcome for the list as a whole, reset by the same effect',
  // Reset inside the block's identity check rather than beside the rest —
  // only a real source change is a switch, and the effect's own note says why.
  folder: 'cleared on switch',
  columns: 'no subject: how you look, not what at; deliberately persisted across everything',
  rootRef: 'no subject: the panel’s own DOM node',
  onFolderChangeRef: 'no subject: mirrors the callback prop, reassigned every render',
  onOpenDocumentRef: 'no subject: mirrors the callback prop, reassigned every render',
  workspaceRef: 'no subject: mirrors the workspace prop, reassigned every render',
  moveDocumentRef: 'no subject: mirrors the current handler, reassigned every render',
  lastReadListRef:
    'no subject: holds the PREVIOUS source’s identity so the reset block can tell a real switch from a StrictMode replay — clearing it would make every replay read as a switch, which is the trap the effect’s own note describes',
  createError:
    'no subject: a refused create, carrying a kind and the store’s words — no path of its own',
  creating: 'no subject: an in-flight flag for this screen’s own submit',
  query: 'no subject: what was typed; the results it produces are `hits`, which IS cleared',
  lastCardCount:
    'no subject: how MANY cards the last listing drew, never which — and it has to outlive the switch on purpose, because sizing the placeholder grid to the outgoing list is what holds the layout still while the incoming one loads',
}

const DAEMON_INDEX_STATE: Record<string, ScopeCoverage> = {
  rows: 'cleared on switch',
  pendingDelete: 'cleared on switch',
  deleteError: 'cleared on switch',
  duplicatingPath: 'cleared on switch',

  workspaces: 'no subject: the list of workspaces, which a switch does not invalidate',
  workspacesLoaded: 'no subject: whether that list has settled',
  selectedWorkspace: 'no subject: it IS the workspace — the thing every clear is keyed on',
  trashCount: 'cleared on switch',
  loaded: 'cleared on switch',
  loadError: 'cleared on switch',
  createError: 'no subject: a refused create; no path of its own',
  duplicateError: 'no subject: a refused duplicate; the path it was about is `duplicatingPath`',
  creating: 'no subject: an in-flight flag for this screen’s own submit',
  deleting: 'no subject: an in-flight flag; the path it is about is `pendingDelete`',
  selectedWorkspaceRef:
    'no subject: mirrors the selection, written during render so it is current within the very render that changes it',
  addressedWorkspaceRef: 'no subject: mirrors the addressed workspace, written during render',
  listGeneration:
    'no subject: a monotonic stamp ordering list loads — resetting it would revive the stale-answer race it exists to close',
  reportedWorkspaceRef:
    'no subject: keyed BY the workspace it names; a switch changes the comparison, not the ref',
  refetchedForRef:
    'no subject: keyed BY the handle it names, the same shape as reportedWorkspaceRef',
}

/** An empty value, in any of the shapes these screens reset to. */
// What counts as putting a slot back. An empty value, or a SCREAMING_CASE
// module constant — the neutral state of a slot is not always empty
// (`saveState` goes back to a `{kind:'saved', lastSavedAt:null}` record, not
// to null). A constant spelled that way is module-level by convention, so it
// cannot be about the scope that just left; a lowercase identifier can be,
// which is why `setFolder(landedIn)` must not read as a reset.
const EMPTY = '(null|\\[\\]|false|0|\'\'|""|[A-Z][A-Z0-9_]*)'

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
 * It exists because a REF held the worst defect this ledger has covered:
 * `hostRef` in `use-markdown-document` kept the departed document's write
 * handle through the next one's load, so a keystroke under one document was
 * saved into another. Scanning only `useState` would never have asked about
 * it.
 *
 * What reading all 27 of them settled is WHICH refs are dangerous, and it is
 * not "refs on a screen". Twenty-six are machinery that names no document —
 * DOM nodes, mirrors rewritten every render, monotonic sequence stamps whose
 * reset would REVIVE the race they exist to close, one-shot flags about the
 * page's own lifetime, markers keyed by the value they hold. The one that bit
 * is the one you could WRITE THROUGH, and it was in a hook rather than a
 * screen. So the question to ask a new ref is not whether it survives a
 * switch — most should — but whether anything can act through it afterwards.
 */
function refNames(source: string): Slot[] {
  return [...source.matchAll(/const (\w+) = useRef\b/g)].map((m) => ({
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
  // Every marker's block, concatenated: a screen whose state moved into a
  // hook clears that state through the hook's own marked reset, which the
  // screen's scope-reset effect calls. The claim stays checkable per setter;
  // what the concatenation cannot see is the CALL from the effect to the
  // hook's reset, which is the reader's half of the contract.
  const blocks: string[] = []
  let from = 0
  for (;;) {
    const start = source.indexOf(SCOPE_RESET_MARKER, from)
    if (start === -1) break
    const end = source.indexOf('}, [', start)
    if (end === -1) break
    blocks.push(source.slice(start, end))
    from = end
  }
  return blocks.join('\n')
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
  prevRefreshSignalRef:
    'no subject: only decides whether a refetch is REDUNDANT — useBranches already refetches on the document change itself',
  suppressNextTooltipOpenRef:
    'no subject: a one-shot about Radix’s return-focus rather than about the document, and the very next open request clears it',
  pendingFocusInCleanupRef: 'no subject: holds a listener remover; unmount runs it',
  chipButtonRef: 'no subject: the trigger’s DOM node',
}

const VERSION_TIMELINE_STATE: Record<string, ScopeCoverage> = {
  versions: 'cleared on switch',
  previewing: 'cleared on switch',
  // The past state ITSELF, held so the published session can be re-emitted
  // when the restore's progress moves. It is a document's content, so a
  // switch that left it would draw the departed document over the arrived
  // one.
  previewPast: 'cleared on switch',
  restoreError: 'cleared on switch',
  isRestoring: 'cleared on switch',

  loading: 'no subject: an in-flight flag for this screen’s own fetch',
  stale:
    'no subject: whether the LAST READ failed, which is about the fetch rather than about a document — and a switch refetches, so a success clears it on its own',
  onPreviewRef:
    'no subject: mirrors the callback prop, reassigned every render — it exists so the session is published from ONE effect rather than from a call beside every state change',
  previewingRef:
    'no subject: mirrors previewing, reassigned every render — so it is dropped with the state it mirrors',
  fetchSeqRef:
    'no subject: a monotonic dispatch stamp; resetting it would revive the stale-response race it exists to close',
  prevRefreshSignalRef:
    'no subject: only decides whether a refetch is REDUNDANT — the switch already refetches through refresh’s identity',
}

// Scoped on the DOCUMENT, and the one case that scans REFS too — see
// `refNames` for why.
const MARKDOWN_DOCUMENT_STATE: Record<string, ScopeCoverage> = {
  doc: 'cleared on switch',
  body: 'cleared on switch',
  coreFacets: 'cleared on switch',
  hostRef: 'cleared on switch',

  saveState: 'cleared on switch',
  // The conversations on THIS document. Left standing across a switch it
  // lists the departed document's threads beside the arrived one's body,
  // over a reply box that writes by thread id — into whichever document
  // actually holds it.
  annotations: 'cleared on switch',
  // And where their passages sit in THIS document's body. Offsets into a
  // body that has left the screen, applied to the one that arrived, put
  // every highlight somewhere the reader never marked.
  threadMarks: 'cleared on switch',

  loroRef: 'no subject: mirrors the `loro` prop, reassigned on every render',
  scheduleSaveRef: 'no subject: mirrors the current `scheduleSave`, reassigned on every render',
  setSaveStateRef: 'no subject: mirrors the state setter, reassigned on every render',
  currentDocumentIdRef:
    'no subject: mirrors the scope itself, reassigned on every render — it is what a scheduler outliving its document asks to find out whether its report still belongs on screen',
  schedulerRef:
    'no subject: keyed BY the document id — `schedulerFor` replaces it whenever the id differs, so it corrects itself rather than going stale',
}

// The page itself, not a panel inside it. It keeps its own document
// switching rather than remounting — `App.tsx` says so at the mount site —
// so everything it holds about a document has to be dropped by hand.
/**
 * What the two document pages share, because they mount the same two hooks.
 *
 * Spread into both ledgers rather than written twice: these are one
 * judgement about one piece of code, and two copies of it drift — the whole
 * failure this file exists to stop, one level up. A hook gaining state now
 * fails BOTH screens with the same message.
 */
const DOCUMENT_PAGE_HOOK_STATE: Record<string, ScopeCoverage> = {
  savingVersion: 'no subject: an in-flight flag for this screen\u2019s own submit',
  saveVersionOutcome: 'cleared on switch',
  // Unlike `open`, this one names a THREAD, and a thread id belongs to the
  // document that holds it: left standing across a switch it would scroll
  // the arrived body to a passage the departed document quoted, or expand a
  // conversation that is not on this document at all. Cleared by
  // useCommentsRail's own scope reset.
  selectedThreadId: 'cleared on switch',
  // A passage inside the DEPARTED document's body. Left standing it would
  // hand the arrived document an anchor quoting text it does not contain —
  // and a submitted one would open a conversation on the wrong document
  // about a sentence nobody there wrote. Cleared by useCommentsRail.
  composeAnchor: 'cleared on switch',
  writeRef: 'no subject: mirrors the keeper-specific write door, reassigned every render',
  threadsRef:
    'no subject: mirrors the threads the rail already holds, reassigned every render — an edit reads it to rebuild the message it rewrites, and the list it mirrors is republished per document',
}

const DOCUMENT_PAGE_STATE: Record<string, ScopeCoverage> = {
  ...DOCUMENT_PAGE_HOOK_STATE,
  // Which panel the one inspector slot shows — properties, comments,
  // connections or history. How the reader looks rather than what at:
  // everything a panel SAYS is document-scoped and cleared on its own
  // (`preview` and `bookmarkArmed` below, `selectedThreadId` and
  // `composeAnchor` above, the facets and backlinks the keeper republishes
  // per document), so a panel left open across a switch shows the arrived
  // document — as the rail always did.
  inspector:
    'no subject: which inspector panel is open, not what is in it — what each panel shows is cleared by its own entries or republished per document by the keeper',
  // The past state being looked at. Restoring one the person opened on the
  // DEPARTED document would apply that version id to the arrived one.
  preview: 'cleared on switch',
  // Cleared with the panel: a field left armed across a switch would name
  // the arrived document from the departed one's keystroke.
  bookmarkArmed: 'cleared on switch',
  currentScopeRef:
    'no subject: mirrors the scope itself, reassigned every render — it is what a save outliving its document asks to find out whether its outcome still belongs on screen',
}

const BROWSER_DOCUMENT_PAGE_STATE: Record<string, ScopeCoverage> = {
  versionRefreshSignal:
    'no subject: a counter that nudges the History panel to refetch; the list it refreshes is the panel’s own, and the panel remounts per document',
  // The one that bit: a bare boolean over `triggerCleanup()`, which acts on
  // whatever document the controller currently holds. Confirmed after a
  // switch, it deleted the document that had arrived.
  confirmDelete: 'cleared on switch',
  duplicateError: 'cleared on switch',
  isDuplicating: 'cleared on switch',

  isFullscreen:
    'no subject: how you are looking at the page rather than what at — and the browser owns the real state, so a reset here would disagree with the `document.fullscreenElement` the label follows',
  documents:
    'no subject: the WORKSPACE’s list, which a document switch does not change; its own refresh effect keys on the document identity that belongs in it',
  canvasOpsButtonRef: 'no subject: the kebab’s DOM node',
  exitFullscreenRef: 'no subject: a DOM node',
  mainRef: 'no subject: a DOM node',
  wasFullscreenRef:
    'no subject: the previous fullscreen state, for handing focus over — about the viewport, not a document',
  listGenerationRef:
    'no subject: a monotonic stamp ordering list loads — resetting it would revive the stale-resolution race it exists to close',
  currentDocumentIdRef:
    'no subject: mirrors the scope itself, reassigned every render — it is what an async handler outliving its document asks to find out whether its report still belongs on screen',
  isFirstCanvasUrlSyncRef:
    'no subject: whether this MOUNT has synced the URL once, which picks replace over push — resetting it per document would make every switch a replace and flatten the history it exists to keep',
  documentsEnumeratedRef:
    'no subject: whether listDocuments has answered at all, which is about the page’s lifetime rather than one document',
  lastKnownCanvasIdRef:
    'no subject: holds the previously loaded id ON PURPOSE, to tell an external navigation from this page’s own pending push — clearing it is exactly what breaks that',
  shortcutHandledRef: 'no subject: a once-per-page-load flag for the ?new=canvas launcher param',
}

const DAEMON_DOCUMENT_PAGE_STATE: Record<string, ScopeCoverage> = {
  // A read-only view of ONE document's variation tip (ADR-0022). `?v` is
  // not stripped by a switch — `switchDocument` sets the path and nothing
  // else — so the effect that owns this re-resolves the same NAME against
  // the arrived document. Until it answers, the departed document's preview
  // is on screen under the new one's name.
  variationPreview: 'cleared on switch',
  // Worse than the preview, which is why it is called out separately: no
  // branch of that effect clears the notice, so `Variation «x» was not
  // found` about one document outlived it onto the next until this reset.
  variationNotice: 'cleared on switch',
  // Backlinks OF this document. Its own fetch nulls them, but only once it
  // knows the arrived document's id — which comes from a list that may
  // still be refreshing.
  connections: 'cleared on switch',

  authError:
    'no subject: whether the DAEMON refused this pairing, which spans every document it serves — a switch does not re-authorise anything, and the session effect below reads it to say `sync-off`',
  creating: 'no subject: an in-flight flag for this screen’s own create submit',
  branchRefreshSignal:
    'no subject: a counter that nudges HeaderBranchChip to refetch on an externally observed HEAD change; the chip is keyed on the document itself and refetches on a switch without this',
  versionRefreshSignal:
    'no subject: a counter that nudges the History panel to refetch; the list it refreshes is the panel’s own, and the panel remounts per document',
  connectionsRefresh:
    'no subject: a counter that re-runs the backlinks fetch; that fetch is keyed on the document id and nulls the value first, so the counter decides WHEN to refetch, never WHAT is shown',

  createBackendRef:
    'no subject: mirrors the `createBackend` prop, reassigned every render — it exists so a parent’s inline arrow cannot make the session’s lifetime depend on the parent’s render',
  spatialEditorRef:
    'no subject: the mounted editor’s imperative handle, and the editor is keyed per document — React swaps the handle on a switch without anything here clearing it',
  canvasesRef:
    'no subject: mirrors the WORKSPACE’s document list, reassigned every render — a document switch does not change which documents exist',
  canvasValueRef:
    'no subject: mirrors the current canvas value, reassigned every render — it is how a write sends the CURRENT canvas rather than the one its closure captured',
}

const CASES = [
  {
    files: [PANEL, PANEL_COLUMNS_HOOK, PANEL_SEARCH_HOOK],
    ledger: PANEL_STATE,
    label: 'WorkspaceFilesPanel',
    scanRefs: true,
  },
  { files: [DAEMON_INDEX], ledger: DAEMON_INDEX_STATE, label: 'DaemonIndexPage', scanRefs: true },
  { files: [BRANCH_CHIP], ledger: BRANCH_CHIP_STATE, label: 'HeaderBranchChip', scanRefs: true },
  {
    files: [VERSION_TIMELINE],
    ledger: VERSION_TIMELINE_STATE,
    label: 'VersionTimeline',
    scanRefs: true,
  },
  {
    files: [MARKDOWN_DOCUMENT],
    ledger: MARKDOWN_DOCUMENT_STATE,
    label: 'useMarkdownDocument',
    scanRefs: true,
  },
  {
    files: [DOCUMENT_PAGE, VERSION_SAVE_FLOW_HOOK, COMMENTS_RAIL_HOOK],
    ledger: DOCUMENT_PAGE_STATE,
    label: 'DocumentPage',
    scanRefs: true,
  },
  {
    files: [BROWSER_DOCUMENT_PAGE],
    ledger: BROWSER_DOCUMENT_PAGE_STATE,
    label: 'BrowserDocumentPage',
    scanRefs: true,
  },
  {
    files: [DAEMON_DOCUMENT_PAGE],
    ledger: DAEMON_DOCUMENT_PAGE_STATE,
    label: 'DaemonDocumentPage',
    scanRefs: true,
  },
] as const

/** Everything a case's ledger has to account for. */
function scanned(source: string, scanRefs: boolean): Slot[] {
  return scanRefs ? [...stateNames(source), ...refNames(source)] : stateNames(source)
}

/** A screen's whole scan surface: its file plus the hooks its state moved to. */
function sourceOf(files: readonly string[]): string {
  return files.map((file) => sources[file] ?? '').join('\n')
}

describe('scoped screen state is classified', () => {
  it.each(CASES)('$label: the scan reaches a plausible amount of state', ({ files, scanRefs }) => {
    // A regex that stops matching reports every entry as stale, which sends
    // the reader to the wrong file entirely.
    for (const file of files) {
      expect(sources[file], `${file} was not globbed`).toBeDefined()
    }
    expect(scanned(sourceOf(files), scanRefs).length).toBeGreaterThan(4)
  })

  // Both directions in one `it`, through the shared helper: they are the same
  // judgement, and a scan that ends up with only one of them reads exactly
  // like a scan that checked.
  it.each(CASES)('$label: every name is classified, and every entry still exists', ({
    files,
    ledger,
    scanRefs,
  }) => {
    assertScannedLedger(
      scanned(sourceOf(files), scanRefs).map((slot) => slot.name),
      ledger,
      {
        unclassified:
          'new state or ref must say whether it is bound to this screen\'s SCOPE — the workspace for a browser, the document for the top bar and the markdown hook. If it is, reset it in the // SCOPE RESET effect and mark it "cleared on switch"; if it is not, say why; if it is and stays anyway, say `survives:` and what a fix would need. A path, an entry or a write handle always is',
        stale: 'these entries name state the screen no longer holds',
      },
    )
  })

  // The half that makes this more than a list of names. An entry claiming to
  // be cleared must have its setter called somewhere — a claim nothing backs
  // is the decoration this ledger exists to replace.
  it.each(CASES)('$label: carries a scope-reset effect to check against', ({ files }) => {
    // Without the marker the block is empty and every `cleared` entry below
    // fails at once — loud, but pointing at the wrong thing. Say it here.
    expect(
      scopeResetBlock(sourceOf(files)).length,
      `no ${SCOPE_RESET_MARKER} marker: the guard cannot tell what this screen drops when its scope changes`,
    ).toBeGreaterThan(0)
  })

  // The other side of the same claim, and the reason it exists is that this
  // ledger already carried a `survives:` entry through the increment that
  // FIXED it. `saveState` was reset and its report scoped, and nothing here
  // went red — the entry would have gone on describing a debt that was paid.
  // An exemption has to expire when the thing it excuses stops being true,
  // or it decays into the decoration this ledger replaces.
  it.each(CASES)('$label: nothing exempt is quietly reset there after all', ({
    files,
    ledger,
    scanRefs,
  }) => {
    const block = scopeResetBlock(sourceOf(files))
    const exempt = new Set(
      Object.entries(ledger)
        .filter(([, scope]) => scope !== 'cleared on switch')
        .map(([name]) => name),
    )
    const backed = scanned(sourceOf(files), scanRefs)
      .filter((slot) => exempt.has(slot.name))
      .filter((slot) => slot.reset.test(block))
      .map((slot) => slot.name)
    expect(
      backed,
      'classified `no subject:` or `survives:` but the scope-reset effect resets it — the entry outlived what it described, so promote it to "cleared on switch"',
    ).toEqual([])
  })

  it.each(CASES)('$label: everything marked cleared is reset IN that effect', ({
    files,
    ledger,
    scanRefs,
  }) => {
    const block = scopeResetBlock(sourceOf(files))
    const cleared = new Set(
      Object.entries(ledger)
        .filter(([, scope]) => scope === 'cleared on switch')
        .map(([name]) => name),
    )
    const unbacked = scanned(sourceOf(files), scanRefs)
      .filter((slot) => cleared.has(slot.name))
      .filter((slot) => !slot.reset.test(block))
      .map((slot) => slot.name)
    expect(
      unbacked,
      'marked "cleared on switch" but the scope-reset effect does not reset it — either clear it there or reclassify',
    ).toEqual([])
  })
})
