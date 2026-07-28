import type {
  AliasHistoryRow,
  AliasResolutionRow,
  ApplyRowsInput,
  BacklinkRow,
  CanvasListRow,
  FacetIndexRow,
  ListBacklinksInput,
  ListBacklinksResult,
  ListCanvasesInput,
  ListCanvasesResult,
  QueryFacetInput,
  QueryFacetResult,
  ResolveAliasHistoryInput,
  ResolveAliasInput,
  ResolveAliasResult,
  WorkspaceIndex,
} from '@kamiazya/whiteboard-canvas-ports'

interface WorkspaceRecord {
  readonly canvasList: readonly CanvasListRow[]
  readonly facets: readonly FacetIndexRow[]
  readonly aliases: readonly AliasResolutionRow[]
  readonly backlinks: readonly BacklinkRow[]
  readonly aliasHistory: readonly AliasHistoryRow[]
}

function emptyRecord(): WorkspaceRecord {
  return { canvasList: [], facets: [], aliases: [], backlinks: [], aliasHistory: [] }
}

/**
 * Minimal in-memory `WorkspaceIndex` test double: full delete-then-insert
 * semantics per `applyRows` call (mirrors a real libSQL implementation),
 * keyed strictly by the per-call `workspaceId` so one instance can safely
 * back many workspaces exactly as the port contract requires.
 */
export function createInMemoryWorkspaceIndex(): WorkspaceIndex {
  const workspaces = new Map<string, WorkspaceRecord>()

  function getRecord(workspaceId: string): WorkspaceRecord {
    return workspaces.get(workspaceId) ?? emptyRecord()
  }

  return {
    async applyRows(input: ApplyRowsInput): Promise<void> {
      workspaces.set(input.workspaceId, {
        canvasList: input.canvasList,
        facets: input.facets,
        aliases: input.aliases,
        backlinks: input.backlinks,
        aliasHistory: input.aliasHistory,
      })
    },
    async resolveAlias(input: ResolveAliasInput): Promise<ResolveAliasResult> {
      const record = getRecord(input.workspaceId)
      const found = record.aliases.find((row) => row.alias === input.alias)
      return found ? { canvasId: found.canvasId } : null
    },
    async resolveAliasHistory(input: ResolveAliasHistoryInput): Promise<ResolveAliasResult> {
      const record = getRecord(input.workspaceId)
      const found = record.aliasHistory.find((row) => row.alias === input.alias)
      return found ? { canvasId: found.canvasId } : null
    },
    async listCanvases(input: ListCanvasesInput): Promise<ListCanvasesResult> {
      const record = getRecord(input.workspaceId)
      const offset = input.offset ?? 0
      const sliced =
        input.limit !== undefined
          ? record.canvasList.slice(offset, offset + input.limit)
          : record.canvasList.slice(offset)
      return { rows: [...sliced] }
    },
    async queryFacet(input: QueryFacetInput): Promise<QueryFacetResult> {
      const record = getRecord(input.workspaceId)
      const canvasIds = record.facets
        .filter((row) => row.facet === input.facet && row.value === input.value)
        .map((row) => row.canvasId)
      return { canvasIds }
    },
    async listBacklinks(input: ListBacklinksInput): Promise<ListBacklinksResult> {
      const record = getRecord(input.workspaceId)
      const rows = record.backlinks.filter((row) => row.toCanvasId === input.toCanvasId)
      return { rows: [...rows] }
    },
  }
}
