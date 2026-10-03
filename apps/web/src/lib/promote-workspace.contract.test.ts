// @vitest-environment node
import { createWorkspaceDocumentAtPath } from '@kamiazya/whiteboard-loro-adapter'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import {
  resetBrowserWorkspaceIdForTests,
  setBrowserWorkspaceIdForTests,
} from './browser-workspace-id.js'
import { promoteWorkspace } from './promote-workspace.js'

afterEach(resetBrowserWorkspaceIdForTests)

function recordWithOneDocument(): LoroDoc {
  const record = new LoroDoc()
  createWorkspaceDocumentAtPath(record, {
    path: 'notes/a',
    documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    kind: 'markdown',
  })
  record.commit()
  return record
}

describe('promoteWorkspace, answered with a promote body its contract refuses', () => {
  it('reports one failed result and logs where the daemon disagreed', async () => {
    setBrowserWorkspaceIdForTests('ws-browser')
    const record = recordWithOneDocument()

    const result = await promoteWorkspace({
      fetch: (async () => jsonResponse({ ok: true, attested: 'yes' })) as typeof fetch,
      keeperBaseUrl: 'http://127.0.0.1:3099',
      workspaceId: 'ws-daemon',
      workspaceDocs: { open: async () => record } as unknown as WorkspaceDocs,
    })

    expect(result).toEqual({
      kind: 'failed',
      reason: 'The daemon answered the move with an unexpected response.',
    })
    await expectLoggedFailure('/workspace-document/promote failed its contract at attested')
  })
})
