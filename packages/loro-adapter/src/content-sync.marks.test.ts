// A whole-body write that changes one place must not take down the passage
// marks on the text it did not change. A mark belongs to the characters it
// covers, so a write that deletes and re-inserts every character removes
// every mark — the annotation layer's passages — for an edit nowhere near
// them. Both writers that project a plain body back into a live document go
// through `syncRootContainer`: the daemon's content write (an MCP body edit,
// `wb_workspace_edit`'s document.set) and a version restore.
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { writeMarkdownBody } from './markdown-body.js'
import { markThreadPassages, readThreadMarks } from './thread-marks.js'
import {
  createWorkspaceDocument,
  documentContainers,
  reconcileDocContent,
  writeWorkspaceDocumentContent,
} from './workspace-tree.js'

const DOCUMENT_ID = '01JZZZZZZZZZZZZZZZZZZZZZZZ'
const BODY = 'Ship the report on Friday. The draft is not written.'
const PASSAGE = 'report on Friday'
const AT = { start: BODY.indexOf(PASSAGE), end: BODY.indexOf(PASSAGE) + PASSAGE.length }
/** The same body with one edit far from the passage. */
const EDITED = `${BODY} Done by Thursday.`

/** A standalone document holding just a body — the projection a writer hands over. */
function bodyDoc(body: string): LoroDoc {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, body)
  return doc
}

describe('a passage mark on untouched text', () => {
  it('survives the daemon writing the document body', () => {
    const record = new LoroDoc()
    createWorkspaceDocument(record, {
      documentId: DOCUMENT_ID,
      segment: 'notes',
      kind: 'markdown',
    })
    const containers = documentContainers(record, DOCUMENT_ID)
    writeMarkdownBody(containers, BODY)
    markThreadPassages(record, containers, new Map([['t1', AT]]))

    writeWorkspaceDocumentContent(record, DOCUMENT_ID, bodyDoc(EDITED))

    expect(containers.getText('body').toString()).toBe(EDITED)
    expect(readThreadMarks(containers).get('t1')).toEqual(AT)
  })

  it('survives a restore that changes the body elsewhere', () => {
    const live = bodyDoc(BODY)
    markThreadPassages(live, live, new Map([['t1', AT]]))

    reconcileDocContent(live, bodyDoc(EDITED))

    expect(live.getText('body').toString()).toBe(EDITED)
    expect(readThreadMarks(live).get('t1')).toEqual(AT)
  })
})
