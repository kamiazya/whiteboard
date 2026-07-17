import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureDevDataDirSecured,
  injectDerivedPortArg,
  readDevDaemonMarker,
  removeDevDaemonMarker,
  reraiseSignalOrExit,
  resolveDevDataDirEnv,
  resolveRepoRootFromScriptDir,
  resolveTsxWatchSpawn,
  writeDevDaemonMarker,
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

describe('reraiseSignalOrExit', () => {
  it('re-raises the signal against the given pid via kill', () => {
    const calls = []
    reraiseSignalOrExit('SIGTERM', {
      pid: 4242,
      kill: (pid, signal) => calls.push({ pid, signal }),
      exit: () => {
        throw new Error('exit should not be called when kill succeeds')
      },
    })

    expect(calls).toEqual([{ pid: 4242, signal: 'SIGTERM' }])
  })

  it('falls back to exit(1) when kill throws (e.g. Windows EINVAL on POSIX signals)', () => {
    const exitCalls = []
    reraiseSignalOrExit('SIGTERM', {
      pid: 4242,
      kill: () => {
        throw new Error('EINVAL: invalid argument, kill')
      },
      exit: (code) => exitCalls.push(code),
    })

    expect(exitCalls).toEqual([1])
  })
})

describe('injectDerivedPortArg', () => {
  it('appends --port=<derived> when argv has no --port flag', () => {
    expect(injectDerivedPortArg(['--daemon', '--token=whiteboard-dev'], 3123)).toEqual([
      '--daemon',
      '--token=whiteboard-dev',
      '--port=3123',
    ])
  })

  it('leaves argv untouched (no duplicate) when caller already passed --port', () => {
    const argv = ['--daemon', '--port=4000']

    expect(injectDerivedPortArg(argv, 3123)).toEqual(['--daemon', '--port=4000'])
  })

  it('does not mutate the input argv array', () => {
    const argv = ['--daemon']
    const result = injectDerivedPortArg(argv, 3123)

    expect(argv).toEqual(['--daemon'])
    expect(result).not.toBe(argv)
  })
})

describe('dev daemon identity marker', () => {
  let tempRoot: string

  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
  })

  it('writes { port, repoRoot, pid, startedAt } to <dataDir>/dev-daemon.json', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dev-daemon-marker-'))

    writeDevDaemonMarker(tempRoot, { port: 3123, repoRoot: '/repo/worktree', pid: 4242 })

    const raw = JSON.parse(readFileSync(join(tempRoot, 'dev-daemon.json'), 'utf8'))
    expect(raw).toMatchObject({ port: 3123, repoRoot: '/repo/worktree', pid: 4242 })
    expect(typeof raw.startedAt).toBe('string')
  })

  it('overwrites a malformed existing marker instead of throwing', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dev-daemon-marker-'))
    writeFileSyncMalformed(tempRoot)

    expect(() =>
      writeDevDaemonMarker(tempRoot, { port: 3123, repoRoot: '/repo/worktree', pid: 4242 }),
    ).not.toThrow()

    const raw = JSON.parse(readFileSync(join(tempRoot, 'dev-daemon.json'), 'utf8'))
    expect(raw.port).toBe(3123)
  })

  it('readDevDaemonMarker returns null when the marker file is absent', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dev-daemon-marker-'))

    expect(readDevDaemonMarker(tempRoot)).toBeNull()
  })

  it('readDevDaemonMarker returns null (not a throw) when the marker is malformed JSON', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dev-daemon-marker-'))
    writeFileSyncMalformed(tempRoot)

    expect(readDevDaemonMarker(tempRoot)).toBeNull()
  })

  it('readDevDaemonMarker round-trips a previously written marker', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dev-daemon-marker-'))
    writeDevDaemonMarker(tempRoot, { port: 3123, repoRoot: '/repo/worktree', pid: 4242 })

    expect(readDevDaemonMarker(tempRoot)).toMatchObject({
      port: 3123,
      repoRoot: '/repo/worktree',
      pid: 4242,
    })
  })

  it('removeDevDaemonMarker deletes the marker and is a no-op when already absent', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dev-daemon-marker-'))
    writeDevDaemonMarker(tempRoot, { port: 3123, repoRoot: '/repo/worktree', pid: 4242 })

    removeDevDaemonMarker(tempRoot)
    expect(existsSync(join(tempRoot, 'dev-daemon.json'))).toBe(false)

    expect(() => removeDevDaemonMarker(tempRoot)).not.toThrow()
  })

  function writeFileSyncMalformed(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'dev-daemon.json'), '{ not valid json')
  }
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
