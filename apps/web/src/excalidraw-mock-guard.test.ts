import { describe, expect, it } from 'vitest'

/**
 * OpenCanvas cutover guard: no test file should mock `@excalidraw/excalidraw`
 * — a test that mocks it is testing a component that no longer runs.
 * Sources captured via build-time `import.meta.glob` (raw text) rather than
 * runtime `node:fs`, matching `canvas-render`'s import-guard.test.ts pattern.
 * `docs-snapshots/*` is excluded: those deliberately keep a real Excalidraw
 * render for the doc-screenshot pipeline (see architecture-map.md and
 * `docs/contributing`'s doc-screenshots note) and are out of this cutover's
 * scope.
 */
const testModules = import.meta.glob('./**/*.test.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

const MOCK_EXCALIDRAW_PATTERN = /vi\.mock\(\s*['"]@excalidraw\/excalidraw['"]/

function isDocsSnapshot(path: string): boolean {
  return path.includes('/docs-snapshots/')
}

describe('excalidraw mock guard', () => {
  const nonDocsSnapshotTests = Object.entries(testModules).filter(([path]) => !isDocsSnapshot(path))

  it('scans at least one test file', () => {
    expect(nonDocsSnapshotTests.length).toBeGreaterThan(0)
  })

  it.each(nonDocsSnapshotTests)('%s does not mock @excalidraw/excalidraw', (path, contents) => {
    expect(MOCK_EXCALIDRAW_PATTERN.test(contents), `${path} mocks @excalidraw/excalidraw`).toBe(
      false,
    )
  })
})
