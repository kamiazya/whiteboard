import { readProposals, writeProposal } from '@kamiazya/whiteboard-loro-adapter'
import {
  type CanvasEdge,
  edgePatchFieldsSchema,
  nodePatchFieldsSchema,
  PROPOSED_CHANGE_OPS,
  type Proposal,
  type ProposedChange,
  type SpatialCanvas,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import type { LoroDoc } from 'loro-crdt'
import type { ServerDeps } from '../server-deps.js'
import { saveDocumentSnapshot } from './document-io.js'

/**
 * Turning one `wb_canvas_edit` batch into a proposal (ADR-0029 decision 7).
 *
 * The batch is resolved exactly as an applied one is — ids minted, geometry
 * placed, every op validated — and then, instead of the resulting board being
 * saved, the DIFFERENCE between the board and that result is stored as the
 * proposal's changes.
 *
 * Diffing rather than carrying the ops through is not a shortcut around
 * decision 2. A proposed node has to be stored RESOLVED, because the renderer
 * draws it in place before anyone adopts it — so the op as the caller wrote
 * it (id-less, geometry-less) was never what would be stored. The resolved
 * result IS the resolved op, and reading it off the diff is how the tool
 * avoids saying the same thing twice.
 *
 * It also collapses a batch that touches one element twice into the one net
 * change a person decides on, which is what adoption needs.
 */

/**
 * The verbs a proposal can carry, read off the stored union rather than
 * listed again. What is absent follows from ADR-0029's own decisions: `tidy`
 * has no anchor, `region.set` deletes what it was not told about (so it can
 * be neither drawn as a set of priors nor adopted in part), `comment.*` is
 * the annotation layer rather than content, and a lock is a claim on a
 * document rather than a change to it.
 */
const PROPOSABLE: ReadonlySet<string> = new Set<string>(PROPOSED_CHANGE_OPS)

export function isProposableOp(op: string): boolean {
  return PROPOSABLE.has(op)
}

const NODE_PATCH_FIELDS = Object.keys(nodePatchFieldsSchema.shape)
const EDGE_PATCH_FIELDS = Object.keys(edgePatchFieldsSchema.shape)

/**
 * Thrown when the diff finds a difference the change vocabulary cannot
 * express. Unreachable through the tool as it stands — every proposable verb
 * writes only patch fields, and `node.add` refuses an id already on the board
 * — so this exists for the verb somebody makes proposable later without
 * teaching the diff about it. Loud, because the alternative is a proposal
 * that silently drops half of what it was asked to propose.
 */
class UnrepresentableChangeError extends Error {
  constructor(id: string, field: string) {
    super(
      `"${id}" differs in ${field}, which a proposed change cannot carry; ` +
        'the verb that produced it needs an arm in proposedChangeSchema',
    )
    this.name = 'UnrepresentableChangeError'
  }
}

type Fields = Record<string, unknown>

/**
 * The patchable fields that differ, and what they held before.
 *
 * A prior OMITS a field the element did not have — "the anchor held nothing
 * there" — which is exactly the asymmetry `proposedChangeSchema` allows and
 * the opposite one it refuses.
 */
function patchBetween(
  before: Fields,
  after: Fields,
  patchFields: readonly string[],
  id: string,
): { patch: Fields; assumed: Fields } | undefined {
  const patch: Fields = {}
  const assumed: Fields = {}
  for (const field of patchFields) {
    if (Object.is(before[field], after[field])) continue
    patch[field] = after[field]
    if (before[field] !== undefined) assumed[field] = before[field]
  }
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (field === 'id' || patchFields.includes(field)) continue
    if (!Object.is(before[field], after[field])) throw new UnrepresentableChangeError(id, field)
  }
  return Object.keys(patch).length === 0 ? undefined : { patch, assumed }
}

/**
 * A change's id is its element's, prefixed by the surface it is on. That
 * makes one proposal hold at most one change per element — a second call
 * touching the same element REPLACES its change rather than stacking a
 * second opinion beside it — and it needs no minting, so two replicas
 * proposing the same edit agree on the key.
 */
function changeIdFor(kind: 'node' | 'edge', elementId: string): string {
  return `${kind}:${elementId}`
}

/**
 * Every change between the board and what the batch would have made of it,
 * in element-id order so two runs of the same batch store the same list.
 */
function proposedChangesFromDiff(before: SpatialCanvas, after: SpatialCanvas): ProposedChange[] {
  const changes: ProposedChange[] = []
  const nodesBefore = new Map(before.nodes.map((node) => [node.id, node]))
  const nodesAfter = new Map(after.nodes.map((node) => [node.id, node]))
  for (const [id, node] of nodesAfter) {
    const prior = nodesBefore.get(id)
    if (prior === undefined) {
      changes.push({ id: changeIdFor('node', id), status: 'open', op: 'node.add', node })
      continue
    }
    const patched = patchBetween(prior as Fields, node as Fields, NODE_PATCH_FIELDS, id)
    if (patched !== undefined) {
      changes.push({
        id: changeIdFor('node', id),
        status: 'open',
        op: 'node.patch',
        nodeId: id,
        patch: patched.patch,
        assumed: patched.assumed,
      })
    }
  }
  for (const [id, node] of nodesBefore) {
    if (nodesAfter.has(id)) continue
    changes.push({
      id: changeIdFor('node', id),
      status: 'open',
      op: 'node.remove',
      nodeId: id,
      assumed: node satisfies SpatialNode,
    })
  }

  const edgesBefore = new Map(before.edges.map((edge) => [edge.id, edge]))
  const edgesAfter = new Map(after.edges.map((edge) => [edge.id, edge]))
  for (const [id, edge] of edgesAfter) {
    const prior = edgesBefore.get(id)
    if (prior === undefined) {
      changes.push({ id: changeIdFor('edge', id), status: 'open', op: 'edge.add', edge })
      continue
    }
    const patched = patchBetween(prior as Fields, edge as Fields, EDGE_PATCH_FIELDS, id)
    if (patched !== undefined) {
      changes.push({
        id: changeIdFor('edge', id),
        status: 'open',
        op: 'edge.patch',
        edgeId: id,
        patch: patched.patch,
        assumed: patched.assumed,
      })
    }
  }
  for (const [id, edge] of edgesBefore) {
    if (edgesAfter.has(id)) continue
    changes.push({
      id: changeIdFor('edge', id),
      status: 'open',
      op: 'edge.remove',
      edgeId: id,
      assumed: edge satisfies CanvasEdge,
    })
  }

  return changes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** The first `p<n>` no proposal on this document already holds. */
function mintProposalId(taken: ReadonlySet<string>): string {
  for (let i = 1; ; i++) {
    const candidate = `p${i}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Stores what the batch would have done, INSTEAD of doing it: the content
 * containers are left exactly as they were and only the proposals plane
 * grows. `saveDocumentSnapshot` rather than `saveDocumentBodySnapshot` is
 * what makes that true — the latter writes the canvas back.
 *
 * Answers `undefined` when the batch would change nothing. That is not an
 * error here: what to say about an empty proposal belongs to the tool, which
 * owns how a refusal is worded.
 */
export async function storeCanvasProposal(args: {
  readonly deps: ServerDeps
  readonly workspaceId: string
  readonly documentId: string
  readonly proposalId?: string
  readonly doc: LoroDoc
  readonly before: SpatialCanvas
  readonly after: SpatialCanvas
}): Promise<Proposal | undefined> {
  const changes = proposedChangesFromDiff(args.before, args.after)
  if (changes.length === 0) return undefined
  const open = readProposals(args.doc)
  const continuing = open.find((existing) => existing.id === args.proposalId)
  const proposal: Proposal = {
    id: args.proposalId ?? mintProposalId(new Set(open.map((existing) => existing.id))),
    // No author: server-core carries no operator identity, and a
    // browser-kept workspace has nobody signed in to record.
    //
    // A continuation keeps the time the proposal was OPENED. Decision 8's
    // batch is one request across several calls, so re-stamping here would
    // make `createdAt` name the last call rather than the proposal.
    createdAt: continuing?.createdAt ?? new Date().toISOString(),
    changes,
  }
  writeProposal(args.doc, proposal)
  await saveDocumentSnapshot(args.deps, args.workspaceId, args.documentId, args.doc)
  // Read back rather than answering with the changes this call contributed.
  // The result is typed as a whole proposal, so it has to be one — and the
  // merge that produced it belongs to the container, so recomputing it here
  // would be a second implementation free to disagree with the first.
  return readProposals(args.doc).find((stored) => stored.id === proposal.id) ?? proposal
}
