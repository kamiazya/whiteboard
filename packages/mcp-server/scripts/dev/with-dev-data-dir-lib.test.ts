import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDevDataDirEnv, resolveRepoRootFromScriptDir } from './with-dev-data-dir-lib.mjs'

describe('resolveDevDataDirEnv', () => {
  const repoRoot = '/repo'

  it('sets WHITEBOARD_DATA_DIR to <repoRoot>/.dev-data when unset', () => {
    const result = resolveDevDataDirEnv({}, repoRoot)

    expect(result.WHITEBOARD_DATA_DIR).toBe(resolve('/repo/.dev-data'))
  })

  it('does NOT override an already-set WHITEBOARD_DATA_DIR (explicit env always wins)', () => {
    const result = resolveDevDataDirEnv({ WHITEBOARD_DATA_DIR: '/custom/data' }, repoRoot)

    expect(result.WHITEBOARD_DATA_DIR).toBe('/custom/data')
  })

  it('returns a new object and leaves the input env untouched (immutable update)', () => {
    const input = { FOO: 'bar' }
    const result = resolveDevDataDirEnv(input, repoRoot)

    expect(result).not.toBe(input)
    expect(input).not.toHaveProperty('WHITEBOARD_DATA_DIR')
    expect(result.FOO).toBe('bar')
  })
})

describe('resolveRepoRootFromScriptDir', () => {
  it('resolves the repo root two levels above packages/mcp-server from the dev scripts dir', () => {
    // This file lives at packages/mcp-server/scripts/dev — repo root is
    // four levels up (dev -> scripts -> mcp-server -> packages -> repoRoot).
    const scriptDir = '/repo/packages/mcp-server/scripts/dev'

    expect(resolveRepoRootFromScriptDir(scriptDir)).toBe(resolve('/repo'))
  })
})
