import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { purgeOldDaemonLogs } from './log-rotation.js'

let dataDir: string

async function seedLog(name: string, bytes: number): Promise<void> {
  await mkdir(join(dataDir, 'logs'), { recursive: true })
  await writeFile(join(dataDir, 'logs', name), Buffer.alloc(bytes, 0xab))
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'log-rotation-test-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

describe('purgeOldDaemonLogs', () => {
  it('removes daemon-*.log files dated more than retainDays before now', async () => {
    // 2026-05-02 reference; retainDays=14 → cutoff = 2026-04-18.
    await seedLog('daemon-2026-04-01.log', 1000) // older → drop
    await seedLog('daemon-2026-04-17.log', 500) // older → drop
    await seedLog('daemon-2026-04-19.log', 200) // newer than cutoff → keep
    await seedLog('daemon-2026-05-02.log', 100) // today → keep
    await seedLog('keep-this.txt', 50) // not a daemon log → keep

    const result = await purgeOldDaemonLogs(dataDir, {
      retainDays: 14,
      now: new Date('2026-05-02T03:00:00Z'),
    })
    expect(result.purgedCount).toBe(2)
    expect(result.purgedBytes).toBe(1500)

    const remaining = (await readdir(join(dataDir, 'logs'))).sort()
    expect(remaining).toEqual(['daemon-2026-04-19.log', 'daemon-2026-05-02.log', 'keep-this.txt'])
  })

  it('returns zero counts when the logs directory does not exist yet', async () => {
    const result = await purgeOldDaemonLogs(dataDir)
    expect(result).toEqual({ purgedCount: 0, purgedBytes: 0 })
  })

  it('respects custom retainDays', async () => {
    await seedLog('daemon-2026-04-30.log', 10) // 2 days old → drop with retainDays=1
    await seedLog('daemon-2026-05-02.log', 20) // today → keep

    const result = await purgeOldDaemonLogs(dataDir, {
      retainDays: 1,
      now: new Date('2026-05-02T00:00:00Z'),
    })
    expect(result.purgedCount).toBe(1)
    expect(result.purgedBytes).toBe(10)
  })
})
