/**
 * A blob — a trashed document's snapshot among them — is held to the
 * database's modes: a 0600 file in 0700 directories, rather than whatever
 * the umask leaves, which on a host bind mount is readable by every host
 * user.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256Hex } from '../../../shared/sha256.js'
import { CHMOD_IS_OBSERVABLE } from '../../../shared/test-utils/chmod-is-observable.js'
import { blobShardDir, blobShardPath, blobsRoot } from '../../tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../../tenant/id.js'
import { FsBlobStore } from './fs-blob-store.js'

const modeOf = async (path: string): Promise<string> =>
  ((await stat(path)).mode & 0o777).toString(8)

describe('the modes FsBlobStore writes with', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'fs-blob-modes-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it.skipIf(!CHMOD_IS_OBSERVABLE)('writes a shard file 0600 under 0700 directories', async () => {
    const root = blobsRoot(dataDir, SELF_HOST_TENANT_ID)
    const bytes = new TextEncoder().encode('trashed snapshot')
    const store = new FsBlobStore(root, dataDir)

    const { ref } = await store.put({ bytes })
    expect(ref.digestHex).toBe(sha256Hex(bytes))

    expect(await modeOf(blobShardPath(root, ref.digestHex))).toBe('600')
    expect(await modeOf(blobShardDir(root, ref.digestHex))).toBe('700')
    expect(await modeOf(root)).toBe('700')
  })
})
