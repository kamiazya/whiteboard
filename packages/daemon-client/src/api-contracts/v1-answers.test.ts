/**
 * A newer daemon adds a field to an `/api/v1` answer; an older cached bundle
 * must still read the answer it asked for.
 *
 * Every case parses a fixture carrying an UNKNOWN key at every object level
 * (`...extra`, written out by hand so a record's own keys are never
 * mistaken for one) through the schema the browser really uses — the barrel's
 * export, not the server-core declaration behind it. The MCP tool outputs
 * those answers derive from are `.strict()` for the SDK's runtime check, so
 * parsing through them is the failure this holds against: "Response failed
 * schema validation" for a document that was in fact created.
 */
import { describe, expect, it } from 'vitest'
import { versionDocumentResponseSchema } from './document.js'
import {
  createDocumentV1ResponseSchema,
  documentBacklinksResponseSchema,
  documentOkfV1ResponseSchema,
  documentSearchResponseSchema,
  linkifyMentionsResponseSchema,
  workspaceDocumentTagsResponseSchema,
} from './index.js'

const DOCUMENT_ID = '01HZX3K9Q5V8N2M4P6R7S8T9WA'
const OTHER_ID = '01HZX3K9Q5V8N2M4P6R7S8T9WB'
const extra = { futureField: 'a newer daemon says this' }

const backlink = {
  documentId: OTHER_ID,
  path: 'notes/b',
  kind: 'markdown',
  contexts: ['see [[a]]'],
}

const ANSWERS = [
  {
    name: 'createDocumentV1ResponseSchema',
    schema: createDocumentV1ResponseSchema,
    known: { workspaceId: 'ws-1', documentId: DOCUMENT_ID, path: 'notes/a' },
    withExtras: { workspaceId: 'ws-1', documentId: DOCUMENT_ID, path: 'notes/a', ...extra },
  },
  {
    name: 'documentBacklinksResponseSchema',
    schema: documentBacklinksResponseSchema,
    known: { backlinks: [backlink], unlinkedMentions: [backlink] },
    withExtras: {
      backlinks: [{ ...backlink, ...extra }],
      unlinkedMentions: [{ ...backlink, ...extra }],
      ...extra,
    },
  },
  {
    name: 'workspaceDocumentTagsResponseSchema',
    schema: workspaceDocumentTagsResponseSchema,
    known: {
      documents: [{ documentId: DOCUMENT_ID, tags: ['health:ok'] }],
      contents: [{ documentId: DOCUMENT_ID, tags: ['health:ok'] }],
      inUse: [{ tag: 'health:ok', documents: 1, boards: 0, nodes: 0, edges: 0 }],
      library: { health: { exclusive: true, values: { ok: { color: '4' } } } },
    },
    withExtras: {
      documents: [{ documentId: DOCUMENT_ID, tags: ['health:ok'], ...extra }],
      contents: [{ documentId: DOCUMENT_ID, tags: ['health:ok'], ...extra }],
      inUse: [{ tag: 'health:ok', documents: 1, boards: 0, nodes: 0, edges: 0, ...extra }],
      library: { health: { exclusive: true, values: { ok: { color: '4', ...extra } }, ...extra } },
      ...extra,
    },
  },
  {
    name: 'linkifyMentionsResponseSchema',
    schema: linkifyMentionsResponseSchema,
    known: { linked: 2 },
    withExtras: { linked: 2, ...extra },
  },
  {
    name: 'documentOkfV1ResponseSchema',
    schema: documentOkfV1ResponseSchema,
    known: { markdown: '# a', body: '# a', frontmatter: { type: 'note' } },
    withExtras: { markdown: '# a', body: '# a', frontmatter: { type: 'note' }, ...extra },
  },
  {
    name: 'documentSearchResponseSchema',
    schema: documentSearchResponseSchema,
    known: { results: [{ documentId: DOCUMENT_ID, path: 'notes/a', score: 1.5, contexts: ['a'] }] },
    withExtras: {
      results: [
        { documentId: DOCUMENT_ID, path: 'notes/a', score: 1.5, contexts: ['a'], ...extra },
      ],
      ...extra,
    },
  },
] as const

describe('the /api/v1 answers the browser parses tolerate a field they have not heard of', () => {
  it.each(ANSWERS)('$name reads the fixture as written', ({ schema, known }) => {
    // The control: without it a fixture the schema refuses outright would
    // make every case below fail for a reason that has nothing to do with
    // the extra key.
    expect(schema.safeParse(known).success).toBe(true)
  })

  it.each(ANSWERS)('$name reads an answer carrying an unknown key at every level', ({
    schema,
    known,
    withExtras,
  }) => {
    const parsed = schema.safeParse(withExtras)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    // Read as the fields this bundle knows, no more and no fewer.
    expect(parsed.data).toEqual(known)
  })

  it('versionDocumentResponseSchema reads a stored canvas whose node a newer daemon gave a field', () => {
    const node = { id: 'n1', x: 0, y: 0, width: 100, height: 40 }
    const parsed = versionDocumentResponseSchema.safeParse({
      kind: 'spatial',
      canvas: { nodes: [{ ...node, ...extra }], edges: [], ...extra },
    })
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    expect(parsed.data).toEqual({ kind: 'spatial', canvas: { nodes: [node], edges: [] } })
  })

  it('still refuses a declared field of the wrong type, so tolerance is not acceptance', () => {
    expect(linkifyMentionsResponseSchema.safeParse({ linked: -1 }).success).toBe(false)
    expect(
      createDocumentV1ResponseSchema.safeParse({ workspaceId: 'ws-1', documentId: 'nope' }).success,
    ).toBe(false)
  })
})
