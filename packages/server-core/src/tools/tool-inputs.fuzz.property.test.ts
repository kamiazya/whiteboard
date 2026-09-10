/**
 * Every MCP tool, called with inputs drawn from its OWN input schema.
 *
 * A tool's tests exercise the inputs its author thought of. This lane draws
 * the rest — every optional field, every union arm, every enum value the
 * schema admits — against a seeded in-memory workspace, and asks two things
 * of each call: that it either answers or REFUSES (a domain error naming
 * what was wrong), never crashes; and that what it answers is what its
 * `outputSchema` says it answers. The MCP SDK validates `structuredContent`
 * against `outputSchema` at runtime, so the second is a defect a model
 * would see as a failed call, and the first is a stack trace where a reason
 * should be.
 *
 * A refusal is any error that is not shaped like a crash. A crash is a
 * `TypeError` / `RangeError` / `ReferenceError` / `SyntaxError`, a
 * non-Error thrown, or a message in the vocabulary of one ("Cannot read
 * properties of undefined"). The refusing test doubles this harness does
 * not replace are ENVIRONMENT, counted so a tool that only ever hit one is
 * visible as unexercised rather than passing.
 *
 * Ids are drawn from the seeded workspace at real weight — a spatial
 * document with two nodes, a group, an edge and a comment, a markdown document, and
 * one id that exists nowhere — so a tool reaches its happy path as well as
 * its not-found path, and a node-scoped op names a node that is there.
 */

import { facetsArbitrary } from '@kamiazya/whiteboard-facet-engine/testing'
import {
  writeCoreFacets,
  writeDocumentKind,
  writeMarkdownBody,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  annotationIdSchema,
  documentIdSchema,
  documentPathSchema,
  extensionFacetsSchema,
  nodeIdSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { arbitraryForSchema, sameSchema } from '@kamiazya/whiteboard-model/test-utils'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import type { LoroDoc } from 'loro-crdt'
import { afterAll, describe, expect } from 'vitest'
import type { z } from 'zod'
import { createServer } from '../create-server.js'
import { FakeDocumentStore, seedDoc } from '../test-utils/fake-document-store.js'
import { FakeLiveDocuments } from '../test-utils/fake-live-documents.js'
import { FakeVersionHistory } from '../test-utils/fake-version-history.js'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { inMemoryDocumentTeardown } from '../test-utils/unused-document-teardown.js'

const WORKSPACE_ID = 'ws-1'
const SPATIAL_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const MARKDOWN_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'
const MISSING_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V9'

async function seededTools() {
  const store = new FakeDocumentStore()
  let board: LoroDoc | undefined
  await seedDoc(store, SPATIAL_ID, (doc) => {
    board = doc
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, {
      nodes: [
        { id: 'n1', type: 'text', x: 0, y: 0, width: 200, height: 80, text: 'one' },
        { id: 'n2', type: 'text', x: 400, y: 0, width: 200, height: 80, text: 'two' },
        { id: 'g1', type: 'group', x: -20, y: 200, width: 640, height: 200, label: 'later' },
      ],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
      'x-whiteboard': { comments: [{ id: 'c1', x: 10, y: 10, text: 'why?', targetNodeId: 'n1' }] },
    })
  })
  await seedDoc(store, MARKDOWN_ID, (doc) => {
    writeDocumentKind(doc, 'markdown')
    writeCoreFacets(doc, { type: 'note', tags: ['seed'] })
    writeMarkdownBody(doc, `# Plan\n\nA paragraph with [[${SPATIAL_ID}]] in it.\n`)
  })
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    documentId: SPATIAL_ID,
    path: 'board',
    kind: 'spatial',
  })
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    documentId: MARKDOWN_ID,
    path: 'notes/plan',
    kind: 'markdown',
  })
  const versions = new FakeVersionHistory()
  if (board === undefined) throw new Error('seedDoc did not configure the board')
  // One saved version, so restore and list have something to name ('v1').
  await versions.save(WORKSPACE_ID, 'board', board, { auto: false, label: 'seed' })
  const deps = makeTestDeps({
    documentStore: store,
    documentIndex: store.documentIndex,
    documentTeardown: inMemoryDocumentTeardown(),
    versions,
    liveDocuments: new FakeLiveDocuments(),
  })
  return createServer(deps).tools
}

/**
 * The seeded ids and passages at real weight, so a tool reaches what exists
 * as well as what does not: a node-scoped op names a node that is there, a
 * passage edit quotes text the body holds, a facet write carries a payload
 * the registry accepts, and a version id names the one version saved.
 * Matched by the schema's def (`.describe()` clones the object) or by the
 * field's path where a tool declares its own `z.string()`.
 */
const facetsForAnyTarget = fc.oneof(
  facetsArbitrary(bundledFacetRegistry, 'node'),
  facetsArbitrary(bundledFacetRegistry, 'canvas'),
  facetsArbitrary(bundledFacetRegistry, 'document'),
)
const passages = fc.constantFrom('Plan', 'paragraph', 'in it')
const override = (path: string, schema: z.ZodTypeAny): fc.Arbitrary<unknown> | undefined => {
  if (sameSchema(schema, workspaceIdSchema)) {
    return fc.constantFrom(WORKSPACE_ID, WORKSPACE_ID, WORKSPACE_ID, 'nowhere')
  }
  if (sameSchema(schema, documentIdSchema)) {
    return fc.constantFrom(SPATIAL_ID, SPATIAL_ID, MARKDOWN_ID, MARKDOWN_ID, MISSING_ID)
  }
  if (sameSchema(schema, documentPathSchema)) return fc.constantFrom('board', 'notes/plan', 'fresh')
  if (sameSchema(schema, nodeIdSchema)) {
    return fc.constantFrom('n1', 'n1', 'n2', 'n2', 'g1', 'n3', 'e1', 'e1', 'e2', 'zz')
  }
  if (sameSchema(schema, annotationIdSchema)) return fc.constantFrom('c1', 't2', 'zz')
  if (sameSchema(schema, extensionFacetsSchema)) return facetsForAnyTarget
  if (path.endsWith('.versionId')) return fc.constantFrom('v1', 'zz')
  if (path.endsWith('.exact') || path.endsWith('.assumed')) return passages
  if (path.endsWith('.fragment') || path.endsWith('.query')) {
    return fc.oneof(passages, fc.constantFrom('one', 'two'), fc.string({ maxLength: 6 }))
  }
  if (path.endsWith('.markdown')) {
    return fc.oneof(
      fc.constant('---\ntype: note\ntags: [a]\n---\n# Title\n\nA body.\n'),
      fc.string({ maxLength: 40 }),
    )
  }
  return undefined
}

/**
 * What one field cannot know about its siblings. Each is a fix-up over a
 * drawn input for ONE tool, applied to a share of the draws so the
 * refusal it removes stays reachable on the rest: a facet write carries a
 * payload for the target it names; a passage edit's `assumed` is what the
 * passage says, which is the contract the field states.
 */
/** `input` with `patch` applied on three draws in four, so the unshaped refusal stays reachable. */
function mostly<T>(inputs: fc.Arbitrary<unknown>, patch: (input: T) => T): fc.Arbitrary<unknown> {
  return fc
    .tuple(inputs, fc.nat({ max: 3 }))
    .map(([input, keep]) => (keep === 0 ? input : patch(input as T)))
}

const shapeFor: Record<string, (input: fc.Arbitrary<unknown>) => fc.Arbitrary<unknown>> = {
  wb_facet_set: (inputs) =>
    inputs.chain((drawn) => {
      const input = drawn as {
        documentIds: string[]
        nodeId?: string
        target?: string
        tags?: unknown
        facets?: unknown
      }
      const target =
        input.nodeId !== undefined ? 'node' : input.target === 'canvas' ? 'canvas' : 'document'
      // A node write names one spatial document and carries no tags; the
      // rest is what the schema drew.
      const scoped =
        input.nodeId === undefined
          ? input
          : { ...input, documentIds: [SPATIAL_ID], tags: undefined }
      return mostly(
        fc
          .option(facetsArbitrary(bundledFacetRegistry, target), { nil: undefined, freq: 4 })
          .map((facets) => (facets === undefined ? scoped : { ...scoped, facets })),
        (input: { tags?: unknown }) => {
          const { tags: _dropped, ...rest } = input
          return rest
        },
      )
    }),
  wb_body_edit: (inputs) =>
    mostly(
      inputs,
      (input: {
        documentId: string
        ops: { anchor: { quote: { exact: string } }; assumed: string }[]
      }) => ({
        ...input,
        documentId: MARKDOWN_ID,
        ops: input.ops.map((op) => ({ ...op, assumed: op.anchor.quote.exact })),
      }),
    ),
  // One op at a time on the spatial document, mostly: the op union is wide
  // and each op wants its own context (a group for `within`, a range inside
  // a body, a patch the node's type has fields for), so a batch of four
  // random ops nearly always carries one the canvas refuses.
  wb_canvas_edit: (inputs) =>
    mostly(inputs, (input: { documentId: string; ops: unknown[] }) => ({
      ...input,
      documentId: SPATIAL_ID,
      ops: input.ops.slice(0, 1),
    })),
}

type Outcome = 'answered' | 'refused' | 'environment' | 'crash' | 'drift'
const ENVIRONMENT =
  /was called by a test that passed unused|composed a \w+ it does not exercise|not exercised|not implemented/
const CRASH_NAMES = new Set(['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'])
const CRASH_MESSAGE =
  /Cannot read propert|is not a function|is not iterable|undefined is not|Maximum call stack|Invalid array length|Unexpected token|Cannot convert|Cannot destructure/

function classifyThrow(error: unknown): { outcome: Outcome; detail: string } {
  if (!(error instanceof Error))
    return { outcome: 'crash', detail: `threw a non-Error: ${String(error)}` }
  if (ENVIRONMENT.test(error.message)) return { outcome: 'environment', detail: error.message }
  if (CRASH_NAMES.has(error.name) || CRASH_MESSAGE.test(error.message)) {
    return { outcome: 'crash', detail: `${error.name}: ${error.message}\n${error.stack ?? ''}` }
  }
  return { outcome: 'refused', detail: `${error.name}: ${error.message}` }
}

interface ToolLike {
  readonly name: string
  readonly inputSchema: z.ZodTypeAny
  readonly outputSchema?: z.ZodTypeAny
  execute(input: never): Promise<unknown>
}

const tally = new Map<string, Record<Outcome, number>>()
const reasons = new Map<string, Map<string, number>>()
const emptyTally = (): Record<Outcome, number> => ({
  answered: 0,
  refused: 0,
  environment: 0,
  crash: 0,
  drift: 0,
})

const catalogue = await seededTools()

describe('every tool answers or refuses an input its own schema admits', () => {
  for (const [key, tool] of Object.entries(catalogue) as [string, ToolLike][]) {
    const counts = emptyTally()
    tally.set(tool.name, counts)
    const drawn = arbitraryForSchema(tool.inputSchema, { override })
    const inputs = (shapeFor[tool.name] ?? ((same) => same))(drawn)
    fcTest.prop([inputs], withDefaults({ numRuns: 100 }))(tool.name, async (input) => {
      // Fresh state per run: a write tool must not leave the next draw a
      // different document than the one every other draw sees.
      const tools = await seededTools()
      const subject = (tools as Record<string, ToolLike>)[key]
      if (subject === undefined) throw new Error(`no tool at ${key}`)
      let result: unknown
      try {
        result = await subject.execute(input as never)
      } catch (error) {
        const { outcome, detail } = classifyThrow(error)
        counts[outcome] += 1
        const byReason = reasons.get(tool.name) ?? new Map<string, number>()
        reasons.set(tool.name, byReason)
        const reason = detail.slice(0, 110)
        byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
        expect(outcome, `${tool.name} on ${JSON.stringify(input)}\n${detail}`).not.toBe('crash')
        return
      }
      if (subject.outputSchema !== undefined) {
        const parsed = subject.outputSchema.safeParse(result)
        if (!parsed.success) {
          counts.drift += 1
          expect.fail(
            `${tool.name} answered something its outputSchema refuses for ${JSON.stringify(input)}:\n` +
              parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n'),
          )
        }
      }
      counts.answered += 1
    })
  }

  afterAll(() => {
    if (process.env.FUZZ_TALLY) {
      for (const [name, counts] of tally) {
        console.info(name, JSON.stringify(counts), [...(reasons.get(name) ?? [])].join(' | '))
      }
    }
    // A tool this lane never got past a refusing double is unexercised, and
    // that has to be visible rather than read as green.
    const unexercised = [...tally.entries()]
      .filter(([, c]) => c.answered === 0)
      .map(([name]) => name)
    expect(unexercised, `tools this lane never exercised: ${JSON.stringify([...tally])}`).toEqual(
      [],
    )
  })
})
