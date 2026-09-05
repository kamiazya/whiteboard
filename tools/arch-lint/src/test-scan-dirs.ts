import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the repo's vitest test files live, for scans ABOUT test files
 * (titles, sleeps, imports). Every package and tool source tree plus the
 * mcp-server dev scripts, which carry colocated tests of their own.
 * `test-lazy-import-check.test.ts` predates this list and keeps its own
 * narrower one, with the exemptions measured against it.
 */
export const TEST_SCAN_DIRS = [
  'apps/web/src',
  'packages/canvas-render/src',
  'packages/canvas-viewer/src',
  'packages/codec/src',
  'packages/facet-engine/src',
  'packages/facet-ui/src',
  'packages/loro-adapter/src',
  'packages/mcp-server/scripts',
  'packages/mcp-server/src',
  'packages/model/src',
  'packages/plugin-visual/src',
  'packages/ports/src',
  'packages/search/src',
  'packages/server-core/src',
  'packages/workspace-index/src',
  'tools/arch-lint/src',
] as const

export function listTestFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listTestFiles(full))
      continue
    }
    if (/\.test\.(ts|tsx)$/.test(entry.name)) files.push(full)
  }
  return files
}
