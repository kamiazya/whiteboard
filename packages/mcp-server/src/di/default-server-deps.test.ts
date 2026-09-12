import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from '../server/routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-default-deps-')

vi.mock('../server/config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { getDefaultServerDeps } = await import('./default-server-deps.js')
const { getDoc, saveDocument, _clearWorkspaceDocCacheForTests } = await import(
  '../server/store/document-store.js'
)
const { clearCache } = await import('../server/store/doc-cache.js')
const { createDaemonIdentity } = await import('../server/security/daemon-identity.js')

/**
 * The seam an MCP tool saves a version through. A tool names no operator —
 * "unnamed here always means the agent" — so what the row records is
 * whatever the composition root stamped, and until this wiring existed that
 * was a nanoid minted per process: two rows this daemon saved either side of
 * a restart claimed different agents. ADR-0035 decision 2 says a stored row
 * names the DEVICE.
 */
describe('the ServerDeps a route falls back to', () => {
  it('stamps an unnamed agent save with this daemon’s did:key', async () => {
    clearCache()
    _clearWorkspaceDocCacheForTests()
    await mkdir(join(tmp.dir, 'ws1'), { recursive: true })
    await saveDocument('ws1', 'canvas-a', new LoroDoc(), { kind: 'spatial' })

    const deps = await getDefaultServerDeps()
    const entry = await deps.versions.save('ws1', 'canvas-a', await getDoc('ws1', 'canvas-a'), {
      auto: false,
      label: 'by an agent',
    })

    // Read back off the identity file rather than pinned: what matters is
    // that the row names the key the daemon proves itself with, not any
    // particular value.
    expect(entry.operator).toMatchObject({
      kind: 'ai',
      actor: createDaemonIdentity({ dataDir: tmp.dir }).did,
    })
    expect(entry.operator?.actor).toMatch(/^did:key:z6Mk/)
  })
})
