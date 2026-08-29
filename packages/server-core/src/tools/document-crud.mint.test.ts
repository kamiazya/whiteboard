/**
 * ADR-0019's mint boundary: the SERVER decides a workspace's canonical id,
 * and the string a caller sent becomes its `segment`.
 *
 * This is the one place a workspace comes into existence on this side —
 * `wbDocumentCreate`'s `createWorkspace: true` branch, which `wb_workspace_edit`
 * and the HTTP create route both delegate to — so it is the one place the
 * rule can be stated.
 */
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { ignoredDocumentWrites } from '../test-utils/ignored-document-writes.js'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { inMemoryDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { wbDocumentCreate } from './document-crud.js'

const CANONICAL = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

function makeDeps(): ServerDeps {
  return {
    documentStore: createInMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
    documentTeardown: inMemoryDocumentTeardown(),
    documentWritten: ignoredDocumentWrites(),
  }
}

describe('wbDocumentCreate mints the workspace id', () => {
  it('keys the new workspace by a canonical ULID, not by what the caller sent', async () => {
    const deps = makeDeps()

    await wbDocumentCreate(deps, {
      workspaceId: 'design',
      path: 'spec',
      kind: 'markdown',
      createWorkspace: true,
    })

    const entries = await deps.documentIndex.listWorkspaces()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.workspaceId).toMatch(CANONICAL)
    // Asserted explicitly rather than left to the regex: `design` failing the
    // ULID shape is the whole point, and a future id format that happened to
    // accept it would make the check above pass while the rule was gone.
    expect(entries[0]?.workspaceId).not.toBe('design')
  })

  it('carries the string the caller sent into the segment layer', async () => {
    const deps = makeDeps()

    await wbDocumentCreate(deps, {
      workspaceId: 'design',
      path: 'spec',
      kind: 'markdown',
      createWorkspace: true,
    })

    const entries = await deps.documentIndex.listWorkspaces()
    expect(entries[0]?.segment).toBe('design')
    // ...and it is a real address, not decoration: this is the resolution the
    // caller's next request goes through.
    expect((await deps.documentIndex.resolveWorkspace('design'))?.workspaceId).toBe(
      entries[0]?.workspaceId,
    )
  })

  it('reports the workspace it minted, so the caller can name what it just made', async () => {
    // Without this the contract is unusable: the server picks an id, files
    // the document under it, and never says what it was. `path` and
    // `documentId` alone do not identify a workspace.
    const deps = makeDeps()

    const created = await wbDocumentCreate(deps, {
      workspaceId: 'design',
      path: 'spec',
      kind: 'markdown',
      createWorkspace: true,
    })

    const entries = await deps.documentIndex.listWorkspaces()
    expect(created.workspaceId).toBe(entries[0]?.workspaceId)
    // Both halves are needed. The line above alone passes without the mint
    // too — the field echoes the input, and without a mint the input IS the
    // stored id, so the two agree for the wrong reason. What says the mint
    // happened is that the REPORTED id is canonical and is not the handle.
    expect(created.workspaceId).toMatch(CANONICAL)
    expect(created.workspaceId).not.toBe('design')
    // The document really is filed under the reported id — a field that
    // merely echoed something plausible would read the same here.
    const entry = await deps.documentIndex.resolveDocumentById({
      workspaceId: created.workspaceId,
      documentId: created.documentId,
    })
    expect(entry?.path).toBe('spec')
  })

  it('refuses to create under a handle that could never be a segment', async () => {
    // A mint with no segment would leave the caller's own string naming
    // nothing — their very next request 404s on the address they chose.
    // Stage 2's BACKFILL settles for NULL because it has existing data it
    // must not discard; a create has nothing yet, so it can refuse and keep
    // "the string you sent is the address" true without exception.
    const deps = makeDeps()

    await expect(
      wbDocumentCreate(deps, {
        workspaceId: 'V1StGXR8_Z5jdHi6B-myT',
        path: 'spec',
        kind: 'markdown',
        createWorkspace: true,
      }),
    ).rejects.toThrow(/segment/i)
    expect(await deps.documentIndex.listWorkspaces()).toEqual([])
  })

  it('refuses a handle already shaped like a canonical id', async () => {
    // The other half of the same rule: a ULID-shaped segment collides with
    // the canonical-id fallback in the one address position.
    const deps = makeDeps()

    await expect(
      wbDocumentCreate(deps, {
        workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        path: 'spec',
        kind: 'markdown',
        createWorkspace: true,
      }),
    ).rejects.toThrow(/segment/i)
    expect(await deps.documentIndex.listWorkspaces()).toEqual([])
  })

  it('mints nothing and echoes the id when the workspace already exists', async () => {
    // The non-creating path is the common one and must be untouched: by the
    // time an existing workspace is addressed, its handle has already been
    // resolved at the boundary, so what arrives here IS the canonical id.
    const deps = makeDeps()
    await deps.documentIndex.createWorkspace({
      workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      segment: 'design',
    })

    const created = await wbDocumentCreate(deps, {
      workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      path: 'spec',
      kind: 'markdown',
    })

    expect(created.workspaceId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(await deps.documentIndex.listWorkspaces()).toHaveLength(1)
  })

  it('mints nothing when the create is refused for a malformed body', async () => {
    // The preflight runs BEFORE the mint, so a refusal leaves no workspace —
    // which is what `document-create-orphan` asserted in prose while the code
    // bootstrapped first. Without this order the caller's retry mints a
    // SECOND workspace and the first is unreachable rubble.
    const deps = makeDeps()

    await expect(
      wbDocumentCreate(deps, {
        workspaceId: 'design',
        path: 'spec',
        kind: 'markdown',
        createWorkspace: true,
        markdown: '---\nthis: [is: not: yaml\n---\nbody',
      }),
    ).rejects.toThrow(/okf|frontmatter|yaml|parse/i)

    expect(await deps.documentIndex.listWorkspaces()).toEqual([])

    // ...and the retry makes exactly one, rather than a second alongside
    // rubble from the first attempt.
    const retried = await wbDocumentCreate(deps, {
      workspaceId: 'design',
      path: 'spec',
      kind: 'markdown',
      createWorkspace: true,
      markdown: '---\ntype: note\n---\nvalid this time',
    })
    const entries = await deps.documentIndex.listWorkspaces()
    expect(entries).toHaveLength(1)
    expect(retried.workspaceId).toBe(entries[0]?.workspaceId)
  })

  it('is idempotent: the flag on an existing workspace mints no rival', async () => {
    // The flag has always been safe to set on every request. Minting
    // unconditionally would have broken that in two ways at once — a second
    // create into the same workspace making a rival, and a handle the
    // boundary already resolved to a canonical id being refused for being
    // ULID-shaped, which is how `/api/v1`'s own duplicate-path case failed.
    const deps = makeDeps()

    const first = await wbDocumentCreate(deps, {
      workspaceId: 'design',
      path: 'a',
      kind: 'spatial',
      createWorkspace: true,
    })
    const second = await wbDocumentCreate(deps, {
      workspaceId: 'design',
      path: 'b',
      kind: 'spatial',
      createWorkspace: true,
    })
    // ...and by the CANONICAL id too, which is what a resolved handle looks
    // like by the time it reaches here.
    const third = await wbDocumentCreate(deps, {
      workspaceId: first.workspaceId,
      path: 'c',
      kind: 'spatial',
      createWorkspace: true,
    })

    expect(second.workspaceId).toBe(first.workspaceId)
    expect(third.workspaceId).toBe(first.workspaceId)
    expect(await deps.documentIndex.listWorkspaces()).toHaveLength(1)
  })
})
