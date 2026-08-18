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
  resolveDevAllowedWebOriginsEnv,
  resolveDevDataDirEnv,
  resolveEffectivePort,
  resolveTsxWatchSpawn,
  writeDevDaemonMarker,
} from './with-dev-data-dir-lib.mjs'

describe('resolveDevAllowedWebOriginsEnv', () => {
  it('defaults to the project pages.dev origins when unset', () => {
    const result = resolveDevAllowedWebOriginsEnv({})
    expect(result.WHITEBOARD_ALLOWED_WEB_ORIGINS).toBe(
      'https://kamiazya-whiteboard.pages.dev,https://*.kamiazya-whiteboard.pages.dev',
    )
  })

  it('an explicit env value wins over the dev default', () => {
    const result = resolveDevAllowedWebOriginsEnv({
      WHITEBOARD_ALLOWED_WEB_ORIGINS: 'https://example.com',
    })
    expect(result.WHITEBOARD_ALLOWED_WEB_ORIGINS).toBe('https://example.com')
  })

  it('an explicit empty string disables the default (deliberate loopback-only)', () => {
    const result = resolveDevAllowedWebOriginsEnv({ WHITEBOARD_ALLOWED_WEB_ORIGINS: '' })
    expect(result.WHITEBOARD_ALLOWED_WEB_ORIGINS).toBe('')
  })
})

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

  it('still appends --port=<derived> for a bare "--port <value>" (space form), because parseArg in server/index.ts only recognizes the "--port=value" form and would otherwise silently fall back to the default port', () => {
    const argv = ['--daemon', '--port', '4000']

    expect(injectDerivedPortArg(argv, 3123)).toEqual(['--daemon', '--port', '4000', '--port=3123'])
  })
})

describe('resolveEffectivePort', () => {
  it('returns the derived port when argv has no --port=value flag', () => {
    expect(resolveEffectivePort(['--daemon'], 3123)).toBe(3123)
  })

  it('returns the caller-provided --port=value when present, matching what parseArg resolves', () => {
    expect(resolveEffectivePort(['--daemon', '--port=4000'], 3123)).toBe(4000)
  })

  it("returns the derived port for a bare '--port <value>' argv, since that form is not a recognized override", () => {
    expect(resolveEffectivePort(['--daemon', '--port', '4000'], 3123)).toBe(3123)
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

  it('creates the data dir first when it does not exist yet (e.g. an explicit WHITEBOARD_DATA_DIR override that was never mkdir-ed)', () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dev-daemon-marker-'))
    const notYetCreated = join(tempRoot, 'override', 'nested')

    expect(() =>
      writeDevDaemonMarker(notYetCreated, { port: 3123, repoRoot: '/repo/worktree', pid: 4242 }),
    ).not.toThrow()

    expect(existsSync(join(notYetCreated, 'dev-daemon.json'))).toBe(true)
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

describe('resolveRepoRootFromGit', () => {
  it('returns the git toplevel for the current working directory', async () => {
    const { resolveRepoRootFromGit } = await import('./with-dev-data-dir-lib.mjs')
    const result = resolveRepoRootFromGit(process.cwd())

    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
    expect(existsSync(join(result, '.git'))).toBe(true)
  })

  it('resolves to the worktree root, not the main checkout, when cwd is inside a worktree', async () => {
    const { resolveRepoRootFromGit } = await import('./with-dev-data-dir-lib.mjs')
    const result = resolveRepoRootFromGit(process.cwd())
    const gitPath = join(result, '.git')

    // If we're running inside a worktree, .git is a file not a directory.
    // If we're running in the main checkout, .git is a directory.
    // Either way the result must match the cwd's own git toplevel.
    expect(existsSync(gitPath)).toBe(true)

    // The resolved root must be an ancestor of (or equal to) the cwd.
    expect(resolve(process.cwd()).startsWith(resolve(result))).toBe(true)
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
