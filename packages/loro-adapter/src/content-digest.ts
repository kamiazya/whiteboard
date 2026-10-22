/**
 * The identity of a document's CONTENT, as a short string — what a picture of
 * the document is a picture OF.
 *
 * Why not the `updatedAt` register the tree entry already carries: a register
 * is one replica's word, and a merge does not consult it. Measured with two
 * replicas making disjoint edits (A adds a node at stamp 5000, B edits the
 * base node at stamp 2000) and then exchanging updates: on B the content
 * became `n0:edited-by-B, n1:added-by-A` — a state neither replica ever wrote
 * — while its `updatedAt` stayed 2000. A cache keyed on the stamp keeps
 * serving B's old picture of the old content under an unchanged key, and a
 * persistent cache keeps doing so past the end of the tab. The stamp names a
 * write; only the content itself names the state the merge produced.
 *
 * Computed from the projected content at read time, so it IS a function of
 * the merged state, and the same function on every keeper — the browser's
 * index and the daemon's both list through `readWorkspaceDocuments`.
 *
 * Canonical before hashing: a Loro map's JSON keys come out in whatever
 * order that replica's ops arrived, so two converged replicas can serialise
 * identical content differently. Sorting keys at every level is what makes
 * "same content" and "same digest" the same statement — and the property
 * test cross-merges replicas to hold this to that.
 *
 * cyrb53 rather than a cryptographic hash: this is a cache key, and it has to
 * be SYNCHRONOUS — the listing is — and free of `node:` and `SubtleCrypto`,
 * which is async and absent in some worker contexts. Sixty-four bits of
 * hex is enough to make an accidental collision between two states of one
 * document a non-event over any plausible history.
 */

import { compareCodeUnit } from '@kamiazya/whiteboard-model'
import { CONTENT_CONTAINER_KEYS } from './loro-bridge.js'

/**
 * A container that holds nothing is the same as no container. The workspace
 * tree pre-attaches every content container on a node (so an untouched
 * document carries `{}` and `''` under every key), a fresh standalone document
 * has only the containers something wrote, and a projection sits in between.
 * Same content, three JSON shapes — measured, the tree and the projection
 * agreed and the fresh document did not. Dropping empties at the CONTAINER
 * level is what makes the three one statement; nested empties stay, because
 * inside a container an empty object is content.
 */
function holdsNothing(value: unknown): boolean {
  if (value === '') return true
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value as object).length === 0
  )
}

/**
 * How deep the recursive form goes before a subtree is written with an
 * explicit stack. A stored value is nested as deep as its writer chose, and
 * recursion all the way overflowed the call stack at about 2500 levels — a
 * depth Loro itself stores, imports and reads back — which failed every
 * listing of the workspace holding it. Recursion is kept above the bound
 * because it is the faster form: measured on a 2000-node board, 10-12 ms a
 * digest against 22-27 ms for the stack.
 */
const RECURSIVE_DEPTH = 256

/** JSON with every object's keys sorted, at any depth. */
export function stableStringify(value: unknown): string {
  return stringifyWithin(value, 0)
}

function scalar(value: unknown): string | null {
  return value === null || typeof value !== 'object' ? (JSON.stringify(value) ?? 'null') : null
}

function stringifyWithin(value: unknown, depth: number): string {
  const leaf = scalar(value)
  if (leaf !== null) return leaf
  if (depth >= RECURSIVE_DEPTH) return stringifyWithStack(value as object)
  if (Array.isArray(value))
    return `[${value.map((item) => stringifyWithin(item, depth + 1)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort(compareCodeUnit)
  const members = keys.map(
    (key) => `${JSON.stringify(key)}:${stringifyWithin(record[key], depth + 1)}`,
  )
  return `{${members.join(',')}}`
}

/**
 * The same output with the work on a stack: a string on it is output, an
 * object is still to be written.
 */
function stringifyWithStack(root: object): string {
  const out: string[] = []
  const stack: Array<string | object> = [root]
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (typeof next === 'string') {
      out.push(next)
      continue
    }
    const array = Array.isArray(next)
    out.push(array ? '[' : '{')
    stack.push(array ? ']' : '}')
    pushMembers(stack, next as Record<string, unknown>, array)
  }
  return out.join('')
}

/** An array's items or an object's sorted entries, pushed so they pop in order. */
function pushMembers(
  stack: Array<string | object>,
  record: Record<string, unknown>,
  array: boolean,
): void {
  const keys = array ? null : Object.keys(record).sort(compareCodeUnit)
  const count = keys === null ? (record as unknown as unknown[]).length : keys.length
  for (let i = count - 1; i >= 0; i--) {
    const key = keys === null ? i : (keys[i] as string)
    const separator = i > 0 ? ',' : ''
    const label = keys === null ? '' : `${JSON.stringify(key)}:`
    const head = separator + label
    const item = record[key]
    const leaf = scalar(item)
    if (leaf !== null) stack.push(head + leaf)
    else {
      stack.push(item as object)
      if (head !== '') stack.push(head)
    }
  }
}

/** 53-bit-quality string hash (cyrb53), widened to 64 hex bits of output. */
function cyrb53(input: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

/**
 * The digest of a document's content containers, as `node.data.toJSON()`
 * hands them over. Key order and container order are both irrelevant to the
 * answer; only the values are.
 */
export function contentDigestOf(content: Record<string, unknown>): string {
  const held: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(content)) {
    if (!holdsNothing(value)) held[key] = value
  }
  return cyrb53(stableStringify(held))
}

/**
 * The same digest for a document whose containers are ROOTS of a standalone
 * Loro document — an editor session's, or a browser-kept markdown document's
 * — rather than keys on a tree node. Reads `toJSON()`, which reflects the
 * live state including edits not yet committed, so a key read at the moment
 * a change is published already names the picture of it.
 */
export function contentDigestOfDocument(doc: { toJSON(): unknown }): string {
  const raw = doc.toJSON() as Record<string, unknown>
  const content: Record<string, unknown> = {}
  // Own keys only: a root named `__proto__` becomes the projection's PROTOTYPE,
  // so `in` would read content the document does not hold.
  for (const { key } of CONTENT_CONTAINER_KEYS) if (Object.hasOwn(raw, key)) content[key] = raw[key]
  return contentDigestOf(content)
}
