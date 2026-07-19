import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The user-facing docs/ tree is the contract surface for anything a real
// operator needs to discover (env vars, escape hatches). R5 of the MCP-UI
// retirement (ADR 0001) deletes the WHITEBOARD_LEGACY_UI escape hatch along
// with the legacy UI it toggled — this test fails the build if the flag is
// ever documented again without the code behind it existing.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const DOCS_ROOT = join(REPO_ROOT, 'docs')

function collectMarkdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(dir, entry.name)
    if (entry.isDirectory()) return collectMarkdownFiles(entryPath)
    return entry.name.endsWith('.md') ? [entryPath] : []
  })
}

describe('docs/ contract', () => {
  it('no longer documents the retired WHITEBOARD_LEGACY_UI escape hatch', () => {
    const markdownFiles = collectMarkdownFiles(DOCS_ROOT)
    const mentioning = markdownFiles.filter((path) =>
      readFileSync(path, 'utf8').includes('WHITEBOARD_LEGACY_UI'),
    )
    expect(mentioning).toEqual([])
  })

  it('describes `pnpm test` as covering every package with a root vitest project', () => {
    // The root vitest.config.ts is the source of truth for which packages
    // `pnpm test` actually exercises. A doc line that omits a package (e.g.
    // canvas-viewer) misleads contributors into skipping its failures.
    const rootVitestConfig = readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf8')
    const projectPackageDirs = [
      ...new Set(
        [...rootVitestConfig.matchAll(/'((?:packages|apps)\/[^/]+)\//g)].map((match) => match[1]),
      ),
    ]
    // The doc shorthand for each package's project(s) doesn't match its
    // directory name 1:1 (e.g. packages/mcp-server's projects are named
    // "mcp-node"/"mcp-smoke", not "mcp-server"). Check for the substring a
    // reader would recognize as "this package's tests are covered" instead
    // of requiring an exact directory-name match.
    const docMentionTokenForPackageDir: Record<string, string> = {
      'packages/mcp-server': 'mcp',
      'packages/canvas-viewer': 'canvas-viewer',
      'apps/web': 'web',
    }
    const docsDescribingFullTestSuite = [
      join(DOCS_ROOT, 'contributing/development.md'),
      join(DOCS_ROOT, 'contributing/testing.md'),
    ]

    for (const docPath of docsDescribingFullTestSuite) {
      const content = readFileSync(docPath, 'utf8')
      // Only the line that spells out the suite composition (identified by
      // its "mcp-smoke" mention) is a drift risk; a plain "pnpm test # all
      // projects" summary line makes no enumeration claim to go stale.
      const fullSuiteLine = content
        .split('\n')
        .find((line) => /^pnpm test\s/.test(line.trim()) && line.includes('mcp-smoke'))
      expect(fullSuiteLine, `${docPath} is missing a \`pnpm test\` description line`).toBeDefined()
      for (const packageDir of projectPackageDirs) {
        const token = docMentionTokenForPackageDir[packageDir]
        expect(token, `add a doc-mention token for ${packageDir} in this test`).toBeDefined()
        expect(
          fullSuiteLine,
          `${docPath}'s \`pnpm test\` line should mention "${token}" (from ${packageDir} in vitest.config.ts)`,
        ).toContain(token)
      }
    }
  })
})
