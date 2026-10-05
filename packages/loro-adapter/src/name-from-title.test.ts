/**
 * The two gates that decide whether a heading may name a document, over a
 * real workspace record. The browser suites and the daemon's sync operation
 * drive this through a write; here each gate is held on its own, where
 * removing one cannot be absorbed by whatever the keeper does around it.
 */
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { MARKDOWN_BODY_KEY } from './containers.js'
import { seedNameFromTitle, seedNamesFromTitles } from './name-from-title.js'
import {
  createWorkspaceDocumentAtPath,
  deleteWorkspaceDocument,
  documentContainers,
  resolveWorkspaceDocumentById,
  setWorkspaceDocumentName,
} from './workspace-tree.js'

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

// The generated-path gate on its own: a heading names a note at a path the
// new-document flow chose, and never one a person did.
describe('the generated-path gate', () => {
  const namedAt = (path: string) => {
    const workspace = workspaceWith(path, '# Weekly review\n')
    seedNameFromTitle(workspace, DOC)
    return nameOf(workspace) !== undefined
  }

  it.each(['untitled', 'untitled-2', 'design/untitled-17'])('opens at %s', (path) => {
    expect(namedAt(path)).toBe(true)
  })

  // `-1` is never generated: the counter starts at 2.
  it.each([
    'weekly-review',
    'untitled-notes',
    'design/untitled/child',
    'untitled-1',
  ])('stays shut at %s', (path) => {
    expect(namedAt(path)).toBe(false)
  })
})

/** A second replica of `workspace` and the update typing `text` into DOC's body there. */
function typedOnReplica(workspace: LoroDoc, documentId: string, text: string): Uint8Array {
  const replica = new LoroDoc()
  replica.import(workspace.export({ mode: 'snapshot' }))
  const from = replica.oplogVersion()
  documentContainers(replica, documentId).getText(MARKDOWN_BODY_KEY).insert(0, text)
  replica.commit()
  return replica.export({ mode: 'update', from }) as Uint8Array
}

describe('seedNamesFromTitles', () => {
  it('names a document the operations since `since` wrote to', () => {
    const workspace = workspaceWith('untitled', '')
    const update = typedOnReplica(workspace, DOC, '# Weekly review\n')
    const since = workspace.oplogVersion()
    workspace.import(update)

    seedNamesFromTitles(workspace, since)

    expect(nameOf(workspace)).toBe('Weekly review')
  })

  it('leaves alone a document nothing since `since` wrote to', () => {
    const workspace = workspaceWith('untitled', '# Weekly review\n')

    seedNamesFromTitles(workspace, workspace.oplogVersion())

    expect(nameOf(workspace)).toBeUndefined()
  })

  // A rename that clears the name is a write to the node's own map, and the
  // still-generated path is what says the heading may name it again — the
  // same answer the browser keeper reaches on its next save.
  it('reads a write to the node itself, not only to its body', () => {
    const workspace = workspaceWith('untitled', '# Weekly review\n', 'Weekly review')
    const replica = new LoroDoc()
    replica.import(workspace.export({ mode: 'snapshot' }))
    const from = replica.oplogVersion()
    setWorkspaceDocumentName(replica, { documentId: DOC })
    const since = workspace.oplogVersion()
    workspace.import(replica.export({ mode: 'update', from }))
    expect(nameOf(workspace)).toBeUndefined()

    seedNamesFromTitles(workspace, since)

    expect(nameOf(workspace)).toBe('Weekly review')
  })

  it('passes over a document the same operations deleted', () => {
    const workspace = workspaceWith('untitled', '')
    const replica = new LoroDoc()
    replica.import(workspace.export({ mode: 'snapshot' }))
    const from = replica.oplogVersion()
    documentContainers(replica, DOC).getText(MARKDOWN_BODY_KEY).insert(0, '# Weekly review\n')
    deleteWorkspaceDocument(replica, { documentId: DOC })
    const since = workspace.oplogVersion()
    workspace.import(replica.export({ mode: 'update', from }))
    const after = workspace.oplogVersion().toJSON()

    seedNamesFromTitles(workspace, since)

    expect(workspace.oplogVersion().toJSON()).toEqual(after)
  })

  it('writes nothing when no document it read takes a name', () => {
    const workspace = workspaceWith('notes/weekly', '')
    const update = typedOnReplica(workspace, DOC, '# Weekly review\n')
    const since = workspace.oplogVersion()
    workspace.import(update)
    const after = workspace.oplogVersion().toJSON()

    seedNamesFromTitles(workspace, since)

    expect(workspace.oplogVersion().toJSON()).toEqual(after)
  })
})
