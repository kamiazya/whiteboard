import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'

/**
 * Registers per-test temp-dir lifecycle (beforeEach create, afterEach rm).
 * Returns a getter so callers can read the current path inside tests.
 */
export function withTempDataDir(prefix = 'whiteboard-test-'): { get dir(): string } {
  let tempDir = ''

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), prefix))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  return {
    get dir(): string {
      return tempDir
    },
  }
}
