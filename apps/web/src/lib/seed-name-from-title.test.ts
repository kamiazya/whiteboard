// @vitest-environment node
/**
 * The two gates that decide whether a heading may name a document, over a
 * real workspace record. The browser suites drive this through a save; here
 * each gate is held on its own, where removing one cannot be absorbed by
 * whatever the page does around it.
 */
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  MARKDOWN_BODY_KEY,
  resolveWorkspaceDocumentById,
  setWorkspaceDocumentName,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { seedNameFromTitle } from './seed-name-from-title.js'

const DOC = '01J0000000000000000000SEED'

function workspaceWith(path: string, body: string, name?: string): LoroDoc {
  const workspace = new LoroDoc()
  createWorkspaceDocumentAtPath(workspace, {
    path,
    documentId: DOC,
    kind: 'markdown',
    ...(name === undefined ? {} : { name }),
  })
  documentContainers(workspace, DOC).getText(MARKDOWN_BODY_KEY).insert(0, body)
  workspace.commit()
  return workspace
}

const nameOf = (workspace: LoroDoc) => resolveWorkspaceDocumentById(workspace, DOC)?.name

describe('seedNameFromTitle', () => {
  it('names an unnamed document at a generated path after its heading', () => {
    const workspace = workspaceWith('notes/untitled-2', '# Weekly review\n\nbody')

    seedNameFromTitle(workspace, DOC)

    expect(nameOf(workspace)).toBe('Weekly review')
  })

  // A cleared name and a never-set one look the same in the tree; the placed
  // path is what says somebody already chose how this document is addressed.
  it('leaves a placed document whose name was cleared unnamed', () => {
    const workspace = workspaceWith('notes/weekly', '# Weekly review\n', 'Weekly')
    setWorkspaceDocumentName(workspace, { documentId: DOC })
    expect(nameOf(workspace)).toBeUndefined()

    seedNameFromTitle(workspace, DOC)

    expect(nameOf(workspace)).toBeUndefined()
  })

  // Loro drops a map set of an equal value, so this outcome holds with or
  // without the early return in front of it; that return only saves the walk.
  it('writes nothing when the name already is the title', () => {
    const workspace = workspaceWith('untitled', '# Weekly review\n', 'Weekly review')
    const before = workspace.version().toJSON()

    seedNameFromTitle(workspace, DOC)

    expect(workspace.version().toJSON()).toEqual(before)
  })

  it('grows a name it seeded from a heading still being typed', () => {
    const workspace = workspaceWith('untitled', '# From the list\n', 'From')

    seedNameFromTitle(workspace, DOC)

    expect(nameOf(workspace)).toBe('From the list')
  })

  it('never replaces a name the heading does not start with', () => {
    const workspace = workspaceWith('untitled', '# From the list\n', 'Meeting')

    seedNameFromTitle(workspace, DOC)

    expect(nameOf(workspace)).toBe('Meeting')
  })
})
