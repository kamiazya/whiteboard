import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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
// Deliberately NOT covered: the checklist's companion "functions stay under
// 50 lines" clause. That needs an AST to find function boundaries, which is
// a different instrument than counting a file's newlines — out of scope for
// this slice.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

const LINE_BUDGET = 800

/** `wc -l` semantics: the number of '\n' characters, not `split('\n').length`. */
function lineCount(absolutePath: string): number {
  const text = readFileSync(absolutePath, 'utf8')
  return (text.match(/\n/g) ?? []).length
}

/** The `src` directory of every package/tool matching a `<group>/*` glob that has one. */
function groupSrcDirs(group: string): string[] {
  return readdirSync(join(REPO_ROOT, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(group, entry.name, 'src'))
    .filter((relDir) => existsSync(join(REPO_ROOT, relDir)))
}

const SCAN_ROOTS = ['apps/web/src', ...groupSrcDirs('packages'), ...groupSrcDirs('tools')]

/**
 * Directories excluded WHOLE, with the reason a line count there would be
 * noise rather than debt.
 *
 * `migrations/` is history — a migration's own text does not change once
 * written (see .claude/rules/vocabulary.md). `vendor/budoux/` is a vendored
 * third-party file (`ja-model.ts`, a generated data table copied from the
 * `budoux` package — see its own README for why it is vendored rather than
 * depended on); its size is not this repo's code to shrink.
 */
const EXCLUDED_DIR_SEGMENTS = ['/migrations/', '/vendor/budoux/']

function walk(absoluteDir: string): string[] {
  return readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(absoluteDir, entry.name)
    if (entry.isDirectory()) return walk(absolutePath)
    return [absolutePath]
  })
}

function isScannedSourceFile(absolutePath: string): boolean {
  if (!/\.tsx?$/.test(absolutePath)) return false
  if (absolutePath.endsWith('.d.ts')) return false
  if (/\.test\.tsx?$/.test(absolutePath)) return false
  const normalized = absolutePath.replaceAll('\\', '/')
  return !EXCLUDED_DIR_SEGMENTS.some((segment) => normalized.includes(segment))
}

function scanFiles(): string[] {
  return SCAN_ROOTS.flatMap((relRoot) => walk(join(REPO_ROOT, relRoot)))
    .filter(isScannedSourceFile)
    .map((absolutePath) => relativeToRepo(absolutePath))
    .sort()
}

function relativeToRepo(absolutePath: string): string {
  return absolutePath.slice(REPO_ROOT.length + 1)
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
  'apps/web/src/lib/spatial/commands.ts': 926,
  // The annotation entry's scope resolver lives in `annotation-scope.ts`
  // rather than here, so what this file spends on it is the hook call — now
  // five lines because the entry also has to know the document's threads,
  // to open the one a paragraph already has. The two document pages paid
  // more than that back in the same change (942 -> 934, 926 -> 925), their
  // hand-built thread writes replaced by one shared door.
  // +1: the annotation entry also has to be handed the LIVE passage marks,
  // so the toolbar resolves a thread the way the gutter beside it does.
  'apps/web/src/components/markdown-editor/MarkdownEditor.tsx': 1021,
  // +1: `CONTENT_CONTAINER_KEYS` gains the proposal layer's plane
  // (ADR-0029). One line, and it has to be here — the list is what a
  // tree-node host pre-attaches from, and a container attached on first
  // READ instead clears the UndoManager's redo stack.
  'packages/loro-adapter/src/loro-bridge.ts': 943,
  'packages/canvas-render/src/layout/edges/edge-rules.ts': 948,
  'packages/server-core/src/tools/canvas-edit.ts': 948,
  'apps/web/src/App.tsx': 973,
  'apps/web/src/components/workspace-files/WorkspaceFilesPanel.tsx': 1196,
  // Raised from 1032 by the document PLANE primitives — a mergeable child
  // map on a document's node, and the read that never opens one. They sit
  // here rather than in a new file because `nodeById` is this module's, and
  // because a plane is a tree-node concept: splitting it out would export
  // the node lookup for one caller. The prose is most of the 44 lines and is
  // the point of them — a plane opened the regular way loses one replica's
  // whole plane with both sides agreeing on the survivor.
  // Raised again from 1076 by PLANE NAMESPACING — the `plane:` prefix, and
  // the two readers that now skip it. Nearly all of it is the reason: a
  // plane in the node's flat namespace is carried into
  // `projectWorkspaceDocument` and written back by the next content save,
  // from whatever the projection held when it was taken. Measured through
  // the daemon's merge before the fix, a branch tip read back as "" with
  // nothing red, which is precisely the comment's job to prevent a second
  // time.
  'packages/loro-adapter/src/workspace-tree.ts': 1116,
  'packages/canvas-render/src/svg/backend.ts': 991,
  // Raised from 1366 by the automatic-checkpoint trigger: a narrow
  // `{signal, flush}` pair on SessionDeps, signalled from
  // `subscribeLocalUpdates` and flushed from the two page-leaving handlers
  // beside the edit flush. Most of the 25 lines is the reason the FLUSH lives
  // here rather than as the page's own listener — its order against the edit
  // flush is load-bearing, and two independent listeners would leave that to
  // registration timing.
  'apps/web/src/lib/document-sync-session.ts': 1391,
  // Raised from 1131 because compaction's retained-history cut now reads
  // branch tips from BOTH planes for the length of the migration: the record,
  // where a document goes the first time its branches are written, and the
  // rows a document that has not been written since still has. A union rather
  // than a merge — a document is never in both — and the comment saying so is
  // most of the 14 lines.
  'packages/mcp-server/src/server/store/document-store.ts': 1145,
  // Raised from 926 by the version STORE being built once and shared. A
  // merge's pre-merge point cannot go through the versions seam — that
  // `save` carries a label and nothing else, while a checkpoint has to say
  // it is automatic and which variation it belongs to — so the store is
  // built here and handed to both seams, and the comment saying why is most
  // of the seven lines.
  // Raised from 933 by the checkpoint scheduler being BUILT here — the
  // keeper's `save`, the HEAD lookup its rows are laned by, and the pair the
  // session signals. Most of the 54 lines is two pieces of reasoning a reader
  // cannot recover from the code: the doc handed to the scheduler is the
  // workspace RECORD rather than this document's content (it keys the
  // "anything changed" check on a frontier, and the record's is what the
  // store saves), and the pair's `flush` signals BEFORE it flushes, because
  // the edit flush's commit reaches `subscribeLocalUpdates` only on a later
  // microtask and a flush alone would find nothing armed. Raised again to 997
  // when `signal` was made TOTAL: it runs inside Loro's subscriber, where a
  // throw escapes as an unhandled rejection that reddens a whole run while
  // every test passes.
  // Raised again to 1011 by the branch-refresh signal: the browser record is
  // not readable at mount, so nothing re-read the branch plane once it
  // arrived and a document opened ON a variation kept naming the default one.
  // Most of the added lines is that reason — the bug is invisible in the
  // three lines of state that fix it.
  // Raised again to 1028 by kind parity on the versions seam. Two lines pick
  // the record seam by kind and supply the document's kind to it; the rest is
  // the two findings behind them, neither recoverable from the code. A note's
  // version ROWS were always written — a version is a frontier of the
  // workspace record — and only the seam that reads and restores one was
  // built from a backend a note never has. And `loadPast` asked the past
  // STATE its kind, which a tree-hosted document keeps in its node meta, so
  // the answer was always "not markdown": the fallback saved a canvas and
  // drew a note an empty viewer.
  // Raised again to 1031 by the SEARCH the URL sync now carries: one line of
  // wiring so a HEAD moved from the shared `?v=` banner refreshes the chip,
  // and three of reason. The reason is the whole entry — a `navigate` given a
  // pathname replaces the location, so the query a reader arrived with is
  // dropped by a repair they never asked for, and nothing about the call says
  // so.
  // +2 for the shared thread-write door: this page still chooses between the
  // markdown host and the spatial write per verb, so what it saves is the
  // command building rather than the branch.
  'apps/web/src/pages/BrowserDocumentPage.tsx': 1033,
  'packages/canvas-render/src/layout/nodes/mdast-blocks.ts': 1674,
  'packages/canvas-render/src/layout/spatial-canvas.ts': 1840,
  'packages/canvas-render/src/layout/edges/spatial-edges.ts': 2069,
  'apps/web/src/components/spatial-editor/SpatialEditor.tsx': 2592,
}

describe('file-size budget: files stay under 800 lines (shrink-only grandfather)', () => {
  const files = scanFiles()

  // The guard-that-never-reaches-its-subject discipline: a broken glob that
  // silently scans zero files would pass both assertions below vacuously.
  it('reaches a source tree of the size this repo actually has', () => {
    expect(files.length).toBeGreaterThan(500)
  })

  it('flags no over-budget file outside FILE_SIZE_GRANDFATHER', () => {
    const unlisted = files
      .map((path) => ({ path, lines: lineCount(join(REPO_ROOT, path)) }))
      .filter(({ path, lines }) => lines > LINE_BUDGET && !(path in FILE_SIZE_GRANDFATHER))
      .map(({ path, lines }) => `${path}: ${lines} lines`)

    expect(unlisted).toEqual([])
  })

  it('holds every grandfathered file at or under its recorded ceiling', () => {
    const grown = Object.entries(FILE_SIZE_GRANDFATHER)
      .filter(([path]) => existsSync(join(REPO_ROOT, path)))
      .map(([path, ceiling]) => ({ path, ceiling, lines: lineCount(join(REPO_ROOT, path)) }))
      .filter(({ lines, ceiling }) => lines > ceiling)
      .map(
        ({ path, lines, ceiling }) =>
          `${path}: ${lines} lines, over its recorded ceiling of ${ceiling} — shrink it back, or raise the ceiling here deliberately`,
      )

    expect(grown).toEqual([])
  })

  it('holds no grandfather entry that has shrunk to budget — delete it instead', () => {
    const shrunk = Object.keys(FILE_SIZE_GRANDFATHER)
      .filter((path) => existsSync(join(REPO_ROOT, path)))
      .map((path) => ({ path, lines: lineCount(join(REPO_ROOT, path)) }))
      .filter(({ lines }) => lines <= LINE_BUDGET)
      .map(
        ({ path, lines }) => `${path}: ${lines} lines, at or under the ${LINE_BUDGET}-line budget`,
      )

    expect(shrunk).toEqual([])
  })

  it('holds no grandfather entry for a file that moved or was deleted', () => {
    const missing = Object.keys(FILE_SIZE_GRANDFATHER).filter(
      (path) => !existsSync(join(REPO_ROOT, path)),
    )
    expect(missing).toEqual([])
  })
})
