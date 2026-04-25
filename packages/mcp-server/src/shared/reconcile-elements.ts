import { LoroDoc, LoroMap } from 'loro-crdt'

// Restore helper that reconciles the current doc's elements LoroList to match
// the element shape of a past doc. Both `past` and `current` are `LoroDoc`
// instances, and `getMovableList('elements')` stores LoroMap values.
//
// Loro can express deletion via isDeleted=true, so extra ops can reshape the
// current document into the past state without breaking CRDT guarantees.
//
// Note: running restore during concurrent editing can race with recent peer ops.
// In practice this becomes last-writer-wins. It is not catastrophic, but a
// recent peer stroke may be overwritten. The UI warns about this upfront.
//
// This lives in shared code so it can be reused for branch checkout as well.
// `past` represents the detached LoroDoc state we want to reach.
export function reconcileElementsOnDoc(doc: LoroDoc, past: LoroDoc): void {
  const list = doc.getMovableList('elements')
  const pastList = past.getMovableList('elements')

  // Past side: id -> plain object snapshot, including tombstones.
  const pastById = new Map<string, Record<string, unknown>>()
  const pastEntries = pastList.toJSON() as Array<Record<string, unknown>>
  for (const el of pastEntries) {
    const id = el.id
    if (typeof id === 'string') pastById.set(id, el)
  }

  // Current side: id -> { idx, snapshot }. The live LoroMap is accessed with list.get(idx).
  const currentById = new Map<string, { idx: number; snap: Record<string, unknown> }>()
  const currentEntries = list.toJSON() as Array<Record<string, unknown>>
  for (let i = 0; i < currentEntries.length; i++) {
    const el = currentEntries[i]
    const id = el?.id
    if (typeof id === 'string') currentById.set(id, { idx: i, snap: el })
  }

  // (1) IDs present in both docs: set only changed fields and align deletions.
  for (const [id, pastEl] of pastById) {
    const cur = currentById.get(id)
    if (!cur) continue
    const curMap = list.get(cur.idx) as LoroMap
    for (const [k, v] of Object.entries(pastEl)) {
      if (cur.snap[k] !== v) {
        curMap.set(k, v as Parameters<LoroMap['set']>[1])
      }
    }
    const pastKeys = new Set(Object.keys(pastEl))
    for (const key of Object.keys(cur.snap)) {
      if (!pastKeys.has(key)) {
        curMap.delete(key)
      }
    }
  }

  // (2) IDs only in current: tombstone them because they do not exist in past.
  for (const [id, cur] of currentById) {
    if (pastById.has(id)) continue
    if (cur.snap.isDeleted === true) continue
    const curMap = list.get(cur.idx) as LoroMap
    curMap.set('isDeleted', true)
  }

  // (3) IDs only in past: insert a new LoroMap and copy all fields from past.
  // This is uncommon, but it can happen if an old ID disappeared and a later
  // edit recreated the shape under a different ID.
  for (const [id, pastEl] of pastById) {
    if (currentById.has(id)) continue
    const m = list.insertContainer(list.length, new LoroMap())
    for (const [k, v] of Object.entries(pastEl)) {
      m.set(k, v as Parameters<LoroMap['set']>[1])
    }
  }
}
