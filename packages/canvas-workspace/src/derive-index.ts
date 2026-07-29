import type { CoreFacets, ExtensionFacets } from '@kamiazya/whiteboard-canvas-model'
import { issueFacetPayloadSchema } from '@kamiazya/whiteboard-canvas-model'
import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/mdast'
import type {
  AliasHistoryRow,
  AliasResolutionRow,
  ApplyRowsInput,
  BacklinkRow,
  CanvasListRow,
  FacetIndexRow,
} from '@kamiazya/whiteboard-canvas-ports'
import { extractBacklinks } from './extract-backlinks.js'
import type { WorkspaceTree } from './workspace-tree.js'

/**
 * Per-canvas input to index derivation. Never crosses a process boundary —
 * these derivers run in-process against already-loaded tree + doc state —
 * so, mirroring canvas-render's scene graph, this stays plain TS rather
 * than a Zod schema. The five *output* row shapes are the schematized
 * contract (canvas-ports); this input type is derivation-internal.
 */
export interface CanvasIndexInput {
  readonly canvasId: string
  readonly updatedAtMs: number
  readonly coreFacets?: CoreFacets
  readonly extensionFacets?: ExtensionFacets
  /**
   * Already reference-resolved mdast body (wikiLink/embed nodes carry a
   * concrete canvasId, produced by canvas-codec's `resolveReferences`).
   * Passing raw, unresolved mdast silently yields zero backlink rows since
   * `extractBacklinks` only recognizes the resolved node shapes. Omit for
   * non-markdown (spatial) canvases, which have no backlinks to extract.
   */
  readonly resolvedBody?: MdastRoot
}

export interface WorkspaceIndexDeriveInput {
  readonly workspaceId: ApplyRowsInput['workspaceId']
  readonly tree: WorkspaceTree
  readonly canvases: readonly CanvasIndexInput[]
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** Scalar `issue/1` fields deep-indexed as one row each, in a fixed emission order. */
const ISSUE_FACET_SCALAR_FIELDS = ['status', 'priority', 'due', 'summary'] as const

/** Array `issue/1` fields deep-indexed as one row per element, in a fixed emission order. */
const ISSUE_FACET_ARRAY_FIELDS = ['assignees', 'labels'] as const

/**
 * Deep-indexes a known `issue/1` extension-facet payload into one row per
 * present scalar field and one row per array element, in addition to the
 * existence row every domain gets. `extensionFacetsSchema` validates the
 * bucket key shape only (`z.unknown()` payload), so a value stored under
 * `issue/1` is not guaranteed to match `issueFacetPayloadSchema` — a
 * `safeParse` failure falls back to no deep rows (existence-only) rather
 * than throwing, so one malformed payload never aborts indexing for the
 * rest of the workspace.
 */
function deriveIssueFacetDeepRows(
  domainKey: string,
  payload: unknown,
  canvasId: string,
): FacetIndexRow[] {
  const parsed = issueFacetPayloadSchema.safeParse(payload)
  if (!parsed.success) return []

  const rows: FacetIndexRow[] = []
  for (const field of ISSUE_FACET_SCALAR_FIELDS) {
    const value = parsed.data[field]
    if (value !== undefined) {
      rows.push({ facet: `facets.${domainKey}.${field}`, value, canvasId })
    }
  }
  for (const field of ISSUE_FACET_ARRAY_FIELDS) {
    for (const value of parsed.data[field] ?? []) {
      rows.push({ facet: `facets.${domainKey}.${field}`, value, canvasId })
    }
  }
  return rows
}

/**
 * Facet index rows: one row per (facet key, value, canvasId). Core `type`/
 * `view` each produce at most one row per canvas; `tags` produces one row
 * per tag. Extension domains (`facets.<domain>/<version>`) always index as
 * existence rows (`value: ''`) — a canvas either has the domain applied or
 * it doesn't. The `issue/1` domain additionally deep-indexes its known
 * fields (`facets.issue/1.status`, `.assignees`, etc.) since its shape is
 * schematized; other domains have no canonical scalar value in the current
 * row DTO (`{facet, value}` only) and stay existence-only until the row DTO
 * grows a path field.
 */
export function deriveFacetIndexRows(canvases: readonly CanvasIndexInput[]): FacetIndexRow[] {
  const rows: FacetIndexRow[] = []
  for (const canvas of canvases) {
    const { coreFacets, extensionFacets, canvasId } = canvas
    if (coreFacets?.type !== undefined) {
      rows.push({ facet: 'type', value: coreFacets.type, canvasId })
    }
    for (const tag of coreFacets?.tags ?? []) {
      rows.push({ facet: 'tags', value: tag, canvasId })
    }
    if (coreFacets?.view !== undefined) {
      rows.push({ facet: 'view', value: coreFacets.view, canvasId })
    }
    const extensions = extensionFacets ?? {}
    for (const domainKey of Object.keys(extensions).sort(compareStrings)) {
      rows.push({ facet: `facets.${domainKey}`, value: '', canvasId })
      if (domainKey === 'issue/1') {
        rows.push(...deriveIssueFacetDeepRows(domainKey, extensions[domainKey], canvasId))
      }
    }
  }
  // Explicit sort (not insertion order) so shuffling the `canvases` input
  // never changes the derived output — (facet, value, canvasId) is a total
  // tie-breaker since canvasId is unique per canvas.
  return rows.sort(
    (a, b) =>
      compareStrings(a.facet, b.facet) ||
      compareStrings(a.value, b.value) ||
      compareStrings(a.canvasId, b.canvasId),
  )
}

/**
 * Canvas list rows: title falls back from frontmatter `title` to the
 * canvas's own tree segment (its leaf name, not the full alias path — the
 * DTO has no alias field, see `deriveAliasResolutionRows`) to `''` when
 * neither is available (e.g. an orphaned canvas with no tree node).
 */
export function deriveCanvasListRows(
  tree: WorkspaceTree,
  canvases: readonly CanvasIndexInput[],
): CanvasListRow[] {
  const segmentByCanvasId = new Map<string, string>()
  for (const node of tree.snapshot().nodes) {
    segmentByCanvasId.set(node.canvasId, node.segment)
  }
  const rows = canvases.map((canvas) => ({
    canvasId: canvas.canvasId,
    title: canvas.coreFacets?.title ?? segmentByCanvasId.get(canvas.canvasId) ?? '',
    updatedAtMs: canvas.updatedAtMs,
  }))
  return rows.sort((a, b) => compareStrings(a.canvasId, b.canvasId))
}

/**
 * Alias resolution rows: current alias (root-to-leaf segment join) -> the
 * node's canvasId, for every tree node. Uses `WorkspaceTree.resolveAlias`
 * directly rather than reimplementing the ancestor walk, since
 * `WorkspaceTreeSnapshot` is a flat node list with no parent pointer.
 */
export function deriveAliasResolutionRows(tree: WorkspaceTree): AliasResolutionRow[] {
  const rows: AliasResolutionRow[] = []
  for (const node of tree.snapshot().nodes) {
    const alias = tree.resolveAlias(node.id)
    if (alias === undefined) continue
    rows.push({ alias, canvasId: node.canvasId })
  }
  return rows.sort((a, b) => compareStrings(a.alias, b.alias))
}

/**
 * Backlink rows: reuses `extractBacklinks` (the mdast walk lives there,
 * once) per canvas and concatenates. No additional cross-doc dedup is
 * needed beyond `extractBacklinks`' own per-doc dedup — each row's
 * `fromCanvasId` is that canvas's own ID, so two different source canvases
 * never produce a colliding (from, to) pair by coincidence.
 */
export function deriveBacklinkRows(canvases: readonly CanvasIndexInput[]): BacklinkRow[] {
  const rows: BacklinkRow[] = []
  for (const canvas of canvases) {
    if (canvas.resolvedBody === undefined) continue
    rows.push(...extractBacklinks(canvas.canvasId, canvas.resolvedBody))
  }
  return rows.sort(
    (a, b) =>
      compareStrings(a.fromCanvasId, b.fromCanvasId) || compareStrings(a.toCanvasId, b.toCanvasId),
  )
}

/**
 * The workspace tree retains no alias history today — `rename`/`move`
 * overwrite a node's segment/parent in place with no tombstone of the
 * previous value. Until the tree gains that tracking, this deriver has no
 * source data to read and always returns an empty, DTO-typed set.
 */
export function deriveAliasHistoryRows(): AliasHistoryRow[] {
  return []
}

/** Assembles all five WorkspaceIndex row-sets — the payload 5b-3c's `WorkspaceIndex.applyRows` will consume. */
export function deriveWorkspaceIndexRows(input: WorkspaceIndexDeriveInput): ApplyRowsInput {
  const { workspaceId, tree, canvases } = input
  return {
    workspaceId,
    canvasList: deriveCanvasListRows(tree, canvases),
    facets: deriveFacetIndexRows(canvases),
    aliases: deriveAliasResolutionRows(tree),
    backlinks: deriveBacklinkRows(canvases),
    aliasHistory: deriveAliasHistoryRows(),
  }
}
