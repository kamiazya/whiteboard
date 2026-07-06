import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Stage 2 slice 4 (ADR 0001) ported four API-free pure-logic modules from the
// daemon app (packages/mcp-server/src/app, frozen, deleted in Stage 5) into
// apps/web (canonical going forward). During the dual-copy window a fix
// landing on only one side would drift silently — this test pins the two
// copies together so CI catches that instead of a future bug report.
//
// Allowed adaptations (the only differences tolerated by normalization):
//   1. Relative import specifier extension style (e.g. `./foo.js` vs `./foo`)
//   2. The `// @vitest-environment jsdom` pragma line (apps/web defaults to
//      jsdom, so the pragma is redundant there and was dropped)
//   3. Trailing whitespace / trailing-newline differences
//
// Any other divergence is a real drift and must fail.

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../..')

interface PortPair {
  label: string
  original: string
  ported: string
}

const pairs: PortPair[] = [
  {
    label: 'useThemeMode.ts',
    original: 'packages/mcp-server/src/app/hooks/useThemeMode.ts',
    ported: 'apps/web/src/hooks/useThemeMode.ts',
  },
  {
    label: 'useThemeMode.test.tsx',
    original: 'packages/mcp-server/src/app/hooks/useThemeMode.test.tsx',
    ported: 'apps/web/src/hooks/useThemeMode.test.tsx',
  },
  {
    label: 'useDirtyState.ts',
    original: 'packages/mcp-server/src/app/hooks/useDirtyState.ts',
    ported: 'apps/web/src/hooks/useDirtyState.ts',
  },
  {
    label: 'useDirtyState.test.ts',
    original: 'packages/mcp-server/src/app/hooks/useDirtyState.test.ts',
    ported: 'apps/web/src/hooks/useDirtyState.test.ts',
  },
  {
    label: 'canvas-page-fullscreen.ts',
    original: 'packages/mcp-server/src/app/pages/canvas-page-fullscreen.ts',
    ported: 'apps/web/src/lib/canvas-page-fullscreen.ts',
  },
  {
    label: 'canvas-page-fullscreen.test.ts',
    original: 'packages/mcp-server/src/app/pages/canvas-page-fullscreen.test.ts',
    ported: 'apps/web/src/lib/canvas-page-fullscreen.test.ts',
  },
  {
    label: 'canvas-fullscreen-hash.ts',
    original: 'packages/mcp-server/src/app/pages/canvas-fullscreen-hash.ts',
    ported: 'apps/web/src/lib/canvas-fullscreen-hash.ts',
  },
  {
    label: 'canvas-fullscreen-hash.test.ts',
    original: 'packages/mcp-server/src/app/pages/canvas-fullscreen-hash.test.ts',
    ported: 'apps/web/src/lib/canvas-fullscreen-hash.test.ts',
  },
]

function normalize(source: string): string {
  return source
    .split('\n')
    .filter((line) => line.trim() !== '// @vitest-environment jsdom')
    .map((line) =>
      line.replace(
        /from ('|")(\.\.?\/[^'"]+)\.js\1/g,
        (_match, quote, spec) => `from ${quote}${spec}${quote}`,
      ),
    )
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim()
}

function unifiedDiff(label: string, expected: string, actual: string): string {
  const expectedLines = expected.split('\n')
  const actualLines = actual.split('\n')
  const max = Math.max(expectedLines.length, actualLines.length)
  const diffLines: string[] = []
  for (let i = 0; i < max; i++) {
    if (expectedLines[i] !== actualLines[i]) {
      diffLines.push(`  line ${i + 1}:`)
      diffLines.push(`    - ${expectedLines[i] ?? '<missing>'}`)
      diffLines.push(`    + ${actualLines[i] ?? '<missing>'}`)
    }
  }
  return `${label} diverged beyond allowed adaptations:\n${diffLines.join('\n')}`
}

describe('port-parity (Stage 2 slice 4 dual-copy guard)', () => {
  for (const pair of pairs) {
    it(`${pair.label}: apps/web copy matches the frozen packages/mcp-server original`, () => {
      const originalPath = resolve(repoRoot, pair.original)
      const portedPath = resolve(repoRoot, pair.ported)
      expect(existsSync(originalPath), `missing original: ${pair.original}`).toBe(true)
      expect(existsSync(portedPath), `missing ported copy: ${pair.ported}`).toBe(true)

      const originalSource = readFileSync(originalPath, 'utf8')
      const portedSource = readFileSync(portedPath, 'utf8')
      expect(originalSource.length, `original is empty: ${pair.original}`).toBeGreaterThan(0)
      expect(portedSource.length, `ported copy is empty: ${pair.ported}`).toBeGreaterThan(0)

      const normalizedOriginal = normalize(originalSource)
      const normalizedPorted = normalize(portedSource)
      expect(normalizedPorted, unifiedDiff(pair.label, normalizedOriginal, normalizedPorted)).toBe(
        normalizedOriginal,
      )
    })
  }
})
