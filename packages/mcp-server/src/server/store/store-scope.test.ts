import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDataDirForTests, setDataDirForTests } from '../../shared/data-dir-secure.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'
import { clearDbCache, closeDb } from './db/index.js'
import { globalStoreScope, storeScope } from './store-scope.js'
import { _clearWorkspaceDocCacheForTests, getWorkspaceDoc } from './workspace-doc-cache.js'

let dir: string
let other: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-scope-'))
  other = await mkdtemp(join(tmpdir(), 'wb-scope-other-'))
})

afterEach(async () => {
  _clearWorkspaceDocCacheForTests()
  await closeDb(dir)
  await closeDb(other)
  clearDbCache()
  resetDataDirForTests()
  await rm(dir, { recursive: true, force: true })
  await rm(other, { recursive: true, force: true })
})

describe('a store scope', () => {
  it('names the directory and tenant it was built over, and lays files out under them', () => {
    const scope = storeScope(dir, 'tenant-two')

    expect(scope.dataDir).toBe(dir)
    expect(scope.layout.tenantId).toBe('tenant-two')
    expect(scope.layout.workspaceFilesDir('ws-1')).toBe(
      join(dir, 'tenants', 'tenant-two', 'workspaces', 'ws-1', 'files'),
    )
  })

  it('opens a migrated database over its own directory', async () => {
    const db = await storeScope(dir).db()

    expect(await db.selectFrom('workspaces').select('id').execute()).toEqual([])
    expect(await storeScope(dir).db()).toBe(db)
  })

  it('binds the database to its tenant, so two scopes over one directory cannot see each other', async () => {
    const mine = await storeScope(dir, SELF_HOST_TENANT_ID).db()
    const theirs = await storeScope(dir, 'tenant-two').db()
    await theirs
      .insertInto('memberProfiles')
      .values({
        id: 'p-two',
        displayName: 'Two',
        accountId: 'a-two',
        createdAt: 1,
        updatedAt: 1,
      })
      .execute()

    expect(await mine.selectFrom('memberProfiles').select('id').execute()).toEqual([])
    expect(await theirs.selectFrom('memberProfiles').select('id').execute()).toEqual([
      { id: 'p-two' },
    ])
  })

  it('keeps two directories apart', async () => {
    const [a, b] = [await storeScope(dir).db(), await storeScope(other).db()]
    await a
      .insertInto('memberProfiles')
      .values({
        id: 'p-a',
        displayName: 'A',
        accountId: 'a-a',
        createdAt: 1,
        updatedAt: 1,
      })
      .execute()

    expect(await b.selectFrom('memberProfiles').select('id').execute()).toEqual([])
  })
})

describe('the process scope', () => {
  it('follows the process data dir as it is redirected, rather than the one at load', () => {
    setDataDirForTests(dir)
    expect(globalStoreScope.dataDir).toBe(dir)
    expect(globalStoreScope.layout.dataDir).toBe(dir)

    setDataDirForTests(other)
    expect(globalStoreScope.dataDir).toBe(other)
    expect(globalStoreScope.layout.workspaceFilesDir('w')).toContain(other)
  })

  it('opens whichever database the process data dir names at the time', async () => {
    setDataDirForTests(dir)
    const first = await globalStoreScope.db()
    setDataDirForTests(other)
    const second = await globalStoreScope.db()

    expect(second).not.toBe(first)
  })
})

describe('the live workspace documents are cached per scope', () => {
  it('hands two scopes their own document for the same workspace id', async () => {
    const [a, b] = [storeScope(dir), storeScope(other)]

    const docA = await getWorkspaceDoc('ws-1', a)
    const docB = await getWorkspaceDoc('ws-1', b)

    expect(docA).not.toBe(docB)
    expect(await getWorkspaceDoc('ws-1', a)).toBe(docA)
    expect(await getWorkspaceDoc('ws-1', b)).toBe(docB)
  })
})
