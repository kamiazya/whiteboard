import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findRepoRoot, repoRoot } from './repo-root.js'

const WORKSPACE_MARKER = 'pnpm-workspace.yaml'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratchDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-repo-root-')))
  scratch.push(dir)
  return dir
}

describe('findRepoRoot', () => {
  it('finds the marker from a directory nested far below it', () => {
    const root = scratchDir()
    writeFileSync(join(root, WORKSPACE_MARKER), 'packages:\n  - packages/*\n')
    const deep = join(root, 'packages', 'a', 'src', 'server', 'release', 'deeper')
    mkdirSync(deep, { recursive: true })

    expect(findRepoRoot(deep)).toBe(root)
  })

  it('answers the nearest marker, so a nested checkout is its own root', () => {
    const outer = scratchDir()
    writeFileSync(join(outer, WORKSPACE_MARKER), '')
    const inner = join(outer, '.claude', 'worktrees', 'lane')
    mkdirSync(join(inner, 'packages', 'x'), { recursive: true })
    writeFileSync(join(inner, WORKSPACE_MARKER), '')

    expect(findRepoRoot(join(inner, 'packages', 'x'))).toBe(inner)
  })

  it('looks for the marker it is given, so the refusal below does not depend on the machine', () => {
    const root = scratchDir()
    writeFileSync(join(root, 'custom.marker'), '')
    const deep = join(root, 'a', 'b')
    mkdirSync(deep, { recursive: true })

    expect(findRepoRoot(deep, 'custom.marker')).toBe(root)
  })

  it('refuses, naming where it started, when no ancestor carries the marker', () => {
    const start = scratchDir()
    const missing = `no-such-marker-${process.pid}-${Date.now()}`

    expect(() => findRepoRoot(start, missing)).toThrow(start)
  })
})

describe('repoRoot', () => {
  it('is the checkout this very file lives in, wherever that checkout sits', () => {
    expect(join(repoRoot(), 'packages/mcp-server/src/shared/test-utils/repo-root.ts')).toBe(
      join(import.meta.dirname, 'repo-root.ts'),
    )
  })
})
