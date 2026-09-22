import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsBlobStore } from '../store/fs/fs-blob-store.js'
import {
  blobsRoot,
  moveLegacyDataDirUnderTenant,
  tenantRoot,
  workspaceFilesDir,
} from './data-layout.js'

const OTHER = 'tenant-two'
const SELF = 'self-host'

let dataDir: string
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-data-layout-'))
})
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

describe('where a tenant keeps its files', () => {
  it('puts a workspace under workspaces/, so a workspace named blobs is not the blob root', () => {
    expect(workspaceFilesDir(dataDir, SELF, 'blobs')).toBe(
      join(dataDir, 'tenants', SELF, 'workspaces', 'blobs', 'files'),
    )
    expect(blobsRoot(dataDir, SELF)).toBe(join(dataDir, 'tenants', SELF, 'blobs'))
    expect(workspaceFilesDir(dataDir, SELF, 'blobs')).not.toContain(
      `${join('tenants', SELF, 'blobs')}${'/'}files`,
    )
  })

  it('keeps one tenant out of another tenant root', () => {
    expect(tenantRoot(dataDir, SELF)).not.toBe(tenantRoot(dataDir, OTHER))
    expect(blobsRoot(dataDir, OTHER).startsWith(tenantRoot(dataDir, OTHER))).toBe(true)
  })
})

describe('the blob store under a tenant', () => {
  it('does not answer one tenant with another tenant bytes at the same digest', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4])
    const mine = new FsBlobStore(blobsRoot(dataDir, SELF), dataDir)
    const theirs = new FsBlobStore(blobsRoot(dataDir, OTHER), dataDir)
    const { ref } = await mine.put({ bytes, contentType: 'image/png' })

    // Same content, so the same digest: a shared store would answer here.
    expect(await theirs.has({ ref })).toEqual({ exists: false })
    expect(await theirs.get({ ref })).toBeNull()
    expect((await mine.get({ ref }))?.bytes).toEqual(bytes)

    // And deleting it in one tenant leaves the other alone.
    await theirs.put({ bytes, contentType: 'image/png' })
    await theirs.delete({ ref })
    expect(await mine.has({ ref })).toEqual({ exists: true })
  })
})

describe('moving a data directory written before tenants existed', () => {
  async function seedLegacy(): Promise<void> {
    await mkdir(join(dataDir, 'blobs', 'ab'), { recursive: true })
    await writeFile(join(dataDir, 'blobs', 'ab', 'cdef'), 'blob-bytes')
    await mkdir(join(dataDir, 'ws-1', 'files'), { recursive: true })
    await writeFile(join(dataDir, 'ws-1', 'files', 'a.png'), 'file-bytes')
    // Keeper-wide neighbours that must NOT move.
    await writeFile(join(dataDir, 'whiteboard.db'), 'db')
    await writeFile(join(dataDir, 'daemon-identity.json'), '{}')
    await mkdir(join(dataDir, 'models'), { recursive: true })
  }

  it('moves blobs and workspace files under the tenant, and leaves the keeper own files', async () => {
    await seedLegacy()
    const moved = await moveLegacyDataDirUnderTenant(dataDir, SELF)
    expect(moved).toEqual({ blobs: true, workspaces: ['ws-1'] })
    expect(await readdir(join(dataDir, 'tenants', SELF, 'blobs', 'ab'))).toEqual(['cdef'])
    expect(await readdir(workspaceFilesDir(dataDir, SELF, 'ws-1'))).toEqual(['a.png'])
    expect((await readdir(dataDir)).sort()).toEqual([
      'daemon-identity.json',
      'models',
      'tenants',
      'whiteboard.db',
    ])
  })

  it('is a no-op the second time, so a restart does not move a live tenant back', async () => {
    await seedLegacy()
    await moveLegacyDataDirUnderTenant(dataDir, SELF)
    expect(await moveLegacyDataDirUnderTenant(dataDir, SELF)).toEqual({
      blobs: false,
      workspaces: [],
    })
    expect(await readdir(join(dataDir, 'tenants', SELF, 'blobs', 'ab'))).toEqual(['cdef'])
  })

  it('leaves a legacy workspace dir alone when the tenant already holds that workspace', async () => {
    await seedLegacy()
    await mkdir(workspaceFilesDir(dataDir, SELF, 'ws-1'), { recursive: true })
    await writeFile(join(workspaceFilesDir(dataDir, SELF, 'ws-1'), 'kept.png'), 'newer')
    const moved = await moveLegacyDataDirUnderTenant(dataDir, SELF)
    expect(moved.workspaces).toEqual([])
    // The tenant's own copy stands, and the legacy directory is still there to
    // look at rather than merged blindly.
    expect(await readdir(workspaceFilesDir(dataDir, SELF, 'ws-1'))).toEqual(['kept.png'])
    expect(await readdir(join(dataDir, 'ws-1', 'files'))).toEqual(['a.png'])
  })
})
