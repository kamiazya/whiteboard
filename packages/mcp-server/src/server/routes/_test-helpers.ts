import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ServerDeps, wbDocumentCreate } from '@kamiazya/whiteboard-server-core'
import { afterEach, beforeEach } from 'vitest'
import { getDataDir } from '../config.js'
import { type StoreScope, storeScope } from '../store/store-scope.js'
import { FileVersionStore, type VersionStore } from '../store/version-store.js'
import { createDataLayout } from '../tenant/data-layout.js'
import type { DataLayout } from '../tenant/data-layout-seam.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'
import type { DocumentRouterOptions } from './document.js'

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
  const deps = await resolveTestServerDeps(dataDir)
  await deps.documentIndex.createWorkspace({ workspaceId })
}

/**
 * The production wiring over a test's data dir, for a test that drives a
 * router or a store directly rather than through `createApp`. The same
 * resolve the roots make — `prepareDataDir` first, as the daemon does at
 * boot, so a test that reaches a route before anything migrated the dir
 * does not meet a missing table. Dynamic imports, since the data-dir
 * config is `vi.mock`ed per file and must be in place before the store
 * module loads.
 *
 * Routers require their deps and never compose their own: a fallback would be
 * a second composition path in production. What a TEST needs is this.
 */
export async function resolveTestServerDeps(dataDir: string): Promise<ServerDeps> {
  const { getDb } = await import('../store/db/index.js')
  const { prepareDataDir } = await import('../store/db/prepare.js')
  const { resolveSelfHostServerDeps } = await import('../../di/self-host-server-deps.js')
  await prepareDataDir(dataDir)
  return resolveSelfHostServerDeps(await getDb(dataDir), dataDir)
}

/**
 * Creates a document through the operation every surface shares, the way a
 * fixture that has no HTTP route to bootstrap with needs to: the workspace is
 * minted under the handle given when it does not exist yet, exactly as a
 * create with `createWorkspace: true` does (ADR-0019's mint boundary).
 */
export async function createTestDocument(
  deps: ServerDeps,
  input: { workspaceId: string; path: string; kind?: 'spatial' | 'markdown'; name?: string },
): Promise<void> {
  await wbDocumentCreate(deps, {
    workspaceId: input.workspaceId,
    path: input.path,
    kind: input.kind ?? 'spatial',
    createWorkspace: true,
    ...(input.name === undefined ? {} : { name: input.name }),
  })
}

/**
 * The data layout a root hands `createApp`, over `dataDir` or, by default, the
 * data dir the test's own setup redirected the process to.
 */
export function testDataLayout(dataDir: string = getDataDir()): DataLayout {
  return createDataLayout(dataDir, SELF_HOST_TENANT_ID)
}

/** The scope a router test hands a router: the data dir the test mocked, as production's root would. */
export function testStoreScope(dataDir: string = getDataDir()): StoreScope {
  return storeScope(dataDir, SELF_HOST_TENANT_ID)
}

/**
 * The options `createDocumentRouter` takes, over the mocked data dir's scope
 * and the version store the root would build over it, unless a test supplies
 * its own. The router requires both, so a test cannot get a second
 * composition path by omitting one.
 */
export function testDocumentRouterOptions(
  options: Omit<DocumentRouterOptions, 'scope' | 'versionStore'> & {
    scope?: StoreScope
    versionStore?: VersionStore
  },
): DocumentRouterOptions {
  const scope = options.scope ?? testStoreScope()
  return { ...options, scope, versionStore: options.versionStore ?? new FileVersionStore(scope) }
}
