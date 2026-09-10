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
// Built once: constructing one runs the registry's own preflight over
// every facet, which inside a per-draw `chain` cost a property its timeout.
const facetsByTarget = {
  node: facetsArbitrary(bundledFacetRegistry, 'node'),
  canvas: facetsArbitrary(bundledFacetRegistry, 'canvas'),
  document: facetsArbitrary(bundledFacetRegistry, 'document'),
} as const
const facetsForAnyTarget = fc.oneof(
  facetsByTarget.node,
  facetsByTarget.canvas,
  facetsByTarget.document,
)
const passages = fc.constantFrom('Plan', 'paragraph', 'in it')
const OKF_NOTE = '---\ntype: note\ntags: [a]\n---\n# Title\n\nA body.\n'
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
  if (path.endsWith('.markdown'))
    return fc.oneof(fc.constant(OKF_NOTE), fc.string({ maxLength: 40 }))
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
          .option(facetsByTarget[target], { nil: undefined, freq: 4 })
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
  // One op at a time on the spatial document, mostly, each fitted to the
  // seeded canvas: the op union is wide and each op wants its own context
  // (a group for `within`, a range inside a body, a patch the node's type
  // has fields for), so a batch of four random ops nearly always carries
  // one the canvas refuses.
  wb_canvas_edit: (inputs) =>
    mostly(inputs, (input: { documentId: string; ops: Record<string, unknown>[] }) => ({
      ...input,
      documentId: SPATIAL_ID,
      ops: input.ops.slice(0, 1).map(fitCanvasOp),
    })),
}

shapeFor.wb_workspace_edit = (inputs) =>
  // A `document.set` writes OKF onto the markdown document, mostly.
  mostly(inputs, (input: { ops: Record<string, unknown>[] }) => ({
    ...input,
    ops: input.ops.map((op) =>
      op.op === 'document.set' ? { ...op, documentId: MARKDOWN_ID, markdown: OKF_NOTE } : op,
    ),
  }))

shapeFor.wb_thread_edit = (inputs) =>
  // A reply and a resolution name the thread the spatial document holds.
  mostly(inputs, (input: { documentId: string; ops: Record<string, unknown>[] }) => ({
    ...input,
    documentId: SPATIAL_ID,
    ops: input.ops.map((op) => (op.op === 'thread.add' ? op : { ...op, threadId: 'c1' })),
  }))

const TEXT_NODE_PATCH_FIELDS = new Set(['x', 'y', 'width', 'height', 'color', 'text'])
const SEEDED_NODES = new Set(['n1', 'n2', 'g1'])

/** Each op aimed at what the seeded canvas holds; unfitted, four never answered and the edge ops barely did. */
function fitCanvasOp(op: Record<string, unknown>): Record<string, unknown> {
  const { within: _within, all: _all, ...targeted } = op
  switch (op.op) {
    case 'node.patch': {
      const patch = Object.entries((op.patch ?? {}) as Record<string, unknown>).filter(([key]) =>
        TEXT_NODE_PATCH_FIELDS.has(key),
      )
      return { ...targeted, id: 'n1', patch: Object.fromEntries(patch) }
    }
    case 'node.splice':
      // n1's text is one line: the range is [0, 0] or [0, 1].
      return { ...targeted, id: 'n1', startLine: 0, endLine: (op.endLine as number) % 2 }
    case 'comment.resolve':
      return { ...targeted, id: 'c1' }
    case 'edge.patch': {
      const patch = (op.patch ?? {}) as Record<string, unknown>
      return {
        ...targeted,
        id: 'e1',
        patch: {
          ...patch,
          ...(patch.fromNode === undefined ? {} : { fromNode: 'n1' }),
          ...(patch.toNode === undefined ? {} : { toNode: 'n2' }),
        },
      }
    }
    case 'edge.remove':
    case 'edge.lock':
      return { ...targeted, id: 'e1' }
    case 'edge.add': {
      const edge = (op.edge ?? {}) as Record<string, unknown>
      return { ...op, edge: { ...edge, id: 'e2', fromNode: 'n1', toNode: 'n2' } }
    }
    case 'region.set':
      return {
        ...op,
        within: 'g1',
        nodes: ((op.nodes as string[]) ?? []).filter((id) => SEEDED_NODES.has(id) && id !== 'g1'),
        ...(op.edges === undefined
          ? {}
          : { edges: (op.edges as string[]).filter((id) => id === 'e1') }),
      }
    default:
      return op
  }
}

/**
 * A batch tool's op union, read off its schema: each arm's `op` literal and
 * the arm itself, so the lane can drive ONE op kind at a time. A wide union
 * cannot pass on one arm this way — measured before this split: 100 draws
 * of `wb_canvas_edit` answered with 7 of its 13 op kinds, and `node.add`,
 * `node.patch`, `node.splice`, `edge.remove`, `comment.resolve` and
 * `region.set` were never seen on the answering path.
 */
interface OpArm {
  readonly op: string
  readonly schema: z.ZodTypeAny
}
const internalsOf = (schema: z.ZodTypeAny) =>
  (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def
const literalOf = (schema: z.ZodTypeAny | undefined): string | undefined => {
  const values = schema === undefined ? undefined : (internalsOf(schema).values as unknown[])
  return typeof values?.[0] === 'string' ? values[0] : undefined
}
/** Every arm under `schema`, flattening nested unions; an arm is named by its `op` and, where two share one, its `kind`. */
function armsUnder(schema: z.ZodTypeAny): readonly OpArm[] {
  const def = internalsOf(schema)
  if (def.type === 'union') return (def.options as z.ZodTypeAny[]).flatMap(armsUnder)
  const inner = (def.innerType ?? def.in) as z.ZodTypeAny | undefined
  if (def.shape === undefined && inner !== undefined) return armsUnder(inner)
  const shape = def.shape as Record<string, z.ZodTypeAny> | undefined
  const op = literalOf(shape?.op)
  if (op === undefined) return []
  const kind = literalOf(shape?.kind)
  return [{ op: kind === undefined ? op : `${op}(${kind})`, schema }]
}
function opArmsOf(inputSchema: z.ZodTypeAny): readonly OpArm[] {
  const shape = internalsOf(inputSchema).shape as Record<string, z.ZodTypeAny> | undefined
  const ops = shape?.ops
  if (ops === undefined) return []
  let element = ops
  while (internalsOf(element).element === undefined) {
    const inner = (internalsOf(element).innerType ?? internalsOf(element).in) as
      | z.ZodTypeAny
      | undefined
    if (inner === undefined) return []
    element = inner
  }
  return armsUnder(internalsOf(element).element as z.ZodTypeAny)
}

/**
 * Whether each op kind reaches the tool's ANSWERING path from the seeded
 * workspace — a ledger in the repo's sense: every arm of every batch tool
 * has an entry, an entry names an arm that exists, `answers` is checked
 * against the run, and a `refused-only:` entry says why the seeding cannot
 * reach it and is checked to still be true. A new op arrives unclassified
 * and fails the run until someone answers for it.
 */
type OpReach = 'answers' | `refused-only: ${string}`
const OP_REACH: Record<string, OpReach> = {
  'wb_workspace_edit/document.create(markdown)': 'answers',
  'wb_workspace_edit/document.create(spatial)': 'answers',
  'wb_workspace_edit/document.set': 'answers',
  'wb_workspace_edit/document.delete': 'answers',
  'wb_body_edit/body.replace': 'answers',
  'wb_canvas_edit/node.add': 'answers',
  'wb_canvas_edit/node.patch': 'answers',
  'wb_canvas_edit/node.splice': 'answers',
  'wb_canvas_edit/node.remove': 'answers',
  'wb_canvas_edit/edge.add': 'answers',
  'wb_canvas_edit/edge.patch': 'answers',
  'wb_canvas_edit/edge.remove': 'answers',
  'wb_canvas_edit/node.lock': 'answers',
  'wb_canvas_edit/edge.lock': 'answers',
  'wb_canvas_edit/tidy': 'answers',
  'wb_canvas_edit/comment.add': 'answers',
  'wb_canvas_edit/comment.resolve': 'answers',
  'wb_canvas_edit/region.set': 'answers',
  'wb_thread_edit/thread.add': 'answers',
  'wb_thread_edit/message.add': 'answers',
  'wb_thread_edit/thread.resolve': 'answers',
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
/** Which op kinds (and which top-level keys) each tool ANSWERED with, so a wide op union cannot pass on one arm. */
const answeredShapes = new Map<string, Map<string, number>>()
function recordShape(name: string, input: unknown): void {
  const shapes = answeredShapes.get(name) ?? new Map<string, number>()
  answeredShapes.set(name, shapes)
  const record = input as { ops?: { op?: string }[] } & Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  shapes.set(`keys:${keys}`, (shapes.get(`keys:${keys}`) ?? 0) + 1)
  for (const op of record.ops ?? []) {
    if (typeof op.op === 'string') shapes.set(`op:${op.op}`, (shapes.get(`op:${op.op}`) ?? 0) + 1)
  }
}
const emptyTally = (): Record<Outcome, number> => ({
  answered: 0,
  refused: 0,
  environment: 0,
  crash: 0,
  drift: 0,
})

const catalogue = await seededTools()

async function runOnce(
  key: string,
  tool: ToolLike,
  input: unknown,
  counts: Record<Outcome, number>,
): Promise<void> {
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
  recordShape(tool.name, input)
}

const opTally = new Map<string, Record<Outcome, number>>()

describe('every tool answers or refuses an input its own schema admits', () => {
  for (const [key, tool] of Object.entries(catalogue) as [string, ToolLike][]) {
    const counts = emptyTally()
    tally.set(tool.name, counts)
    const drawn = arbitraryForSchema(tool.inputSchema, { override })
    const inputs = (shapeFor[tool.name] ?? ((same) => same))(drawn)
    fcTest.prop([inputs], withDefaults({ numRuns: 100 }))(tool.name, async (input) => {
      await runOnce(key, tool, input, counts)
    })

    // One op kind at a time, so every arm of the union is driven at the
    // same rate rather than at whatever share a random batch gives it.
    for (const arm of opArmsOf(tool.inputSchema)) {
      const armCounts = emptyTally()
      opTally.set(`${tool.name}/${arm.op}`, armCounts)
      const single = fc
        .tuple(drawn, arbitraryForSchema(arm.schema, { override }))
        .map(([input, op]) => ({ ...(input as Record<string, unknown>), ops: [op] }))
      const shaped = (shapeFor[tool.name] ?? ((same) => same))(single)
      fcTest.prop([shaped], withDefaults({ numRuns: 60 }))(
        `${tool.name} with one ${arm.op} op`,
        async (input) => {
          await runOnce(key, tool, input, armCounts)
        },
      )
    }
  }

  afterAll(() => {
    if (process.env.FUZZ_TALLY) {
      for (const [name, counts] of tally) {
        console.info(name, JSON.stringify(counts), [...(reasons.get(name) ?? [])].join(' | '))
        console.info(`  answered-shapes ${name}`, [...(answeredShapes.get(name) ?? [])].join(' | '))
      }
      for (const [name, counts] of opTally) console.info('op', name, JSON.stringify(counts))
    }
    // A tool this lane never got past a refusing double is unexercised, and
    // that has to be visible rather than read as green.
    const unexercised = [...tally.entries()]
      .filter(([, c]) => c.answered === 0)
      .map(([name]) => name)
    expect(unexercised, `tools this lane never exercised: ${JSON.stringify([...tally])}`).toEqual(
      [],
    )
    // The op ledger, both directions.
    const arms = [...opTally.keys()]
    expect(
      arms.filter((arm) => !(arm in OP_REACH)),
      'op arms with no OP_REACH entry',
    ).toEqual([])
    expect(
      Object.keys(OP_REACH).filter((entry) => !opTally.has(entry)),
      'OP_REACH entries naming no op arm',
    ).toEqual([])
    const wrong = arms.flatMap((arm) => {
      const counts = opTally.get(arm)
      const claim = OP_REACH[arm]
      if (counts === undefined || claim === undefined) return []
      if (claim === 'answers' && counts.answered === 0)
        return [`${arm}: claimed to answer, never did`]
      if (claim !== 'answers' && counts.answered > 0) return [`${arm}: ${claim} — but it answered`]
      return []
    })
    expect(wrong).toEqual([])
  })
})
