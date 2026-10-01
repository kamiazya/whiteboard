/**
 * Every content container is something the digest SEES.
 *
 * The digest properties assert equality — one content, one digest, in either
 * merge order — so a digest that ignored a whole container would pass them
 * all: two documents differing only there are, to it, the same document, and
 * a picture cached under its key is served for content it never drew.
 *
 * What the digest reads is `CONTENT_CONTAINER_KEYS`, and what a document HAS
 * is the `*_KEY` constants in `containers.ts`. Two lists written by hand
 * drift in the direction that costs nothing to miss: a container added to the
 * second and never to the first reads, writes and syncs perfectly, and simply
 * never changes the document's identity.
 *
 * So the rows below are driven from the constants, not from the list under
 * test — deriving them from the list would drop a row together with the entry
 * it should have caught. A key is covered by being listed, or by an entry in
 * `EXEMPT` saying why a write into it is not a change to the document.
 */
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import * as containers from './containers.js'
import { contentDigestOfDocument } from './content-digest.js'
import { CONTENT_CONTAINER_KEYS } from './loro-bridge.js'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readWorkspaceDocuments,
} from './workspace-tree.js'

type ContainerKeyName = Extract<keyof typeof containers, `${string}_KEY`>

const KEY_NAMES = Object.keys(containers).filter((name): name is ContainerKeyName =>
  name.endsWith('_KEY'),
)
const keyOf = (name: ContainerKeyName): string => String(Reflect.get(containers, name))

/**
 * What a write into each container looks like. Exhaustive by type: a new
 * `*_KEY` constant is a compile error here until somebody says what it holds.
 */
const KIND = {
  COMMENTS_KEY: 'map',
  THREADS_KEY: 'map',
  PROPOSALS_KEY: 'map',
  NODES_KEY: 'map',
  EDGES_KEY: 'map',
  LINES_KEY: 'map',
  CANVAS_KEY: 'map',
  FACETS_KEY: 'map',
  NODE_LOCKS_KEY: 'map',
  EDGE_LOCKS_KEY: 'map',
  CORE_KEY: 'map',
  TRUST_KEY: 'map',
  DOCUMENT_KEY: 'map',
  MARKDOWN_BODY_KEY: 'text',
} as const satisfies Record<ContainerKeyName, 'map' | 'text'>

/**
 * Containers a write into which is deliberately NOT a change to the document,
 * with why. Empty today: every container in `containers.ts` is content. An
 * entry here is a decision that two documents differing only in that
 * container are the same document, which is rarely true of anything stored.
 */
const EXEMPT: Partial<Record<ContainerKeyName, string>> = {}

const listedKeys = new Set(CONTENT_CONTAINER_KEYS.map((c) => c.key))
const exemptNames = Object.keys(EXEMPT) as ContainerKeyName[]
const covered = KEY_NAMES.filter((name) => EXEMPT[name] === undefined)

const ID = '01JQXYZ0000000000000000000'

describe('every container in containers.ts is part of what the digest identifies', () => {
  it('finds the constants it is about', () => {
    // A scan that reaches nothing passes everything below.
    expect(KEY_NAMES.length).toBeGreaterThan(10)
    expect(listedKeys.size).toBeGreaterThan(10)
  })

  it.each(covered)('a write into %s moves the digest of a tree-hosted document', (name) => {
    const ws = new LoroDoc()
    createWorkspaceDocumentAtPath(ws, { path: 'a', documentId: ID, kind: 'spatial' })
    const digestOf = (): string => {
      const found = readWorkspaceDocuments(ws).find((e) => e.documentId === ID)
      if (found === undefined) throw new Error('document not listed')
      return found.contentDigest
    }
    const before = digestOf()

    const host = documentContainers(ws, ID)
    if (KIND[name] === 'text') host.getText(keyOf(name)).insert(0, 'probe')
    else host.getMap(keyOf(name)).set('probe', 1)
    host.commit()

    expect(digestOf()).not.toBe(before)
  })

  it.each(covered)('a write into %s moves the digest of a standalone document', (name) => {
    const doc = new LoroDoc()
    const before = contentDigestOfDocument(doc)

    if (KIND[name] === 'text') doc.getText(keyOf(name)).insert(0, 'probe')
    else doc.getMap(keyOf(name)).set('probe', 1)
    doc.commit()

    expect(contentDigestOfDocument(doc)).not.toBe(before)
  })

  it('lists every container, or exempts it with a reason', () => {
    const unaccounted = KEY_NAMES.filter(
      (name) => !listedKeys.has(keyOf(name)) && EXEMPT[name] === undefined,
    )
    expect(unaccounted).toEqual([])
  })

  it('lists no container that containers.ts does not name', () => {
    const named = new Set(KEY_NAMES.map(keyOf))
    expect([...listedKeys].filter((key) => !named.has(key))).toEqual([])
  })

  it('exempts only constants that exist, each with a reason', () => {
    expect(exemptNames.filter((name) => !KEY_NAMES.includes(name))).toEqual([])
    expect(exemptNames.filter((name) => (EXEMPT[name] ?? '').trim() === '')).toEqual([])
  })

  it('does not exempt a container the digest already covers', () => {
    expect(exemptNames.filter((name) => listedKeys.has(keyOf(name)))).toEqual([])
  })

  it('lists each container under the kind a write into it needs', () => {
    const mismatched = CONTENT_CONTAINER_KEYS.filter((entry) => {
      const name = KEY_NAMES.find((n) => keyOf(n) === entry.key)
      return name !== undefined && KIND[name] !== entry.kind
    })
    expect(mismatched).toEqual([])
  })
})
