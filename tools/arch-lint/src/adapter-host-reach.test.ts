/**
 * An adapter may not do a mechanic's job inline — the second half of ADR-0018.
 *
 * `adapter-mechanic-check` sees an adapter IMPORT a mechanic. A route that calls
 * `writeFile` or reads `process.env` itself has welded the operation to the
 * host just the same and imports nothing under `store/`, so that scan cannot
 * see it. This ledgers the disk, the operating system, child processes and the
 * environment in the adapter population, shrink-only, with a reason per file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findAdapterHostReach, hostReachOf } from './adapter-host-reach-check.js'
import { ADAPTER_HOST_REACH, ADAPTER_HOST_REACH_CEILING } from './adapter-reach.js'
import { ADAPTER_HELPER_FILES } from './architecture-map.js'
import { REPO_ROOT } from './scan-roots.js'

const SERVER_DIR = join(REPO_ROOT, 'packages/mcp-server/src/server')

const ledgered = Object.entries(ADAPTER_HOST_REACH)
  .flatMap(([file, { kinds }]) => kinds.map((kind) => `${file} -> ${kind}`))
  .sort()

describe('what counts as host reach', () => {
  const kindsOf = (source: string): string[] => [...hostReachOf('a.ts', source)].sort()

  it.each([
    ['node:fs', "import { writeFile } from 'node:fs/promises'\nexport const x = writeFile\n"],
    ['node:fs', "import { readFileSync } from 'node:fs'\nexport const x = readFileSync\n"],
    ['node:fs', "import { readFile } from 'fs/promises'\nexport const x = readFile\n"],
    ['node:os', "import { userInfo } from 'node:os'\nexport const x = userInfo\n"],
    ['node:child_process', "import { spawn } from 'node:child_process'\nexport const x = spawn\n"],
    ['process.env', 'export const x = process.env.WHITEBOARD_SECRET_THING\n'],
    ['process.env', "export const x = process.env['HOME']\n"],
    ['node:fs', "export const load = () => import('node:fs/promises')\n"],
  ])('finds %s', (kind, source) => {
    expect(kindsOf(source)).toEqual([kind])
  })

  it('leaves alone what is not the host: a type-only import and a pure builtin', () => {
    expect(
      kindsOf(
        [
          "import type { Stats } from 'node:fs'",
          "import { join } from 'node:path'",
          'export const x = join',
        ].join('\n'),
      ),
    ).toEqual([])
  })
})

describe('the finder reads the adapter population, on a fixture tree', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'arch-lint-host-reach-'))
  afterAll(() => rmSync(fixture, { recursive: true, force: true }))
  mkdirSync(join(fixture, 'routes'), { recursive: true })
  mkdirSync(join(fixture, 'mcp'), { recursive: true })
  mkdirSync(join(fixture, 'store'), { recursive: true })
  writeFileSync(
    join(fixture, 'routes', 'zz-d1.ts'),
    "import { writeFile, rm } from 'node:fs/promises'\nexport const d1 = [writeFile, rm]\n",
  )
  writeFileSync(
    join(fixture, 'routes', 'zz-d2.ts'),
    'export const d2 = process.env.WHITEBOARD_SECRET_THING\n',
  )
  writeFileSync(
    join(fixture, 'mcp', 'tool.ts'),
    "import { userInfo } from 'node:os'\nexport const t = userInfo\n",
  )
  writeFileSync(join(fixture, 'routes', 'zz.test.ts'), "import 'node:fs'\n")
  writeFileSync(join(fixture, 'routes', '_test-helper.ts'), "import 'node:fs'\n")
  // A mechanic is MEANT to touch the disk: only the adapter trees are judged.
  writeFileSync(join(fixture, 'store', 'disk.ts'), "import 'node:fs'\n")

  it('names a planted write and a planted environment read, and nothing else', () => {
    expect(findAdapterHostReach(fixture)).toEqual([
      'mcp/tool.ts -> node:os',
      'routes/zz-d1.ts -> node:fs',
      'routes/zz-d2.ts -> process.env',
    ])
  })
})

describe('the adapter host-reach ledger, over the real tree', () => {
  const actual = findAdapterHostReach(SERVER_DIR, ADAPTER_HELPER_FILES)

  it('reaches the adapter population', () => {
    expect(actual.length).toBeGreaterThan(10)
  })

  it('finds no reach outside the ledger', () => {
    expect(
      actual.filter((edge) => !ledgered.includes(edge)),
      'an adapter touches the disk, the OS, a child process or the environment itself. Give the ' +
        'operation a home behind a seam the root hands in — or list the file in ADAPTER_HOST_REACH ' +
        'with why it cannot move yet, and raise the ceiling in the same diff.',
    ).toEqual([])
  })

  it('lists no reach that is gone', () => {
    expect(
      ledgered.filter((edge) => !actual.includes(edge)),
      'delete the entry (or the kind) from ADAPTER_HOST_REACH and lower ADAPTER_HOST_REACH_CEILING',
    ).toEqual([])
  })

  it('holds the ledger at its declared ceiling', () => {
    expect(
      ledgered.length,
      ledgered.length > ADAPTER_HOST_REACH_CEILING
        ? 'a new adapter host reach was added: lift it behind a seam, or raise the ceiling on the record'
        : 'a reach was paid off — lower ADAPTER_HOST_REACH_CEILING to match',
    ).toBe(ADAPTER_HOST_REACH_CEILING)
  })

  it('gives every file a reason of substance and lists its kinds sorted and unrepeated', () => {
    for (const [file, { kinds, reason }] of Object.entries(ADAPTER_HOST_REACH)) {
      expect(reason.trim().split(/\s+/).length, `${file} needs a reason`).toBeGreaterThan(4)
      expect(kinds, `${file}'s kinds`).toEqual([...new Set(kinds)].sort())
    }
  })
})
