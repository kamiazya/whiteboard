/**
 * Making one document's CONTENT equal another's, or copying it — the rule the
 * workspace tree's write, its restore and its projection all apply.
 *
 * It is one rule written three times until it was not: the tree write, the
 * standalone restore (`reconcileDocContent`, whose own comment said "same diff
 * rules as the tree write") and the value copy each dispatched on a
 * container's kind in their own words. What actually differs between them is
 * only WHERE the root containers live, which is `RootContainers`.
 *
 * Two properties the daemon depends on, both held here: a sync of equal
 * content commits NOTHING (per-save write-through would otherwise grow the
 * workspace log with copies of unchanged state), and a nested container
 * arrives as a container rather than a flattened value (a thread written back
 * as a value is lost across a restart).
 */
import { CONTAINER_NAME_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { type LoroDoc, LoroMap, LoroMovableList, LoroText } from 'loro-crdt'
import { CONTENT_CONTAINER_KEYS } from './loro-bridge.js'
import { openMergeableMap } from './mergeable-containers.js'
import { spliceText } from './minimal-change.js'

/**
 * Structural equality for the plain-JSON values the bridge stores in map
 * entries. Pairs still to compare are held on a stack rather than in
 * recursion, since a stored value is nested as deep as its writer chose.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  const pending: Array<readonly [unknown, unknown]> = [[a, b]]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [left, right] = next
    if (Object.is(left, right)) continue
    if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null)
      return false
    if (Array.isArray(left) !== Array.isArray(right)) return false
    const leftRec = left as Record<string, unknown>
    const rightRec = right as Record<string, unknown>
    const leftKeys = Object.keys(leftRec)
    if (leftKeys.length !== Object.keys(rightRec).length) return false
    for (const key of leftKeys) {
      if (!(key in rightRec)) return false
      pending.push([leftRec[key], rightRec[key]])
    }
  }
  return true
}

/**
 * The kind of container `value` is, or null for a plain value.
 *
 * A plain value may carry a `kind` FIELD (a thread anchor does); only a
 * container has the METHOD, which is what this asks.
 */
export function containerKind(value: unknown): string | null {
  return typeof value === 'object' &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === 'function'
    ? (value as { kind: () => string }).kind()
    : null
}

/**
 * Recreate a sequence container `LoroMap.set` cannot take — recreated whole,
 * the way `copyNodeData` carries it, rather than handed to `set` as a value.
 * Always a change: there is no cheaper equality for a container than the
 * rewrite itself.
 */
function recreateSequence(target: LoroMap, key: string, kind: string, wanted: unknown): true {
  if (target.get(key) !== undefined) target.delete(key)
  if (kind === 'Text') {
    target.setContainer(key, new LoroText()).insert(0, (wanted as LoroText).toString())
    return true
  }
  const list = target.setContainer(key, new LoroMovableList())
  for (const entry of (wanted as LoroMovableList).toJSON() as unknown[]) {
    list.push(entry as Parameters<typeof list.push>[0])
  }
  return true
}

/**
 * The child map a copy opens at `key`: mergeable, so two peers creating one
 * thread at once converge — unless its name could pass
 * `CONTAINER_NAME_MAX_CHARS`. A mergeable child is a root named by its
 * parent's id, rewritten and never longer, plus its key, and a root name long
 * enough leaves a record no keeper can open. Only data stored before the sync
 * judge refused such a key reaches the plain branch; every key a writer mints
 * is an id far inside the bound.
 */
function openCopiedMap(target: LoroMap, key: string): LoroMap {
  return target.id.length + key.length > CONTAINER_NAME_MAX_CHARS
    ? target.setContainer(key, new LoroMap())
    : openMergeableMap(target, key)
}

/**
 * Sync a nested MAP, replacing a value that sits where a container is wanted.
 * That value is what the flattening sync described on `syncMapEntries` wrote,
 * and replacing it is what makes the flattened thread read again.
 */
function syncNestedMap(target: LoroMap, key: string, wanted: LoroMap): boolean {
  const existing = target.get(key) as unknown
  if (existing instanceof LoroMap) return syncMapEntries(existing, wanted)
  if (existing !== undefined) target.delete(key)
  syncMapEntries(openCopiedMap(target, key), wanted)
  return true
}

/** One key of `syncMapEntries`: make `target[key]` equal `wanted`, answering whether it changed. */
function syncMapEntry(target: LoroMap, key: string, wanted: unknown): boolean {
  const kind = containerKind(wanted)
  if (kind === 'Text' || kind === 'MovableList' || kind === 'List') {
    return recreateSequence(target, key, kind, wanted)
  }
  if (wanted instanceof LoroMap) return syncNestedMap(target, key, wanted)
  const existing = target.get(key) as unknown
  if (existing instanceof LoroMap) {
    // A container where a value is wanted: nothing writes this shape today,
    // but replacing is the only answer that leaves the target equal to the
    // source.
    target.delete(key)
    target.set(key, wanted as Parameters<LoroMap['set']>[1])
    return true
  }
  if (jsonEqual(existing, wanted)) return false
  target.set(key, wanted as Parameters<LoroMap['set']>[1])
  return true
}

/**
 * Makes `target`'s entries equal `source`'s, entry by entry, and says
 * whether anything changed.
 *
 * Container-aware, which is the whole reason it exists: a thread under
 * `threads` and a proposal under `proposals` are nested CONTAINERS (mergeable,
 * so two peers writing one at once converge), and `toJSON()` flattens a
 * container into the object it holds. A sync that reads the projection and
 * `set`s what it finds writes the thread back as a VALUE — which the
 * record then carries across a restart, where the reader skips it and the
 * writer, asked to open a container at a key holding a value, throws.
 * Neither side of the round trip failed, and the loss showed only across a
 * restart. So an entry that is a container in the source is synced into a
 * container in the target, recursively, and only a plain value is `set`.
 *
 * A key that holds a value where the source has a container is a record
 * written by the flattening sync above: it is replaced by the container, so
 * the flattened thread reads again once its document is next saved.
 *
 * A DIFF: an equal entry commits nothing, so an identical sync leaves the
 * frontier where it was — the property the daemon's per-save write-through
 * depends on.
 */
function syncMapEntries(target: LoroMap, source: LoroMap): boolean {
  let changed = false
  for (const key of source.keys()) {
    if (syncMapEntry(target, key, source.get(key) as unknown)) changed = true
  }
  for (const key of target.keys()) {
    if (source.get(key) === undefined) {
      target.delete(key)
      changed = true
    }
  }
  return changed
}

/**
 * Make one ROOT container of a tree document equal the standalone source's,
 * answering whether it changed. The kind is read off the JSON projection: a
 * string is Text, an array a legacy sequence, an object a Map — the whole
 * vocabulary the bridge writes.
 */
export function syncRootContainer(
  roots: RootContainers,
  key: string,
  value: unknown,
  source: LoroDoc,
): boolean {
  if (typeof value === 'string') {
    // Only the changed span. A rich-text mark belongs to the characters it
    // covers — the annotation layer's passages on a markdown body — so
    // deleting every character and re-inserting it took every mark down,
    // for any write that changed anything anywhere.
    return spliceText(roots.text(key), value)
  }
  if (Array.isArray(value)) {
    // A legacy List/MovableList root (old clients' `elements`). Carried as a
    // VALUE copy — dropping a container kind the bridge does not favour would
    // turn a save into content loss. Rewritten wholesale on change: this shape
    // has no per-entry key to diff by.
    const list = roots.list(key)
    if (jsonEqual(list.toJSON(), value)) return false
    for (let i = list.length - 1; i >= 0; i--) list.delete(i, 1)
    for (const entry of value) list.push(entry as Parameters<typeof list.push>[0])
    return true
  }
  if (typeof value === 'object' && value !== null) {
    // The container, not its JSON: a nested container (a thread, a proposal)
    // has to arrive as one. See syncMapEntries.
    return syncMapEntries(roots.map(key), source.getMap(key))
  }
  return false
}

/**
 * Empty a bridge container the source never attached — "content equals the
 * source" includes what the source does not have. Answers whether anything
 * was there to remove, so an already-empty one commits nothing.
 */
export function clearRootContainer(
  roots: RootContainers,
  key: string,
  kind: 'map' | 'text' | 'list',
): boolean {
  if (kind === 'map') {
    const map = roots.map(key)
    const keys = Object.keys(map.toJSON() as Record<string, unknown>)
    for (const entryKey of keys) map.delete(entryKey)
    return keys.length > 0
  }
  if (kind === 'list') {
    const list = roots.list(key)
    const had = list.length > 0
    for (let i = list.length - 1; i >= 0; i--) list.delete(i, 1)
    return had
  }
  const text = roots.text(key)
  if (text.length === 0) return false
  text.delete(0, text.length)
  return true
}

/**
 * Where a document's ROOT containers live — the one thing the tree write and
 * the standalone restore differ in. A tree document keeps them on its node's
 * data map; a standalone document keeps them at its own root. Everything else
 * about making content equal a source is the same rule, so it is written once
 * against this.
 */
export interface RootContainers {
  text(key: string): LoroText
  list(key: string): LoroMovableList
  map(key: string): LoroMap
}

/**
 * A node's content key holding something other than the container a reader
 * opens there — a scalar, or a container of another kind. Thrown instead of
 * opening one over it: over a scalar the engine throws a bare string, and
 * over another kind it hands that container back, whose methods then misread
 * it or trap the engine (measured on loro-crdt 1.13.6: clearing a body held
 * as a map aborts with "memory access out of bounds").
 */
class UnreadableDocumentContentError extends Error {
  constructor(
    readonly key: string,
    readonly held: string,
  ) {
    super(`The document's ${JSON.stringify(key)} holds ${held}, not the content kept there`)
    this.name = 'UnreadableDocumentContentError'
  }
}

/** The Loro kinds a key may hold for a node to open it as `kind`; a legacy list is either. */
const OPENS_AS: Readonly<Record<'text' | 'list' | 'map', readonly string[]>> = {
  text: ['Text'],
  list: ['MovableList', 'List'],
  map: ['Map'],
}

/** Whether `data` holds nothing at `key`, or a container a node opens as `kind`. */
function holdsOpenable(data: LoroMap, key: string, kind: 'text' | 'list' | 'map'): boolean {
  const held: unknown = data.get(key)
  return held === undefined || OPENS_AS[kind].includes(containerKind(held) ?? '')
}

/** Whether `data` holds, at `key`, nothing or — for a content key — the container it is declared as. */
export function holdsDeclaredContent(data: LoroMap, key: string): boolean {
  const declared = CONTENT_CONTAINER_KEYS.find((content) => content.key === key)
  return declared === undefined || holdsOpenable(data, key, declared.kind)
}

/** The container at `key`, made when absent; never opened over anything else (`UnreadableDocumentContentError`). */
function openNodeContainer<C extends LoroText | LoroMovableList | LoroMap>(
  data: LoroMap,
  key: string,
  kind: 'text' | 'list' | 'map',
  fresh: () => C,
): C {
  if (!holdsOpenable(data, key, kind)) {
    const held: unknown = data.get(key)
    throw new UnreadableDocumentContentError(key, containerKind(held) ?? typeof held)
  }
  return data.getOrCreateContainer(key, fresh())
}

export const nodeRoots = (data: LoroMap): RootContainers => ({
  text: (key) => openNodeContainer(data, key, 'text', () => new LoroText()),
  list: (key) => openNodeContainer(data, key, 'list', () => new LoroMovableList()),
  map: (key) => openNodeContainer(data, key, 'map', () => new LoroMap()),
})

export const docRoots = (doc: LoroDoc): RootContainers => ({
  text: (key) => doc.getText(key),
  list: (key) => doc.getMovableList(key),
  map: (key) => doc.getMap(key),
})

/** The container kind a root's JSON projection says it is, or null for a scalar. */
export function projectedKind(value: unknown): 'text' | 'list' | 'map' | null {
  if (typeof value === 'string') return 'text'
  if (Array.isArray(value)) return 'list'
  if (typeof value === 'object' && value !== null) return 'map'
  return null
}

/** A stored container's kind as the JSON projection spells it (`projectedKind`). */
export const PROJECTED_KIND_OF: Readonly<Record<string, 'text' | 'list' | 'map'>> = {
  Text: 'text',
  Map: 'map',
  List: 'list',
  MovableList: 'list',
}

/**
 * Whether a source root may be written onto a node's `data` at `key`: never a
 * key in `reserved` — what the node keeps for itself, where a map at
 * `nameChosen` leaves it unreadable and a text at `name` names it at any
 * length — and never where the node already holds something of another kind,
 * a scalar (a retired field such as `currentBranch`) or a container the
 * root's projection does not match. Opening a container over either throws or
 * traps the engine part-way through a write, the roots before it written.
 */
export function rootFitsNode(
  data: LoroMap,
  key: string,
  value: unknown,
  reserved: ReadonlySet<string>,
): boolean {
  if (reserved.has(key)) return false
  const held: unknown = data.get(key)
  if (held === undefined) return true
  return PROJECTED_KIND_OF[containerKind(held) ?? ''] === projectedKind(value)
}

/**
 * Root containers made FRESH at each key, replacing whatever was there.
 * `nodeRoots` opens an existing one, which is right for a diff and wrong for a
 * copy: appending a source's text into a container that already holds some
 * would double it.
 */
export const freshNodeRoots = (data: LoroMap): RootContainers => ({
  text: (key) => data.setContainer(key, new LoroText()),
  list: (key) => data.setContainer(key, new LoroMovableList()),
  map: (key) => data.setContainer(key, new LoroMap()),
})

/**
 * Carry one container's VALUE into `into` at `key` — the copy rule restore and
 * projection share. Any kind not named here is dropped rather than
 * half-copied: nothing writes one today, and when something does this is
 * where it has to be taught, since a wrong copy would be worse than a visible
 * gap.
 */
export function copyContainerValue(
  into: RootContainers,
  key: string,
  kind: string,
  value: unknown,
): void {
  if (kind === 'Map') {
    syncMapEntries(into.map(key), value as LoroMap)
  } else if (kind === 'Text') {
    into.text(key).insert(0, (value as LoroText).toString())
  } else if (kind === 'MovableList' || kind === 'List') {
    // A legacy list root, carried as a value copy — see syncRootContainer's
    // array branch.
    const list = into.list(key)
    for (const entry of (value as LoroMovableList).toJSON() as unknown[]) {
      list.push(entry as Parameters<typeof list.push>[0])
    }
  }
}
