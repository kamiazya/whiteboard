import { readSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { LoroDoc, PeerID } from 'loro-crdt'
import { VersionVector } from 'loro-crdt'

// CRDT merge is automatic, but the UI still needs signals for surprising LWW
// outcomes. Given base / target / source / preview docs, this detects
// non-obvious merge results such as tombstone resurrection, orphan refs, and
// mixed field winners.
//
// Design choices:
// - routes only handle Loro checkout/export mechanics; badge detection stays pure
// - preview is expected to come from route-level merge preparation (today:
//   the source tip, under the shipped "source wins" tip-adoption merge)
// - base is the merge base: the common ancestor of target and source, so a
//   node/edge missing from `base` never counts as resurrected or conflicted —
//   it is simply new on one side

export type MergeBadge =
  | { type: 'resurrected'; elementId: string }
  | { type: 'orphan_ref'; elementId: string; missingRef: string }
  | { type: 'field_merge'; elementId: string; fields: string[] }

type ElementSnap = Record<string, unknown> & { id: string }

// Build a map of every node AND edge, keyed by id. Unlike the retired
// legacy 'elements' movable-list (which tombstoned entries with
// `isDeleted: true`), the current nodes/edges model has no tombstone
// concept: a deleted node or edge is removed from its LoroMap outright, so
// presence in readSpatialCanvas's output already means "alive".
export function toElementMap(doc: LoroDoc): Map<string, ElementSnap> {
  const { nodes, edges } = readSpatialCanvas(doc)
  const out = new Map<string, ElementSnap>()
  for (const node of nodes) out.set(node.id, node as ElementSnap)
  for (const edge of edges) out.set(edge.id, edge as ElementSnap)
  return out
}

// Edges are the only element kind carrying a reference to another element in
// the current model (fromNode/toNode); nodes carry none, so this returns []
// for a node entry.
function refTargetIdsOf(el: ElementSnap): string[] {
  const ids: string[] = []
  if (typeof el.fromNode === 'string') ids.push(el.fromNode)
  if (typeof el.toNode === 'string') ids.push(el.toNode)
  return ids
}

// The merge base is the common ancestor: the per-peer minimum ("meet") of
// two version vectors. A peer counted on only one side contributes nothing
// to the ancestor and is omitted from the meet (its count would be 0); an
// all-omitted (empty) meet checks out to genesis.
export function meetVersion(a: VersionVector, b: VersionVector): VersionVector {
  const bCounts = b.toJSON()
  const meet = new Map<PeerID, number>()
  for (const [peer, aCount] of a.toJSON()) {
    const bCount = bCounts.get(peer)
    if (bCount === undefined) continue
    const count = Math.min(aCount, bCount)
    if (count > 0) meet.set(peer, count)
  }
  return new VersionVector(meet)
}

interface DetectArgs {
  base: LoroDoc
  target: LoroDoc
  source: LoroDoc
  preview: LoroDoc
}

export function detectMergeBadges({ base, target, source, preview }: DetectArgs): MergeBadge[] {
  const byBase = toElementMap(base)
  const byTarget = toElementMap(target)
  const bySource = toElementMap(source)
  const byPreview = toElementMap(preview)

  const badges: MergeBadge[] = []

  for (const [id, prev] of byPreview) {
    const baseEl = byBase.get(id)
    const targetEl = byTarget.get(id)
    const sourceEl = bySource.get(id)

    // resurrected: alive at base, alive in preview (guaranteed — prev is a
    // byPreview entry), and absent at target tip. Committing revives
    // something the target branch deleted. The "edited on the other side"
    // condition an earlier design considered is deliberately dropped: under
    // tip-adoption the element is revived regardless, making that a subset
    // of this rule rather than an additional requirement.
    if (baseEl && !targetEl) {
      badges.push({ type: 'resurrected', elementId: id })
    }

    // orphan_ref: a live preview edge references a node with no alive entry
    // in preview. The bridge's edge-cascade invariant (deleteSpatialNode
    // removes every edge touching the deleted node in the same commit)
    // means this cannot happen for a doc built through normal writes — kept
    // as a defensive net for a corrupt or foreign-shaped doc.
    for (const refId of refTargetIdsOf(prev)) {
      if (!byPreview.has(refId)) {
        badges.push({ type: 'orphan_ref', elementId: id, missingRef: refId })
      }
    }

    // field_merge: present at base, target tip, AND source tip (an id newly
    // created on both sides — same-id double-create — is skipped: there is
    // no shared base value to diff against), listing fields both branches
    // changed away from base to different values.
    if (baseEl && targetEl && sourceEl) {
      const fields: string[] = []
      const keys = new Set([...Object.keys(targetEl), ...Object.keys(sourceEl)])
      keys.delete('id')
      for (const key of keys) {
        const baseVal = JSON.stringify(baseEl[key])
        const targetVal = JSON.stringify(targetEl[key])
        const sourceVal = JSON.stringify(sourceEl[key])
        if (targetVal === sourceVal) continue // No conflict: both sides agree.
        if (targetVal === baseVal) continue // Target didn't change this field.
        if (sourceVal === baseVal) continue // Source didn't change this field.
        fields.push(key)
      }
      if (fields.length > 0) {
        badges.push({ type: 'field_merge', elementId: id, fields: fields.sort() })
      }
    }
  }

  // Stable ordering: type, then elementId.
  const typeOrder: Record<MergeBadge['type'], number> = {
    resurrected: 0,
    orphan_ref: 1,
    field_merge: 2,
  }
  badges.sort((a, b) => {
    const t = typeOrder[a.type] - typeOrder[b.type]
    if (t !== 0) return t
    return a.elementId < b.elementId ? -1 : a.elementId > b.elementId ? 1 : 0
  })
  return badges
}
