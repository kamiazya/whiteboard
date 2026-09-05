import { describe, expect, it } from 'vitest'

// Vite's import.meta.glob (not node:fs) enumerates and reads every source
// file: apps/web/src ships to the browser, and a repo-wide boundary guard
// (packages/mcp-server's web-app-boundary test) fails the build if any file
// under this tree imports a Node-only builtin — even from a test file, since
// that guard scans every .ts/.tsx here unconditionally.
const rawModules = import.meta.glob('/src/**/*.{ts,tsx}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

const BANNED_PATTERNS = [/\bdocument\.modelContext\b/, /\bnavigator\.modelContext\b/]

const ALLOWED_FILES = new Set([
  'lib/webmcp/use-browser-tool-registry.ts',
  'lib/webmcp/use-browser-tool-registry.test.tsx',
  // The document-page contract injects a fake `document.modelContext` to
  // prove the registry is mounted, for BOTH keepers — the same proof the
  // per-page `.webmcp.test.tsx` files below give, run from one place.
  'test-utils/document-page.contract.tsx',
  // This guard's own source necessarily spells out the banned strings to
  // scan for them.
  'lib/webmcp/webmcp-api-confinement.test.ts',
])

// Page-level wiring regression tests (e.g. DaemonDocumentPage.webmcp.test.tsx)
// legitimately inject a fake
// `document.modelContext` to prove the hook is actually mounted — allow
// that whole naming convention rather than listing every page test file.
const ALLOWED_SUFFIX = /\.webmcp\.test\.tsx$/

function relPathOf(moduleKey: string): string {
  // moduleKey looks like "/src/lib/webmcp/use-browser-tool-registry.ts".
  return moduleKey.replace(/^\/src\//, '')
}

function findOffenders(allowList: Set<string>): string[] {
  const offenders: string[] = []
  for (const [moduleKey, content] of Object.entries(rawModules)) {
    const relPath = relPathOf(moduleKey)
    if (allowList.has(relPath) || ALLOWED_SUFFIX.test(relPath)) continue
    if (BANNED_PATTERNS.some((pattern) => pattern.test(content))) {
      offenders.push(relPath)
    }
  }
  return offenders
}

describe('WebMCP ambient API confinement', () => {
  it('finds source files to scan', () => {
    expect(Object.keys(rawModules).length).toBeGreaterThan(0)
  })

  it('references document.modelContext/navigator.modelContext only inside use-browser-tool-registry.ts (and its tests)', () => {
    const offenders = findOffenders(ALLOWED_FILES)

    expect(offenders).toEqual([])
  })

  it('the guard actually fails when a reference is not allow-listed (proves the scan is not vacuous)', () => {
    // Re-run the same scan but pretend nothing is allow-listed —
    // use-browser-tool-registry.ts legitimately contains
    // "document.modelContext", so the guard must report it as an offender.
    const offendersWithNoAllowList = findOffenders(new Set())

    expect(offendersWithNoAllowList).toContain('lib/webmcp/use-browser-tool-registry.ts')
  })
})
