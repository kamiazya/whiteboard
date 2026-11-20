/**
 * The conformance cases for naming a document by its path in
 * `workspaceDocumentEntry`: the document that owns the path, as the listing
 * names it, and nothing for a path no document owns. A keeper resolves a path
 * on every checkpoint and listing, so the read must not cost the record.
 */
import { describe, expect, it } from 'vitest'
import type { CrdtEngine } from '../engine/types.js'
import { ask, held, write } from './crdt-engine-conformance-kit.js'

const NOTE = '01J000000000000000000000E1'
const CHILD = '01J000000000000000000000E2'
const FIRST_CLAIM = '01J000000000000000000000E3'
const SECOND_CLAIM = '01J000000000000000000000E4'

type Entry = { documentId: string; path: string; shadowed?: true } | null

const entryAt = async (engine: CrdtEngine, handle: number, path: string) =>
  (await ask(engine, handle, 'workspaceDocumentEntry', { path })) as { ok: Entry }

function placed(engine: CrdtEngine) {
  const { handle } = engine.open({ peer: '5' })
  const create = (path: string, documentId: string) =>
    write(engine, handle, 'createWorkspaceDocumentAtPath', { path, documentId, kind: 'markdown' })
  create('note', NOTE)
  create('note/child', CHILD)
  create('folder/inside', '01J000000000000000000000E5')
  return { handle, create }
}

/** Two replicas that each created a document at `dup`, merged: the path is claimed twice. */
function claimedTwice(makeEngine: () => CrdtEngine) {
  const engine = makeEngine()
  const { handle, create } = placed(engine)
  create('dup', FIRST_CLAIM)
  const other = makeEngine()
  const otherHandle = other.open({ peer: '6' }).handle
  write(other, otherHandle, 'createWorkspaceDocumentAtPath', {
    path: 'dup',
    documentId: SECOND_CLAIM,
    kind: 'markdown',
  })
  const { bytes } = other.export({ handle: otherHandle, mode: 'update' })
  engine.import({ handle, bytes: bytes as string, judge: 'none' })
  return { engine, handle }
}

function describePathLookup(makeEngine: () => CrdtEngine) {
  it('answers the document at a plain path and one nested under a document', async () => {
    const engine = makeEngine()
    const { handle } = placed(engine)
    expect((await entryAt(engine, handle, 'note')).ok).toMatchObject({
      documentId: NOTE,
      path: 'note',
    })
    expect((await entryAt(engine, handle, 'note/child')).ok).toMatchObject({
      documentId: CHILD,
      path: 'note/child',
    })
  })

  it('answers the same entry as the one the id names', async () => {
    const engine = makeEngine()
    const { handle } = placed(engine)
    const byPath = await entryAt(engine, handle, 'note/child')
    expect(await ask(engine, handle, 'workspaceDocumentEntry', { documentId: CHILD })).toEqual(
      byPath,
    )
  })

  it('answers nothing for a path no document owns, and for the path of a folder', async () => {
    const engine = makeEngine()
    const { handle } = placed(engine)
    expect(await entryAt(engine, handle, 'missing')).toEqual({ ok: null })
    expect(await entryAt(engine, handle, 'folder')).toEqual({ ok: null })
  })

  it('answers the owner of a path two documents claim, the one the listing does not shadow', async () => {
    const { engine, handle } = claimedTwice(makeEngine)
    const listed = (await ask(engine, handle, 'documents')) as { ok: NonNullable<Entry>[] }
    const claimants = listed.ok.filter((entry) => entry.path === 'dup')
    expect(claimants.map((entry) => entry.documentId).sort()).toEqual([FIRST_CLAIM, SECOND_CLAIM])
    const owner = claimants.find((entry) => entry.shadowed !== true)
    expect((await entryAt(engine, handle, 'dup')).ok).toMatchObject({
      documentId: owner?.documentId,
    })
  })
}

function describePathLookupLimits(makeEngine: () => CrdtEngine) {
  it('refuses a read that names both an id and a path, and one that names neither', async () => {
    const engine = makeEngine()
    const { handle } = placed(engine)
    const both = { documentId: NOTE, path: 'note' }
    expect(await ask(engine, handle, 'workspaceDocumentEntry', both)).toEqual({ err: 'TypeError' })
    expect(await ask(engine, handle, 'workspaceDocumentEntry', {})).toEqual({ err: 'TypeError' })
  })

  it('opens no container and moves no version', async () => {
    const engine = makeEngine()
    const { handle } = placed(engine)
    const roots = () => Object.keys(held(engine, handle, 'snapshot').getShallowValue()).sort()
    const before = { roots: roots(), version: engine.version({ handle }).encodedFrontiers }
    await entryAt(engine, handle, 'note')
    await entryAt(engine, handle, 'missing')
    expect({ roots: roots(), version: engine.version({ handle }).encodedFrontiers }).toEqual(before)
  })
}

export function describeEntryByPath(makeEngine: () => CrdtEngine) {
  describe('the workspace document entry named by a path', () => {
    describePathLookup(makeEngine)
    describePathLookupLimits(makeEngine)
  })
}
