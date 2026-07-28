import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AliasHistoryRow,
  AliasResolutionRow,
  BacklinkRow,
  CanvasListRow,
  FacetIndexRow,
  WorkspaceIndex,
} from '@kamiazya/whiteboard-canvas-ports'
import { describe, expect } from 'vitest'
import { fc, fcTest } from '../../../shared/test-utils/fast-check.js'
import { createIsolatedDb } from '../db/test-helpers.js'
import { InMemoryWorkspaceIndex } from '../inmemory/in-memory-workspace-index.js'
import { LibsqlWorkspaceIndex } from './libsql-workspace-index.js'

// Small fixed pool so applyOps/readOps generate collisions (overlapping
// aliases/facets/canvasIds/workspaces) often enough to exercise replace and
// isolation semantics, not just always-distinct rows.
const WORKSPACE_IDS = ['workspace-a', 'workspace-b'] as const
const CANVAS_IDS = ['canvas-1', 'canvas-2', 'canvas-3'] as const
const ALIASES = ['home', 'about'] as const
const FACETS = ['kind'] as const
const FACET_VALUES = ['note', 'diagram'] as const

type ApplyRowsOp = {
  type: 'applyRows'
  workspaceId: (typeof WORKSPACE_IDS)[number]
  canvasList: CanvasListRow[]
  facets: FacetIndexRow[]
  aliases: AliasResolutionRow[]
  backlinks: BacklinkRow[]
  aliasHistory: AliasHistoryRow[]
}

type ReadOp =
  | { type: 'resolveAlias'; workspaceId: (typeof WORKSPACE_IDS)[number]; alias: string }
  | { type: 'resolveAliasHistory'; workspaceId: (typeof WORKSPACE_IDS)[number]; alias: string }
  | {
      type: 'listCanvases'
      workspaceId: (typeof WORKSPACE_IDS)[number]
      limit?: number
      offset?: number
    }
  | {
      type: 'queryFacet'
      workspaceId: (typeof WORKSPACE_IDS)[number]
      facet: string
      value: string
    }
  | { type: 'listBacklinks'; workspaceId: (typeof WORKSPACE_IDS)[number]; toCanvasId: string }

type Op = ApplyRowsOp | ReadOp

async function applyOp(index: WorkspaceIndex, op: Op): Promise<unknown> {
  switch (op.type) {
    case 'applyRows':
      await index.applyRows(op)
      return undefined
    case 'resolveAlias':
      return index.resolveAlias({ workspaceId: op.workspaceId, alias: op.alias })
    case 'resolveAliasHistory':
      return index.resolveAliasHistory({ workspaceId: op.workspaceId, alias: op.alias })
    case 'listCanvases':
      return index.listCanvases({
        workspaceId: op.workspaceId,
        limit: op.limit,
        offset: op.offset,
      })
    case 'queryFacet':
      return index.queryFacet({ workspaceId: op.workspaceId, facet: op.facet, value: op.value })
    case 'listBacklinks':
      return index.listBacklinks({ workspaceId: op.workspaceId, toCanvasId: op.toCanvasId })
  }
}

const workspaceIdArb = fc.constantFrom(...WORKSPACE_IDS)
const canvasIdArb = fc.constantFrom(...CANVAS_IDS)
const aliasArb = fc.constantFrom(...ALIASES)
const facetArb = fc.constantFrom(...FACETS)
const facetValueArb = fc.constantFrom(...FACET_VALUES)

const canvasListRowArb: fc.Arbitrary<CanvasListRow> = fc.record({
  canvasId: canvasIdArb,
  title: fc.string({ maxLength: 10 }),
  updatedAtMs: fc.integer({ min: 0, max: 1_000_000 }),
})

const facetRowArb: fc.Arbitrary<FacetIndexRow> = fc.record({
  facet: facetArb,
  value: facetValueArb,
  canvasId: canvasIdArb,
})

const aliasRowArb: fc.Arbitrary<AliasResolutionRow> = fc.record({
  alias: aliasArb,
  canvasId: canvasIdArb,
})

const backlinkRowArb: fc.Arbitrary<BacklinkRow> = fc.record({
  fromCanvasId: canvasIdArb,
  toCanvasId: canvasIdArb,
})

const aliasHistoryRowArb: fc.Arbitrary<AliasHistoryRow> = fc.record({
  alias: aliasArb,
  canvasId: canvasIdArb,
  retiredAtMs: fc.integer({ min: 0, max: 1_000_000 }),
})

const applyRowsOpArb: fc.Arbitrary<ApplyRowsOp> = fc.record({
  type: fc.constant('applyRows' as const),
  workspaceId: workspaceIdArb,
  canvasList: fc.array(canvasListRowArb, { maxLength: 4 }),
  facets: fc.array(facetRowArb, { maxLength: 4 }),
  aliases: fc.array(aliasRowArb, { maxLength: 4 }),
  backlinks: fc.array(backlinkRowArb, { maxLength: 4 }),
  aliasHistory: fc.array(aliasHistoryRowArb, { maxLength: 4 }),
})

const readOpArb: fc.Arbitrary<ReadOp> = fc.oneof(
  fc.record({
    type: fc.constant('resolveAlias' as const),
    workspaceId: workspaceIdArb,
    alias: aliasArb,
  }),
  fc.record({
    type: fc.constant('resolveAliasHistory' as const),
    workspaceId: workspaceIdArb,
    alias: aliasArb,
  }),
  fc.record({
    type: fc.constant('listCanvases' as const),
    workspaceId: workspaceIdArb,
    limit: fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }),
    offset: fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }),
  }),
  fc.record({
    type: fc.constant('queryFacet' as const),
    workspaceId: workspaceIdArb,
    facet: facetArb,
    value: facetValueArb,
  }),
  fc.record({
    type: fc.constant('listBacklinks' as const),
    workspaceId: workspaceIdArb,
    toCanvasId: canvasIdArb,
  }),
)

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: applyRowsOpArb, weight: 2 },
  { arbitrary: readOpArb, weight: 3 },
)

describe('LibsqlWorkspaceIndex / InMemoryWorkspaceIndex observational parity', () => {
  // Each property run gets its own fresh isolated DB (created/disposed inside
  // the property body) so one run's rows never leak into the next.
  fcTest.prop([fc.array(opArb, { maxLength: 15 })], { numRuns: 20 })(
    'produce identical results for every step of a random op sequence',
    async (ops) => {
      const tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-libsql-workspace-index-parity-'))
      const handle = await createIsolatedDb({ dataDir: tempDir })
      try {
        const inMemory = new InMemoryWorkspaceIndex()
        const libsql = new LibsqlWorkspaceIndex(handle.db)

        for (const op of ops) {
          const [inMemoryResult, libsqlResult] = await Promise.all([
            applyOp(inMemory, op),
            applyOp(libsql, op),
          ])
          expect(libsqlResult).toEqual(inMemoryResult)
        }
      } finally {
        await handle.dispose()
        await rm(tempDir, { recursive: true, force: true })
      }
    },
  )
})
