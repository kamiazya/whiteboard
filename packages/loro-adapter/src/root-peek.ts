import { type ContainerID, type LoroDoc, LoroMap } from 'loro-crdt'

/**
 * The root map a record holds under `key`, or `undefined` when it holds none.
 * Asking a `LoroDoc` for a root it never had registers it, and a snapshot then
 * carries the empty root, so a read through `getMap` makes the record's bytes
 * depend on who looked. The root is therefore looked up in the shallow value
 * first and fetched by the container id listed there.
 */
export function peekRootMap(doc: LoroDoc, key: string): LoroMap | undefined {
  const cid = doc.getShallowValue()[key]
  const held = typeof cid === 'string' ? doc.getContainerById(cid as ContainerID) : undefined
  return held instanceof LoroMap ? held : undefined
}
