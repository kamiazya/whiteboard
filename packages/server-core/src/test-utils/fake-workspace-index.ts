import type {
  ApplyRowsInput,
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

/**
 * A no-op `WorkspaceIndex` fake for tool tests that only exercise a
 * mutation's own effect (canvas doc / workspace tree), not the reindex it
 * triggers as a side effect. `applyRows` records every call so a test can
 * still assert on reindex behavior when that is the point under test.
 */
export class FakeWorkspaceIndex implements WorkspaceIndex {
  readonly applyRowsCalls: ApplyRowsInput[] = []

  async applyRows(input: ApplyRowsInput): Promise<void> {
    this.applyRowsCalls.push(input)
  }

  async resolveAlias(_input: ResolveAliasInput): Promise<ResolveAliasResult> {
    return null
  }

  async resolveAliasHistory(_input: ResolveAliasHistoryInput): Promise<ResolveAliasResult> {
    return null
  }

  async listCanvases(_input: ListCanvasesInput): Promise<ListCanvasesResult> {
    return { rows: [] }
  }

  async queryFacet(_input: QueryFacetInput): Promise<QueryFacetResult> {
    return { canvasIds: [] }
  }

  async listBacklinks(_input: ListBacklinksInput): Promise<ListBacklinksResult> {
    return { rows: [] }
  }
}
