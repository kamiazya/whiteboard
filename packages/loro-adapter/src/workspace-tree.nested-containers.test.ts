import { LoroDoc, LoroMovableList, LoroText } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  createWorkspaceDocument,
  projectWorkspaceDocument,
  writeWorkspaceDocumentContent,
} from './workspace-tree.js'

const ID = '01HZZZZZZZZZZZZZZZZZZZZZZ2'

/**
 * A map entry that is itself a text or a list container. `LoroMap.set`
 * takes a value, not a container, so a fold that met one at a nested key
 * would hand it to `set`; the fold recreates it the way the node copy does.
 */
describe('a nested text or list container survives the fold', () => {
  it('folds a text and a list under a map, and projects them back as containers', () => {
    const record = new LoroDoc()
    record.setPeerId(1n)
    createWorkspaceDocument(record, { documentId: ID, segment: 'note', kind: 'spatial' })

    const live = new LoroDoc()
    const meta = live.getMap('meta')
    meta.setContainer('note', new LoroText()).insert(0, 'keep me')
    const list = meta.setContainer('steps', new LoroMovableList())
    list.push('one')
    list.push('two')
    live.commit()

    writeWorkspaceDocumentContent(record, ID, live)
    const projected = projectWorkspaceDocument(
      LoroDoc.fromSnapshot(record.export({ mode: 'snapshot' })),
      ID,
    )
    expect(projected).not.toBeNull()
    if (projected === null) throw new Error('unreachable')
    expect(projected.getMap('meta').toJSON()).toEqual({ note: 'keep me', steps: ['one', 'two'] })
    // Containers, not value copies: a later edit lands in the same text.
    const note = projected.getMap('meta').get('note')
    expect(note instanceof LoroText).toBe(true)
  })
})
