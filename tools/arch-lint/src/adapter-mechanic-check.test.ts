import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

import { findAdapterMechanicEdges } from './adapter-mechanic-check.js'
import {
  ADAPTER_SCAN_EXEMPT_FILES,
  ADAPTERS_REACHING_MECHANICS,
  ADAPTERS_REACHING_MECHANICS_CEILING,
  MECHANICS_NOT_SCANNED,
} from './architecture-map.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SERVER_DIR = join(REPO_ROOT, 'packages/mcp-server/src/server')

const actual = findAdapterMechanicEdges(
  SERVER_DIR,
  MECHANICS_NOT_SCANNED,
  ADAPTER_SCAN_EXEMPT_FILES,
)

describe('ADR-0018: an adapter may not reach a mechanic directly', () => {
  // A route or an MCP tool registration that imports a mechanic has nowhere
  // to put the operation it is performing except inside itself, so the next
  // surface needing that operation writes it again. Every divergence
  // ADR-0018 records began that way — an agent delete that left thumbnails
  // behind, an agent write that never compacted.
  it('reports no adapter -> mechanic edge outside the allowlist', () => {
    const allowed = new Set(ADAPTERS_REACHING_MECHANICS)
    const unlisted = actual.filter((edge) => !allowed.has(edge))

    expect(
      unlisted,
      'a new adapter reached a mechanic directly. Give the operation a home in ' +
        'server-core (a use case over ports and seams) and call that instead — ' +
        'or, if it is genuinely this deployment telling itself something, name a ' +
        'seam on ServerDeps the way documentTeardown and documentWritten do.',
    ).toEqual([])
  })

  // Guarded from both sides, so an entry cannot outlive its debt. Note this
  // is NOT what keeps the list shrinking — that is the ceiling below, and the
  // comment here claimed otherwise for as long as the claim was false.
  it('every allowlist entry is still a real edge', () => {
    const found = new Set(actual)
    const stale = ADAPTERS_REACHING_MECHANICS.filter((edge) => !found.has(edge))

    expect(
      stale,
      'these edges are gone — delete them from ADAPTERS_REACHING_MECHANICS. ' +
        'An entry that outlives its debt is how an allowlist stops being read.',
    ).toEqual([])
  })

  // The scan reaching nothing would make both assertions above pass while
  // checking nothing at all — the failure mode this repo has been bitten by
  // more than once.
  // The ratchet. The two assertions above stop a fabricated entry and a stale
  // one, and neither has anything to say about the ordinary way this list
  // grows: a real new adapter -> mechanic edge added together with its
  // allowlist line. Measured before this existed — a genuine
  // `routes/export.ts -> backup-in-progress` import, duly listed, passed all
  // six assertions, and the list had gone 35 -> 40 in a week under two
  // comments asserting it could only shrink.
  //
  // Equality rather than an upper bound, so paying debt off is also a failure
  // until the number comes down with it. A ceiling nobody lowers stops
  // recording progress and turns into a budget.
  it('holds the allowlist at its declared ceiling', () => {
    expect(
      ADAPTERS_REACHING_MECHANICS.length,
      ADAPTERS_REACHING_MECHANICS.length > ADAPTERS_REACHING_MECHANICS_CEILING
        ? 'a new adapter -> mechanic edge was added. ADR-0018 is Accepted, so ' +
            'this is debt being taken on against a decision to pay it down: give ' +
            'the operation a home in server-core, or raise the ceiling in the ' +
            'same PR and say there why that was not possible.'
        : 'an edge was paid off — lower ADAPTERS_REACHING_MECHANICS_CEILING to ' +
            'match, so the number keeps recording where the migration is.',
    ).toBe(ADAPTERS_REACHING_MECHANICS_CEILING)
  })

  it('the scan actually reaches the adapter tree', () => {
    expect(actual.length).toBeGreaterThan(20)
  })

  // Asserted against a FIXTURE rather than the real tree, because the real
  // tree is meant to hold no such edge: a guard whose only evidence is a
  // violation that exists today stops proving anything the day it is fixed.
  describe('the matcher sees a mechanic at any depth under store/', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'arch-lint-adapter-'))
    afterAll(() => rmSync(fixture, { recursive: true, force: true }))

    mkdirSync(join(fixture, 'routes'), { recursive: true })
    mkdirSync(join(fixture, 'mcp'), { recursive: true })
    writeFileSync(
      join(fixture, 'routes', 'thing.ts'),
      [
        "import { upsertWorkspaceRow } from '../store/db/upsert-workspace.js'",
        "import { getDocCache } from '../store/doc-cache.js'",
        // Depth is not a property of today's tree: `store/db/` is simply how
        // deep it happens to go. A matcher that hard-codes the depths it has
        // seen is the same blind spot one level down.
        "import { deep } from '../store/db/workspaces/upsert-row.js'",
        'export const thing = [upsertWorkspaceRow, getDocCache, deep]',
      ].join('\n'),
    )
    writeFileSync(join(fixture, 'mcp', 'noop.ts'), 'export const noop = 1\n')

    it('names it by its path under store/, so db/x cannot be read as x', () => {
      expect(findAdapterMechanicEdges(fixture, [])).toEqual([
        'routes/thing.ts -> db/upsert-workspace',
        'routes/thing.ts -> db/workspaces/upsert-row',
        'routes/thing.ts -> doc-cache',
      ])
    })
  })

  // Guarded from both sides too. An exemption is a CLASSIFICATION — "this
  // file is not an adapter" — so it has to keep being true of a file that
  // still exists and still has edges to suppress. One that suppresses nothing
  // is decoration, and reads to the next person as though something was
  // decided.
  it('every exempt file exists and actually has edges the exemption suppresses', () => {
    const unexempted = findAdapterMechanicEdges(SERVER_DIR, MECHANICS_NOT_SCANNED)
    const suppressing = ADAPTER_SCAN_EXEMPT_FILES.filter((file) =>
      unexempted.some((edge) => edge.startsWith(`${file} -> `)),
    )

    expect(
      suppressing,
      'an entry in ADAPTER_SCAN_EXEMPT_FILES suppresses nothing — the file was ' +
        'moved, renamed, or no longer reaches a mechanic. Delete it.',
    ).toEqual([...ADAPTER_SCAN_EXEMPT_FILES])
  })

  it('excludes the error taxonomy, which an adapter is entitled to read', () => {
    expect(MECHANICS_NOT_SCANNED).toContain('corrupt-stored-data')
    expect(actual.some((edge) => edge.endsWith('corrupt-stored-data'))).toBe(false)
  })
})
