import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isExcludedPath,
  REPO_ROOT,
  relativeToRepo,
  SCAN_ROOTS,
  scriptFiles,
  walk,
} from './scan-roots.js'
import { registerSizeLedgerAssertions } from './size-ledger-assertions.js'
import { classifyPath } from './source-scan.js'

// docs/contributing/review-checklist.md says "Files stay under 800 lines",
// and until this guard existed nothing enforced it — 17 files already over
// the line, none of them flagged, while every other architecture invariant
// in this repo has an executable guard (ADAPTERS_REACHING_MECHANICS,
// KNOWN_IMPORT_CYCLES). This is the same shape: a SHRINK-ONLY grandfather
// list, guarded from both sides, so an entry cannot outlive the debt it
// names. An over-800 file not in the list fails naming the file and its
// count; a listed file that has shrunk to 800 or under fails telling the
// closer to delete the entry — so paying debt off is recorded, not just
// tolerated silently forever.
//
// The checklist's companion "functions stay under 50 lines" clause needs an
// AST to find function boundaries, which is a different instrument than
// counting a file's newlines. It is `function-size-budget.test.ts`, beside
// this file, on this same shrink-only contract. The two are not
// interchangeable: a file budget is satisfied by MOVING mass, which is how
// 834 lines of pointer handling left `SpatialEditor.tsx` for a file of their
// own while remaining one function.
//
// It lived in `packages/mcp-server/src/server/` until it moved here, and the
// move is worth one line because it deleted things rather than relocating
// them: a dedicated `file-size-budget:` pre-push command (the whole
// `arch-lint-node` project already runs at push), the self-assertion that
// named that command, and the paragraphs in three documents explaining why a
// scan of `apps/web/src` was filed under the daemon. It is an arch-lint scan
// by every criterion that package states — it reads other packages' source,
// runs no product code, opens no port and asserts on no clock.
const LINE_BUDGET = 800

/** `wc -l` semantics: the number of '\n' characters, not `split('\n').length`. */
function lineCount(absolutePath: string): number {
  const text = readFileSync(absolutePath, 'utf8')
  return (text.match(/\n/g) ?? []).length
}

function isScannedSourceFile(absolutePath: string): boolean {
  if (!/\.tsx?$/.test(absolutePath)) return false
  if (absolutePath.endsWith('.d.ts')) return false
  // Test files are held by TEST_FILE_SIZE_GRANDFATHER below, at the SAME
  // budget, so they are moved to a sibling ledger rather than exempted. This
  // line was a silent exclusion for a long time, unlike the directory
  // exclusions in `scan-roots.ts`, which each say why.
  if (isTestFile(absolutePath)) return false
  return !isExcludedPath(absolutePath)
}

/** `test` only: support files, benches and harnesses are shipped-ledger material here, since size is a property of any source file. */
function isTestFile(absolutePath: string): boolean {
  return classifyPath(absolutePath) === 'test'
}

function isScannedTestFile(absolutePath: string): boolean {
  return isTestFile(absolutePath) && !isExcludedPath(absolutePath)
}

/**
 * The two ledger files, which this ledger deliberately does not hold.
 *
 * Each one's length is a function of how many entries its list has, so its
 * ceiling records the SIZE OF THE DEBT LIST and nothing about the file —
 * and every entry already has to carry a reason, so the deliberateness the
 * ceiling would add is already spent one line above it.
 *
 * What it cost instead: the number changes on every branch that records a
 * raise, so two branches that both record one conflict HERE, on a line
 * neither of them is about. Measured on one PR in one session: three
 * conflicts, each resolved by re-counting the merged file's own lines, and
 * the reasons stacked up as archaeology ("FIVE branches", then "SIX") until
 * the comment said more about merging than about sizes. The function ledger
 * was held for a while and paid the same way: a two-line reason beside one
 * of its entries moved its own ceiling here.
 */
const LEDGER_PATHS = [
  'tools/arch-lint/src/file-size-budget.test.ts',
  'tools/arch-lint/src/function-size-budget.test.ts',
]

/** A listed file's current count, or nothing for one that is gone (another assertion's finding). */
function readingOf(path: string): number | undefined {
  return existsSync(join(REPO_ROOT, path)) ? lineCount(join(REPO_ROOT, path)) : undefined
}

function scanTestFiles(): string[] {
  return SCAN_ROOTS.flatMap((relRoot) =>
    walk(join(REPO_ROOT, relRoot), { include: isScannedTestFile }),
  )
    .map((absolutePath) => relativeToRepo(absolutePath))
    .filter((path) => !LEDGER_PATHS.includes(path))
    .sort()
}

function scanScriptFiles(): string[] {
  return scriptFiles().filter((path) => path.endsWith('.mjs'))
}

function scanFiles(): string[] {
  return SCAN_ROOTS.flatMap((relRoot) =>
    walk(join(REPO_ROOT, relRoot), { include: isScannedSourceFile }),
  )
    .map((absolutePath) => relativeToRepo(absolutePath))
    .sort()
}

/**
 * Files over the 800-line budget, each entry a CEILING the file must stay
 * at or under — not merely a membership list. The first version recorded a
 * count nothing compared against, and 11 of 17 files grew by up to 262
 * lines under a green build; the ratchet assertion below is what makes
 * "shrink-only" a property instead of a hope. Growing a listed file means
 * raising its ceiling here, on the record, in the same diff.
 *
 * Both-sides guarded below: an over-budget file missing from this list fails
 * the build, and an entry that no longer names an over-budget file fails it
 * too — the same contract as ADAPTERS_REACHING_MECHANICS and
 * KNOWN_IMPORT_CYCLES in tools/arch-lint/src/architecture-map.ts. Shrinking
 * one of these is a welcome diff; leaving its entry behind after shrinking
 * it is not.
 */
const FILE_SIZE_GRANDFATHER: Record<string, number> = {
  // The editor's command union — one arm per thing a person can change, with
  // the write each arm makes — and the canonical-emptiness rules those writes
  // share (`withCanvasFacet`). It is wide because the matrix in
  // `element-verb-parity.test.ts` holds every verb to every collection, and a
  // stroke stores as much as a relation does. What has already left: which
  // collection a selected ink id came from (`ink-commands.ts`) and the tag
  // list rules (`lib/spatial/tags.ts`), the z-order block (`z-order.ts`) and
  // the paste/duplicate builder (`fragment-insert.ts`). The next shrink is the
  // line arms leaving as a sibling the way the ink-id family did.
  // +7: the bend cap on `set-line-bends` / `set-edge-bends`, which refuse a list
  // the model would refuse on read.
  'apps/web/src/lib/spatial/commands.ts': 1321,
  // The markdown host: CodeMirror's extensions, the preview column and the
  // conversation and proposal markers drawn beside it. What has a seam has
  // already left — the pane scroll sync and the preview geometry it shares
  // with the rail, the passage proposals (`use-passage-proposals.ts`), the
  // annotation scope (`annotation-scope.ts`), the shared editing baseline
  // (`markdown-editing-base.ts`). What stays is the component's own prop
  // surface and the wiring, which this file is for. A budget met by trimming
  // the rationale beside that wiring buys lines at the price of what the
  // lines were for, so it is not met that way.
  'apps/web/src/components/markdown-editor/MarkdownEditor.tsx': 879,
  // The ink TERMS left for `edge-ink.ts` — how a path's ink is
  // measured, separately from what the named rules charge for it. The next
  // shrink is the PREFERENCE half (candidate generation, from
  // `facingLaneWindow` through `shouldAdoptCandidate`) as a sibling the same
  // way: it reads only `fullyContains` from the penalty half, which moves to
  // `edge-geometry.ts` first, and the penalty half (`PENALTY_RULES` and the
  // cost tuple) reads `bendCount` and `fullyContains` and none of the rest.
  'packages/canvas-render/src/layout/edges/edge-rules.ts': 845,
  // The file browser's host: the column area's four views as a discriminated
  // union built once and drawn by one switch, and `refreshAndSelect`, the one
  // rule five flows used to repeat. Its pieces — the toolbar, the last-write
  // line, the object pane, the card menu's items and each column view — are
  // `workspace-files-panel-parts.tsx` beside it.
  'apps/web/src/components/workspace-files/WorkspaceFilesPanel.tsx': 889,
  // The workspace tree over a Loro doc: node lookup, the stored-plane skip
  // (a `plane:` key a branch-era record still carries is kept out of the
  // projection and the content save) and the fold that carries a nested
  // container instead of flattening it, and the unreadable-node report the file
  // GC fails closed on. The content-sync rule the tree write,
  // the standalone restore and the projection all apply is `content-sync.ts`.
  // Raised by 16 for the chosen-name mark: it has to be written by the name
  // writers here, which are the only place every keeper's rename converges.
  'packages/loro-adapter/src/workspace-tree.ts': 975,
  // The document session: one object serving both document pages over either
  // keeper, with the publish channels (content, annotations, proposals,
  // history, locks, body) and the ordering rules between them — the edit flush
  // before the checkpoint flush, an undo taking back a write still inside its
  // debounce window, a decision reaching two planes. What has already left:
  // the command writes (`command-writes.ts`), the adopted-passage write
  // (`apply-adopted-passages.ts`) and the listener sets (`subscribers.ts`).
  // The next shrink is the locks and the history/undo group as sub-modules
  // taking `contentOf` and `doc`; the undo one is also handed
  // `dropQueuedWrite`, because the debounce timer and the queue stay closed
  // over by the factory (`function-size-budget.test.ts` carries the same path
  // for `createDocumentSyncSession`). Raised by nine for the refused-write
  // handler and its dep: a backend message the session answers is a line of
  // the handler table, and the recovery itself lives in the ledger. Raised by
  // ten for `getDocumentName`, the record's name for the open document.
  // Raised by thirty-two for the document leaving the record under the open
  // page: only the session knows which node it serves, so only it can see the
  // node go, stop writing, and say so. Raised by three more for a trash
  // restore bringing the node back, which resumes it. Lowered by two when the
  // per-reader guards became one content lookup that answers null meanwhile.
  'apps/web/src/lib/document-sync-session.ts': 1231,
  // The markdown typesetter: one block per mdast kind, the inline run walker
  // (`layoutPhrasing`) with its emoji, icon and image projections, embeds, and
  // the fit that decides what is cut when a body does not fit. Each inner step
  // is a named function carrying its reason, which is where the lines go. The
  // code block (`mdast-code-block.ts`), the table (`mdast-table.ts`) and the
  // vocabulary they share with the typesetter (`mdast-layout-options.ts`) are
  // sibling modules; the vocabulary went first, so neither imports the
  // typesetter back. The next shrink is the inline writer out of
  // `layoutPhrasing`, benched before and after.
  'packages/canvas-render/src/layout/nodes/mdast-blocks.ts': 1341,
  // The side-choice SEARCH: the cost model's application to a whole canvas,
  // the trial machinery of `createConfigScore`, the repair pass and the
  // regions. The side vocabulary (`edge-sides.ts`), the anchor pass
  // (`edge-anchors.ts`) and the router (`edge-router.ts`) are sibling modules
  // — measured before cutting, the search reads all three and none reads the
  // search, so the vocabulary went first and no module imports the file it
  // left. What remains over budget is the search's own, and the next shrink
  // is the trial scorer as a module of its own. The anchor contract's doc sits
  // here too, on `assignEdgeAnchors`, the export a reader hovers.
  'packages/canvas-render/src/layout/edges/spatial-edges.ts': 1063,
  // The gesture REDUCER: every pointer phase's decision for every tool and
  // every kind of element, each arm carrying the reason it is where it is.
  // What has already left: the per-kind hit-tests (`element-pick.ts`,
  // `ink-hit.ts`), the stroke arithmetic (`lib/spatial/freehand.ts`), the
  // mark grouping (`stroke-group.ts`) and the overlays each gesture renders.
  // `reduceGesture`'s biggest arms and its pointerup switch are their own
  // reducers already, so the next shrink is a tool's whole family of arms
  // leaving as one module, not another arm.
  'apps/web/src/components/spatial-editor/gestures.ts': 845,
  // The editor HOST: the gesture state and the layers it draws, each layer
  // carrying the doc comment that says what it is for. Six layers have left
  // through the `EditorGesture` bundle — `selection-inspector.tsx`,
  // `routable-handles.tsx`, `selection-handles.tsx`, `gesture-overlays.tsx`,
  // `in-place-editors.tsx`, `node-target-dialogs.tsx` — and the next one
  // leaves the same way: through the bundle, once its share of the editor's
  // values is named.
  'apps/web/src/components/spatial-editor/SpatialEditor.tsx': 2060,
}

describe('the path form both ledgers are keyed with', () => {
  // Feeds the helper a backslash tail on the real root: it exercises the
  // normalisation, not a Windows run, which nothing here can do. Without it
  // the assertion reads back the backslashes, which is exactly what would
  // reach a ledger lookup there.
  it('answers forward slashes, whatever separator the walk produced', () => {
    expect(relativeToRepo(`${join(REPO_ROOT, 'packages')}\\mcp-server\\src\\x.ts`)).toBe(
      'packages/mcp-server/src/x.ts',
    )
  })
})

describe('file-size budget: files stay under 800 lines (shrink-only grandfather)', () => {
  const files = scanFiles()

  // The guard-that-never-reaches-its-subject discipline: a broken glob that
  // silently scans zero files would pass both assertions below vacuously.
  it('reaches a source tree of the size this repo actually has', () => {
    expect(files.length).toBeGreaterThan(500)
  })

  registerSizeLedgerAssertions({
    budget: LINE_BUDGET,
    entries: files.map((key) => ({ key, lines: lineCount(join(REPO_ROOT, key)) })),
    ledgers: [FILE_SIZE_GRANDFATHER],
    ledgerOf: () => FILE_SIZE_GRANDFATHER,
    readingOf,
    wording: {
      titles: {
        unlisted: 'flags no over-budget file outside FILE_SIZE_GRANDFATHER',
        grown: 'holds every grandfathered file at or under its recorded ceiling',
        shrunk: 'holds no grandfather entry that has shrunk to budget — delete it instead',
        missing: 'holds no grandfather entry for a file that moved or was deleted',
        headroom:
          'holds no grandfather entry whose ceiling stands far above its reading — lower it',
      },
      unlisted: ({ key, lines }) => `${key}: ${lines} lines`,
      grown: (key, lines, ceiling) =>
        `${key}: ${lines} lines, over its recorded ceiling of ${ceiling} — shrink it back, or raise the ceiling here deliberately`,
      shrunk: (key, lines) => `${key}: ${lines} lines, at or under the ${LINE_BUDGET}-line budget`,
    },
  })
})

/**
 * Test files over the SAME 800-line budget, on the same shrink-only contract
 * as FILE_SIZE_GRANDFATHER above: an entry is a ceiling, both sides are
 * guarded, and growing a listed file means raising its ceiling here in the
 * same diff.
 *
 * Why the same budget rather than a higher one, which is the question that
 * kept this exclusion silent. The case for a higher ceiling is that a test
 * file legitimately repeats setup, so it should be allowed to run larger.
 * Measured across this repo on 2026-09-19 — a reading of that day, not one
 * kept current; the file counts have since moved, the ratio is what held —
 * that is not what the sizes say: test files are barely larger than source
 * files at every percentile:
 *
 * |            | median | p90 | p95 | p99  | max  |
 * |------------|--------|-----|-----|------|------|
 * | source (1058) |   99 | 341 | 517 | 1081 | 2843 |
 * | test (1443)   |  116 | 382 | 574 | 1266 | 3110 |
 *
 * A ratio of 1.09-1.17 does not pay for an exemption, and an exemption
 * nobody can date is the thing this ledger exists to remove. So the budget
 * is the one the checklist already states, and what differs is only which
 * files each ledger holds.
 *
 * Note what this does NOT claim: that a long test file carries the same
 * maintainability signal as a long source file. It claims only that the
 * justification offered for a higher ceiling is not supported by the sizes.
 * A shrink-only ratchet never demands shrinkage, so it does not fight a
 * test that honestly needs its setup — it only stops one growing unwatched.
 */
const TEST_FILE_SIZE_GRANDFATHER: Record<string, number> = {
  // The app shell's wiring cases: every route, the daemon address, the
  // workspace id's two sources, the replica-key holder and the read-plane
  // states (ADR-0041/0042), the pairing and transfer handshakes. Each is a
  // case about App's OWN derivation, pinned here rather than only in the
  // hook's test because the gate is App's.
  'apps/web/src/App.test.tsx': 1373,
  'apps/web/src/components/VersionTimeline.test.tsx': 1061,
  'apps/web/src/components/annotations/CommentsPanel.browser.test.tsx': 821,
  // Every move/demote test arranges the `/replica-key` route, the
  // `connectReplicaKeeper` wiring (the pull those flows drive is sealed) and a
  // registered passkey (ADR-0039: moving requires one), and claims the warn the
  // deferred-demote case provokes now that app-logger reaches the console.
  // so the deferred-demote case claims the warn it provokes (import + two lines).
  'apps/web/src/components/settings/PromoteWorkspaceSection.browser.test.tsx': 887,
  'apps/web/src/components/spatial-editor/SpatialEditor.browser.test.tsx': 2138,
  // The editor-state model and its coverage ledger: a `not modelled` entry
  // per command kind the model cannot drive, each a sentence somebody has to
  // be able to defend (the ledger's fourth direction fails on a `not
  // modelled` the run DOES produce), plus the census that prints on a green
  // run — a floor is a claim about a distribution, and a number printed only
  // on failure is one draw from its left tail.
  // The directed scripts for the four rare chains, whose statistical floors
  // no sample size makes safe, and the setup both runs share.
  // +95: R1 (the canvas stays readable through the model's own schema after
  // every step) and the long-stroke command that reaches the bend cap.
  'apps/web/src/components/spatial-editor/editor-state.property.test.ts': 2959,
  'apps/web/src/components/spatial-editor/gestures.test.ts': 864,
  // The v19 -> v20 upgrade block (the plaintext replica discard): the seed
  // fixture, the chunk-range no-op case, the drop-and-leaves-others-byte-identical
  // test, and the idempotency case that seeds a post-v20 sealed replica row so
  // the version guard has something it would delete.
  'apps/web/src/lib/browser-idb-migration.browser.test.tsx': 1892,
  // The three cases pinning undo: the document agreeing with the screen after an
  // undo and after a redo, and a taken-back write settling as saved rather than
  // reading as pending forever.
  'apps/web/src/lib/document-sync-session.test.ts': 2662,
  // One example per rule of every command arm, ink included: a table of ink
  // verbs where every row is one example is what stops the next one being
  // added without one. It grows one row per verb the parity matrix reports,
  // which is the growth it is for.
  // +23: the bend-cap refusal, on a stroke and on a relation.
  'apps/web/src/lib/spatial/commands.test.ts': 1704,
  // The embed-preview waits use `waitForOrSayWhen`, which needs a line saying why
  // a wait here reports more than "it expired"; both the page embed and its
  // sibling, the note-body embed, have failed on CI from branches that cannot
  // reach them, so the note covers the two as one subject.
  'apps/web/src/pages/BrowserDocumentPage.markdown.browser.test.tsx': 1076,
  'apps/web/src/pages/BrowserDocumentPage.test.tsx': 1018,
  // The cancel case: the page's effect cleanup has to stop the replica refresh
  // and the push it armed, and both schedulers' mocks have to answer a spy
  // cancel rather than undefined.
  'apps/web/src/pages/DaemonDocumentPage.test.tsx': 890,
  // The index page's whole surface — switching, creating, deleting, trash,
  // names, the duplicate flow — in one file. Its daemon fake is
  // `test-utils/fake-daemon-fetch.ts` now, answering through
  // the api-contract schemas; what is left over budget is the cases. Raised
  // by the four lines the shared `otherReadBody` import takes once biome
  // splits it, which replaced three hand-written invalid catch-all bodies.
  'apps/web/src/pages/DaemonIndexPage.test.tsx': 2077,
  'apps/web/src/pages/SettingsPage.test.tsx': 839,
  'apps/web/src/pages/use-browser-document-controller.test.ts': 1448,
  'packages/canvas-render/src/layout/comments.test.ts': 823,
  'packages/canvas-render/src/layout/edges/edge-rules.properties.test.ts': 843,
  'packages/canvas-render/src/layout/edges/edge-rules.test.ts': 1061,
  'packages/canvas-render/src/layout/nodes/mdast-blocks.test.ts': 1331,
  'packages/canvas-render/src/layout/spatial-canvas.properties.test.ts': 965,
  // The curved-line layout case: the seam the
  // freehand pen rides, from facet through style to a rounded scene node.
  'packages/canvas-render/src/layout/spatial-canvas.test.ts': 1240,
  'packages/canvas-render/src/quality/drawing-score.test.ts': 843,
  'packages/canvas-render/src/svg/backend.test.ts': 1184,
  // +1: the import of `afterAllFloor`, which keeps the reach floor from failing
  // a run that filtered the property feeding it away.
  'packages/canvas-render/src/tidy.test.ts': 1177,
  // A referenced canvas arriving in the form canvas_view
  // sends it (JSON Canvas) reaches the viewer as the model.
  // The refresh asking for the style the last result drew, which needs the
  // file's embedded-host and fake-App setup, and a click's anchor naming the
  // member drawn over a frame the document stores first, which needs the same.
  'packages/canvas-viewer/src/widget-entry.test.tsx': 1375,
  // An unchanged canvas reconciling to no ops, which the "writes only what
  // changed" test above it could not see; the delete cascade pinned over ink
  // (anchored ink goes, free ink stays, the line's lock goes with it); and the
  // import block naming the envelope and body modules the bridge is split into.
  'packages/loro-adapter/src/loro-bridge.test.ts': 1356,
  // A scoreboard whose rows are pinned exactly is one whose history is prose, so
  // each row says why it moved rather than a changelog: the harness handing the
  // tools the bundled registry (the seam is required and the tools fall back to
  // nothing), the `document.move` arm's row and why its follow report costs wire
  // bytes and no visible ones, `wb_canvas_edit`'s row and the two totals, and the
  // rows for the readable annotation layer, the snapshot's dressing and the
  // in-place rename, the node input losing `embed`, `proposals` on wb_document_get,
  // wb_viewport_set losing `animate` and describing `mode`, and the facet titles.
  // Then one audit wave's reasons beside seven re-pinned rows (proposal
  // `author`, `follow`, the snapshot's `lineCount`, listed pins, restore's
  // kind, viewport coordinates, `document.create`'s `name`) and the totals.
  // Then two more reasons: restore's written id and the totals.
  // Then the markdown size limit and the explicit-propose sentence: two rows and the totals.
  // Then the document path bound beside four rows and both totals.
  'packages/mcp-server/src/server/mcp/tool-surface-quality.test.ts': 1050,
  // The not-JSON refusal's assertion carries the reason it is strict: a mutation
  // showed the loose form (`typeof title === 'string'`) stays green with the
  // refusal DELETED, so without the note the next reader loosens it again. Every
  // router it builds is handed the test wiring, since routers compose nothing of
  // their own.
  'packages/mcp-server/src/server/routes/document/workspaces.test.ts': 1024,
  // One test pins that saves to two documents of one workspace collapse into one
  // compaction, since compaction is workspace-keyed.
  'packages/mcp-server/src/server/store/document-store.compact.test.ts': 901,
  // The tool-write half of the race says which lock it holds.
  'packages/mcp-server/src/server/store/document-store.test.ts': 863,
  // +17 for the tenant layout: this file's subject IS filesystem paths, so
  // every seed now names a tenant's workspaces root, and three symlink seeds
  // gained the parent mkdir that root needs. Splitting it instead would have
  // duplicated ~148 lines of vi.mock/hoisted setup into the second file.
  'packages/mcp-server/src/server/store/file-gc-sweeper.test.ts': 1002,
  // The agent-activity summary's wording and order are pinned by a case of their
  // own, because the one assertion it had (`toMatch(/\S/)`) a mutation proved vacuous.
  // The describes that stand alone (`region.set`, `node.add within a group`,
  // line ops) live in `canvas-edit.<topic>.test.ts` siblings over
  // `_test-canvas-edit.ts`; what remains is the tool's core and sizing cases.
  'packages/server-core/src/tools/canvas-edit.test.ts': 1948,
  'packages/server-core/src/tools/facet-set.test.ts': 1320,
}

describe('file-size budget: test files, same 800-line budget, same shrink-only contract', () => {
  const testFiles = scanTestFiles()

  // Same guard-that-never-reaches-its-subject discipline as above: a filter
  // that stopped matching would pass every assertion below over an empty set,
  // which reads exactly like a clean tree.
  it('reaches a test tree of the size this repo actually has', () => {
    expect(testFiles.length).toBeGreaterThan(900)
  })

  registerSizeLedgerAssertions({
    budget: LINE_BUDGET,
    entries: testFiles.map((key) => ({ key, lines: lineCount(join(REPO_ROOT, key)) })),
    ledgers: [TEST_FILE_SIZE_GRANDFATHER],
    ledgerOf: () => TEST_FILE_SIZE_GRANDFATHER,
    readingOf,
    wording: {
      titles: {
        unlisted: 'flags no over-budget test file outside TEST_FILE_SIZE_GRANDFATHER',
        grown: 'holds every grandfathered test file at or under its recorded ceiling',
        shrunk: 'holds no test-file entry that has shrunk to budget — delete it instead',
        missing: 'holds no test-file entry for a file that moved or was deleted',
        headroom: 'holds no test-file entry whose ceiling stands far above its reading — lower it',
      },
      unlisted: ({ key, lines }) => `${key}: ${lines} lines`,
      grown: (key, lines, ceiling) =>
        `${key}: ${lines} lines, over its recorded ceiling of ${ceiling} — shrink it back, or raise the ceiling here deliberately`,
      shrunk: (key, lines) => `${key}: ${lines} lines, at or under the ${LINE_BUDGET}-line budget`,
    },
  })

  // The two ledgers must not both claim a file: the source scan excludes test
  // files and this one requires them, so an overlap means one of the two
  // filters drifted.
  it('shares no path with the source ledger', () => {
    const shared = Object.keys(TEST_FILE_SIZE_GRANDFATHER).filter(
      (path) => path in FILE_SIZE_GRANDFATHER,
    )
    expect(shared).toEqual([])
  })
})

/**
 * Plain-Node `.mjs` scripts over the SAME 800-line budget, on the same
 * shrink-only contract: the smokes under `tests/` and each package's
 * `scripts/`. They were outside both ledgers above only because the scan
 * looked for TypeScript, and the largest of them grew to 2668 lines unwatched.
 * An entry is a ceiling, both sides are guarded, and growing a listed file
 * means raising its ceiling here in the same diff.
 */
const SCRIPT_FILE_SIZE_GRANDFATHER: Record<string, number> = {
  // The errands the LLM-driven tool-surface eval asks a model to run, each
  // with its prompt and the outcome it is graded by. It is a table, so it
  // grows by the number of tasks the eval holds.
  'packages/mcp-server/scripts/eval/tasks.mjs': 1041,
  // The stdio round-trip smoke: every registered tool exercised through one
  // spawned server, whose state each step builds on. The next shrink is the
  // steps leaving as modules that take the shared client, the way the
  // distribution smokes' helpers did.
  // The steps that read a markdown thread back through
  // `wb_document_get`, rename a spatial board in place, read an edge facet
  // through the snapshot, and the session-end checkpoint phase (whose body
  // lives in `smoke/lib`).
  // The canvas_view theme-font steps, with the widget's refresh-keeps-the-theme
  // step, live in `smoke/lib/canvas-view-theme.mjs`; the listed-pin check is
  // `smoke/lib/listed-pin.mjs`, leaving an import and a call here; so are the
  // proposal-author and facet-write refusal checks (`smoke/lib/*.mjs`).
  'packages/mcp-server/scripts/smoke/mcp-e2e-smoke.mjs': 2712,
  // The server backup/restore/support-bundle CLI scenarios, which share one
  // seeded data dir, two spawned servers and one leak pass over everything
  // they printed. What has left: the JWT, TLS, CLI-runner and readiness
  // helpers (`smoke-helpers.mjs`). The next shrink is the support-bundle
  // scenarios as their own script.
  'tests/e2e/distribution/packaged-server-mode-cli-smoke.mjs': 1070,
}

describe('file-size budget: .mjs scripts, same 800-line budget, same shrink-only contract', () => {
  const scripts = scanScriptFiles()

  // Same guard-that-never-reaches-its-subject discipline as above: a root that
  // stopped resolving would leave every assertion below over an empty set.
  it('reaches the script trees this repo actually has', () => {
    expect(scripts.length).toBeGreaterThan(20)
    expect(scripts).toContain('packages/mcp-server/scripts/smoke/mcp-e2e-smoke.mjs')
    expect(scripts).toContain('tests/e2e/distribution/smoke-helpers.mjs')
  })

  registerSizeLedgerAssertions({
    budget: LINE_BUDGET,
    entries: scripts.map((key) => ({ key, lines: lineCount(join(REPO_ROOT, key)) })),
    ledgers: [SCRIPT_FILE_SIZE_GRANDFATHER],
    ledgerOf: () => SCRIPT_FILE_SIZE_GRANDFATHER,
    readingOf,
    wording: {
      titles: {
        unlisted: 'flags no over-budget script outside SCRIPT_FILE_SIZE_GRANDFATHER',
        grown: 'holds every grandfathered script at or under its recorded ceiling',
        shrunk: 'holds no script entry that has shrunk to budget — delete it instead',
        missing: 'holds no script entry for a file that moved or was deleted',
        headroom: 'holds no script entry whose ceiling stands far above its reading — lower it',
      },
      unlisted: ({ key, lines }) => `${key}: ${lines} lines`,
      grown: (key, lines, ceiling) =>
        `${key}: ${lines} lines, over its recorded ceiling of ${ceiling} — shrink it back, or raise the ceiling here deliberately`,
      shrunk: (key, lines) => `${key}: ${lines} lines, at or under the ${LINE_BUDGET}-line budget`,
    },
  })
})
