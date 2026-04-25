import type { LoroDoc } from 'loro-crdt'

// CRDT merge is automatic, but the UI still needs signals for surprising LWW
// outcomes. Given target / source / preview docs, this detects non-obvious merge
// results such as tombstone resurrection, orphan refs, and mixed field winners.
//
// Design choices:
// - routes only handle Loro checkout/export mechanics; badge detection stays pure
// - preview is expected to come from route-level merge preparation

export type MergeBadge =
  | { type: 'resurrected'; elementId: string }
  | { type: 'orphan_ref'; elementId: string; missingRef: string }
  | { type: 'field_merge'; elementId: string; fields: string[] }

type ElementSnap = Record<string, unknown> & { id?: unknown }

function toElementMap(doc: LoroDoc): Map<string, ElementSnap> {
  try {
    const list = doc.getMovableList('elements')
    const entries = list.toJSON() as ElementSnap[]
    const out = new Map<string, ElementSnap>()
    for (const el of entries) {
      if (typeof el?.id === 'string') out.set(el.id, el)
    }
    return out
  } catch {
    return new Map()
  }
}

// Alive means not tombstoned. isDeleted is expected to be a boolean.
function isAlive(el: ElementSnap | undefined): boolean {
  if (!el) return false
  return el.isDeleted !== true
}

// Collect reference IDs that arrows / annotations / text can point at.
// This covers the main preview-time cases: startBinding.elementId,
// endBinding.elementId, containerId, and frameId.
function refTargetIdsOf(el: ElementSnap): string[] {
  const ids: string[] = []
  const sb = el.startBinding as { elementId?: unknown } | undefined
  if (sb && typeof sb.elementId === 'string') ids.push(sb.elementId)
  const eb = el.endBinding as { elementId?: unknown } | undefined
  if (eb && typeof eb.elementId === 'string') ids.push(eb.elementId)
  if (typeof el.containerId === 'string') ids.push(el.containerId)
  if (typeof el.frameId === 'string') ids.push(el.frameId)
  return ids
}

// A live preview element is orphaned if its referenced target is tombstoned or missing.
function isOrphanRefTarget(previewById: Map<string, ElementSnap>, refId: string): boolean {
  const refEl = previewById.get(refId)
  if (!refEl) return true
  return !isAlive(refEl)
}

export interface DetectArgs {
  target: LoroDoc
  source: LoroDoc
  preview: LoroDoc
}

export function detectMergeBadges({ target, source, preview }: DetectArgs): MergeBadge[] {
  const byTarget = toElementMap(target)
  const bySource = toElementMap(source)
  const byPreview = toElementMap(preview)

  const badges: MergeBadge[] = []

  for (const [id, prev] of byPreview) {
    const tgt = byTarget.get(id)
    const src = bySource.get(id)
    // Skip post-merge hallucinations that exist in neither target nor source.
    if (!tgt && !src) continue

    // Case A: the element existed in target, was tombstoned there, and is alive
    // in preview. Exclude brand-new elements that only came from source.
    const tgtExisted = tgt !== undefined
    const tgtAlive = isAlive(tgt)
    const prevAlive = isAlive(prev)
    const isResurrected = tgtExisted && !tgtAlive && prevAlive
    if (isResurrected) {
      badges.push({ type: 'resurrected', elementId: id })
    }

    // Case B: a live preview element references something that is not live.
    if (prevAlive) {
      for (const refId of refTargetIdsOf(prev)) {
        if (isOrphanRefTarget(byPreview, refId)) {
          badges.push({ type: 'orphan_ref', elementId: id, missingRef: refId })
        }
      }
    }

    // Case C: field-level LWW mixing, excluding resurrected cases. If target and
    // source differ and preview picks a mix of winners, surface that as a badge.
    if (!isResurrected && tgt && src) {
      const targetKeys = new Set(Object.keys(tgt))
      const sourceKeys = new Set(Object.keys(src))
      const relevantKeys = new Set([...targetKeys, ...sourceKeys])
      // id / type / isDeleted are already covered by cases A/B.
      relevantKeys.delete('id')
      relevantKeys.delete('type')
      relevantKeys.delete('isDeleted')
      const mixed: string[] = []
      let allTargetWins = true
      let allSourceWins = true
      for (const k of relevantKeys) {
        const tVal = tgt[k]
        const sVal = src[k]
        const pVal = prev[k]
        if (tVal === sVal) continue // Ignore fields with no diff.
        // If preview matches neither side, that is a more complex merge shape and
        // is outside the current scope.
        const pEqTarget = JSON.stringify(pVal) === JSON.stringify(tVal)
        const pEqSource = JSON.stringify(pVal) === JSON.stringify(sVal)
        if (!pEqTarget) allTargetWins = false
        if (!pEqSource) allSourceWins = false
        if (pEqSource && !pEqTarget) {
          // Source won for this field.
          mixed.push(k)
        }
      }
      // If one side won every field, it is not mixed. Otherwise, mixed contains
      // the fields where preview differs by winner.
      if (mixed.length > 0 && !allTargetWins && !allSourceWins) {
        badges.push({ type: 'field_merge', elementId: id, fields: mixed.sort() })
      } else if (mixed.length > 0 && allSourceWins) {
        // If source won all fields, it is still useful to surface the full diff
        // relative to target.
        badges.push({ type: 'field_merge', elementId: id, fields: mixed.sort() })
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
