/**
 * Storing a document given as snapshot bytes: it lands at the path with the
 * kind asked for, a taken path is refused unless overwriting, and what lands
 * is the content the bytes carry.
 */
import { readMarkdownBody, writeMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { DocumentPathTakenError } from '@kamiazya/whiteboard-ports'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { documentOf, resolveTestServerDeps, withTempDataDir } from '../routes/_test-helpers.js'

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const tmp = withTempDataDir('whiteboard-live-create-')
const WS = '01M8BBN7JS60N0ZAR13NP8SXBF'

let deps: ServerDeps
beforeEach(async () => {
  deps = await resolveTestServerDeps(tmp.dir)
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
})

const noteBytes = (body: string): Uint8Array => {
  const doc = new LoroDoc()
  writeMarkdownBody(doc, body)
  doc.commit()
  return new Uint8Array(doc.export({ mode: 'snapshot' }))
}

describe('liveDocuments.create', () => {
  it('stores the bytes as the document at a new path, under the kind asked for', async () => {
    await deps.liveDocuments.create(WS, 'notes/one', noteBytes('# one'), { kind: 'markdown' })
    expect(await deps.liveDocuments.exists(WS, 'notes/one')).toBe(true)
    expect(await deps.liveDocuments.kind(WS, 'notes/one')).toBe('markdown')
    expect(readMarkdownBody(await documentOf(deps, WS, 'notes/one'))).toBe('# one')
  })

  it('refuses a path already held unless asked to overwrite it', async () => {
    await deps.liveDocuments.create(WS, 'notes/one', noteBytes('# one'), { kind: 'markdown' })
    await expect(
      deps.liveDocuments.create(WS, 'notes/one', noteBytes('# two'), { kind: 'markdown' }),
    ).rejects.toBeInstanceOf(DocumentPathTakenError)
    expect(readMarkdownBody(await documentOf(deps, WS, 'notes/one'))).toBe('# one')
    await deps.liveDocuments.create(WS, 'notes/one', noteBytes('# two'), {
      kind: 'markdown',
      overwrite: true,
    })
    expect(readMarkdownBody(await documentOf(deps, WS, 'notes/one'))).toBe('# two')
  })
})
