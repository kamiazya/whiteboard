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
  'apps/web/src/components/markdown-editor/MarkdownEditor.tsx': 1015,
  'packages/loro-adapter/src/loro-bridge.ts': 942,
  'packages/canvas-render/src/layout/edges/edge-rules.ts': 948,
  'packages/server-core/src/tools/canvas-edit.ts': 948,
  'apps/web/src/App.tsx': 973,
  'apps/web/src/components/workspace-files/WorkspaceFilesPanel.tsx': 1196,
  'packages/loro-adapter/src/workspace-tree.ts': 1032,
  'packages/canvas-render/src/svg/backend.ts': 991,
  'apps/web/src/pages/DaemonDocumentPage.tsx': 921,
  'apps/web/src/lib/document-sync-session.ts': 1366,
  'packages/mcp-server/src/server/store/document-store.ts': 1131,
  'apps/web/src/pages/BrowserDocumentPage.tsx': 981,
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
