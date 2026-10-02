/**
 * Whether a refusal for an unknown workspace may name the ones that exist is
 * a decision of the root that boots the deps: the stdio entry and the local
 * daemon opt in, and server mode never does, because there the refusal is
 * uniform so that it says nothing about which workspaces exist.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wbDocumentList } from '@kamiazya/whiteboard-server-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { disposeAutoCompact, uninstallAutoCompact } from '../server/store/auto-compact.js'
import { clearDbCacheForTests, closeDb } from '../server/store/db/index.js'
import { clearDocCacheForTests } from '../server/store/doc-cache.js'
import { _clearWorkspaceDocCacheForTests } from '../server/store/workspace-doc-cache.js'
import { resetDataDirForTests, setDataDirForTests } from '../shared/data-dir-secure.js'
import { bootSelfHostDeps } from './boot-self-host-deps.js'

let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-known-ws-'))
  setDataDirForTests(dataDir)
})

afterEach(async () => {
  uninstallAutoCompact()
  await disposeAutoCompact()
  clearDocCacheForTests()
  _clearWorkspaceDocCacheForTests()
  await closeDb(dataDir)
  clearDbCacheForTests()
  resetDataDirForTests()
  await rm(dataDir, { recursive: true, force: true })
})

describe('bootSelfHostDeps and the workspaces a refusal may name', () => {
  it('names none by default, so the server-mode refusal stays uniform', async () => {
    const { serverDeps } = await bootSelfHostDeps(dataDir)
    expect(serverDeps.knownWorkspaceHandles).toBeUndefined()
    const refusal = await wbDocumentList(serverDeps, { workspaceId: 'main' }).catch(
      (err: Error) => err,
    )
    expect((refusal as Error).message).toContain('Workspace not found')
    expect((refusal as Error).message).not.toContain('default')
  })

  it("names the fresh directory's workspace by its segment when the root opts in", async () => {
    const { serverDeps } = await bootSelfHostDeps(dataDir, { nameKnownWorkspaces: true })
    expect(await serverDeps.knownWorkspaceHandles?.()).toEqual(['default'])
    await expect(wbDocumentList(serverDeps, { workspaceId: 'main' })).rejects.toThrow(
      /Workspaces here: "default"/,
    )
  })
})
