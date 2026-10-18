// What a sync update leaves standing in a document, judged with the bounds in
// `sync-text-limits.ts` by the same keepers on the same bytes. Kept apart
// because none of it measures how much: both are about whether a reader can
// find, and open, what the update wrote.
import type { ContainerID, JsonSchema, LoroDoc, LoroMap, VersionVector } from 'loro-crdt'
import { containerKind } from './content-sync.js'
import { CONTENT_CONTAINER_KEYS } from './loro-bridge.js'
import { WORKSPACE_TREE_KEY } from './workspace-tree.js'

/**
 * A document node's content key left holding anything but a container of the
 * kind `CONTENT_CONTAINER_KEYS` declares — a scalar, another kind of
 * container, or nothing — which every reader and writer of that document
 * opens there.
 */
export type ContentRootBreach = {
  readonly shape: 'content-root'
  readonly key: string
  /** The node's own map, so a caller can name the document. */
  readonly container: ContainerID
}

/**
 * A write into a container whose creating op is not in the write's own
 * causal past. Loro takes it in with no parent, so no bound finds it by its
 * path, and asking for that path traps the engine; once a later change
 * attaches the container, a replay of the history applies all of it while a
 * live state that took the two apart reads it empty.
 */
export type UnattachedContainerBreach = {
  readonly shape: 'unattached-container'
  /** The container written into. */
  readonly container: ContainerID
}

type Change = JsonSchema['changes'][number]

/** The Loro kind each content key's container is declared as. */
const CONTENT_KIND: ReadonlyMap<string, string> = new Map(
  CONTENT_CONTAINER_KEYS.map(({ key, kind }) => [key, kind === 'map' ? 'Map' : 'Text']),
)

/** A container id's creating op, or `null` for a root, which no op creates. */
function creatorOf(container: ContainerID): { peer: `${number}`; counter: number } | null {
  const match = /^cid:(\d+)@(\d+):/.exec(container)
  return match === null ? null : { peer: match[2] as `${number}`, counter: Number(match[1]) }
}

/**
 * Whether `doc` holds the op that creates `container` — true for a root. Only
 * then does the container have a parent, and only then is its path safe to
 * ask for.
 */
export function holdsContainerCreation(doc: LoroDoc, container: ContainerID): boolean {
  const creator = creatorOf(container)
  return creator === null || (doc.oplogVersion().get(creator.peer) ?? 0) > creator.counter
}

/**
 * The first container an op of `change` writes into without its creation in
 * the change's causal past — the change's own earlier ops, and what its deps
 * reach. A client can only write into a container it holds, so no real
 * peer's change has one.
 */
function unattachedIn(doc: LoroDoc, change: Change): ContainerID | null {
  const peer = change.id.slice(change.id.indexOf('@') + 1)
  let past: VersionVector | undefined
  for (const op of change.ops) {
    const creator = creatorOf(op.container)
    if (creator === null) continue
    if (creator.peer === peer && creator.counter < op.counter) continue
    past ??= doc.frontiersToVV(
      change.deps.map((dep) => {
        const at = dep.indexOf('@')
        return { peer: dep.slice(at + 1) as `${number}`, counter: Number(dep.slice(0, at)) }
      }),
    )
    if ((past.get(creator.peer) ?? 0) <= creator.counter) return op.container
  }
  return null
}

/**
 * The first write in `json` into an unattached container. Asked before any
 * path is: the path of such a container traps the engine.
 */
export function unattachedBreach(doc: LoroDoc, json: JsonSchema): UnattachedContainerBreach | null {
  for (const change of json.changes) {
    const container = unattachedIn(doc, change)
    if (container !== null) return { shape: 'unattached-container', container }
  }
  return null
}

/**
 * The content keys `json` sets or deletes in any map, by that map. Which map
 * is a tree node's own is asked once the state is up (`contentRootBreach`),
 * since a node the update itself creates has no path before.
 */
export function contentKeyWrites(json: JsonSchema): Map<ContainerID, Set<string>> {
  const written = new Map<ContainerID, Set<string>>()
  for (const change of json.changes) {
    for (const op of change.ops) {
      const content = op.content as { readonly key?: unknown }
      if (!op.container.endsWith(':Map') || typeof content.key !== 'string') continue
      if (!CONTENT_KIND.has(content.key)) continue
      written.set(op.container, (written.get(op.container) ?? new Set()).add(content.key))
    }
  }
  return written
}

/** Whether `container` is a workspace-tree node's own map, where a document's content keys sit. */
function isNodeMap(doc: LoroDoc, container: ContainerID): boolean {
  const path = doc.getPathToContainer(container)
  return path?.length === 2 && path[0] === WORKSPACE_TREE_KEY
}

/**
 * A node map the update left holding, at a content key it wrote, anything
 * but a container of the declared kind — read from the state, so a value
 * the same update put right, or a concurrent write that won the key, passes.
 */
export function contentRootBreach(
  doc: LoroDoc,
  written: ReadonlyMap<ContainerID, ReadonlySet<string>>,
): ContentRootBreach | null {
  for (const [container, keys] of written) {
    if (!isNodeMap(doc, container)) continue
    const map = doc.getContainerById(container) as LoroMap | undefined
    if (map === undefined) continue
    for (const key of keys) {
      if (containerKind(map.get(key)) !== CONTENT_KIND.get(key)) {
        return { shape: 'content-root', key, container }
      }
    }
  }
  return null
}
