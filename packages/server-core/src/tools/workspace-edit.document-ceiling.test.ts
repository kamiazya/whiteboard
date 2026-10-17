import { describe, expect, it } from 'vitest'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { inMemoryDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { createWorkspaceEditTool } from './workspace-edit.js'

/** Written out rather than imported, so the test is not judged by the constant it judges. */
const CEILING = 2000
const WS = 'crowded'

describe('wb_workspace_edit at the workspace document ceiling', () => {
  it('creates up to the ceiling and refuses the op that would pass it', async () => {
    const deps = makeTestDeps({ documentTeardown: inMemoryDocumentTeardown() })
    await deps.documentIndex.createWorkspace({ workspaceId: WS })
    for (let i = 0; i < CEILING - 1; i++) {
      await deps.documentIndex.createDocument({ workspaceId: WS, path: `d${i}`, kind: 'spatial' })
    }

    await expect(
      createWorkspaceEditTool(deps).execute({
        workspaceId: WS,
        ops: [
          { op: 'document.create', path: 'last', kind: 'spatial' },
          { op: 'document.create', path: 'one-more', kind: 'spatial' },
        ],
      }),
    ).rejects.toThrow(/ops\[1\] \(document\.create\).*at most 2000.*1 op\(s\) before it/)

    const listed = await deps.documentIndex.listDocuments({ workspaceId: WS })
    expect(listed).toHaveLength(CEILING)
    expect(listed.some((entry) => entry.path === 'one-more')).toBe(false)
  })
})
