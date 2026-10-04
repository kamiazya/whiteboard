import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { DocumentNameConflictError } from './document-crud.errors.js'
import { wbDocumentCreate } from './document-crud.js'

const WS = 'ws-1'

async function makeDeps(): Promise<ServerDeps> {
  const deps = makeTestDeps()
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  return deps
}

describe('a name given both as `name` and as frontmatter `title`', () => {
  const OKF = (title: string) => `---\ntype: note\ntitle: ${title}\n---\nbody`

  async function nameOf(deps: ServerDeps, documentId: string) {
    return (await deps.documentIndex.resolveDocumentById({ workspaceId: WS, documentId }))?.name
  }

  it('is refused when the two differ, and nothing is created', async () => {
    const deps = await makeDeps()

    await expect(
      wbDocumentCreate(deps, {
        workspaceId: WS,
        path: 'two-names',
        kind: 'markdown',
        name: 'Named',
        markdown: OKF('Other'),
      }),
    ).rejects.toThrow(DocumentNameConflictError)

    expect(await deps.documentIndex.listDocuments({ workspaceId: WS })).toEqual([])
  })

  it('is refused when a blank title would silently clear the name', async () => {
    const deps = await makeDeps()

    await expect(
      wbDocumentCreate(deps, {
        workspaceId: WS,
        path: 'cleared',
        kind: 'markdown',
        name: 'Named',
        markdown: '---\ntype: note\ntitle: ""\n---\nbody',
      }),
    ).rejects.toThrow(DocumentNameConflictError)
  })

  it('is accepted when they agree, ignoring surrounding whitespace', async () => {
    const deps = await makeDeps()
    const created = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: 'agreed',
      kind: 'markdown',
      name: ' Same ',
      markdown: OKF('Same'),
    })
    expect(await nameOf(deps, created.documentId)).toBe('Same')
  })

  it.each([
    ['name alone', { name: 'Only name', markdown: 'body' }, 'Only name'],
    ['title alone', { markdown: OKF('Only title') }, 'Only title'],
  ])('keeps %s', async (_label, content, expected) => {
    const deps = await makeDeps()
    const created = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: 'one-name',
      kind: 'markdown',
      ...content,
    })
    expect(await nameOf(deps, created.documentId)).toBe(expected)
  })
})
