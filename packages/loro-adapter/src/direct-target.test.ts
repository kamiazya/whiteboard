import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { directTarget } from './direct-target.js'
import { readMarkdownBody } from './markdown-body.js'
import { createWorkspaceDocumentAtPath, documentContainers } from './workspace-tree.js'

const DOCUMENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe('directTarget', () => {
  it('applies wire writes to the roots of a plain document and reads back what they wrote', () => {
    const doc = new LoroDoc()
    const target = directTarget(doc)

    target.apply([{ op: 'writeMarkdownBody', args: { body: '# root' } }])

    expect(target.body()).toBe('# root')
    expect(target.documentId).toBeUndefined()
    expect(target.coreFacets()).toBeUndefined()
  })

  it('applies writes to the tree node of a hosted document and leaves the roots alone', () => {
    const ws = new LoroDoc()
    createWorkspaceDocumentAtPath(ws, { path: 'note', documentId: DOCUMENT_ID, kind: 'markdown' })
    const target = directTarget(ws, DOCUMENT_ID)

    target.apply([{ op: 'writeMarkdownBody', args: { body: '# hosted', documentId: DOCUMENT_ID } }])

    expect(target.body()).toBe('# hosted')
    expect(readMarkdownBody(documentContainers(ws, DOCUMENT_ID))).toBe('# hosted')
    expect(ws.getText('body').toString()).toBe('')
  })

  it('refuses a write no writer answers to', () => {
    expect(() =>
      directTarget(new LoroDoc()).apply([{ op: 'noSuchWriter' as never, args: {} }]),
    ).toThrow('no writer named noSuchWriter')
  })
})
