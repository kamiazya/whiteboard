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

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
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
  for (const { key } of CONTENT_CONTAINER_KEYS) if (key in raw) content[key] = raw[key]
  return contentDigestOf(content)
}
