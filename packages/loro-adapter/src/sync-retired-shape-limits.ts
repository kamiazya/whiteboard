// Whether a sync update NEWLY writes a shape an older version stored and no
// reader serves any more (`retired-stored-shape.ts`, `annotations.ts`). A
// record holding one is refused on read, so the daemon must not be the place
// one lands: the write is refused where it arrives, by name, with nothing kept.
//
// Judged from the update's operations, not by walking the record: the suspects
// are the keys an update inserts, read in the state before it (while the
// document is detached) and in the state after, and only a shape retired after
// and not before is refused. A delete is the repair and so never a suspect, and
// a document that already holds a shape stays editable.
//
// Every read here PEEKS. The daemon judges its cached record itself, so a root
// opened to look at it would ride the next save — asking a LoroDoc for a root
// it does not hold registers it, even through `getContainerById`.
import { documentKindSchema } from '@kamiazya/whiteboard-model'
import {
  type ContainerID,
  type JsonSchema,
  type LoroDoc,
  LoroList,
  LoroMap,
  LoroMovableList,
  LoroText,
  type TreeID,
} from 'loro-crdt'
import {
  CANVAS_KEY,
  DOCUMENT_KEY,
  type DocumentContainers,
  EDGES_KEY,
  NODES_KEY,
  RETIRED_COMMENTS_KEY,
  RETIRED_ELEMENTS_KEY,
} from './containers.js'
import {
  PRE_ADR_0037_EXTENSION_KEY,
  RETIRED_BODY_NODE_ID,
  retiredCanvasShape,
  retiredEdgeShape,
  retiredElementsShape,
  retiredMarkdownShape,
  retiredNodeShape,
} from './retired-stored-shape.js'
import { contentPathOf } from './sync-value-bounds.js'
import { WORKSPACE_TREE_KEY } from './workspace-tree.js'

/**
 * A shape the update newly wrote: `retired-shape` for a node, edge, canvas
 * setting, markdown body or elements list in a form no reader serves, and
 * `retired-comment-plane` for a row in the flat comments plane.
 */
export type RetiredShapeBreach =
  | {
      readonly shape: 'retired-shape'
      /** What was written, in the words the read refusal uses. */
      readonly found: string
      /** The map or list written into, so a caller can name the document. */
      readonly container: ContainerID
    }
  | {
      readonly shape: 'retired-comment-plane'
      /** How many rows the plane holds after the update. */
      readonly rows: number
      readonly container: ContainerID
    }

/** One place an update may have written a retired shape: a map key, or (key `null`) a list. */
export interface RetiredShapeSuspect {
  readonly container: ContainerID
  readonly key: string | null
}

type Family = 'nodes' | 'edges' | 'canvas' | 'comments' | 'elements'

const FAMILY_OF_KEY: ReadonlyMap<string, Family> = new Map([
  [NODES_KEY, 'nodes'],
  [EDGES_KEY, 'edges'],
  [CANVAS_KEY, 'canvas'],
  [RETIRED_COMMENTS_KEY, 'comments'],
  [RETIRED_ELEMENTS_KEY, 'elements'],
])

/**
 * What a suspect holds in one state when it is a retired shape. `weight` is
 * how much of it there is, so a list that only shrank is not newly written.
 */
interface Reading {
  readonly found: string
  readonly weight: number
  readonly rows: number
}

const isListId = (container: ContainerID) =>
  container.endsWith(':List') || container.endsWith(':MovableList')

/** The key an insert op writes at (`null` for a list's entry), or `undefined` when it is not an insert. */
function insertedKey(op: JsonSchema['changes'][number]['ops'][number]): string | null | undefined {
  const content = op.content as { readonly type?: unknown; readonly key?: unknown }
  if (content.type !== 'insert') return undefined
  if (isListId(op.container)) return null
  return op.container.endsWith(':Map') && typeof content.key === 'string' ? content.key : undefined
}

/**
 * The places `json` inserts into, once each. A delete is the repair and is
 * not one; a list is a suspect whatever it was given, since the entries it
 * holds are counted in the state.
 */
export function retiredShapeSuspects(json: JsonSchema): RetiredShapeSuspect[] {
  const seen = new Set<string>()
  const suspects: RetiredShapeSuspect[] = []
  for (const change of json.changes) {
    for (const op of change.ops) {
      const key = insertedKey(op)
      if (key === undefined) continue
      const id = `${op.container}\u0000${key ?? ''}`
      if (seen.has(id)) continue
      seen.add(id)
      suspects.push({ container: op.container, key })
    }
  }
  return suspects
}

/** One state of the document, with its roots listed once. */
class State {
  private roots: Record<string, unknown> | undefined
  constructor(readonly doc: LoroDoc) {}

  hasRoot(name: string): boolean {
    return this.rootId(name) !== undefined
  }

  rootId(name: string): ContainerID | undefined {
    this.roots ??= this.doc.getShallowValue()
    const cid = this.roots[name]
    return typeof cid === 'string' ? (cid as ContainerID) : undefined
  }
}

const peekedMap = (held: unknown): LoroMap | undefined =>
  held instanceof LoroMap ? held : undefined
const peekedList = (held: unknown): LoroList | LoroMovableList | undefined =>
  held instanceof LoroList || held instanceof LoroMovableList ? held : undefined
const peekedText = (held: unknown): LoroText | undefined =>
  held instanceof LoroText ? held : undefined

function refuseOpening(): never {
  throw new Error('judging a retired shape opens no container')
}

/** What a tree-node host's own meta map holds at `key`. */
const treeNodeMeta = (state: State, path: readonly (string | number)[], key: string): unknown =>
  state.doc
    .getTree(WORKSPACE_TREE_KEY)
    .getNodeByID(path[1] as TreeID)
    ?.data.get(key)

/**
 * The document a content container belongs to, as the readers see it: a
 * document root resolves a key only through the roots the state lists, a tree
 * node through its own meta map. Neither opens anything, so `getMap` and
 * `getText` are not offered.
 */
function hostOf(state: State, path: readonly (string | number)[]): DocumentContainers {
  const fetch = (key: string): unknown => {
    if (path.length > 1) return treeNodeMeta(state, path, key)
    const cid = state.rootId(key)
    return cid === undefined ? undefined : state.doc.getContainerById(cid)
  }
  return {
    getMap: refuseOpening,
    getText: refuseOpening,
    peekMap: (key) => peekedMap(fetch(key)),
    peekList: (key) => peekedList(fetch(key)),
    peekText: (key) => peekedText(fetch(key)),
    commit: refuseOpening,
  }
}

/**
 * The kind a body-node suspect's document is, envelope first and the tree
 * node's own meta when the envelope is silent — an unkinded envelope is no
 * reason to read a spatial document's text node as a markdown body.
 */
function documentIsSpatial(
  state: State,
  host: DocumentContainers,
  path: readonly (string | number)[],
): boolean {
  const stated = documentKindSchema.safeParse(host.peekMap?.(DOCUMENT_KEY)?.get('kind'))
  if (stated.success) return stated.data === 'spatial'
  if (path.length === 1) return false
  return documentKindSchema.safeParse(treeNodeMeta(state, path, 'kind')).data === 'spatial'
}

function readKey(
  state: State,
  family: Family,
  key: string,
  map: LoroMap,
  path: readonly (string | number)[],
): string | null {
  const value = map.get(key)
  switch (family) {
    case 'nodes': {
      const found = retiredNodeShape(key, value)
      if (found !== null || key !== RETIRED_BODY_NODE_ID || value === undefined) return found
      const host = hostOf(state, path)
      return documentIsSpatial(state, host, path) ? null : retiredMarkdownShape(host)
    }
    case 'edges':
      return retiredEdgeShape(key, value)
    case 'canvas':
      return key === PRE_ADR_0037_EXTENSION_KEY ? retiredCanvasShape(map) : null
    case 'comments':
      return value === undefined ? null : `a comment "${key}" in the flat comments plane`
    default:
      return null
  }
}

/** What `suspect` holds in `state` when it is a retired shape, or null. */
function read(state: State, suspect: RetiredShapeSuspect): Reading | null {
  const { doc } = state
  const path = contentPathOf(doc, suspect.container)
  if (path === undefined) return null
  // A root the state does not list is not there; asking for it would add it.
  if (path.length === 1 && !state.hasRoot(String(path[0]))) return null
  const family = FAMILY_OF_KEY.get(String(path.at(-1)))
  if (family === undefined) return null
  const held = doc.getContainerById(suspect.container)
  if (suspect.key === null) {
    const list = peekedList(held)
    if (family !== 'elements' || list === undefined) return null
    const found = retiredElementsShape(hostOf(state, path))
    return found === null ? null : { found, weight: list.length, rows: 0 }
  }
  const map = peekedMap(held)
  if (map === undefined || family === 'elements') return null
  const found = readKey(state, family, suspect.key, map, path)
  return found === null ? null : { found, weight: 1, rows: map.size }
}

/**
 * What each suspect holds in `doc`'s current state. Read while the document is
 * still the one before the update, a shape stored earlier is not the update's
 * doing; read after, it is the state the judgement compares against.
 */
export function retiredHeld(
  doc: LoroDoc,
  suspects: readonly RetiredShapeSuspect[],
): (Reading | null)[] {
  const state = new State(doc)
  return suspects.map((suspect) => {
    try {
      return read(state, suspect)
    } catch {
      // A container the update itself creates does not exist in the earlier state.
      return null
    }
  })
}

/** The first shape the update left standing that the state before it did not hold. */
export function retiredShapeBreach(
  doc: LoroDoc,
  suspects: readonly RetiredShapeSuspect[],
  before: readonly (Reading | null)[],
): RetiredShapeBreach | null {
  const after = retiredHeld(doc, suspects)
  for (const [index, now] of after.entries()) {
    const was = before[index]
    if (now === null || (was !== null && was !== undefined && now.weight <= was.weight)) continue
    const { container } = suspects[index] as RetiredShapeSuspect
    const path = contentPathOf(doc, container)
    return path?.at(-1) === RETIRED_COMMENTS_KEY
      ? { shape: 'retired-comment-plane', rows: now.rows, container }
      : { shape: 'retired-shape', found: now.found, container }
  }
  return null
}
