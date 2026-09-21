/**
 * The straggler its sibling file hunts by REPETITION, reproduced by
 * construction.
 *
 * `backup-in-progress.test.ts` runs the marker 60 times and asserts none
 * survives. That found the first straggler (8 of 60 before its fix) and then
 * kept finding a rarer one on CI and never here — 42 of 60 on a loaded
 * runner, 0 of 360 on this machine. A test that needs the machine to be
 * unlucky is a test that reports the machine.
 *
 * What it is unlucky ABOUT is two refreshes in flight at once: `inFlight`
 * holds whichever write STARTED last, so awaiting it says nothing about an
 * older write that has not finished. Gate one write and the whole thing is
 * deterministic — and it stays a test of the real code, since the only thing
 * substituted is WHEN a write completes.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface GatedWrite {
  readonly release: () => void
  readonly finished: Promise<void>
}

/** Every write the marker has started, in order. */
const writes: GatedWrite[] = []
/** Which of them waits to be released; every other completes at once. */
let gatedIndex = -1

vi.mock('../atomic-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../atomic-write.js')>()
  return {
    ...actual,
    writeFileAtomic: async (dataDir: string, path: string, contents: string) => {
      const index = writes.length
      let release = (): void => {}
      const gate =
        index === gatedIndex
          ? new Promise<void>((resolve) => {
              release = resolve
            })
          : Promise.resolve()
      let done = (): void => {}
      const finished = new Promise<void>((resolve) => {
        done = resolve
      })
      writes.push({ release, finished })
      await gate
      try {
        return await actual.writeFileAtomic(dataDir, path, contents)
      } finally {
        done()
      }
    },
  }
})

const { BACKUP_MARKER_FILENAME, withBackupMarker } = await import('./backup-in-progress.js')

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-backup-marker-overlap-'))
  writes.length = 0
  gatedIndex = -1
})
afterEach(async () => {
  // Release anything still held, or a leaked write keeps the directory busy
  // and the cleanup fails with ENOTEMPTY rather than the test's own message.
  for (const write of writes) write.release()
  await Promise.all(writes.map((write) => write.finished))
  await rm(dir, { recursive: true, force: true })
})

describe('the backup marker with two refreshes in flight', () => {
  it('waits for EVERY write, not the one that started last', async () => {
    // Index 0 is the opening write, awaited before the interval is armed.
    // Index 1 is the first refresh, and it is the one held back.
    gatedIndex = 1

    let releaseBody = (): void => {}
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve
    })
    const pass = withBackupMarker(dir, async () => bodyGate, {
      ttlMs: 60_000,
      refreshEveryMs: 1,
    })
    await vi.waitFor(() => expect(writes.length).toBeGreaterThanOrEqual(2))

    // The held write is released on a later turn, so BOTH shapes terminate:
    // code that awaits only the newest write finishes the pass first and then
    // takes the straggler; code that awaits every write finishes after it.
    releaseBody()
    setTimeout(() => writes[1]?.release(), 0)
    await pass
    await writes[1]?.finished

    expect(
      await readdir(dir),
      'a refresh that was still in flight when the pass ended re-created the marker after it was removed',
    ).not.toContain(BACKUP_MARKER_FILENAME)
  })
})
