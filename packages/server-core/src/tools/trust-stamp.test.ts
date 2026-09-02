import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createDocumentSetTool, documentSetInputSchema } from './document-set.js'
import { exportOkf } from './export-okf.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'
const NOW = '2026-08-23T12:00:00.000Z'

async function setup() {
  const store = new FakeDocumentStore()
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  const deps = makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
  return { deps, documentSet: createDocumentSetTool(deps) }
}

async function write(markdown: string, actor?: string) {
  const { deps, documentSet } = await setup()
  await documentSet.execute({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    markdown,
    ...(actor === undefined ? {} : { actor }),
  })
  return exportOkf(deps, { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })
}

/**
 * Two writes against ONE document, which `write` above cannot express — it
 * builds a fresh store per call, so every case it covers is a first write.
 * The read-modify-write loop is only visible across two.
 */
async function writeTwice(
  first: { markdown: string; actor?: string; at: string },
  second: (previous: string) => { markdown: string; actor?: string; at: string },
) {
  const { deps, documentSet } = await setup()
  vi.setSystemTime(new Date(first.at))
  await documentSet.execute({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    markdown: first.markdown,
    ...(first.actor === undefined ? {} : { actor: first.actor }),
  })
  const after = await exportOkf(deps, { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })
  const next = second(after.markdown)
  vi.setSystemTime(new Date(next.at))
  await documentSet.execute({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    markdown: next.markdown,
    ...(next.actor === undefined ? {} : { actor: next.actor }),
  })
  return exportOkf(deps, { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })
}

describe('wb_document_set stamps the OKF trust family (ADR-0016)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stamps the declared actor and the server clock', async () => {
    const result = await write('---\ntype: note\n---\nBody.', 'reference_agent/gemini-2.5-pro')

    expect(result.frontmatter.generated).toEqual({
      by: 'reference_agent/gemini-2.5-pro',
      at: NOW,
    })
  })

  it('names the server when the client does not identify itself, rather than inventing one', async () => {
    const result = await write('---\ntype: note\n---\nBody.')

    expect(result.frontmatter.generated).toEqual({ by: 'process:whiteboard-server', at: NOW })
  })

  /**
   * An imported bundle's `generated` is the truth about how that content was
   * produced (§5.2) — the import did not author it. Overwriting it with a
   * stamp would destroy the provenance the family exists to carry.
   */
  it('honours a generated the document already declares instead of restamping it', async () => {
    const result = await write(
      [
        '---',
        'type: note',
        'generated: { by: someone_else/1.0, at: 2020-01-01T00:00:00Z }',
        '---',
        'Body.',
      ].join('\n'),
      'reference_agent/gemini-2.5-pro',
    )

    expect(result.frontmatter.generated).toEqual({
      by: 'someone_else/1.0',
      at: '2020-01-01T00:00:00Z',
    })
  })

  it('carries an incoming verified list through, and emits it at the frontmatter root', async () => {
    const result = await write(
      [
        '---',
        'type: note',
        'verified: { by: "human:ahormati", at: 2026-06-25T09:00:00Z }',
        '---',
        'Body.',
      ].join('\n'),
    )

    // The bare mapping §5.2 makes a MUST to accept, normalised to a list once.
    expect(result.frontmatter.verified).toEqual([
      { by: 'human:ahormati', at: '2026-06-25T09:00:00Z' },
    ])
    expect(result.markdown).toContain('verified:')
    expect(result.markdown).not.toContain('trust:')
  })

  it('does not fold the trust family into facetsRaw, now that it is modelled', async () => {
    const result = await write('---\ntype: note\n---\nBody.')

    expect(result.frontmatter.facetsRaw).toBeUndefined()
  })

  /**
   * On the SCHEMA, not on `execute`: input validation happens once at the MCP
   * boundary (the SDK parses against `inputSchema`), so `execute` receives an
   * already-typed value and asserting there would test nothing.
   */
  it('rejects an actor that is not a single-line string', () => {
    const base = {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      markdown: '---\ntype: note\n---\nBody.',
    }

    expect(documentSetInputSchema.safeParse({ ...base, actor: 'human:a' }).success).toBe(true)
    for (const actor of ['', ' human:a', 'human:a ', 'human:a\nhuman:b']) {
      expect(documentSetInputSchema.safeParse({ ...base, actor }).success).toBe(false)
    }
  })
})

describe('an edit that round-trips our own stamp advances it (ADR-0016 decision 2)', () => {
  const FIRST = '2026-01-01T00:00:00.000Z'
  const LATER = '2026-06-01T00:00:00.000Z'

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * `wb_document_set` replaces the ENTIRE content, so an agent changing one
   * paragraph must read the document first — and the read hands back the
   * `generated` block this server just wrote. Honouring a declared
   * `generated` unconditionally therefore freezes the stamp at the first
   * write and every later edit, by any actor, keeps it. Measured before this
   * rule existed: body `first body` -> `SECOND body`, actor
   * `reference_agent/a` -> `human:someone-else`, five months apart, and
   * `generated` unchanged.
   *
   * That is not a lost signal but a false one, and it defeats the reason
   * decision 2 gives for the server owning the clock: `generated.at` is what
   * a consumer uses to tell a recent edit from a stale fact.
   */
  it('restamps when the declared generated is the one already stored and the content changed', async () => {
    const result = await writeTwice(
      { markdown: '---\ntype: note\n---\nfirst body\n', actor: 'reference_agent/a', at: FIRST },
      (previous) => ({
        markdown: previous.replace('first body', 'SECOND body'),
        actor: 'human:someone-else',
        at: LATER,
      }),
    )

    expect(result.frontmatter.generated).toEqual({ by: 'human:someone-else', at: LATER })
  })

  /**
   * The import case decision 2 protects, unchanged: a stamp this server did
   * not write is foreign provenance and survives, however different the
   * content is from what was there.
   */
  it('still honours a generated this server did not write', async () => {
    const result = await writeTwice(
      { markdown: '---\ntype: note\n---\nours\n', actor: 'reference_agent/a', at: FIRST },
      () => ({
        markdown: [
          '---',
          'type: note',
          'generated: { by: someone_else/1.0, at: 2020-01-01T00:00:00Z }',
          '---',
          'imported over the top',
        ].join('\n'),
        actor: 'reference_agent/a',
        at: LATER,
      }),
    )

    expect(result.frontmatter.generated).toEqual({
      by: 'someone_else/1.0',
      at: '2020-01-01T00:00:00Z',
    })
  })

  /**
   * A rewrite that changes nothing is not an origin event, so re-importing
   * the same bundle twice does not lose its provenance to the second import.
   */
  it('does not restamp a rewrite that changes nothing', async () => {
    const result = await writeTwice(
      { markdown: '---\ntype: note\n---\nsame body\n', actor: 'reference_agent/a', at: FIRST },
      (previous) => ({ markdown: previous, actor: 'human:someone-else', at: LATER }),
    )

    expect(result.frontmatter.generated).toEqual({ by: 'reference_agent/a', at: FIRST })
  })
})
