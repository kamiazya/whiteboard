/**
 * An ADAPTER does not reach for the process's data directory or the self-host
 * tenant: the composition root hands it a data layout.
 *
 * `getDataDir()` is a process global, and `SELF_HOST_TENANT_ID` is the one
 * tenant a self-hosted keeper has. A route that reads either decides, inside
 * itself, WHICH directory and WHICH tenant it serves — so a composition with a
 * different data dir or another tenant (a test, a second root, a keeper that
 * hosts several) cannot be expressed without rewriting the route, and the
 * default it fell back to is invisible to anything that builds the app.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  findAdapterGlobalReads,
  findCompositionGlobalReads,
} from './adapter-process-global-check.js'
import { REPO_ROOT } from './scan-roots.js'

const SERVER_DIR = join(REPO_ROOT, 'packages/mcp-server/src/server')
const SRC_DIR = join(REPO_ROOT, 'packages/mcp-server/src')

/**
 * Adapter-tree files that still read a process global, each with why it may.
 * Guarded from both sides, and its size is pinned: a new entry is a decision
 * somebody states, and a paid-off one has to come out.
 */
const STILL_READ_BY_ADAPTERS: Record<string, string> = {
  'mcp/index.ts -> getDataDir':
    'the stdio entry is a composition root with nobody above it to hand it a layout: it resolves the data dir once and boots its deps and its signing identity from it',
}
const LEDGER_SIZE = 1

const actual = findAdapterGlobalReads(SERVER_DIR)

describe('an adapter does not read the process data dir or the self-host tenant', () => {
  it('reports no read outside the ledger', () => {
    const unlisted = actual.filter((edge) => !(edge in STILL_READ_BY_ADAPTERS))
    expect(
      unlisted,
      'a route or MCP adapter reads a process global. Take the data layout the ' +
        'composition root passes (the dataLayout on createApp) instead of calling ' +
        'getDataDir() or naming SELF_HOST_TENANT_ID.',
    ).toEqual([])
  })

  it('lists no read the adapter has stopped making', () => {
    const found = new Set(actual)
    const stale = Object.keys(STILL_READ_BY_ADAPTERS).filter((edge) => !found.has(edge))
    expect(stale, 'delete these from the ledger: the read is gone').toEqual([])
  })

  it('pins the ledger at its size, so a paid-off entry lowers it and a new one is deliberate', () => {
    expect(Object.keys(STILL_READ_BY_ADAPTERS)).toHaveLength(LEDGER_SIZE)
  })

  it('gives every ledger entry a reason', () => {
    for (const reason of Object.values(STILL_READ_BY_ADAPTERS)) {
      expect(reason.length).toBeGreaterThan(30)
    }
  })

  it('scans the adapter population, so a clean result is not an empty walk', () => {
    expect(actual.length).toBeGreaterThan(0)
  })

  describe('the matcher', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'arch-lint-adapter-globals-'))
    afterAll(() => rmSync(fixture, { recursive: true, force: true }))

    mkdirSync(join(fixture, 'routes', 'document'), { recursive: true })
    mkdirSync(join(fixture, 'mcp'), { recursive: true })
    writeFileSync(
      join(fixture, 'routes', 'reads.ts'),
      [
        "import { getDataDir } from '../config.js'",
        "import { SELF_HOST_TENANT_ID } from '../tenant/id.js'",
        'export const where = () => join(getDataDir(), SELF_HOST_TENANT_ID)',
      ].join('\n'),
    )
    // Prose naming a global is not a read, and neither is a layout's own field.
    writeFileSync(
      join(fixture, 'routes', 'document', 'prose.ts'),
      [
        '// Walks getDataDir() with stat(); SELF_HOST_TENANT_ID is the tenant.',
        "export const note = 'getDataDir() is not called here'",
        'export const ok = (layout: { dataDir: string }) => layout.dataDir',
      ].join('\n'),
    )
    writeFileSync(join(fixture, 'routes', '_test-helper.ts'), 'export const x = getDataDir()\n')
    writeFileSync(join(fixture, 'routes', 'reads.test.ts'), 'export const y = getDataDir()\n')
    writeFileSync(join(fixture, 'mcp', 'tool.ts'), 'export const z = getDataDir()\n')

    it('names each read by file and global, and skips prose, tests and helpers', () => {
      expect(findAdapterGlobalReads(fixture)).toEqual([
        'mcp/tool.ts -> getDataDir',
        'routes/reads.ts -> SELF_HOST_TENANT_ID',
        'routes/reads.ts -> getDataDir',
      ])
    })
  })
})

/**
 * The layers that build stores take the directory and tenant they serve as an
 * argument too. `bootSelfHostDeps(dataDir)` builds the document store over the
 * dir it is given, and the seams beside it — live documents, versions,
 * teardown, the doc cache, file GC — used to read `getDataDir()` underneath, so
 * the two agreed only while the global happened to equal the argument.
 * Everything below is a read that remains, each with why it is the one place
 * allowed to make that choice.
 */
const STILL_READ_BY_COMPOSITION: Record<string, string> = {
  'di/container.ts -> globalStoreScope':
    "a container with no store module of its own binding (the in-memory one a test builds) has no directory, so its seams take the process's",
  'di/store-local.module.ts -> SELF_HOST_TENANT_ID':
    'createSelfHostStoreLocalModule is the one place the self-host tenant is chosen for the local stores',
  'store/backup-blob-mirror.ts -> SELF_HOST_TENANT_ID':
    "a manifest written before tenants existed records one tenant's blobs, and reads back as the self-host tenant's",
  'store/db/index.ts -> SELF_HOST_TENANT_ID':
    'the default tenant a database handle is bound to when the caller names none',
  'store/db/index.ts -> getDataDir':
    'the default of the handle functions, which every store reaches through a StoreScope that names its directory',
  'store/db/prepare.ts -> SELF_HOST_TENANT_ID':
    'moves a data dir written before tenants existed under the one tenant a self-host has',
  'store/store-scope.ts -> SELF_HOST_TENANT_ID':
    'the default tenant of a scope, and of the process scope',
  'store/store-scope.ts -> getDataDir':
    'the process scope: the one place the global is read for stores that have no composition above them',
}
const COMPOSITION_LEDGER_SIZE = 8

const composed = findCompositionGlobalReads(SRC_DIR)

describe('a layer that builds stores does not read the process data dir or tenant', () => {
  it('reports no read outside the ledger', () => {
    const unlisted = composed.filter((edge) => !(edge in STILL_READ_BY_COMPOSITION))
    expect(
      unlisted,
      'a store or a composition file reads a process global. Take the StoreScope ' +
        'the store module binds (server/store/store-scope.ts) instead of calling ' +
        'getDataDir() or naming SELF_HOST_TENANT_ID.',
    ).toEqual([])
  })

  it('lists no read that has stopped being made', () => {
    const found = new Set(composed)
    const stale = Object.keys(STILL_READ_BY_COMPOSITION).filter((edge) => !found.has(edge))
    expect(stale, 'delete these from the ledger: the read is gone').toEqual([])
  })

  it('pins the ledger at its size, so a paid-off entry lowers it and a new one is deliberate', () => {
    expect(Object.keys(STILL_READ_BY_COMPOSITION)).toHaveLength(COMPOSITION_LEDGER_SIZE)
  })

  it('gives every ledger entry a reason', () => {
    for (const reason of Object.values(STILL_READ_BY_COMPOSITION)) {
      expect(reason.length).toBeGreaterThan(30)
    }
  })

  it('scans both trees, so a clean result is not an empty walk', () => {
    expect(composed.some((edge) => edge.startsWith('di/'))).toBe(true)
    expect(composed.some((edge) => edge.startsWith('store/'))).toBe(true)
  })

  describe('the matcher', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'arch-lint-composition-globals-'))
    afterAll(() => rmSync(fixture, { recursive: true, force: true }))

    mkdirSync(join(fixture, 'di'), { recursive: true })
    mkdirSync(join(fixture, 'server', 'store', 'db', 'migrations'), { recursive: true })
    writeFileSync(
      join(fixture, 'di', 'wires.ts'),
      'export const seam = () => liveDocuments(globalStoreScope, getDataDir())\n',
    )
    // Inside store/, `globalStoreScope` is the layer's own default parameter.
    writeFileSync(
      join(fixture, 'server', 'store', 'reads.ts'),
      'export const f = (scope = globalStoreScope) => join(getDataDir(), SELF_HOST_TENANT_ID)\n',
    )
    writeFileSync(
      join(fixture, 'server', 'store', 'db', 'migrations', '0001.ts'),
      'export const old = getDataDir()\n',
    )
    writeFileSync(
      join(fixture, 'server', 'store', 'reads.test.ts'),
      'export const t = getDataDir()\n',
    )

    it('names each read by tree, file and global, and skips tests and migrations', () => {
      expect(findCompositionGlobalReads(fixture)).toEqual([
        'di/wires.ts -> getDataDir',
        'di/wires.ts -> globalStoreScope',
        'store/reads.ts -> SELF_HOST_TENANT_ID',
        'store/reads.ts -> getDataDir',
      ])
    })
  })
})
