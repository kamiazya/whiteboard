/**
 * The workspace record held for the length of one call: what an operation
 * reads and writes through it is the record the daemon serves, a write it
 * saves lands, and the session it was handed answers nothing once the call
 * is over, whether the call returned or threw.
 */
import type { RecordSession } from '@kamiazya/whiteboard-loro-adapter'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveTestServerDeps, withTempDataDir } from '../routes/_test-helpers.js'

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tmp.dir
  },
  getDataDir: () => tmp.dir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const tmp = withTempDataDir('whiteboard-record-bracket-')
const WS = '01M8BBN7JS60N0ZAR13NP8SXBF'

let deps: ServerDeps
beforeEach(async () => {
  deps = await resolveTestServerDeps(tmp.dir)
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  await deps.documentIndex.createDocument({ workspaceId: WS, path: 'note', kind: 'markdown' })
})

const parse = <T>(value: unknown) => value as T
const pathsIn = async (record: RecordSession) =>
  (await record.read({ query: 'documents' }, { parse: parse<Array<{ path: string }>> })).map(
    (entry) => entry.path,
  )

describe('workspaceDocuments.withRecord', () => {
  it('hands the live record to the call and answers what the call answers', async () => {
    const answer = await deps.workspaceDocuments.withRecord(WS, async (record) => {
      expect(await pathsIn(record)).toEqual(['note'])
      return 'answered'
    })
    expect(answer).toBe('answered')
  })

  it('persists what a call writes and saves, and the next call reads it', async () => {
    await deps.workspaceDocuments.withRecord(WS, async (record) => {
      record.write([
        {
          op: 'createWorkspaceDocumentAtPath',
          args: { path: 'board', documentId: '01BRWAAAAAAAAAAAAAAAAAAAA1', kind: 'spatial' },
        },
      ])
      await record.save()
    })
    deps.workspaceDocuments.evict(WS)
    const paths = await deps.workspaceDocuments.withRecord(WS, pathsIn)
    expect(paths.sort()).toEqual(['board', 'note'])
  })

  it('keeps one record for brackets that overlap, so one sees what the other wrote unsaved', async () => {
    await deps.workspaceDocuments.withRecord(WS, async (outer) => {
      outer.write([
        {
          op: 'createWorkspaceDocumentAtPath',
          args: { path: 'board', documentId: '01BRWAAAAAAAAAAAAAAAAAAAA1', kind: 'spatial' },
        },
      ])
      const seen = await deps.workspaceDocuments.withRecord(WS, pathsIn)
      expect(seen.sort()).toEqual(['board', 'note'])
    })
    deps.workspaceDocuments.evict(WS)
  })

  it('answers nothing from the session once the call returned', async () => {
    let escaped: RecordSession | undefined
    await deps.workspaceDocuments.withRecord(WS, async (record) => {
      escaped = record
    })
    expect(() => escaped?.version()).toThrow(/released/)
    await expect(escaped?.read({ query: 'documents' }, { parse })).rejects.toThrow(/released/)
  })

  it('answers nothing from the session once the call threw, and lets the error through', async () => {
    let escaped: RecordSession | undefined
    await expect(
      deps.workspaceDocuments.withRecord(WS, async (record) => {
        escaped = record
        throw new Error('the call failed')
      }),
    ).rejects.toThrow('the call failed')
    expect(() => escaped?.version()).toThrow(/released/)
  })
})
