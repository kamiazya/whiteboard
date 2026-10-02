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
import { findAdapterGlobalReads } from './adapter-process-global-check.js'
import { REPO_ROOT } from './scan-roots.js'

const SERVER_DIR = join(REPO_ROOT, 'packages/mcp-server/src/server')

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
