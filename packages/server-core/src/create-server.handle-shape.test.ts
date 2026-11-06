/**
 * `POST …/documents` is the one `/api/v1` route that may name a workspace
 * that does not exist yet, because `createWorkspace` can mint it. An
 * unresolved `<namespace>/<segment>` address is minted only in the caller's
 * own namespace and only when asked; otherwise it names no workspace and is
 * refused as unknown — never handed to a keeper that parses it as an id.
 */

import { SINGLE_PERSON_NAMESPACE } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { seededServer } from './test-utils/seeded-workspace.js'

async function create(workspace: string, body: Record<string, unknown>) {
  const { app } = await seededServer()
  return app.fetch(
    new Request(`http://test/api/v1/workspaces/${encodeURIComponent(workspace)}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

describe('creating a document under a namespaced address that resolves to nothing', () => {
  it.each([
    { label: 'not asked to create it', address: `${SINGLE_PERSON_NAMESPACE}/fresh`, extra: {} },
    { label: 'in another namespace', address: 'a/b', extra: { createWorkspace: true } },
    { label: 'in another namespace, not asked', address: 'a/b', extra: {} },
  ])('is refused as an unknown workspace when $label', async ({ address, extra }) => {
    const res = await create(address, { path: 'fresh', kind: 'markdown', ...extra })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'workspace_not_found' })
  })

  it("mints it in the caller's own namespace when asked to create it", async () => {
    const res = await create(`${SINGLE_PERSON_NAMESPACE}/fresh`, {
      path: 'fresh',
      kind: 'markdown',
      createWorkspace: true,
    })
    expect(res.status).toBe(201)
  })
})
