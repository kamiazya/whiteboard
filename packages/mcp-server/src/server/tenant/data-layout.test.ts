import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PENDING_WRITES_DIRNAME } from '../atomic-write.js'
import { FsBlobStore } from '../store/fs/fs-blob-store.js'
import {
  blobShardDir,
  blobShardPath,
  blobsRoot,
  isAnyTenantBlobsPath,
  isBlobShardName,
  listTenants,
  parseBlobShard,
  retiredLayoutEntries,
  storeAreaOf,
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

describe('a tenant own files, beside its blobs', () => {
  it('keeps one tenant origin-keyed files out of another', () => {
    expect(tenantRoot(dataDir, SELF)).not.toBe(tenantRoot(dataDir, OTHER))
  })
})

describe('a data directory in a layout this build no longer reads', () => {
  it('names the flat blob store, a flat workspace files directory and the retired trust store', async () => {
    await mkdir(join(dataDir, 'blobs', 'ab'), { recursive: true })
    await writeFile(join(dataDir, 'blobs', 'ab', 'cdef'), 'blob-bytes')
    await mkdir(join(dataDir, 'ws-1', 'files'), { recursive: true })
    await writeFile(join(dataDir, 'trusted-web-origins.json'), '{}')
    await mkdir(join(dataDir, 'trusted-web-origins.lock'))

    expect(await retiredLayoutEntries(dataDir)).toEqual([
      'blobs',
      'trusted-web-origins.json',
      'trusted-web-origins.lock',
      join('ws-1', 'files'),
    ])
    // Found, never moved or removed: the caller refuses, and the person decides.
    expect(await readdir(join(dataDir, 'blobs', 'ab'))).toEqual(['cdef'])
    expect(await readdir(join(dataDir, 'ws-1'))).toEqual(['files'])
  })

  it('finds nothing in the current layout, beside the keeper own files and an export', async () => {
    await mkdir(join(dataDir, 'tenants', SELF, 'blobs', 'ab'), { recursive: true })
    await mkdir(workspaceFilesDir(dataDir, SELF, 'ws-1'), { recursive: true })
    await mkdir(join(dataDir, 'ws-1', 'exports'), { recursive: true })
    await writeFile(join(dataDir, 'whiteboard.db'), 'db')
    await mkdir(join(dataDir, 'models', 'files'), { recursive: true })
    await mkdir(join(dataDir, PENDING_WRITES_DIRNAME, 'files'), { recursive: true })

    expect(await retiredLayoutEntries(dataDir)).toEqual([])
  })

  it('finds nothing in a data directory that does not exist yet', async () => {
    expect(await retiredLayoutEntries(join(dataDir, 'not-yet'))).toEqual([])
  })
})

describe('what a keeper-wide pass has to walk', () => {
  it('lists the tenants on disk, and nothing when there are none', async () => {
    expect(await listTenants(dataDir)).toEqual([])
    await mkdir(blobsRoot(dataDir, SELF), { recursive: true })
    await mkdir(blobsRoot(dataDir, OTHER), { recursive: true })
    expect((await listTenants(dataDir)).sort()).toEqual([SELF, OTHER].sort())
  })

  it('knows any tenant blob path, which a backup mirrors rather than copies', () => {
    expect(isAnyTenantBlobsPath(dataDir, join(blobsRoot(dataDir, OTHER), 'ab', 'cd'))).toBe(true)
    // The root itself too: the copy skips the whole directory, not its files.
    expect(isAnyTenantBlobsPath(dataDir, blobsRoot(dataDir, SELF))).toBe(true)
    expect(
      isAnyTenantBlobsPath(dataDir, join(workspaceFilesDir(dataDir, SELF, 'ws-1'), 'a.png')),
    ).toBe(false)
  })

  it('does not take a sibling that only shares the tenants directory name prefix', () => {
    expect(isAnyTenantBlobsPath(dataDir, join(dataDir, 'tenants-old', SELF, 'blobs', 'ab'))).toBe(
      false,
    )
    expect(isAnyTenantBlobsPath(dataDir, join(dataDir, 'tenants-old', 'blobs', 'ab'))).toBe(false)
  })

  it('does not count a stray file under tenants/ as a tenant', async () => {
    await mkdir(blobsRoot(dataDir, SELF), { recursive: true })
    await writeFile(join(dataDir, 'tenants', '.DS_Store'), 'x')
    expect(await listTenants(dataDir)).toEqual([SELF])
  })
})

describe('which store a path under the data directory is in', () => {
  const area = (...parts: string[]) => storeAreaOf(dataDir, join(dataDir, ...parts))

  it('names the blob store, a workspace files directory and an exports directory', () => {
    expect(area('tenants', SELF, 'blobs', 'ab', 'cd')).toBe('blobs')
    expect(area('tenants', SELF, 'workspaces', 'ws-1', 'files', 'a.png')).toBe('files')
    expect(area('ws-1', 'exports', 'out.svg')).toBe('exports')
  })

  it('answers null for everything else, including what sits beside a workspace files directory', () => {
    expect(area('whiteboard.db')).toBeNull()
    expect(area('fonts', 'a.woff2')).toBeNull()
    expect(area('tenants', SELF, 'workspaces', 'ws-1')).toBeNull()
    expect(area('tenants', SELF, 'workspaces', 'ws-1', 'notes', 'a.txt')).toBeNull()
    expect(area('tenants', SELF, 'something-else')).toBeNull()
  })
})

describe('where a content digest sits under a blob root', () => {
  const digest = `ab${'0'.repeat(62)}`

  it('shards on the first two hex characters and names the file by the other sixty-two', () => {
    expect(blobShardDir('/root', digest)).toBe(join('/root', 'ab'))
    expect(blobShardPath('/root', digest)).toBe(join('/root', 'ab', '0'.repeat(62)))
  })

  it('reads back as the digest it was written from', () => {
    const [shard, entry] = [digest.slice(0, 2), digest.slice(2)]
    expect(parseBlobShard(shard, entry)).toBe(digest)
  })

  it('takes exactly two lowercase hex characters as a shard name', () => {
    expect(isBlobShardName('ab')).toBe(true)
    for (const name of ['', 'a', 'abc', 'AB', 'zz', 'a-']) expect(isBlobShardName(name)).toBe(false)
  })

  it('refuses anything not named as a shard wrote it', () => {
    expect(parseBlobShard('ab', `${'0'.repeat(62)}.partial`)).toBeNull()
    expect(parseBlobShard('ab', '0'.repeat(61))).toBeNull()
    expect(parseBlobShard('AB', '0'.repeat(62))).toBeNull()
    expect(parseBlobShard('abc', '0'.repeat(62))).toBeNull()
  })

  it('is where FsBlobStore puts a blob, so a mirror and a restore read what the store wrote', async () => {
    const root = blobsRoot(dataDir, SELF)
    const { ref } = await new FsBlobStore(root, dataDir).put({ bytes: new Uint8Array([1, 2, 3]) })
    const shards = await readdir(root)
    expect(shards).toEqual([ref.digestHex.slice(0, 2)])
    expect(await readdir(blobShardDir(root, ref.digestHex))).toEqual([ref.digestHex.slice(2)])
    expect((await stat(blobShardPath(root, ref.digestHex))).isFile()).toBe(true)
  })
})
