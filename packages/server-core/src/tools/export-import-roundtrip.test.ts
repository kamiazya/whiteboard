import { parseSpatial } from '@kamiazya/whiteboard-codec'
import { readFacets, readMarkdownBody, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { ignoredDocumentWrites } from '../test-utils/ignored-document-writes.js'
import { unusedDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { SnapshotNotFoundError } from './document-io.js'
import { createDocumentSetTool, OkfParseError } from './document-set.js'
import { exportJsonCanvas } from './export-json-canvas.js'
import { exportOkf } from './export-okf.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(documentStore: FakeDocumentStore) {
  return {
    documentStore,
    blobStore: {} as never,
    documentIndex: documentStore.documentIndex,
    documentTeardown: unusedDocumentTeardown(),
    documentWritten: ignoredDocumentWrites(),
  }
}

async function loadDoc(store: FakeDocumentStore, documentId: string): Promise<LoroDoc> {
  const snap = await store.loadSnapshot({ docRef: { kind: 'document', documentId } })
  if (!snap) throw new Error('no snapshot')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(snap.manifest, snap.chunks))
  return doc
}

async function setupTools() {
  const store = new FakeDocumentStore()
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  const deps = makeDeps(store)
  return {
    store,
    deps,
    documentSet: createDocumentSetTool(deps),
  }
}

describe('wb_document_set -> OKF export composed round-trip', () => {
  test('preserves body text through the LoroDoc persistence layer', async () => {
    const { documentSet, deps } = await setupTools()

    const markdown = '---\ntype: note\n---\n# Title\n\nBody text.'
    await documentSet.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, markdown })

    const result = await exportOkf(deps, { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    expect(result.markdown).toContain('# Title\n\nBody text.')
  })

  test('preserves core facets (type/title/tags/view) through the LoroDoc persistence layer', async () => {
    const { documentSet, deps } = await setupTools()

    const markdown = [
      '---',
      'type: note',
      'title: "Future: browser-extension auto-connect to the local daemon"',
      'tags:',
      '  - idea',
      '  - browser',
      'view: example.kanban/v1',
      'facets:',
      '  example.note/v1:',
      '    status: idea',
      '---',
      'Body text.',
    ].join('\n')
    await documentSet.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, markdown })

    const result = await exportOkf(deps, { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    expect(result.frontmatter.type).toBe('note')
    expect(result.frontmatter.title).toBe(
      'Future: browser-extension auto-connect to the local daemon',
    )
    expect(result.frontmatter.tags).toEqual(['idea', 'browser'])
    expect(result.frontmatter.view).toBe('example.kanban/v1')
    expect(result.frontmatter.facets).toEqual({ 'example.note/v1': { status: 'idea' } })
  })

  test('preserves facets with arbitrary domain keys through the LoroDoc persistence layer', async () => {
    const { documentSet, deps } = await setupTools()

    const markdown = [
      '---',
      'type: issue',
      'facets:',
      '  example.sample/v1:',
      '    status: open',
      '    priority: high',
      '---',
      'Body.',
    ].join('\n')
    await documentSet.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, markdown })

    const result = await exportOkf(deps, { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    expect(result.frontmatter.facets).toEqual({
      'example.sample/v1': { status: 'open', priority: 'high' },
    })
  })

  test('an empty (facets-only) body round-trips to an empty body', async () => {
    const { documentSet, deps } = await setupTools()

    await documentSet.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      markdown: '---\ntype: note\n---\n',
    })

    const result = await exportOkf(deps, { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    expect(result.markdown.endsWith('---\n')).toBe(true)
  })

  test('re-import after export is idempotent: the second import produces the same LoroDoc state', async () => {
    const { store, documentSet, deps } = await setupTools()

    const markdown =
      '---\ntype: note\nfacets:\n  example.kanban/v1:\n    status: todo\n---\nOriginal body.'
    await documentSet.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, markdown })
    const exported = await exportOkf(deps, { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    await documentSet.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      markdown: exported.markdown,
    })
    const doc = await loadDoc(store, DOCUMENT_ID)

    expect(readFacets(doc)).toEqual({ 'example.kanban/v1': { status: 'todo' } })
    expect(readMarkdownBody(doc)).toBe('Original body.')
  })
})

describe('wb_document_set -> the JSON Canvas exporter composed round-trip', () => {
  test('a markdown document has no canvas to export as JSON Canvas', async () => {
    // It used to have exactly one node, because the body was STORED as a
    // text node. That is what made a markdown document also parse as a
    // valid canvas, and why anything resolving a reference had to ask the
    // document its kind before it could tell prose from a diagram. The body
    // now lives in its own container, so the canvas is genuinely empty.
    //
    // Unreachable in production either way: `wb_document_get` routes by
    // kind, so a markdown document is exported as OKF and only a spatial
    // one ever reaches this exporter. Asserted here because the old
    // assertion encoded the ambiguity, not because the path is used.
    const { documentSet, deps } = await setupTools()

    await documentSet.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      markdown: '---\ntype: note\n---\nHello from OKF.',
    })

    const result = await exportJsonCanvas(deps, {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
    })
    expect(JSON.parse(result.json).nodes).toEqual([])

    // The body is not lost — it is read through its own accessor, which is
    // what the OKF export uses.
    const okf = await exportOkf(deps, { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })
    expect(okf.markdown).toContain('Hello from OKF.')
  })

  test('the exported (strict) JSON Canvas has no x-whiteboard extensions', async () => {
    // Seeded as a SPATIAL document carrying the extension, which is both
    // what this exporter is actually for and the only way this assertion
    // can fail. It used to seed markdown and index `nodes[0]`, which worked
    // only because a markdown body was stored as a node; over an empty
    // node list the same loop would pass while checking nothing.
    const { store, deps } = await setupTools()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeSpatialCanvas(doc, {
        nodes: [
          {
            id: 'n1',
            type: 'text',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            text: 'hi',
            'x-whiteboard': { kind: 'embed', documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
          },
        ],
        edges: [],
      })
    })

    const result = await exportJsonCanvas(deps, {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      options: { strict: true },
    })
    const parsed = JSON.parse(result.json)

    expect(parsed.nodes).toHaveLength(1)
    expect(parsed.nodes[0]['x-whiteboard']).toBeUndefined()
  })
})

describe('the JSON Canvas exporter output re-parses as valid JSON Canvas', () => {
  test('parseSpatial succeeds on the exported (extended) JSON', async () => {
    const { documentSet, deps } = await setupTools()

    await documentSet.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      markdown: '---\ntype: note\n---\nRe-parse me.',
    })
    const result = await exportJsonCanvas(deps, {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
    })

    expect(parseSpatial(result.json).ok).toBe(true)
  })

  test('parseSpatial succeeds on the exported (strict) JSON', async () => {
    const { documentSet, deps } = await setupTools()

    await documentSet.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      markdown: '---\ntype: note\n---\nRe-parse me too.',
    })
    const result = await exportJsonCanvas(deps, {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      options: { strict: true },
    })

    expect(parseSpatial(result.json).ok).toBe(true)
  })
})

describe('error paths do not silently produce corrupt output', () => {
  test('import_okf with no frontmatter rejects before any export is attempted', async () => {
    const { documentSet, deps } = await setupTools()

    await expect(
      documentSet.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        markdown: 'no frontmatter here',
      }),
    ).rejects.toThrow(OkfParseError)

    // No snapshot was ever saved, so the composed export attempt surfaces a
    // clean not-found error rather than reading corrupt/partial state.
    await expect(
      exportOkf(deps, { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }),
    ).rejects.toThrow(SnapshotNotFoundError)
  })

  test('a non-yaml-safe facet value (YAML .nan) imports but rejects on export, never silently exported', async () => {
    const { documentSet, deps } = await setupTools()

    // parseOkf's frontmatter schema only validates facet KEYS, not values
    // (extensionFacetsSchema stores values as z.unknown()) — the yaml-safe
    // check runs on serialize, so a YAML-native `.nan` scalar (parsed to the
    // JS NaN, which has no round-trippable YAML representation) imports
    // successfully but must fail the composed export rather than silently
    // emitting corrupt YAML.
    const markdown = '---\ntype: note\nfacets:\n  example.bad/v1:\n    value: .nan\n---\nBody.'
    await documentSet.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, markdown })

    await expect(
      exportOkf(deps, { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }),
    ).rejects.toThrow(/yaml-safe/)
  })

  /**
   * The concrete shape the preservation rule exists for: an OKF v0.2 document
   * written by some other producer. A read-edit-write through the whiteboard
   * must hand every family back (§4.1, §5, §10.2) — the trust pair as typed
   * fields it models (ADR-0016), everything else carried verbatim.
   */
  test('preserves an OKF v0.2 document: the trust family as typed fields, the rest carried verbatim', async () => {
    const { documentSet, deps } = await setupTools()

    const markdown = [
      '---',
      'type: Attested Computation',
      'description: Recognized revenue for a fiscal year, per Finance definition.',
      'status: stable',
      'runtime: bigquery',
      'parameters:',
      '  - { name: year, type: integer, required: true }',
      'executor:',
      '  resource: references/skills/run-on-bq.md',
      '  receipt: [job_id, executed_sql, result]',
      'attester:',
      '  resource: references/attesters/revenue.py',
      'generated: { by: reference_agent/gemini-2.5-pro, at: 2026-06-20T22:53:05Z }',
      'verified: { by: "human:ahormati", at: 2026-06-25T09:00:00Z }',
      'stale_after: 2026-09-23T00:00:00Z',
      'sources:',
      '  - id: rev-policy',
      '    resource: https://wiki.acme/finance/revenue-recognition',
      '    usage_count: 5000',
      'usage_window: { from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z }',
      '---',
      '# Computation',
      '',
      '    SELECT SUM(amount) AS revenue',
    ].join('\n')

    await documentSet.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, markdown })
    const result = await exportOkf(deps, { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })

    expect(result.frontmatter.type).toBe('Attested Computation')
    expect(result.frontmatter.description).toBe(
      'Recognized revenue for a fiscal year, per Finance definition.',
    )
    expect(result.frontmatter.generated).toEqual({
      by: 'reference_agent/gemini-2.5-pro',
      at: '2026-06-20T22:53:05Z',
    })
    expect(result.frontmatter.verified).toEqual([
      { by: 'human:ahormati', at: '2026-06-25T09:00:00Z' },
    ])
    expect(result.frontmatter.facetsRaw).toEqual({
      status: 'stable',
      runtime: 'bigquery',
      parameters: [{ name: 'year', type: 'integer', required: true }],
      executor: {
        resource: 'references/skills/run-on-bq.md',
        receipt: ['job_id', 'executed_sql', 'result'],
      },
      attester: { resource: 'references/attesters/revenue.py' },
      stale_after: '2026-09-23T00:00:00Z',
      sources: [
        {
          id: 'rev-policy',
          resource: 'https://wiki.acme/finance/revenue-recognition',
          usage_count: 5000,
        },
      ],
      usage_window: { from: '2026-06-01T00:00:00Z', to: '2026-06-30T00:00:00Z' },
    })
    // Emitted at the root they came from, never as a `facetsRaw:` key of
    // this codebase's own invention.
    expect(result.markdown).toContain('\nstatus: stable\n')
    expect(result.markdown).not.toContain('facetsRaw:')
  })

  test('export_okf on a canvas with no stored snapshot surfaces a clean error', async () => {
    const deps = makeDeps(new FakeDocumentStore())

    await expect(
      exportOkf(deps, { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }),
    ).rejects.toThrow(SnapshotNotFoundError)
  })

  test('export_json_canvas on a canvas with no stored snapshot surfaces a clean error', async () => {
    const deps = makeDeps(new FakeDocumentStore())

    await expect(
      exportJsonCanvas(deps, { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }),
    ).rejects.toThrow(SnapshotNotFoundError)
  })
})
