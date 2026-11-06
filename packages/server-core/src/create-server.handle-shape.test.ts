/**
 * `POST …/documents` is the one `/api/v1` route that may name a workspace
 * that does not exist yet, because it can create it. A handle in the
 * `<namespace>/<segment>` form that resolves to nothing is not an id any
 * workspace could be minted under, so it is refused as unknown like on every
 * other route — never handed on to an index that parses it as an id.
 */

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

describe('creating a document under a namespaced handle that resolves to nothing', () => {
  it.each([
    { label: 'without createWorkspace', extra: {} },
    { label: 'with createWorkspace', extra: { createWorkspace: true } },
  ])('is refused as an unknown workspace, $label', async ({ extra }) => {
    const res = await create('a/b', { path: 'fresh', kind: 'markdown', ...extra })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: 'workspace_not_found' })
  })
})
