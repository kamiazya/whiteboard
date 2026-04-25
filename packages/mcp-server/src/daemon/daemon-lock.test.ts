import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withDaemonStartupLock } from './daemon-lock.js'

describe('withDaemonStartupLock', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-daemon-lock-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('runs the callback under an exclusive lock', async () => {
    const result = await withDaemonStartupLock(tempDir, async () => 'ok')
    expect(result).toBe('ok')
  })

  it('waits for an existing lock to be released', async () => {
    await mkdir(join(tempDir, 'daemon.lock'))
    setTimeout(() => {
      void rm(join(tempDir, 'daemon.lock'), { recursive: true, force: true })
    }, 20)

    const result = await withDaemonStartupLock(
      tempDir,
      async () => 'after-wait',
      { retryDelayMs: 5, timeoutMs: 500 },
    )

    expect(result).toBe('after-wait')
  })

  it('writes owner metadata while holding the lock', async () => {
    await withDaemonStartupLock(tempDir, async () => {
      const raw = JSON.parse(
        await readFile(join(tempDir, 'daemon.lock', 'owner.json'), 'utf-8'),
      ) as { pid: number; startedAt: string }
      expect(raw.pid).toBe(process.pid)
      expect(typeof raw.startedAt).toBe('string')
    })
  })

  it('reclaims a stale lock when the recorded owner pid is dead', async () => {
    await mkdir(join(tempDir, 'daemon.lock'))
    await writeFile(
      join(tempDir, 'daemon.lock', 'owner.json'),
      JSON.stringify({ pid: 999999999, startedAt: '2026-04-23T00:00:00.000Z' }),
    )

    const result = await withDaemonStartupLock(
      tempDir,
      async () => 'reclaimed',
      { retryDelayMs: 5, timeoutMs: 200 },
    )

    expect(result).toBe('reclaimed')
  })

  it('keeps waiting when lock metadata is broken and eventually times out', async () => {
    await mkdir(join(tempDir, 'daemon.lock'))
    await writeFile(join(tempDir, 'daemon.lock', 'owner.json'), '{not-json')

    await expect(
      withDaemonStartupLock(tempDir, async () => 'never', { retryDelayMs: 5, timeoutMs: 30 }),
    ).rejects.toThrow(/timeout/i)
  })
})
