import '../../store/_test-loro-records.js'
import {
  readWorkspaceNodes,
  setWorkspaceDocumentName,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestDocument,
  documentIdAt,
  resolveTestServerDeps,
  testDocumentRouterOptions,
  withTempDataDir,
  writeDocumentUpdate,
} from '../_test-helpers.js'

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const tmp = withTempDataDir('whiteboard-restore-points-test-')

let serverDeps: ServerDeps
beforeEach(async () => {
  serverDeps = await resolveTestServerDeps(tmp.dir)
  await serverDeps.documentIndex.createWorkspace({ workspaceId: '01M8BBN7JS60N0ZAR13NP8SXBF' })
})

const { createDocumentRouter } = await import('../document.js')
// Pre-loaded for the same dynamic-import cycle restore.test.ts works around.
await import('../../sync-audience.js')

const WS = '01M8BBN7JS60N0ZAR13NP8SXBF'
const GENERATED = 'untitled'
const CHOSEN = 'plain-path'
let PATH = GENERATED

function bodyUpdate(text: string): Uint8Array<ArrayBuffer> {
  const doc = new LoroDoc()
  const vv0 = doc.version()
  writeMarkdownBody(doc, text)
  doc.commit()
  return doc.export({ mode: 'update', from: vv0 }) as Uint8Array<ArrayBuffer>
}

/** What the record holds as the name of the note, and whether somebody chose it. */
async function nameOfNote() {
  const { getWorkspaceDoc } = await import('../../store/workspace-doc-cache.js')
  const record = await getWorkspaceDoc(WS)
  const node = readWorkspaceNodes(record).find((each) => each.path === PATH)
  if (node === undefined || node.type !== 'document') throw new Error('no note')
  return { name: node.meta.name, nameChosen: node.meta.nameChosen }
}

/** Takes the name off the note, the way a note nobody has named stands. */
async function clearNameUnless(chosen: string | null) {
  if (chosen !== null) return
  const { getWorkspaceDoc, saveWorkspaceDoc } = await import('../../store/workspace-doc-cache.js')
  const record = await getWorkspaceDoc(WS)
  setWorkspaceDocumentName(record, { documentId: await documentIdAt(serverDeps, WS, PATH) })
  await saveWorkspaceDoc(WS, record)
}

async function setChosenName(name: string) {
  const { getWorkspaceDoc, saveWorkspaceDoc } = await import('../../store/workspace-doc-cache.js')
  const record = await getWorkspaceDoc(WS)
  setWorkspaceDocumentName(record, { documentId: await documentIdAt(serverDeps, WS, PATH), name })
  await saveWorkspaceDoc(WS, record)
}

// A restore writes a version's content back through the keeper's one
// whole-content write, which also names a note still at a generated path after
// its heading (`writeDocumentContentAndName`): what the restored content says
// names a note nobody has named, and nothing else is renamed.
describe('a restore and the name of the note', () => {
  async function restoredAfterEdit(path: string, options: { chosen: string | null }) {
    PATH = path
    const app = createDocumentRouter(
      testDocumentRouterOptions({ serverDeps, autoVersionQuietMs: 60_000 }),
    )
    await createTestDocument(serverDeps, { workspaceId: WS, path, kind: 'markdown' })
    const documentId = await documentIdAt(serverDeps, WS, path)
    await writeDocumentUpdate(serverDeps, WS, path, bodyUpdate('# Alpha\n\nfirst'))
    if (options.chosen !== null) await setChosenName(options.chosen)
    const saved = await app.request(`/api/workspaces/${WS}/documents/${documentId}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'alpha' }),
    })
    const { version } = (await saved.json()) as { version: { id: string } }
    await writeDocumentUpdate(serverDeps, WS, path, bodyUpdate('# Beta '))
    await clearNameUnless(options.chosen)
    const afterEdit = await nameOfNote()
    const res = await app.request(
      `/api/workspaces/${WS}/documents/${documentId}/versions/${version.id}/restore`,
      { method: 'POST' },
    )
    return { res, afterEdit, afterRestore: await nameOfNote() }
  }

  it('keeps a name somebody chose, and keeps it marked as chosen', async () => {
    const { res, afterEdit, afterRestore } = await restoredAfterEdit(GENERATED, {
      chosen: 'My own title',
    })
    expect(res.status).toBe(200)
    expect(afterEdit).toEqual({ name: 'My own title', nameChosen: true })
    expect(afterRestore).toEqual({ name: 'My own title', nameChosen: true })
  })

  it('names an unnamed note at a generated path after the heading the restore wrote back', async () => {
    const { res, afterEdit, afterRestore } = await restoredAfterEdit(GENERATED, { chosen: null })
    expect(res.status).toBe(200)
    expect(afterEdit.name).toBeUndefined()
    expect(afterRestore).toEqual({ name: 'Alpha' })
  })

  it('names nothing at a path somebody chose', async () => {
    const { res, afterEdit, afterRestore } = await restoredAfterEdit(CHOSEN, { chosen: null })
    expect(res.status).toBe(200)
    expect(afterRestore).toEqual(afterEdit)
    expect(afterRestore.name).toBeUndefined()
  })
})
