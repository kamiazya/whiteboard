import { describe, expect, it } from 'vitest'
import type { DocumentFolders, DocumentIndex, DocumentTrash } from '../index.js'
import { DisplayNameTakenError, DocumentNotFoundError, WorkspaceNotFoundError } from '../index.js'
import { describeMoveFolderName } from './document-index-move-name-conformance.js'

type FolderIndex = DocumentIndex & DocumentFolders & DocumentTrash

type MakeFolderIndex = () => Promise<{
  index: FolderIndex
  dispose: () => Promise<void>
}>

type WithIndex = (body: (index: FolderIndex) => Promise<void>) => Promise<void>

const WS = 'ws-folders'

async function create(index: FolderIndex, path: string, workspaceId = WS): Promise<void> {
  await index.createDocument({ workspaceId, path, kind: 'markdown' })
}

const rename = (index: FolderIndex, path: string, name?: string) =>
  index.setFolderName({ workspaceId: WS, path, ...(name === undefined ? {} : { name }) })

const names = (index: FolderIndex, workspaceId = WS) => index.listFolderNames({ workspaceId })

/**
 * What `DocumentFolders` promises beyond its signature, for every index that
 * keeps folders as nodes of the workspace record. Separate from
 * `describeDocumentIndexConformance` because a row-backed index has no
 * folder to name, and a case there would be one it could only fail.
 */
export function describeDocumentFoldersConformance(makeIndex: MakeFolderIndex): void {
  const withIndex: WithIndex = async (body) => {
    const { index, dispose } = await makeIndex()
    try {
      await index.createWorkspace({ workspaceId: WS })
      await index.createWorkspace({ workspaceId: 'ws-other' })
      await body(index)
    } finally {
      await dispose()
    }
  }

  describe('DocumentFolders', () => {
    describeFolderNaming(withIndex)
    describeFolderNameLifetime(withIndex)
    describeFolderNameSurvivesTrash(withIndex)
    describeFolderNameRestoreRules(withIndex)
    describeFolderRefusals(withIndex)
    describeFolderDuplicates(withIndex)
    describeMoveFolderName(withIndex, WS)
  })
}

function describeFolderNaming(withIndex: WithIndex): void {
  it('lists nothing for folders nobody named', async () => {
    await withIndex(async (index) => {
      await create(index, 'a/b/c')
      await expect(names(index)).resolves.toEqual([])
    })
  })

  it('names a folder without moving it or anything under it', async () => {
    await withIndex(async (index) => {
      await create(index, 'week-6/plan')

      await rename(index, 'week-6', 'Week 6')

      await expect(names(index)).resolves.toEqual([{ path: 'week-6', name: 'Week 6' }])
      const paths = (await index.listDocuments({ workspaceId: WS })).map((entry) => entry.path)
      expect(paths).toEqual(['week-6/plan'])
    })
  })

  it('lists named folders in path order', async () => {
    await withIndex(async (index) => {
      await create(index, 'b/x')
      await create(index, 'a/y/z')
      await rename(index, 'b', 'Bee')
      await rename(index, 'a/y', 'Why')
      await rename(index, 'a', 'Ay')

      await expect(names(index)).resolves.toEqual([
        { path: 'a', name: 'Ay' },
        { path: 'a/y', name: 'Why' },
        { path: 'b', name: 'Bee' },
      ])
    })
  })
}

function describeFolderNameLifetime(withIndex: WithIndex): void {
  it('clears a name when given none', async () => {
    await withIndex(async (index) => {
      await create(index, 'a/x')
      await rename(index, 'a', 'Archive')
      await rename(index, 'a')
      await expect(names(index)).resolves.toEqual([])
    })
  })

  it('carries the name with the folder when it moves', async () => {
    await withIndex(async (index) => {
      await create(index, 'a/x')
      await rename(index, 'a', 'Archive')
      await index.moveDocument({ workspaceId: WS, from: 'a', to: 'old/a' })
      await expect(names(index)).resolves.toEqual([{ path: 'old/a', name: 'Archive' }])
    })
  })

  it('keeps one workspace folder names out of another', async () => {
    await withIndex(async (index) => {
      await create(index, 'a/x')
      await create(index, 'a/x', 'ws-other')
      await rename(index, 'a', 'Archive')
      await expect(names(index, 'ws-other')).resolves.toEqual([])
    })
  })
}

function describeFolderNameSurvivesTrash(withIndex: WithIndex): void {
  it('brings a folder back with its name when its last document is restored', async () => {
    await withIndex(async (index) => {
      const { documentId } = await index.createDocument({
        workspaceId: WS,
        path: 'term/week-6/plan',
        kind: 'markdown',
      })
      await rename(index, 'term', 'Term 1')
      await rename(index, 'term/week-6', 'Week 6')

      await index.deleteDocument({ workspaceId: WS, path: 'term/week-6/plan' })
      await expect(names(index)).resolves.toEqual([])
      await index.restoreDocument({ workspaceId: WS, documentId })

      await expect(names(index)).resolves.toEqual([
        { path: 'term', name: 'Term 1' },
        { path: 'term/week-6', name: 'Week 6' },
      ])
    })
  })
}

function describeFolderNameRestoreRules(withIndex: WithIndex): void {
  const trashAndRestore = async (index: FolderIndex, path: string, documentId: string) => {
    await index.deleteDocument({ workspaceId: WS, path })
    const restored = await index.restoreDocument({ workspaceId: WS, documentId })
    expect(restored?.path).toBe(path)
  }

  it('keeps a name the folder has been given since, on restore', async () => {
    await withIndex(async (index) => {
      const { documentId } = await index.createDocument({
        workspaceId: WS,
        path: 'a/x',
        kind: 'markdown',
      })
      await rename(index, 'a', 'Old')
      await index.deleteDocument({ workspaceId: WS, path: 'a/x' })
      await create(index, 'a/y')
      await rename(index, 'a', 'New')

      await index.restoreDocument({ workspaceId: WS, documentId })

      await expect(names(index)).resolves.toEqual([{ path: 'a', name: 'New' }])
    })
  })

  it('names only the folders that were named, and none for a document at the root', async () => {
    await withIndex(async (index) => {
      const { documentId } = await index.createDocument({
        workspaceId: WS,
        path: 'a/b/x',
        kind: 'markdown',
      })
      const root = await index.createDocument({ workspaceId: WS, path: 'top', kind: 'markdown' })
      await rename(index, 'a/b', 'Bee')

      await trashAndRestore(index, 'a/b/x', documentId)
      await trashAndRestore(index, 'top', root.documentId)

      await expect(names(index)).resolves.toEqual([{ path: 'a/b', name: 'Bee' }])
    })
  })
}

function describeFolderRefusals(withIndex: WithIndex): void {
  it('refuses a path no folder stands at, a document used as one included', async () => {
    await withIndex(async (index) => {
      await create(index, 'doc')
      await create(index, 'doc/child')

      await expect(rename(index, 'doc', 'Named')).rejects.toThrow(DocumentNotFoundError)
      await expect(rename(index, 'nothing', 'Named')).rejects.toThrow(DocumentNotFoundError)
    })
  })

  it('refuses a blank name and a name holding "/", naming nothing', async () => {
    await withIndex(async (index) => {
      await create(index, 'a/x')
      await expect(rename(index, 'a', '  ')).rejects.toThrow(/blank/)
      await expect(rename(index, 'a', 'a/b')).rejects.toThrow(/contain/)
      await expect(names(index)).resolves.toEqual([])
    })
  })

  it('refuses a workspace the index does not hold, as listDocuments does', async () => {
    await withIndex(async (index) => {
      await expect(names(index, 'ws-nobody')).rejects.toThrow(WorkspaceNotFoundError)
    })
  })
}

function describeFolderDuplicates(withIndex: WithIndex): void {
  it('refuses a name a sibling folder already shows, compared case- and space-blind', async () => {
    await withIndex(async (index) => {
      await create(index, 'term/week-6/plan')
      await create(index, 'term/w7/plan')
      await rename(index, 'term/week-6', 'Week 6')

      await expect(rename(index, 'term/w7', ' week 6 ')).rejects.toThrow(DisplayNameTakenError)
      // Quoted as the sibling is called, not as it was typed.
      await expect(rename(index, 'term/w7', ' week 6 ')).rejects.toThrow(
        'Another folder here is already called "Week 6".',
      )
      await expect(names(index)).resolves.toEqual([{ path: 'term/week-6', name: 'Week 6' }])
    })
  })

  it('refuses a name an unnamed sibling folder shows as its segment', async () => {
    await withIndex(async (index) => {
      await create(index, 'notes/x')
      await create(index, 'other/x')
      await expect(rename(index, 'other', 'Notes')).rejects.toThrow(DisplayNameTakenError)
    })
  })

  it('is no duplicate in another folder, beside a document, or as the folder own name', async () => {
    await withIndex(async (index) => {
      await create(index, 'a/week-6/x')
      await create(index, 'b/w/x')
      await create(index, 'b/plan')
      await rename(index, 'a/week-6', 'Week 6')

      await rename(index, 'b/w', 'Week 6')
      await rename(index, 'b/w', 'week 6')
      await create(index, 'b/v/x')
      await rename(index, 'b/v', 'Plan')

      await expect(names(index)).resolves.toEqual([
        { path: 'a/week-6', name: 'Week 6' },
        { path: 'b/v', name: 'Plan' },
        { path: 'b/w', name: 'week 6' },
      ])
    })
  })
}
