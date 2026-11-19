/**
 * A workspace holds at most 4000 folders, and every way this index makes a
 * new one — a create or a move to a path whose folders do not exist yet, a
 * restore from the trash — refuses past it. Both keepers place through this
 * class, so the ceiling the daemon's sync path holds is held here as well.
 */

import { TooManyFoldersError } from '@kamiazya/whiteboard-ports'
import { beforeEach, describe, expect, it } from 'vitest'
import type { LoroWorkspaceDocumentIndex } from './loro-workspace-document-index.js'
import { restorableTrashDocuments } from './restore-judgement.js'
import {
  INDEX_SUBJECTS,
  type IndexSubject,
  indexOver,
  inMemoryBlobStore,
  liveWorkspaceDocs,
} from './test-utils/index-subjects.js'

/** Written out rather than imported, so the test is not judged by the constant it judges. */
const CEILING = 4000
const WS = '01BSXMXYEPZGZYHNN3KTQZ33EE'

const foldersIn = async (subject: IndexSubject, record: unknown) =>
  (await subject.kind.nodes(record)).filter((node) => node.type === 'folder').length

describe.each(INDEX_SUBJECTS)('a workspace at its folder ceiling over $name', (subject) => {
  let docs: ReturnType<typeof liveWorkspaceDocs>
  let index: LoroWorkspaceDocumentIndex<unknown>

  beforeEach(async () => {
    docs = liveWorkspaceDocs(subject)
    index = indexOver(subject, docs, inMemoryBlobStore())
    await index.createWorkspace({ workspaceId: WS })
  })

  it('still creates a document whose new folders reach the ceiling', async () => {
    await subject.fillFolders(docs.peek(WS), CEILING - 2)
    await index.createDocument({ workspaceId: WS, path: 'x/y/doc', kind: 'markdown' })
    expect(await foldersIn(subject, docs.peek(WS))).toBe(CEILING)
  })

  it('refuses a create whose new folders would pass it, leaving the record as it was', async () => {
    await subject.fillFolders(docs.peek(WS), CEILING - 1)
    await expect(
      index.createDocument({ workspaceId: WS, path: 'x/y/doc', kind: 'markdown' }),
    ).rejects.toBeInstanceOf(TooManyFoldersError)
    expect(await foldersIn(subject, docs.peek(WS))).toBe(CEILING - 1)
    expect((await subject.kind.nodes(docs.peek(WS))).some((node) => node.path === 'x')).toBe(false)
  })

  it('creates into folders that already exist when at the ceiling', async () => {
    await subject.fillFolders(docs.peek(WS), CEILING)
    await index.createDocument({ workspaceId: WS, path: 'f0/doc', kind: 'markdown' })
    expect(await foldersIn(subject, docs.peek(WS))).toBe(CEILING)
  })

  it('refuses a move whose destination needs folders past it', async () => {
    await index.createDocument({ workspaceId: WS, path: 'doc', kind: 'markdown' })
    await subject.fillFolders(docs.peek(WS), CEILING)
    await expect(
      index.moveDocument({ workspaceId: WS, from: 'doc', to: 'x/doc' }),
    ).rejects.toBeInstanceOf(TooManyFoldersError)
    expect((await subject.kind.nodes(docs.peek(WS))).map((node) => node.path)).toContain('doc')
  })
})

describe.each(INDEX_SUBJECTS)('restoring a trashed document over $name', (subject) => {
  /** A trashed `top` whose subtree holds one folder, segment `segment`, and a document. */
  async function trashedWithFolder(segment: string): Promise<Uint8Array> {
    const record = await subject.kind.empty()
    subject.kind.write(record, [
      {
        op: 'createWorkspaceDocumentAtPath',
        args: { path: 'top', documentId: '01BRWAAAAAAAAAAAAAAAAAAAA0', kind: 'markdown' },
      },
    ])
    await subject.addFolderUnder(record, 'top', segment)
    return subject.kind.exportSubtree(record, 'top') as Uint8Array
  }

  it('counts the folders the subtree would bring back', async () => {
    expect(
      await restorableTrashDocuments(await trashedWithFolder('inner'), {
        documentId: '01BRWAAAAAAAAAAAAAAAAAAAA0',
        parentPath: undefined,
      }),
    ).toEqual({ documents: 1, folders: 1 })
  })

  it('refuses a subtree holding a folder the path grammar refuses', async () => {
    expect(
      await restorableTrashDocuments(await trashedWithFolder('not a segment'), {
        documentId: '01BRWAAAAAAAAAAAAAAAAAAAA0',
        parentPath: undefined,
      }),
    ).toBeNull()
  })
})
