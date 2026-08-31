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
    // `recursive` is not enough on its own: a data dir a server is still
    // shutting down can gain a file DURING the walk, and the rmdir at the
    // end then raises ENOTEMPTY. It surfaces as a teardown failure attached
    // to whichever test happened to run last, which names neither the writer
    // nor the race — observed on CI as
    // `ENOTEMPTY: directory not empty, rmdir '/tmp/whiteboard-app-test-…'`
    // against a suite that passes 3/3 locally.
    //
    // `maxRetries` is what node supplies for exactly this. It makes the
    // teardown robust to a writer that is on its way out; it would not
    // rescue one that never stops, and is not meant to.
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  return {
    get dir(): string {
      return tempDir
    },
  }
}

/**
 * Registers a workspace under EXACTLY the id given, so a fixture that
 * addresses it by that literal afterwards still finds it.
 *
 * Needed because these suites bootstrap by POSTing a document, and that
 * route passes `createWorkspace: true` — which is ADR-0019's mint boundary.
 * A mint keys the workspace by a fresh ULID and files the posted handle as
 * its `segment`, so the literal the fixture goes on to read the store by
 * would name nothing. Creating it up front makes the route's flag the no-op
 * it is for every workspace that already exists.
 *
 * Deliberately the port call rather than a `saveDocument`: seeding a
 * throwaway document would show up in the listings several of these cases
 * assert on.
 */
export async function seedWorkspaceRow(dataDir: string, workspaceId: string): Promise<void> {
  const { getDb } = await import('../store/db/index.js')
  const { prepareDataDir } = await import('../store/db/prepare.js')
  const { createContainer, resolveServerDeps } = await import('../../di/container.js')
  const { createStoreLocalModule } = await import('../../di/store-local.module.js')
  await prepareDataDir(dataDir)
  const db = await getDb(dataDir)
  const deps = resolveServerDeps(createContainer(createStoreLocalModule({ db, blobDir: dataDir })))
  await deps.documentIndex.createWorkspace({ workspaceId })
}
