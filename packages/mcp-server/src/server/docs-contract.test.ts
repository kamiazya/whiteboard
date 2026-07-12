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
})
