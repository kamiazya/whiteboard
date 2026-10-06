import { CONTAINER_NAME_MAX_CHARS, ID_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { writeCommentThread } from './comment-threads.js'
import { PROPOSALS_KEY, THREADS_KEY } from './containers.js'
import { openMergeableMap } from './mergeable-containers.js'
import {
  importWithinTextLimits,
  SYNC_TEXT_BREACH_CODES,
  syncTextLimitJudge,
} from './sync-text-limits.js'
import { createWorkspaceDocumentAtPath, documentContainers } from './workspace-tree.js'

const DOC_ID = '01BRWAAAAAAAAAAAAAAAAAAAA0'

/** A workspace record holding one board, as the daemon and the browser keep it. */
function record(seed: (doc: LoroDoc) => void = () => {}): LoroDoc {
  const doc = new LoroDoc()
  createWorkspaceDocumentAtPath(doc, { path: 'board', documentId: DOC_ID, kind: 'spatial' })
  seed(doc)
  doc.commit()
  return doc
}

function updateFrom(base: LoroDoc, edit: (doc: LoroDoc) => void): Uint8Array {
  const client = base.fork()
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return client.export({ mode: 'update', from })
}

/** Both keepers' verdicts, which must agree. */
function judged(base: LoroDoc, update: Uint8Array) {
  const imported = importWithinTextLimits(base.fork(), update).breach
  expect(syncTextLimitJudge(base)(update)).toEqual(imported)
  return imported
}

/** A board's thread plane, where a thread opens a container named by its id. */
const threadsOf = (doc: LoroDoc) => documentContainers(doc, DOC_ID).getMap(THREADS_KEY)

/** The name a container id carries, or `''` for one a peer's op id names. */
function nameOf(id: string): string {
  return id.startsWith('cid:root-') ? id.slice('cid:root-'.length, id.lastIndexOf(':')) : ''
}

/**
 * A thread key whose container's name is exactly `chars` long, measured on
 * the record rather than derived from how the engine spells a name.
 */
function threadKeyNaming(base: LoroDoc, chars: number): string {
  const probe = base.fork()
  const overhead = nameOf(openMergeableMap(threadsOf(probe), 'k').id).length - 1
  return 'k'.repeat(chars - overhead)
}

/** The record still imports whole once a fresh keeper reads it back. */
function reopens(doc: LoroDoc): boolean {
  try {
    new LoroDoc().import(doc.export({ mode: 'snapshot' }))
    return true
  } catch {
    return false
  }
}

describe('a container name brought in by a sync update', () => {
  it('refuses a root container named past the limit', () => {
    const base = record()
    const update = updateFrom(base, (doc) =>
      doc.getMap('r'.repeat(CONTAINER_NAME_MAX_CHARS + 1)).set('a', 1),
    )
    expect(judged(base, update)).toEqual({
      shape: 'container-name',
      chars: CONTAINER_NAME_MAX_CHARS + 1,
      container: expect.any(String),
    })
  })

  it('refuses a thread whose key names its container past the limit', () => {
    const base = record()
    const key = threadKeyNaming(base, CONTAINER_NAME_MAX_CHARS + 1)
    const update = updateFrom(base, (doc) =>
      openMergeableMap(threadsOf(doc), key).set('status', 'open'),
    )
    expect(judged(base, update)).toEqual({
      shape: 'container-name',
      chars: CONTAINER_NAME_MAX_CHARS + 1,
      container: expect.any(String),
    })
  })

  it('refuses a key that only opens a container, writing nothing into it', () => {
    // Opening alone puts the name in the record: a snapshot holding one past
    // the engine's own bound no longer imports, with no op ever written there.
    const base = record()
    const key = threadKeyNaming(base, CONTAINER_NAME_MAX_CHARS + 1)
    const update = updateFrom(base, (doc) => {
      threadsOf(doc).ensureMergeableMap(key)
    })
    expect(judged(base, update)).toMatchObject({
      shape: 'container-name',
      chars: CONTAINER_NAME_MAX_CHARS + 1,
    })
  })

  it('takes names of exactly the limit', () => {
    const base = record()
    const key = threadKeyNaming(base, CONTAINER_NAME_MAX_CHARS)
    const update = updateFrom(base, (doc) => {
      doc.getMap('r'.repeat(CONTAINER_NAME_MAX_CHARS)).set('a', 1)
      openMergeableMap(threadsOf(doc), key).set('status', 'open')
    })
    expect(judged(base, update)).toBeNull()
  })

  it('takes a thread and a proposal whose ids are at the id limit, nested as deep as written', () => {
    const base = record()
    const id = 'i'.repeat(ID_MAX_CHARS)
    const update = updateFrom(base, (doc) => {
      writeCommentThread(documentContainers(doc, DOC_ID), {
        id,
        anchor: { kind: 'document' },
        status: 'open',
        messages: [{ id, body: 'hello' }],
      })
      const proposal = openMergeableMap(documentContainers(doc, DOC_ID).getMap(PROPOSALS_KEY), id)
      openMergeableMap(proposal, 'changes').set(id, { id })
    })
    expect(judged(base, update)).toBeNull()
  })

  it('takes a write into a long-named container the record already holds', () => {
    // A thread opened under a long id before the bound still takes a reply.
    const key = 'k'.repeat(CONTAINER_NAME_MAX_CHARS + 100)
    const base = record((doc) => {
      openMergeableMap(threadsOf(doc), key).set('status', 'open')
      doc.getMap(`r${key}`).set('a', 1)
    })
    const update = updateFrom(base, (doc) => {
      openMergeableMap(threadsOf(doc), key).set('status', 'resolved')
      doc.getMap(`r${key}`).set('a', 2)
    })
    expect(judged(base, update)).toBeNull()
  })

  it('refuses a long name that a record holds into an empty document', () => {
    const base = record((doc) => {
      openMergeableMap(threadsOf(doc), 'k'.repeat(CONTAINER_NAME_MAX_CHARS)).set('a', 1)
    })
    expect(
      importWithinTextLimits(new LoroDoc(), base.export({ mode: 'snapshot' })).breach,
    ).toMatchObject({ shape: 'container-name' })
  })

  it.each([
    ['a root container', (doc: LoroDoc) => doc.getMap('r'.repeat(70_000)).set('a', 1)],
    [
      'a thread key',
      (doc: LoroDoc) => openMergeableMap(threadsOf(doc), 't'.repeat(70_000)).set('a', 1),
    ],
  ])('refuses %s long enough that the record would no longer import', (_, edit) => {
    const base = record()
    const update = updateFrom(base, edit)
    const taken = base.fork()
    taken.import(update)
    // The premise: kept, this update leaves a record no keeper can open.
    expect(reopens(taken)).toBe(false)
    expect(judged(base, update)).toMatchObject({ shape: 'container-name' })
  })

  it('needs more bytes than the limit to name a container past it', () => {
    // The judge answers an update no longer than the limit without applying
    // it, so no shorter update may name a container past the limit — the
    // deepest name a record nests included, under a tree node's own map.
    const base = record()
    const shapes = [
      (doc: LoroDoc) => doc.getMap('r'.repeat(CONTAINER_NAME_MAX_CHARS + 1)).set('a', 1),
      (doc: LoroDoc) => {
        threadsOf(doc).ensureMergeableMap(threadKeyNaming(base, CONTAINER_NAME_MAX_CHARS + 1))
      },
      (doc: LoroDoc) => {
        const nested = new LoroMap()
        const parent = threadsOf(doc).setContainer('p', nested)
        parent.ensureMergeableMap('k'.repeat(CONTAINER_NAME_MAX_CHARS))
      },
    ]
    for (const edit of shapes) {
      expect(updateFrom(base, edit).byteLength).toBeGreaterThan(CONTAINER_NAME_MAX_CHARS)
    }
  })

  it('answers a long container name with its own refusal code', () => {
    expect(SYNC_TEXT_BREACH_CODES['container-name']).toBe('container_name_too_long')
  })
})
