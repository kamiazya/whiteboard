// The names of the containers a sync update brings into a record, judged
// against `CONTAINER_NAME_MAX_CHARS`. Loro writes a root container's name
// whole into every snapshot, and a mergeable child — a comment thread, a
// proposal, the maps inside them — is a root named by its parent and its key.
// A name long enough breaks the snapshot for every document in the record
// while the update that wrote it still imports, so the bound is held where
// an update arrives rather than where a record is read back.
import { CONTAINER_NAME_MAX_CHARS } from '@kamiazya/whiteboard-model'
import type { ContainerID, JsonSchema, LoroDoc, LoroMap, MapOp } from 'loro-crdt'

type Op = JsonSchema['changes'][number]['ops'][number]

const ROOT_PREFIX = 'cid:root-'

/** The length of the name a root container's id carries; 0 for a container a peer's op id names. */
function nameLength(container: ContainerID): number {
  return container.startsWith(ROOT_PREFIX) ? container.lastIndexOf(':') - ROOT_PREFIX.length : 0
}

/**
 * Where an update may bring a long name in: a container one of its ops
 * writes, or the child a map insert opens at `key`, which may hold no op of
 * its own and still be named in the record.
 */
export interface NameSuspect {
  readonly container: ContainerID
  readonly key?: string
}

/** A container an update brought in under a name past the bound. */
export interface LongContainerName {
  readonly chars: number
  readonly container: ContainerID
}

/**
 * The suspects one op contributes. A child's name is its parent's id
 * rewritten — never longer — plus its key, so a map insert whose parent id
 * and key together fit the bound cannot open a child past it, and is passed
 * over without looking the child up.
 */
export function nameSuspectsOf(op: Op): NameSuspect[] {
  const suspects: NameSuspect[] = []
  if (nameLength(op.container) > CONTAINER_NAME_MAX_CHARS) {
    suspects.push({ container: op.container })
  }
  const content = op.content as MapOp
  if (
    op.container.endsWith(':Map') &&
    content.type === 'insert' &&
    op.container.length + content.key.length > CONTAINER_NAME_MAX_CHARS
  ) {
    suspects.push({ container: op.container, key: content.key })
  }
  return suspects
}

/** The container a suspect names in `doc`'s current state, or `undefined` for none. */
function containerAt(doc: LoroDoc, { container, key }: NameSuspect): ContainerID | undefined {
  if (key === undefined) return container
  try {
    const child = (doc.getContainerById(container) as LoroMap | undefined)?.get(key)
    const id = (child as { id?: unknown } | undefined)?.id
    return typeof id === 'string' ? (id as ContainerID) : undefined
  } catch {
    // A parent the update itself creates does not exist in the earlier state.
    return undefined
  }
}

/**
 * Whether `container` is in `doc`'s current state. A mergeable child is found
 * only once its parent holds it; a root resolves whatever its name, so a
 * root counts as held only when the state lists it.
 */
function holds(doc: LoroDoc, container: ContainerID): boolean {
  const path = doc.getPathToContainer(container)
  if (path === undefined) return false
  if (path.length > 1) return true
  return String(path[0]) in doc.getShallowValue()
}

/**
 * The long-named containers `doc` holds now, read while its state is still
 * the one before the update: a name stored before the bound is not the
 * update's doing, and a write into it — a reply to a thread opened under a
 * long id — is let through.
 */
export function heldBefore(doc: LoroDoc, suspects: readonly NameSuspect[]): Set<ContainerID> {
  const held = new Set<ContainerID>()
  for (const suspect of suspects) {
    const container = containerAt(doc, suspect)
    if (container !== undefined && holds(doc, container)) held.add(container)
  }
  return held
}

/** The first container the update brought in under a name past the bound, judged on the state after it. */
export function longNameBreach(
  doc: LoroDoc,
  suspects: readonly NameSuspect[],
  before: ReadonlySet<ContainerID>,
): LongContainerName | null {
  for (const suspect of suspects) {
    const container = containerAt(doc, suspect)
    if (container === undefined || before.has(container)) continue
    const chars = nameLength(container)
    if (chars > CONTAINER_NAME_MAX_CHARS) return { chars, container }
  }
  return null
}
