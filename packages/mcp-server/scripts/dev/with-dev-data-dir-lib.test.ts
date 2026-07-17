import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureDevDataDirSecured,
  resolveDevDataDirEnv,
  resolveRepoRootFromScriptDir,
  resolveTsxWatchSpawn,
} from './with-dev-data-dir-lib.mjs'

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

describe('ensureDevDataDirSecured', () => {
  let tempRoot: string

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  })

  it('creates a missing directory and hardens it to owner-only 0700 on posix', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dev-data-secure-'))
    const target = join(tempRoot, 'nested', '.dev-data')

    ensureDevDataDirSecured(target)

    expect(existsSync(target)).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(target).mode & 0o777).toBe(0o700)
    }
  })

  it('tightens an existing directory that was created under a looser umask', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dev-data-secure-'))
    const target = join(tempRoot, '.dev-data')
    mkdirSync(target, { mode: 0o755 })

    ensureDevDataDirSecured(target)

    if (process.platform !== 'win32') {
      expect(statSync(target).mode & 0o777).toBe(0o700)
    }
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

describe('resolveTsxWatchSpawn', () => {
  it('spawns node directly against tsx dist/cli.mjs, not the node_modules/.bin shim', () => {
    const result = resolveTsxWatchSpawn(
      '/repo/packages/mcp-server',
      '/repo/packages/mcp-server/src/server/index.ts',
      ['--foo'],
      { execPath: '/usr/local/bin/node' },
    )

    expect(result).toEqual({
      command: '/usr/local/bin/node',
      args: [
        resolve('/repo/packages/mcp-server/node_modules/tsx/dist/cli.mjs'),
        'watch',
        '/repo/packages/mcp-server/src/server/index.ts',
        '--foo',
      ],
    })
  })

  it('does not reference node_modules/.bin anywhere in the resolved command or args', () => {
    const result = resolveTsxWatchSpawn('/repo/packages/mcp-server', '/repo/entry.ts', [])

    expect(result.command).not.toContain('.bin')
    expect(result.args.every((arg) => !arg.includes('.bin'))).toBe(true)
  })
})
