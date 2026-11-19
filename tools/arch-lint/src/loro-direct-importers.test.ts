/**
 * Production code reaches the CRDT through the engine, not through `loro-crdt`.
 *
 * Step 9 of ADR-0054 moves every consumer of a `LoroDoc` onto the document
 * engine (`loro-adapter/src/engine`), slice by slice. This is the ratchet: a
 * source file outside `loro-adapter` that imports `loro-crdt` (a static import,
 * `import type`, a re-export or a dynamic `import()`) is in `LORO_DIRECT`, and
 * a file that is not in it fails, so the set only shrinks. A second ledger,
 * `LORO_SHAPED`, holds the files that use loro-adapter's Loro-shaped surface
 * (`DocumentContainers`, `documentContainers`, `projectWorkspaceDocument`)
 * without importing `loro-crdt` themselves: they hold a LoroDoc all the same,
 * and leave when the engine answers what they ask.
 *
 * Both ledgers fail in both directions: an entry whose file no longer matches
 * is stale and is deleted, so a migration cannot forget to remove its row.
 * Tests are not scanned; they keep `loro-crdt` as a devDependency until the
 * package stops being a dependency of anything shipped.
 */
import { describe, expect, it } from 'vitest'
import { readRepoSources } from './scan-roots.js'
import { isShippedPath } from './source-scan.js'
import { stripComments } from './strip-comments.js'

/** `from 'loro-crdt'`, `import 'loro-crdt/x'` and `import('loro-crdt')`, one specifier each. */
const LORO_IMPORT = /(?:\bfrom|\bimport\s*\(|\bimport)\s*['"]loro-crdt(?:\/[^'"]*)?['"]/
/** The names of loro-adapter's surface whose type or value IS a LoroDoc. */
const LORO_SHAPED_SURFACE = /\b(?:DocumentContainers|documentContainers|projectWorkspaceDocument)\b/

/**
 * Shipped files that import `loro-crdt` outside loro-adapter, each with the
 * slice that removes the import (`M` migrates it, `C` first grows the engine
 * contract). Shrink-only.
 */
const LORO_DIRECT: Readonly<Record<string, string>> = {
  'apps/web/src/lib/browser-backend.ts': 'M5: browser keeper',
  'apps/web/src/lib/browser-file-sweep.ts': 'M5: browser keeper',
  'apps/web/src/lib/browser-files-source-tags.ts': 'M5: browser keeper',
  'apps/web/src/lib/browser-files-source.ts': 'M5: browser keeper',
  'apps/web/src/lib/browser-version-store.ts': 'M5: browser keeper',
  'apps/web/src/lib/browser-versions-backend.ts': 'M5: browser keeper',
  'apps/web/src/lib/browser-workspace-docs.ts': 'M5: browser keeper',
  'apps/web/src/lib/carried-planes.ts': 'M5: browser keeper',
  'apps/web/src/lib/command-writes.ts': 'M5: browser keeper',
  'apps/web/src/lib/document-sync-session.ts': 'M6: editor session',
  'apps/web/src/lib/loro-codemirror-sync.ts': 'M6: editor session',
  'apps/web/src/lib/promote-workspace.ts': 'M5: browser keeper',
  'apps/web/src/lib/replica-cache.ts': 'M4: replica',
  'apps/web/src/lib/replica-images.ts': 'M4: replica',
  'apps/web/src/lib/replica-push.ts': 'M4: replica',
  'apps/web/src/lib/replica-record.ts': 'M4: replica',
  'apps/web/src/lib/session-body-binding.ts': 'M6: editor session',
  'apps/web/src/lib/sse-shared-worker.ts': 'M4: sse shared worker',
  'apps/web/src/lib/unreadable-snapshot.ts': 'M5: browser keeper',
  'apps/web/src/lib/workspace-content.ts': 'M5: browser keeper',
  'apps/web/src/lib/workspace-record-ids.ts': 'M5: browser keeper',
  'packages/history/src/checkpoints/scheduler.ts': 'M2: history takes plain values',
  'packages/history/src/compaction-cut.ts': 'M2: history takes plain values',
  'packages/history/src/frontiers-base64.ts': 'M2: history takes plain values',
  'packages/mcp-server/src/server/routes/document/versions.ts': 'M8: daemon store',
  'packages/mcp-server/src/server/routes/document/workspace-document.ts': 'M8: daemon store',
  'packages/mcp-server/src/server/store/auto-checkpoint.ts': 'M8: daemon store',
  'packages/mcp-server/src/server/store/doc-cache.ts': 'M8: daemon store',
  'packages/mcp-server/src/server/store/document-store.ts': 'M8: daemon store',
  'packages/mcp-server/src/server/store/moved-paths.ts': 'M8: daemon store',
  'packages/mcp-server/src/server/store/version-store.ts': 'M8: daemon store',
  'packages/mcp-server/src/server/store/workspace-doc-cache.ts': 'M8: daemon store',
  'packages/mcp-server/src/server/store/workspace-plane.ts': 'M8: daemon store',
  'packages/mcp-server/src/server/store/workspace-tail.ts': 'M8: daemon store',
  'packages/reference-graph/src/content-facts-cache.ts': 'M3: reference-graph takes plain values',
  'packages/reference-graph/src/extract.ts': 'M3: reference-graph takes plain values',
  'packages/server-core/src/document-io.ts': 'M7: server-core',
  'packages/server-core/src/operations/apply-workspace-document-update.ts': 'M7: server-core',
  'packages/server-core/src/operations/promote-carried.ts': 'M7: server-core',
  'packages/server-core/src/operations/promote-workspace.ts': 'M7: server-core',
  'packages/server-core/src/operations/restore-version.ts': 'M7: server-core',
  'packages/server-core/src/operations/sync-update-limit.ts': 'M7: server-core',
  'packages/server-core/src/render/assert-spatial-document.ts': 'M7: server-core',
  'packages/server-core/src/render/resolve-file-references.ts':
    'C1: documentContent has no index-row kind fallback',
  'packages/server-core/src/server-deps.ts': 'M7: server-core',
  'packages/server-core/src/tools/body-edit.ts': 'M7: server-core',
  'packages/server-core/src/tools/canvas-edit-session.ts': 'M7: server-core',
  'packages/server-core/src/tools/canvas-edit.ts': 'M7: server-core',
  'packages/server-core/src/tools/canvas-propose.ts': 'M7: server-core',
  'packages/server-core/src/tools/canvas-render-svg.ts': 'M7: server-core',
  'packages/server-core/src/tools/document-crud.ts': 'M7: server-core',
  'packages/server-core/src/tools/document-set.ts': 'M7: server-core',
  'packages/server-core/src/tools/facet-set.ts': 'M7: server-core',
  'packages/server-core/src/tools/thread-edit.ts': 'M7: server-core',
  'packages/workspace-index/src/document-store-workspace-docs.ts': 'M8: workspace-index storage',
  'packages/workspace-index/src/loro-workspace-document-index.ts': 'M8: workspace-index storage',
  'packages/workspace-index/src/restore-judgement.ts': 'C1: needs an importWorkspaceSubtree writer',
  'packages/workspace-index/src/workspace-docs.ts': 'M8: workspace-index storage',
}

/** Shipped files outside loro-adapter that hold a LoroDoc without importing `loro-crdt`. Shrink-only. */
const LORO_SHAPED: Readonly<Record<string, string>> = {
  'apps/web/src/lib/apply-adopted-passages.ts': 'M5: browser keeper',
  'apps/web/src/lib/browser-import-content.ts': 'M5: browser keeper',
  'apps/web/src/lib/browser-linkify.ts': 'M5: browser keeper',
  'apps/web/src/lib/browser-tag-library-write.ts': 'M5: browser keeper',
  'packages/reference-graph/src/linkify.ts': 'M3: reference-graph takes plain values',
  'packages/reference-graph/src/rewrite.ts': 'M3: reference-graph takes plain values',
}

const SCANNED = /^(?:apps|packages)\/[^/]+\/src\//
const ADAPTER = 'packages/loro-adapter/src/'

interface Scan {
  readonly files: number
  readonly direct: string[]
  readonly shaped: string[]
}

function scan(sources: ReadonlyArray<{ path: string; text: string }>): Scan {
  const files = sources.filter(
    ({ path }) => SCANNED.test(path) && !path.startsWith(ADAPTER) && isShippedPath(path),
  )
  const direct: string[] = []
  const shaped: string[] = []
  for (const { path, text } of files) {
    const code = stripComments(text, path)
    if (LORO_IMPORT.test(code)) direct.push(path)
    else if (LORO_SHAPED_SURFACE.test(code)) shaped.push(path)
  }
  return { files: files.length, direct: direct.sort(), shaped: shaped.sort() }
}

const scanned = scan(readRepoSources())

describe('production code reaches the CRDT through the engine', () => {
  it('reaches the files it judges, so a clean scan is not a blind one', () => {
    expect(scanned.files).toBeGreaterThan(1000)
    // The ledgers shrink to nothing, so the subject's presence is the scan's
    // reach over the trees that hold the importers, not a floor on the findings.
    const paths = readRepoSources().map(({ path }) => path)
    for (const tree of ['apps/web/src/', 'packages/server-core/src/', 'packages/mcp-server/src/']) {
      expect(paths.some((path) => path.startsWith(tree))).toBe(true)
    }
  })

  it('finds no new file importing loro-crdt', () => {
    expect(scanned.direct.filter((path) => !(path in LORO_DIRECT))).toEqual([])
  })

  it('keeps no direct-import row whose file has stopped importing it', () => {
    const current = new Set(scanned.direct)
    expect(Object.keys(LORO_DIRECT).filter((path) => !current.has(path))).toEqual([])
  })

  it('finds no new file holding a LoroDoc through the adapter surface', () => {
    expect(scanned.shaped.filter((path) => !(path in LORO_SHAPED))).toEqual([])
  })

  it('keeps no shaped row whose file has stopped holding one', () => {
    const current = new Set(scanned.shaped)
    expect(Object.keys(LORO_SHAPED).filter((path) => !current.has(path))).toEqual([])
  })

  it('names the slice that removes every row', () => {
    for (const reason of [...Object.values(LORO_DIRECT), ...Object.values(LORO_SHAPED)]) {
      expect(reason).toMatch(/^[MC]\d: \S/)
    }
  })
})

describe('the scan reads every form of the import', () => {
  const found = (path: string, text: string) => scan([{ path, text }]).direct
  const at = 'apps/web/src/lib/a.ts'

  it.each([
    "import { LoroDoc } from 'loro-crdt'",
    "import type { LoroDoc } from 'loro-crdt'",
    "export { LoroDoc } from 'loro-crdt'",
    "import 'loro-crdt'",
    ['const loro = await import', "('loro-crdt')"].join(''),
    'import { LoroDoc } from "loro-crdt/nodejs"',
  ])('finds %s', (text) => {
    expect(found(at, text)).toEqual([at])
  })

  it('skips a comment, a test, loro-adapter itself and a look-alike package', () => {
    expect(found(at, "// import { LoroDoc } from 'loro-crdt'\n/* import('loro-crdt') */")).toEqual(
      [],
    )
    expect(found('apps/web/src/lib/a.test.ts', "import 'loro-crdt'")).toEqual([])
    expect(found('packages/loro-adapter/src/a.ts', "import 'loro-crdt'")).toEqual([])
    expect(found(at, "import 'loro-crdt-extra'")).toEqual([])
  })

  it('reads the adapter surface only where loro-crdt is not imported', () => {
    expect(scan([{ path: at, text: 'documentContainers(doc, id)' }]).shaped).toEqual([at])
    expect(
      scan([{ path: at, text: "import 'loro-crdt'\ndocumentContainers(doc, id)" }]).shaped,
    ).toEqual([])
  })
})
