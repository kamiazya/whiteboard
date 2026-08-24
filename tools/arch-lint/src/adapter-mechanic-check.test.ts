import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { findAdapterMechanicEdges } from './adapter-mechanic-check.js'
import { ADAPTERS_REACHING_MECHANICS, MECHANICS_NOT_SCANNED } from './architecture-map.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SERVER_DIR = join(REPO_ROOT, 'packages/mcp-server/src/server')

const actual = findAdapterMechanicEdges(SERVER_DIR, MECHANICS_NOT_SCANNED)

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

  // Guarded from both sides, so the list can only shrink. Without this, a
  // migration that removed an edge would leave its entry behind and the
  // allowlist would slowly stop describing anything.
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
  it('the scan actually reaches the adapter tree', () => {
    expect(actual.length).toBeGreaterThan(20)
  })

  it('excludes the error taxonomy, which an adapter is entitled to read', () => {
    expect(MECHANICS_NOT_SCANNED).toContain('corrupt-stored-data')
    expect(actual.some((edge) => edge.endsWith('corrupt-stored-data'))).toBe(false)
  })
})
