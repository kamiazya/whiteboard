import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { inMemoryDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { createDocumentGetTool } from './document-get.js'
import { exportOkf } from './export-okf.js'
import { createWorkspaceEditTool, workspaceEditInputSchema } from './workspace-edit.js'

const WS = 'batch'

/**
 * The workspace exists because this fixture says so. It used to appear as a
 * side effect of `createWorkspace: true` on op 0 — which is ADR-0019's MINT
 * boundary, and now keys it by a fresh ULID, leaving the `WS` these cases
 * read back by naming nothing. The one case that is ABOUT bootstrapping
 * keeps the flag and reads the id the batch reports.
 */
async function makeDeps() {
  const deps = makeTestDeps({ documentTeardown: inMemoryDocumentTeardown() })
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  return deps
}
const body = (text: string) => `---\ntype: note\n---\n${text}`

describe('wb_workspace_edit', () => {
  it('creates several documents in one call and reports the ids it minted', async () => {
    const deps = await makeDeps()
    const out = await createWorkspaceEditTool(deps).execute({
      workspaceId: WS,
      ops: [
        { op: 'document.create', path: 'a', kind: 'markdown', name: 'A', markdown: body('one') },
        { op: 'document.create', path: 'b', kind: 'markdown', name: 'B', markdown: body('two') },
        { op: 'document.create', path: 'c', kind: 'spatial', name: 'C' },
      ],
    })
    expect(out.applied).toBe(3)
    expect(out.results).toHaveLength(3)
    // Without the ids coming back, a caller spends a round trip getting
    // them — which is the cost this tool exists to remove.
    for (const r of out.results) expect(r.documentId).toBeTruthy()

    const read = createDocumentGetTool(deps)
    const first = await read.execute({
      workspaceId: WS,
      documentIds: [out.results[0]?.documentId ?? ''],
    })
    expect(first.documents[0]?.content).toContain('one')
  })

  it('stops at the failing op and says how far it got', async () => {
    const deps = await makeDeps()
    const tool = createWorkspaceEditTool(deps)
    await tool.execute({
      workspaceId: WS,
      ops: [{ op: 'document.create', path: 'taken', kind: 'markdown' }],
    })

    // Documents live in their own Loro docs, so a batch spanning several of
    // them cannot be one atomic save the way `wb_canvas_edit` is. The
    // contract is therefore NOT "nothing was written" — it is "these ran,
    // this one failed, the rest did not". Saying "nothing was written"
    // here would be a lie a caller would act on.
    await expect(
      tool.execute({
        workspaceId: WS,
        ops: [
          { op: 'document.create', path: 'fresh', kind: 'markdown', markdown: body('kept') },
          { op: 'document.create', path: 'taken', kind: 'markdown' },
          { op: 'document.create', path: 'never', kind: 'markdown' },
        ],
      }),
    ).rejects.toThrow(/ops\[1\]/)

    const listed = await deps.documentIndex.listDocuments({ workspaceId: WS })
    const paths = listed.map((d) => d.path)
    expect(paths).toContain('fresh') // op 0 ran and stands
    expect(paths).not.toContain('never') // op 2 never ran
  })

  it('names how many ops succeeded in the message, since only .message survives MCP', async () => {
    const deps = await makeDeps()
    const tool = createWorkspaceEditTool(deps)
    await tool.execute({
      workspaceId: WS,
      ops: [{ op: 'document.create', path: 'dup', kind: 'markdown' }],
    })
    await expect(
      tool.execute({
        workspaceId: WS,
        ops: [
          { op: 'document.create', path: 'ok-1', kind: 'markdown' },
          { op: 'document.create', path: 'dup', kind: 'markdown' },
        ],
      }),
    ).rejects.toThrow(/1 op\(s\) before it were applied and stand/)
  })

  it('deletes and sets alongside creates', async () => {
    const deps = await makeDeps()
    const tool = createWorkspaceEditTool(deps)
    const made = await tool.execute({
      workspaceId: WS,
      ops: [{ op: 'document.create', path: 'edit-me', kind: 'markdown', markdown: body('before') }],
    })
    const documentId = made.results[0]?.documentId ?? ''
    await tool.execute({
      workspaceId: WS,
      ops: [
        { op: 'document.set', documentId, markdown: body('after') },
        { op: 'document.create', path: 'doomed', kind: 'markdown' },
      ],
    })
    const read = await createDocumentGetTool(deps).execute({
      workspaceId: WS,
      documentIds: [documentId],
    })
    expect(read.documents[0]?.content).toContain('after')

    const listed = await deps.documentIndex.listDocuments({ workspaceId: WS })
    const doomed = listed.find((d) => d.path === 'doomed')
    await tool.execute({
      workspaceId: WS,
      ops: [{ op: 'document.delete', documentId: doomed?.documentId ?? '' }],
    })
    const after = await deps.documentIndex.listDocuments({ workspaceId: WS })
    expect(after.map((d) => d.path)).not.toContain('doomed')
  })

  it('bootstraps the workspace on op 0 and applies the REST of the batch inside it', async () => {
    // The threading guard. Creating is ADR-0019's mint boundary, so op 0
    // decides an id the caller never sent — and ops 1..n reach the port
    // directly, with no resolution between. Before the batch carried that id
    // forward, op 1 addressed the caller's handle, which by then named
    // nothing: `ops[1] ... Workspace not found: "batch"`.
    const deps: ServerDeps = makeTestDeps({
      documentStore: createInMemoryDocumentStore(),
      documentTeardown: inMemoryDocumentTeardown(),
    })

    const out = await createWorkspaceEditTool(deps).execute({
      workspaceId: WS,
      createWorkspace: true,
      ops: [
        { op: 'document.create', path: 'first', kind: 'markdown', markdown: body('one') },
        { op: 'document.create', path: 'second', kind: 'markdown', markdown: body('two') },
      ],
    })

    expect(out.applied).toBe(2)
    expect(out.workspaceId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    expect(out.workspaceId).not.toBe(WS)

    // BOTH documents in ONE workspace — the id op 0 minted, which is also
    // the one reported. Two workspaces, or a second op that failed, is the
    // shape this guards.
    const workspaces = await deps.documentIndex.listWorkspaces()
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0]?.segment).toBe(WS)
    const listed = await deps.documentIndex.listDocuments({ workspaceId: out.workspaceId })
    expect(listed.map((d) => d.path).sort()).toEqual(['first', 'second'])
  })

  /**
   * One `actor` for the whole batch, not one per op: a batch comes from a
   * single producer, and repeating the same string N times is the cost
   * axis-B consolidation exists to remove.
   *
   * This is the capability that decides whether the standalone
   * `wb_document_create` / `wb_document_set` can be retired at all. They
   * take `actor` and stamp OKF `generated.by` (ADR-0016 §5.2); without it
   * here, retiring them would delete an agent's only way to say who wrote
   * a document, which is a loss no byte count would show.
   */
  it('stamps the batch actor on both a created body and a replaced one', async () => {
    const deps = await makeDeps()
    const tool = createWorkspaceEditTool(deps)
    const made = await tool.execute({
      workspaceId: WS,
      actor: 'reference_agent/gemini-2.5-pro',
      ops: [{ op: 'document.create', path: 'attributed', kind: 'markdown', markdown: body('one') }],
    })
    const documentId = made.results[0]?.documentId ?? ''
    const created = await exportOkf(deps, { workspaceId: WS, documentId })
    expect(created.frontmatter.generated).toMatchObject({
      by: 'reference_agent/gemini-2.5-pro',
    })

    await tool.execute({
      workspaceId: WS,
      actor: 'human:someone',
      ops: [{ op: 'document.set', documentId, markdown: body('two') }],
    })
    const replaced = await exportOkf(deps, { workspaceId: WS, documentId })
    // The replacement markdown declares no `generated` of its own, so this
    // write authors the content and stamps its own actor. ADR-0016's
    // honour-what-is-declared rule is about a `generated` arriving IN the
    // payload (an imported bundle), and `trust-stamp.test.ts` owns it — the
    // batch changes nothing there, it only carries the actor to the write.
    expect(replaced.frontmatter.generated).toMatchObject({ by: 'human:someone' })
  })

  // The batch reuses `okfActorSchema` rather than declaring `z.string()`,
  // so a malformed actor is refused at the boundary the same way
  // `wb_document_set` refuses one. Pinned because widening it here would be
  // invisible to every behavioural case above — they all send a valid actor.
  it('refuses an actor that is not a single-line string', () => {
    const base = {
      workspaceId: WS,
      ops: [{ op: 'document.delete', documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' }],
    }
    expect(workspaceEditInputSchema.safeParse({ ...base, actor: 'human:a' }).success).toBe(true)
    for (const actor of ['', ' human:a', 'human:a ', 'human:a\nhuman:b']) {
      expect(workspaceEditInputSchema.safeParse({ ...base, actor }).success, actor).toBe(false)
    }
  })

  /**
   * The mixed-kind case, which the single-kind cases above cannot reach.
   * `wbDocumentCreateInputSchema`'s spatial arm is `.strict()` and has no
   * `actor` — a spatial document authors no content — so a batch that put
   * the actor on every create failed at the first spatial op with an
   * unrecognized-key error. Found by the e2e smoke, not by a unit test.
   */
  it('carries the actor past a spatial create in the same batch', async () => {
    const deps = await makeDeps()
    const out = await createWorkspaceEditTool(deps).execute({
      workspaceId: WS,
      actor: 'reference_agent/mixed',
      ops: [
        { op: 'document.create', path: 'diagram', kind: 'spatial', name: 'D' },
        { op: 'document.create', path: 'prose', kind: 'markdown', markdown: body('one') },
      ],
    })
    expect(out.applied).toBe(2)
    const exported = await exportOkf(deps, {
      workspaceId: WS,
      documentId: out.results[1]?.documentId ?? '',
    })
    expect(exported.frontmatter.generated).toMatchObject({ by: 'reference_agent/mixed' })
  })

  it('names the server when a batch does not identify itself', async () => {
    const deps = await makeDeps()
    const out = await createWorkspaceEditTool(deps).execute({
      workspaceId: WS,
      ops: [{ op: 'document.create', path: 'anon', kind: 'markdown', markdown: body('one') }],
    })
    const exported = await exportOkf(deps, {
      workspaceId: WS,
      documentId: out.results[0]?.documentId ?? '',
    })
    expect(exported.frontmatter.generated).toMatchObject({ by: 'process:whiteboard-server' })
  })
})
