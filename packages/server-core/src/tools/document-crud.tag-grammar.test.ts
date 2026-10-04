import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { inMemoryDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { wbDocumentCreate, wbDocumentList } from './document-crud.js'

const WS = 'ws-1'

async function makeDeps(): Promise<ServerDeps> {
  const deps = makeTestDeps({ documentTeardown: inMemoryDocumentTeardown() })
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  return deps
}

describe('wbDocumentCreate and the scoped-tag grammar (ADR-0040 decision 1)', () => {
  it('refuses a colon-bearing tag that is not a scoped tag, and mints no document for it', async () => {
    const deps = await makeDeps()

    await expect(
      wbDocumentCreate(deps, {
        workspaceId: WS,
        path: 'services/api',
        kind: 'markdown',
        markdown: '---\ntype: note\ntags:\n  - Health:OK\n---\nBody.',
      }),
    ).rejects.toThrow(/Health:OK.*is not a scoped tag.*key:value/s)

    const listed = await wbDocumentList(deps, { workspaceId: WS })
    expect(listed.documents).toEqual([])
  })

  it('still creates a document carrying a plain tag and a well-formed scoped one', async () => {
    const deps = await makeDeps()

    const created = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: 'services/api',
      kind: 'markdown',
      markdown: '---\ntype: note\ntags:\n  - draft\n  - health:ok\n---\nBody.',
    })

    expect(created.path).toBe('services/api')
  })
})
