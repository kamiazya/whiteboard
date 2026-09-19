import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDataDirForTests, setDataDirForTests } from '../data-dir-secure.js'

/**
 * Point this worker's `getDataDir()` at a fresh scratch directory, for a test
 * file that starts a REAL server.
 *
 * `startHttpServer` runs `prepareDataDir` — migrations included — against
 * whatever `getDataDir()` answers. Vitest gives each test FILE its own worker
 * process but not its own disk, so two such files running at once migrate the
 * same sqlite database concurrently and the loser reports
 * `table "workspaces" already exists` or `SQLITE_BUSY`. The failure lands in
 * whichever file lost the race, which is not necessarily the file that was
 * added — `http-server.test.ts` was the only one for a long time, so it never
 * had to isolate, and it went red when a second real-server file appeared
 * beside it.
 *
 * Ports are already separated per file by hand; this is the same problem one
 * resource over.
 */
export function claimIsolatedDataDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wb-${label}-`))
  setDataDirForTests(dir)
  return dir
}

export function releaseIsolatedDataDir(dir: string): void {
  resetDataDirForTests()
  rmSync(dir, { recursive: true, force: true })
}
