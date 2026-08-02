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
 *
 * Both `.test.` and `.spec.` are scanned. Vitest resolves either, so covering
 * one leaves a filename that silently escapes the guard.
 */
const testModules = import.meta.glob('./**/*.{test,spec}.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

/**
 * `vi.doMock` is the non-hoisted sibling of `vi.mock` and registers the same
 * mock, so naming only `vi.mock` blocks the habit rather than the capability.
 * The trailing `[^'"]*` admits subpath mocks.
 */
const MOCK_EXCALIDRAW_PATTERN = /vi\.(?:do)?[Mm]ock\(\s*['"]@excalidraw\/excalidraw[^'"]*['"]/

function isDocsSnapshot(path: string): boolean {
  return path.includes('/docs-snapshots/')
}

describe('excalidraw mock guard', () => {
  const nonDocsSnapshotTests = Object.entries(testModules).filter(([path]) => !isDocsSnapshot(path))

  it('scans at least one test file', () => {
    expect(nonDocsSnapshotTests.length).toBeGreaterThan(0)
  })

  // Unlike the import guard, this one has no live example to sanity-check
  // against — zero matches is the healthy state, so the scan alone can never
  // prove the pattern still works. These samples are what make a weakened
  // regex fail on the spot rather than the day someone reintroduces a mock.
  it.each([
    ['vi.mock', "vi.mock('@excalidraw/excalidraw', () => ({}))"],
    ['vi.doMock', "vi.doMock('@excalidraw/excalidraw', () => ({}))"],
    ['double quotes', 'vi.mock("@excalidraw/excalidraw")'],
    ['subpath', "vi.mock('@excalidraw/excalidraw/types')"],
    ['padded', "vi.mock(  '@excalidraw/excalidraw'  )"],
  ])('the pattern catches a %s mock', (_form, sample) => {
    expect(MOCK_EXCALIDRAW_PATTERN.test(sample)).toBe(true)
  })

  it('the pattern does not fire on an unrelated mock', () => {
    expect(MOCK_EXCALIDRAW_PATTERN.test("vi.mock('./canvas-sync-session.js')")).toBe(false)
  })

  it.each(nonDocsSnapshotTests)('%s does not mock @excalidraw/excalidraw', (path, contents) => {
    expect(MOCK_EXCALIDRAW_PATTERN.test(contents), `${path} mocks @excalidraw/excalidraw`).toBe(
      false,
    )
  })
})
