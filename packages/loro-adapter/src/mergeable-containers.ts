import { LoroMap, LoroMovableList, LoroText } from 'loro-crdt'

/**
 * The one way this package opens a lazily-created child container on a map.
 *
 * `getOrCreateContainer` mints a REGULAR op-id child, so two replicas that
 * each open the same key having never seen the other's converge on ONE of
 * the two containers and hide the other. Not a conflict and not an error:
 * both sides agree on the truncated result, which is what makes the loss
 * unfindable afterwards. loro-crdt deprecated it for this use in 1.13.0 and
 * `ensureMergeable*` replaces it — a deterministic child id derived from
 * `(parent, key, kind)`, so the two peers were editing one container all
 * along.
 *
 * Measured on 1.13.6, two replicas each writing one entry at one key:
 * `getOrCreateContainer` reads back `{fromB}` on both sides,
 * `ensureMergeableMap` reads back `{fromA, fromB}`.
 *
 * Why a helper rather than the method: **`ensureMergeable*` throws on a key
 * that already holds a non-mergeable value** — the container every document
 * written before this change already has, and any scalar left at the key by
 * corrupt data. So the mergeable branch is taken only for an ABSENT key, and
 * an occupied one keeps the exact behaviour it had. That makes this safe to
 * apply to stored documents without a migration: an old container is adopted
 * and written through, and only a container created from here on is
 * mergeable.
 *
 * `ensureMergeable*` lives on `LoroMap` alone, which is the whole shape of
 * the problem — a list position is already a unique op, so only a map KEY
 * needs two peers to agree on which child it names.
 */
export function openMergeableMap(map: LoroMap, key: string): LoroMap {
  return map.get(key) === undefined
    ? map.ensureMergeableMap(key)
    : map.getOrCreateContainer(key, new LoroMap())
}

/** `openMergeableMap` for a text child. See it for why this shape. */
export function openMergeableText(map: LoroMap, key: string): LoroText {
  return map.get(key) === undefined
    ? map.ensureMergeableText(key)
    : map.getOrCreateContainer(key, new LoroText())
}

/** `openMergeableMap` for a movable-list child. See it for why this shape. */
export function openMergeableMovableList(map: LoroMap, key: string): LoroMovableList {
  return map.get(key) === undefined
    ? map.ensureMergeableMovableList(key)
    : map.getOrCreateContainer(key, new LoroMovableList())
}
