/**
 * A document's content and its node's own meta share one map on the tree
 * node, so a content write that took any root the source holds would let the
 * source rewrite the node: a map named `nameChosen` leaves the node unreadable
 * (every listing then skips it and its subtree), a text named `name` gives it
 * a display name of any length, and a root whose kind differs from what the
 * node already holds at that key traps the engine midway through the write.
 * The source is whatever a client's per-document update made it, so the write
 * has to hold for EVERY set of roots, not the bridge's alone.
 */
import { LoroDoc } from 'loro-crdt'
import { describe, expect } from 'vitest'
import { MARKDOWN_BODY_KEY } from './containers.js'
import { CONTENT_CONTAINER_KEYS } from './loro-bridge.js'
import { fc, fcTest } from './test-utils/fast-check.js'
import {
  createWorkspaceDocument,
  readWorkspaceDocuments,
  WORKSPACE_TREE_KEY,
  workspaceNodeMetaSchema,
  writeWorkspaceDocumentContent,
} from './workspace-tree.js'

const DOCUMENT_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ'
const LEGACY_SCALAR = 'currentBranch'

type RootKind = 'text' | 'map' | 'list'
interface Root {
  readonly name: string
  readonly kind: RootKind
  readonly value: string
}

// Dense on purpose: every name a node already holds something at, so almost
// every case collides with meta, a content container or a legacy scalar.
const rootName = fc.constantFrom(
  ...Object.keys(workspaceNodeMetaSchema.shape),
  ...CONTENT_CONTAINER_KEYS.map(({ key }) => key),
  LEGACY_SCALAR,
  'extra',
)
const rootArbitrary: fc.Arbitrary<Root> = fc.record({
  name: rootName,
  kind: fc.constantFrom<RootKind>('text', 'map', 'list'),
  value: fc.string({ minLength: 1, maxLength: 300 }),
})

function sourceWith(roots: readonly Root[]): LoroDoc {
  const source = new LoroDoc()
  for (const { name, kind, value } of roots) {
    if (kind === 'text') source.getText(name).insert(0, value)
    else if (kind === 'map') source.getMap(name).set('k', value)
    else source.getMovableList(name).push(value)
  }
  source.commit()
  return source
}

function recordHolding(named: boolean, legacyScalar: boolean): LoroDoc {
  const record = new LoroDoc()
  createWorkspaceDocument(record, {
    documentId: DOCUMENT_ID,
    segment: 'notes',
    kind: 'markdown',
    ...(named ? { name: 'Original' } : {}),
  })
  if (legacyScalar) {
    const node = record
      .getTree(WORKSPACE_TREE_KEY)
      .getNodes()
      .find((each) => each.data.get('documentId') === DOCUMENT_ID)
    node?.data.set(LEGACY_SCALAR, 'main')
    record.commit()
  }
  return record
}

/** The meta a content write must leave as it was: all of it but the edit stamp. */
function heldMeta(record: LoroDoc) {
  const entry = readWorkspaceDocuments(record).find((each) => each.documentId === DOCUMENT_ID)
  if (entry === undefined) return undefined
  const { documentId, segment, kind, name, nameChosen, createdAt } = entry
  return { documentId, segment, kind, name, nameChosen, createdAt }
}

describe('writeWorkspaceDocumentContent against roots a node already keys', () => {
  fcTest.prop([
    fc.array(rootArbitrary, { minLength: 1, maxLength: 6 }),
    fc.boolean(),
    fc.boolean(),
  ])(
    'leaves the node listed with its meta untouched, whatever roots the source holds',
    (roots, named, legacyScalar) => {
      const record = recordHolding(named, legacyScalar)
      const before = heldMeta(record)

      expect(writeWorkspaceDocumentContent(record, DOCUMENT_ID, sourceWith(roots))).toBe(true)

      expect(heldMeta(record)).toEqual(before)
    },
  )

  fcTest.prop([fc.array(rootArbitrary, { maxLength: 6 }), fc.string({ minLength: 1 })])(
    'still writes a content root of the kind the node holds it as',
    (others, body) => {
      const record = recordHolding(false, false)
      // A second root under the body's own name is the first property's
      // case; this one asks only that the rest do not stop the body landing.
      const source = sourceWith(others.filter(({ name }) => name !== MARKDOWN_BODY_KEY))
      source.getText(MARKDOWN_BODY_KEY).insert(0, body)
      source.commit()

      writeWorkspaceDocumentContent(record, DOCUMENT_ID, source)

      const node = record
        .getTree(WORKSPACE_TREE_KEY)
        .getNodes()
        .find((each) => each.data.get('documentId') === DOCUMENT_ID)
      const held = node?.data.toJSON() as Record<string, unknown> | undefined
      expect(held?.[MARKDOWN_BODY_KEY]).toBe(body)
    },
  )
})
