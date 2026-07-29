import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * Every mutation tool must reindex via `withReindex`, not by importing
 * `reindexWorkspace` directly — a direct import would bypass the wrapper
 * and either double-reindex or (if the direct call is later removed by
 * mistake) silently drop reindexing with no compile-time signal. Only
 * `reindex-tool.ts` (the manual repair/backfill tool) and `with-reindex.ts`
 * and `reindex.ts` itself are allowed to import it.
 */
const MUTATION_TOOL_FILES = [
  'canvas-crud.ts',
  'body-patch.ts',
  'node-patch.ts',
  'edge-patch.ts',
  'facet-set.ts',
  'canvas-import-okf.ts',
  'version-restore.ts',
]

const REINDEX_IMPORT_PATTERN = /from ['"]\.\/reindex\.js['"]/

describe('mutation tools do not import reindexWorkspace directly', () => {
  for (const file of MUTATION_TOOL_FILES) {
    it(`${file} has no direct import of reindexWorkspace`, () => {
      const source = readFileSync(join(TOOLS_DIR, file), 'utf-8')
      expect(source).not.toMatch(REINDEX_IMPORT_PATTERN)
    })
  }
})
