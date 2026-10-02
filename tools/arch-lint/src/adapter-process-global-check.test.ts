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
  adapterFiles,
  findAdapterGlobalReads,
  findAdapterScopeDefaults,
  findCompositionGlobalReads,
} from './adapter-process-global-check.js'
import { REPO_ROOT } from './scan-roots.js'
import { scopeDefaultingExports } from './scope-default-calls.js'

const SERVER_DIR = join(REPO_ROOT, 'packages/mcp-server/src/server')
const SRC_DIR = join(REPO_ROOT, 'packages/mcp-server/src')

/**
 * Adapter-tree files that still read a process global, each with why it may.
 * Guarded from both sides, and its size is pinned: a new entry is a decision
 * somebody states, and a paid-off one has to come out.
 */
const STILL_READ_BY_ADAPTERS: Record<string, string> = {}
const LEDGER_SIZE = 0

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
    // With the ledger empty the finding itself proves nothing was read, so the
    // walk is what is asserted: the routes, the MCP registrations, the export
    // and search helpers and the top-level files that pass a directory on.
    expect(adapterFiles(SERVER_DIR).length).toBeGreaterThan(50)
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
    // The population is wider than the routes and the MCP tools: the helpers
    // they reach for, and the top-level files that hand a directory on.
    mkdirSync(join(fixture, 'export'), { recursive: true })
    mkdirSync(join(fixture, 'search'), { recursive: true })
    writeFileSync(join(fixture, 'export', 'fonts.ts'), 'export const f = () => getDataDir()\n')
    writeFileSync(join(fixture, 'search', 'model.ts'), 'export const m = () => getDataDir()\n')
    writeFileSync(
      join(fixture, 'shared-background-work.ts'),
      'export const b = () => ({ dataDir: getDataDir() })\n',
    )
    writeFileSync(join(fixture, 'app.ts'), 'export const a = SELF_HOST_TENANT_ID\n')
    // A root chooses the directory once; that is what a root is for.
    writeFileSync(join(fixture, 'http-server.ts'), 'export const r = getDataDir()\n')

    it('names each read by file and global, and skips prose, tests, helpers and roots', () => {
      expect(findAdapterGlobalReads(fixture)).toEqual([
        'app.ts -> SELF_HOST_TENANT_ID',
        'export/fonts.ts -> getDataDir',
        'mcp/tool.ts -> getDataDir',
        'routes/reads.ts -> SELF_HOST_TENANT_ID',
        'routes/reads.ts -> getDataDir',
        'search/model.ts -> getDataDir',
        'shared-background-work.ts -> getDataDir',
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

/**
 * `getDataDir(` is matched by NAME, so the process directory also reaches an
 * adapter through a default parameter it never spells: `new FileVersionStore()`
 * and `getDoc(workspaceId, path)` each decide which directory in the callee.
 * That is how a version list answered `[]` for a served directory the deps
 * were booted over, and how the backup copied the process's directory while
 * the routes served another.
 *
 * What is ledgered is what the population still calls without a scope, each
 * with why.
 */
const STILL_DEFAULTED_BY_ADAPTERS: Record<string, string> = {
  'app.ts -> storeScope':
    'createApp derives the scope every router is handed from the layout its root booted the deps over, once; this is the one place an adapter-layer file builds one',
  'workspace-handle.ts -> workspaceRegistry':
    'a handle is resolved against the process registry for nine routes, the membership gate, the sync stream and the people routes, none of which is handed the registry; threading it through the path-route helpers and the security middleware is its own increment',
}
const DEFAULTED_LEDGER_SIZE = 2

const defaulted = findAdapterScopeDefaults(SRC_DIR)

describe('an adapter or a root passes the scope it serves to a store that defaults to the process', () => {
  it('reports no call outside the ledger', () => {
    const unlisted = defaulted.filter((edge) => !(edge in STILL_DEFAULTED_BY_ADAPTERS))
    expect(
      unlisted,
      'a call leaves the data directory to the store export default (the process ' +
        'global). Pass the StoreScope createApp / bootSelfHostDeps hands down, or ' +
        'take one as a parameter.',
    ).toEqual([])
  })

  it('lists no call that has stopped being made', () => {
    const found = new Set(defaulted)
    const stale = Object.keys(STILL_DEFAULTED_BY_ADAPTERS).filter((edge) => !found.has(edge))
    expect(stale, 'delete these from the ledger: the call now passes a scope').toEqual([])
  })

  it('pins the ledger at its size, so a paid-off entry lowers it and a new one is deliberate', () => {
    expect(Object.keys(STILL_DEFAULTED_BY_ADAPTERS)).toHaveLength(DEFAULTED_LEDGER_SIZE)
  })

  it('gives every ledger entry a reason', () => {
    for (const reason of Object.values(STILL_DEFAULTED_BY_ADAPTERS)) {
      expect(reason.length).toBeGreaterThan(30)
    }
  })

  it('derives the defaulting exports from the store, and finds the ones this was written for', () => {
    const exports = scopeDefaultingExports(SRC_DIR)
    // The subject is PRESENT: a derivation that matched nothing would pass
    // every assertion above by finding no export to call.
    expect(exports.size).toBeGreaterThan(30)
    for (const name of [
      'FileVersionStore',
      'workspaceRegistry',
      'getDoc',
      'listDocuments',
      'loadWorkspaceNames',
      'purgeDanglingFiles',
      'createFileGcSweeper',
      'installAutoCompact',
    ]) {
      expect(exports.has(name), name).toBe(true)
    }
    expect(exports.get('getDoc')).toEqual({ kind: 'parameter', index: 2 })
    expect(exports.get('purgeDanglingFiles')).toEqual({ kind: 'options', index: 1 })
  })

  describe('the matcher', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'arch-lint-scope-defaults-'))
    afterAll(() => rmSync(fixture, { recursive: true, force: true }))

    mkdirSync(join(fixture, 'server', 'store'), { recursive: true })
    mkdirSync(join(fixture, 'server', 'routes'), { recursive: true })
    mkdirSync(join(fixture, 'server', 'export'), { recursive: true })
    writeFileSync(
      join(fixture, 'server', 'store', 'things.ts'),
      [
        "import { globalStoreScope, type StoreScope } from './store-scope.js'",
        'export async function getThing(id: string, scope: StoreScope = globalStoreScope) {}',
        'export const listThings = async (scope: StoreScope = globalStoreScope) => []',
        'export class ThingStore {',
        '  constructor(private readonly scope: StoreScope = globalStoreScope) {}',
        '}',
        'export function sweep(id: string, options: { scope?: StoreScope } = {}) {',
        '  const scope = options.scope ?? globalStoreScope',
        '}',
        // Not defaulting: takes a scope it must be given, or takes none.
        'export function required(id: string, scope: StoreScope) {}',
        'export function unrelated(id: string) {}',
        // Not exported, so no other file can call it.
        'function hidden(scope: StoreScope = globalStoreScope) {}',
      ].join('\n'),
    )
    // A test next to the store is not derived from either.
    writeFileSync(
      join(fixture, 'server', 'store', 'things.test.ts'),
      'export function testOnly(scope: StoreScope = globalStoreScope) {}\n',
    )
    writeFileSync(
      join(fixture, 'server', 'routes', 'omits.ts'),
      [
        "import { getThing, listThings, ThingStore, sweep } from '../store/things.js'",
        'export async function a(id: string) {',
        '  await getThing(id)',
        '  await listThings()',
        '  return new ThingStore()',
        '}',
        'export const b = () => sweep("x", {})',
        // `undefined` is the omission written out.
        'export const c = () => getThing("x", undefined)',
        // Called through a fallback: `(factory ?? sweep)(...)` is still a call.
        'export const d = (factory?: typeof sweep) => (factory ?? sweep)("x")',
      ].join('\n'),
    )
    writeFileSync(
      join(fixture, 'server', 'routes', 'passes.ts'),
      [
        "import { getThing, listThings, ThingStore, sweep, required, unrelated } from '../store/things.js'",
        'export async function a(id: string, scope: StoreScope, options: object) {',
        '  await getThing(id, scope)',
        '  await listThings(scope)',
        '  required(id)',
        '  unrelated(id)',
        '  sweep(id, { scope })',
        '  sweep(id, { ...options })',
        '  sweep(id, options)',
        '  getThing(...[id, scope])',
        '  return new ThingStore(scope)',
        '}',
        // A type query names the function without running it.
        'export type F = typeof getThing',
      ].join('\n'),
    )
    // A local function of the same name is not the store's: nothing imports it.
    writeFileSync(
      join(fixture, 'server', 'routes', 'local.ts'),
      'function listThings() {}\nexport const l = () => listThings()\n',
    )
    writeFileSync(
      join(fixture, 'server', 'routes', 'reference.ts'),
      [
        "import { getThing } from '../store/things.js'",
        // Handed on by reference: the call that picks the directory is elsewhere.
        'export const handler = { load: getThing }',
      ].join('\n'),
    )
    writeFileSync(
      join(fixture, 'server', 'routes', 'prose.ts'),
      [
        "import { getThing } from '../store/things.js'",
        '// getThing(id) is described here and not called; so is "listThings()".',
        'export const note = "getThing(id)"',
      ].join('\n'),
    )
    writeFileSync(
      join(fixture, 'server', 'export', 'headless.ts'),
      "import { getThing as read } from '../store/things.js'\nexport const f = () => read('x')\n",
    )
    writeFileSync(
      join(fixture, 'server', 'app.ts'),
      "import { ThingStore } from './store/things.js'\nexport const store = new ThingStore()\n",
    )
    // Building a scope in an adapter-layer file is choosing the directory too.
    writeFileSync(
      join(fixture, 'server', 'routes', 'builds.ts'),
      [
        "import { storeScope } from '../store/store-scope.js'",
        'export const build = (dir: string) => storeScope(dir)',
      ].join('\n'),
    )
    writeFileSync(
      join(fixture, 'server', 'shared-background-work.ts'),
      [
        "import { globalStoreScope } from './store/store-scope.js'",
        'export const stdio = (scope = globalStoreScope) => scope',
        // A type position names nothing at run time.
        'export type S = typeof globalStoreScope',
      ].join('\n'),
    )

    it('derives the defaulting exports, parameter and options shapes both, and only exported ones', () => {
      expect([...scopeDefaultingExports(fixture)]).toEqual([
        ['getThing', { kind: 'parameter', index: 1 }],
        ['listThings', { kind: 'parameter', index: 0 }],
        ['ThingStore', { kind: 'parameter', index: 0 }],
        ['sweep', { kind: 'options', index: 1 }],
      ])
    })

    it('names each call that leaves the directory to the default, and nothing that passes one', () => {
      expect(findAdapterScopeDefaults(fixture)).toEqual([
        'app.ts -> ThingStore',
        'export/headless.ts -> getThing',
        'routes/builds.ts -> storeScope',
        'routes/omits.ts -> ThingStore',
        'routes/omits.ts -> getThing',
        'routes/omits.ts -> listThings',
        'routes/omits.ts -> sweep',
        'routes/reference.ts -> getThing (by reference)',
        'shared-background-work.ts -> globalStoreScope',
      ])
    })
  })
})
