import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { buildBackupSpawnArgs, runBackupInSubprocess } from './backup-subprocess.js'

/**
 * The scheduled backup runs in its own process, not in the daemon's.
 *
 * Measured, because this is the sort of claim that is otherwise only
 * plausible: `VACUUM INTO` through `@libsql/client` blocks the Node event
 * loop for its whole duration — a 5ms sampler fired ZERO times across a
 * 4767ms snapshot of a 421MB database, and the cost is roughly linear (33ms
 * empty, 314ms at 25MB, 1242ms at 103MB). In the daemon's own process that is
 * every HTTP request, every WebSocket frame and every MCP call stopped for
 * seconds, nightly. The blob copy is not the problem — it stays under 3.1ms
 * of lag across a 200MB tree — but the pass is moved whole, since splitting
 * it would put the two halves of one backup in two places.
 *
 * The child is the CLI this repository already ships and already smoke-tests,
 * `whiteboard server backup --json`, so the scheduled path and the manual one
 * stay literally the same program rather than two implementations that agree
 * today.
 */
describe('the backup subprocess', () => {
  function fakeChild(): EventEmitter & {
    stdout: Readable
    stderr: Readable
    kill: ReturnType<typeof vi.fn>
  } {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: ReturnType<typeof vi.fn>
    }
    child.stdout = Readable.from([])
    child.stderr = Readable.from([])
    child.kill = vi.fn()
    return child
  }

  function spawnReturning(options: {
    stdout?: string
    stderr?: string
    code?: number
    onSpawn?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => void
  }) {
    return (command: string, args: readonly string[], opts: { env: NodeJS.ProcessEnv }) => {
      options.onSpawn?.(command, args, opts.env)
      const child = fakeChild()
      child.stdout = Readable.from([options.stdout ?? ''])
      child.stderr = Readable.from([options.stderr ?? ''])
      queueMicrotask(() => {
        setTimeout(() => child.emit('close', options.code ?? 0), 0)
      })
      return child
    }
  }

  const OK_JSON = JSON.stringify({
    schemaVersion: 2,
    ok: true,
    operation: 'backup',
    stores: { database: { captured: true }, blobs: { captured: true } },
  })

  it('reports what the child reported', async () => {
    const outcome = await runBackupInSubprocess({
      dataDir: '/data',
      outputDir: '/backups/one',
      spawnBackup: spawnReturning({ stdout: `${OK_JSON}\n` }),
    })
    expect(outcome).toEqual({
      kind: 'ok',
      result: {
        schemaVersion: 2,
        ok: true,
        operation: 'backup',
        stores: { database: { captured: true }, blobs: { captured: true } },
      },
    })
  })

  /**
   * A store reported as out of scope has to survive the process boundary
   * intact. It is the one part of the result an operator acts on — it says
   * their rows are still theirs to arrange — and a runner that flattened it
   * to "ok" would silence exactly that.
   */
  it('carries a store reported out of scope through unchanged', async () => {
    const outcome = await runBackupInSubprocess({
      dataDir: '/data',
      outputDir: '/backups/one',
      spawnBackup: spawnReturning({
        stdout: JSON.stringify({
          schemaVersion: 2,
          ok: true,
          operation: 'backup',
          stores: {
            database: { captured: false, reason: 'hosted-elsewhere' },
            blobs: { captured: true },
          },
        }),
      }),
    })
    expect(outcome.kind === 'ok' && outcome.result.stores.database).toEqual({
      captured: false,
      reason: 'hosted-elsewhere',
    })
  })

  it('fails when the child exits non-zero', async () => {
    const outcome = await runBackupInSubprocess({
      dataDir: '/data',
      outputDir: '/backups/one',
      spawnBackup: spawnReturning({ stderr: 'backup refused: …\n', code: 1 }),
    })
    expect(outcome.kind).toBe('error')
  })

  /**
   * A zero exit with unusable output is a failure, not a success. Treating it
   * as ok would report a backup that may not exist — the exact shape ADR-0021
   * exists to remove, arriving by simply not checking.
   */
  it('fails when the child exits zero with nothing usable on stdout', async () => {
    const outcome = await runBackupInSubprocess({
      dataDir: '/data',
      outputDir: '/backups/one',
      spawnBackup: spawnReturning({ stdout: 'not json', code: 0 }),
    })
    expect(outcome.kind).toBe('error')
  })

  it('fails when the child cannot be started at all', async () => {
    const outcome = await runBackupInSubprocess({
      dataDir: '/data',
      outputDir: '/backups/one',
      spawnBackup: () => {
        const child = fakeChild()
        queueMicrotask(() => child.emit('error', new Error('ENOENT')))
        return child
      },
    })
    expect(outcome.kind).toBe('error')
  })

  /**
   * The child is told which directories to work on rather than inheriting
   * them. `WHITEBOARD_DATA_DIR` in the daemon's environment need not be the
   * directory the scheduler was configured with, and a backup of the wrong
   * directory reports success just as loudly as a backup of the right one.
   */
  it('names both directories on the command line', async () => {
    let seen: readonly string[] = []
    await runBackupInSubprocess({
      dataDir: '/data',
      outputDir: '/backups/one',
      spawnBackup: spawnReturning({
        stdout: OK_JSON,
        onSpawn: (_command, args) => {
          seen = args
        },
      }),
    })
    expect(seen).toContain('--data-dir=/data')
    expect(seen).toContain('--output-dir=/backups/one')
    expect(seen).toContain('--json')
  })

  /**
   * The schedule shares one blob mirror between its retained backups; a
   * one-off does not. The child is the same program either way, so the
   * difference has to travel as an argument — and it is absent by default,
   * because a backup that keeps its own mirror is one an operator can carry
   * away.
   */
  it('passes the shared mirror through to the child, and only when there is one', async () => {
    let withMirror: readonly string[] = []
    await runBackupInSubprocess({
      dataDir: '/data',
      outputDir: '/backups/one',
      mirrorRoot: '/backups',
      spawnBackup: spawnReturning({
        stdout: OK_JSON,
        onSpawn: (_command, args) => {
          withMirror = args
        },
      }),
    })
    expect(withMirror).toContain('--mirror-dir=/backups')

    let without: readonly string[] = []
    await runBackupInSubprocess({
      dataDir: '/data',
      outputDir: '/backups/one',
      spawnBackup: spawnReturning({
        stdout: OK_JSON,
        onSpawn: (_command, args) => {
          without = args
        },
      }),
    })
    expect(without.some((arg) => arg.startsWith('--mirror-dir'))).toBe(false)
  })

  describe('buildBackupSpawnArgs', () => {
    it('runs the packaged CLI by default', () => {
      const { command, args } = buildBackupSpawnArgs({
        env: {},
        dataDir: '/data',
        outputDir: '/out',
      })
      expect(command).toBe(process.execPath)
      expect(args[0]).toMatch(/dist\/cli\/index\.js$/)
    })

    /**
     * In development the entry point is TypeScript, so the loader has to come
     * with it. Without this the scheduled backup is the one path that only
     * ever runs in production — which is where a first failure is expensive.
     */
    it('runs the source entry through the loader in development', () => {
      const { args } = buildBackupSpawnArgs({
        env: { WHITEBOARD_DEV: '1' },
        dataDir: '/data',
        outputDir: '/out',
      })
      expect(args.slice(0, 2)).toEqual(['--import', 'tsx/esm'])
      expect(args[2]).toMatch(/src\/cli\/index\.ts$/)
    })
  })
})
