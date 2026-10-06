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
 * Ids are drawn from the seeded workspace (`test-utils/seeded-workspace.ts`,
 * shared with the route lane) at real weight, plus one id that exists
 * nowhere — so a tool reaches its happy path as well as its not-found path,
 * and a node-scoped op names a node that is there.
 */

import { facetsArbitrary } from '@kamiazya/whiteboard-facet-engine/testing'
import {
  annotationIdSchema,
  documentIdSchema,
  documentPathSchema,
  extensionFacetsSchema,
  nodeIdSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import {
  afterAllFloor,
  arbitraryForSchema,
  sameSchema,
} from '@kamiazya/whiteboard-model/test-utils'
import { bundledFacetRegistry } from '@kamiazya/whiteboard-plugin-visual'
import { afterAll, describe, expect, vi } from 'vitest'
import type { z } from 'zod'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import {
  MISSING_DOCUMENT_ID,
  SEEDED_MARKDOWN_ID,
  SEEDED_SPATIAL_ID,
  SEEDED_WORKSPACE_ID,
  seededServer,
} from '../test-utils/seeded-workspace.js'

const WORKSPACE_ID = SEEDED_WORKSPACE_ID
const SPATIAL_ID = SEEDED_SPATIAL_ID
const MARKDOWN_ID = SEEDED_MARKDOWN_ID
const MISSING_ID = MISSING_DOCUMENT_ID

// A CEILING sized on a measurement, not a delay. The slowest property here
// (`wb_document_get`) takes 891ms of vitest's default 5000ms on an idle
// machine — 18% of the budget — and the whole-repo parallel run is where that
// headroom goes. It failed there twice on two DIFFERENT seeds, and both
// replay green when passed back to `withDefaults({ seed })`, so what ran out
// is the clock and not a counterexample: fast-check prints its seed in the
// test NAME, which is what makes a timeout here read exactly like a property
// failure. `reference-semantics.property.test.ts` sets its own for the same
// reason. The remedy is never a pinned seed.
vi.setConfig({ testTimeout: 60_000 })

/** A drawn endpoint when it is a free POINT, else nothing to preserve. */
const pointAt = (end: unknown) =>
  typeof end === 'object' && end !== null && (end as { kind?: string }).kind === 'point'
    ? (end as { kind: 'point'; point: { x: number; y: number } })
    : undefined

async function seededTools() {
  return (await seededServer()).tools
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
  edge: facetsArbitrary(bundledFacetRegistry, 'edge'),
} as const
const facetsForAnyTarget = fc.oneof(
  facetsByTarget.node,
  facetsByTarget.canvas,
  facetsByTarget.document,
)
/** Three passages the seeded note's body holds once each. */
const PASSAGES = ['Plan', 'paragraph', 'in it'] as const
type Passage = (typeof PASSAGES)[number]
const passages = fc.constantFrom(...PASSAGES)
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
    return fc.oneof(passages, fc.constantFrom('one', 'two', 'later'), fc.string({ maxLength: 6 }))
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
 *
 * `extra` is drawn beside the input for a fix-up that needs a value of its
 * own, such as a facet bucket for the target an op turns out to write.
 */
function mostly<T, X = undefined>(
  inputs: fc.Arbitrary<unknown>,
  patch: (input: T, extra: X) => T,
  extra: fc.Arbitrary<X> = fc.constant(undefined as X),
): fc.Arbitrary<unknown> {
  // `patch` on three draws in four, so the unshaped refusal stays reachable.
  return fc
    .tuple(inputs, extra, fc.nat({ max: 3 }))
    .map(([input, drawnExtra, keep]) => (keep === 0 ? input : patch(input as T, drawnExtra)))
}

/**
 * A call aimed at the seeded workspace, whose absence the unshaped quarter
 * still draws; a call that names no workspace is left as drawn.
 */
const inSeededWorkspace = <T extends object>(input: T): T =>
  'workspaceId' in input ? { ...input, workspaceId: WORKSPACE_ID } : input
/** The shape of a tool with no fix-up of its own. */
const inTheSeededWorkspace = (inputs: fc.Arbitrary<unknown>) =>
  mostly(inputs, (input: object) => inSeededWorkspace(input))
/** A call on the board, for the tools that only read a spatial document. */
const onTheBoard = (inputs: fc.Arbitrary<unknown>) =>
  mostly(inputs, (input: object) => ({ ...inSeededWorkspace(input), documentId: SPATIAL_ID }))

/** Where each facet write lands on the seeded workspace: a node and a canvas are the board's, a document's facets the note's. */
const FACET_DOCUMENTS = { node: [SPATIAL_ID], canvas: [SPATIAL_ID], document: [MARKDOWN_ID] }

const shapeFor: Record<string, (input: fc.Arbitrary<unknown>) => fc.Arbitrary<unknown>> = {
  wb_facet_set: (inputs) =>
    inputs.chain((drawn) => {
      const input = drawn as {
        documentIds: string[]
        nodeId?: string
        edgeId?: string
        target?: string
        tags?: unknown
        facets?: unknown
      }
      const target =
        input.nodeId !== undefined ? 'node' : input.target === 'canvas' ? 'canvas' : 'document'
      // A node write names one spatial document, no edge beside the node and
      // no canvas target, and carries no tags; the rest is what the schema drew.
      const scoped =
        input.nodeId === undefined
          ? input
          : {
              ...input,
              documentIds: [SPATIAL_ID],
              edgeId: undefined,
              target: undefined,
              tags: undefined,
            }
      return mostly(
        fc
          .option(facetsByTarget[target], { nil: undefined, freq: 4 })
          .map((facets) => (facets === undefined ? scoped : { ...scoped, facets })),
        // ...and mostly lands where its target is, on a node the board has.
        (input: { nodeId?: string; tags?: unknown; edgeId?: unknown }) => {
          const { tags: _dropped, edgeId: _edge, ...rest } = input
          const nodeId =
            input.nodeId === undefined || SEEDED_NODES.has(input.nodeId) ? input.nodeId : 'n1'
          return { ...inSeededWorkspace(rest), documentIds: FACET_DOCUMENTS[target], nodeId }
        },
      )
    }),
  // Every passage quotes a different passage of the markdown body under its
  // own change id, and `assumed` is what the passage says: a body has no node
  // to scope a quote to, two passages sharing an id are refused as one, and
  // two quoting the same words overlap.
  wb_body_edit: (inputs) =>
    mostly(
      inputs,
      (input: {
        documentId: string
        ops: { id: string; anchor: { nodeId?: string; quote: { exact: string } } }[]
      }) => {
        // The first passage is the drawn one; the rest follow it round the body.
        const first = Math.max(0, PASSAGES.indexOf(input.ops[0]?.anchor.quote.exact as Passage))
        const ops = input.ops
          .slice(0, PASSAGES.length)
          .map(({ anchor: { nodeId: _node, ...anchor }, ...op }, index) => {
            const exact = PASSAGES[(first + index) % PASSAGES.length] as Passage
            const quote = { ...anchor.quote, exact }
            return { ...op, id: `${op.id}-${index}`, anchor: { ...anchor, quote }, assumed: exact }
          })
        return { ...inSeededWorkspace(input), documentId: MARKDOWN_ID, ops }
      },
    ),
  // One op at a time on the spatial document, mostly, each fitted to the
  // seeded canvas: the op union is wide and each op wants its own context
  // (a group for `within`, a range inside a body, a patch the node's type
  // has fields for), so a batch of four random ops nearly always carries
  // one the canvas refuses.
  wb_canvas_edit: (inputs) =>
    mostly(
      inputs,
      (input: { documentId: string; mode?: string; ops: Record<string, unknown>[] }, facets) => {
        const ops = input.ops.slice(0, 1).map((op) => fitCanvasOp(op, facets))
        return {
          ...inSeededWorkspace(input),
          documentId: SPATIAL_ID,
          // A verb a proposal cannot carry applies; `propose` refuses it by name.
          mode: ops.some((op) => UNPROPOSABLE.has(op.op as string)) ? undefined : input.mode,
          ops,
        }
      },
      fc.record({ node: facetsByTarget.node, edge: facetsByTarget.edge }),
    ),
  wb_version_restore: (inputs) =>
    // The one saved version is the board's.
    mostly(inputs, (input: object) => ({
      ...inSeededWorkspace(input),
      documentId: SPATIAL_ID,
      versionId: 'v1',
    })),
  // Every document named is one the workspace holds.
  wb_version_save: (inputs) =>
    mostly(inputs, (input: { documentIds: string[] }) => {
      const held = input.documentIds.filter((id) => id !== MISSING_ID)
      return { ...inSeededWorkspace(input), documentIds: held.length > 0 ? held : [SPATIAL_ID] }
    }),
  // A drawn theme id is never registered; the registered ones are.
  wb_scene_render: (inputs) =>
    mostly(inputs, (input: { style?: string }) => ({
      ...inSeededWorkspace(input),
      ...(input.style === undefined || RENDER_STYLES.has(input.style)
        ? {}
        : { style: 'visual.sketch' }),
    })),
  canvas_view: onTheBoard,
  wb_canvas_snapshot: onTheBoard,
  wb_viewport_set: onTheBoard,
}

const RENDER_STYLES = new Set(['clean', 'document', 'visual.sketch', 'visual.neon'])
const SEEDED_PATHS = new Set(['board', 'notes/plan'])
shapeFor.wb_workspace_edit = (inputs) =>
  // A `document.set` writes OKF onto the markdown document, and a create or a
  // move lands on a path of its own, mostly; a move says what it changes.
  mostly(inputs, (input: { ops: Record<string, unknown>[] }) => ({
    ...inSeededWorkspace(input),
    ops: input.ops.map((op, index) => {
      if (op.op === 'document.set') return { ...op, documentId: MARKDOWN_ID, markdown: OKF_NOTE }
      if (op.op !== 'document.create' && op.op !== 'document.move') return op
      const path = SEEDED_PATHS.has(op.path as string) ? `fresh-${index}` : op.path
      return { ...op, path: path ?? (op.name === undefined ? `fresh-${index}` : undefined) }
    }),
  }))

shapeFor.wb_thread_edit = (inputs) =>
  // A reply and a resolution name the thread the spatial document holds, and
  // a new thread's id is minted, since a drawn one names a thread already there.
  mostly(inputs, (input: { documentId: string; ops: Record<string, unknown>[] }) => ({
    ...inSeededWorkspace(input),
    documentId: SPATIAL_ID,
    ops: input.ops.map(({ threadId: _id, ...op }) =>
      op.op === 'thread.add' ? op : { ...op, threadId: 'c1' },
    ),
  }))

/** What `wb_canvas_edit` refuses under `mode: 'propose'`: verbs with no single anchor to follow. */
const UNPROPOSABLE = new Set([
  'tidy',
  'region.set',
  'comment.add',
  'comment.resolve',
  'node.lock',
  'edge.lock',
])
const TEXT_NODE_PATCH_FIELDS = new Set(['x', 'y', 'width', 'height', 'color', 'text'])
const SEEDED_NODES = new Set(['n1', 'n2', 'g1'])

type Fields = Record<string, unknown>
/** An edge end re-pointed at a node the board has; its side and arrowhead stay as drawn. */
const edgeEnd = (end: unknown, node: string) => ({ ...(end as Fields), node })
/** A line end: a drawn POINT names nothing and stays as drawn; a node end is re-pointed. */
const lineEnd = (end: unknown, node: string) => pointAt(end) ?? { kind: 'node' as const, node }
/** `element` with each drawn end re-pointed by `at`, and a drawn facet bucket swapped for `facets`. */
function fitElement(
  element: unknown,
  at: (end: unknown, node: string) => unknown,
  facets: Fields,
): Fields {
  const fields = (element ?? {}) as Fields
  return {
    ...fields,
    ...(fields.from === undefined ? {} : { from: at(fields.from, 'n1') }),
    ...(fields.to === undefined ? {} : { to: at(fields.to, 'n2') }),
    ...(fields.facets === undefined ? {} : { facets }),
  }
}

/** A drawn resize no smaller than the seeded text node, since a smaller one cannot hold its text. */
function roomyResize(patch: Fields): Fields {
  return {
    ...patch,
    ...(patch.width === undefined ? {} : { width: Math.max(patch.width as number, 200) }),
    ...(patch.height === undefined ? {} : { height: Math.max(patch.height as number, 80) }),
  }
}

/**
 * Each op aimed at what the seeded canvas holds, with a facet bucket for the
 * target it writes; unfitted, four never answered and the edge ops barely did.
 */
function fitCanvasOp(op: Fields, facets: { node: Fields; edge: Fields }): Fields {
  const { within: _within, all: _all, ...targeted } = op
  switch (op.op) {
    case 'node.add': {
      // A fresh id inside the group, sized by the server: a drawn width
      // rarely fits the drawn text, and a drawn stencil is never registered.
      const { stencil: _stencil, ...rest } = op
      const { width: _w, height: _h, ...node } = op.node as Fields
      const within = op.within === undefined ? {} : { within: 'g1' }
      const bucket = node.facets === undefined ? {} : { facets: facets.node }
      return { ...rest, ...within, node: { ...node, ...bucket, id: 'n4' } }
    }
    case 'node.patch': {
      const patch = Object.entries((op.patch ?? {}) as Fields).filter(([key]) =>
        TEXT_NODE_PATCH_FIELDS.has(key),
      )
      const { stencil: _stencil, ...unstenciled } = targeted
      return { ...unstenciled, id: 'n1', patch: roomyResize(Object.fromEntries(patch)) }
    }
    case 'node.splice':
      // n1's text is three lines: a range inside them, in either shape.
      return {
        ...targeted,
        id: 'n1',
        startLine: (op.startLine as number) % 3,
        endLine: ((op.startLine as number) % 3) + ((op.endLine as number) % 2),
      }
    case 'node.remove':
    case 'node.lock':
      return { ...targeted, id: 'n1' }
    case 'comment.resolve':
      return { ...targeted, id: 'c1' }
    case 'comment.add': {
      // About a node the board has, so the server anchors it there.
      const { targetEdgeId: _edge, ...comment } = op.comment as Fields
      return { ...op, comment: { ...comment, targetNodeId: 'n1' } }
    }
    case 'edge.patch':
      return { ...targeted, id: 'e1', patch: fitElement(op.patch, edgeEnd, facets.edge) }
    case 'edge.remove':
    case 'edge.lock':
      return { ...targeted, id: 'e1' }
    // Ink, steered as an edge is, except that a POINT end names nothing and
    // is left alone. Without the steer these arms only ever name an id the
    // board has not got, and the ledger reports an op that answers as one
    // that never does.
    case 'line.add':
      return { ...op, line: { ...fitElement(op.line, lineEnd, facets.edge), id: 'l2' } }
    case 'line.patch':
      return { ...targeted, id: 'l1', patch: fitElement(op.patch, lineEnd, facets.edge) }
    case 'line.remove':
      return { ...targeted, id: 'l1' }
    case 'edge.add': {
      const edge = fitElement(op.edge, edgeEnd, facets.edge)
      return { ...op, edge: { ...edge, id: 'e2', from: { node: 'n1' }, to: { node: 'n2' } } }
    }
    case 'tidy': {
      // The group is empty, so `within` names nothing to place.
      const scope = ((op.scope as string[] | undefined) ?? []).filter((id) => SEEDED_NODES.has(id))
      return { ...targeted, ...(scope.length === 0 ? {} : { scope }) }
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
 * against the run at `ANSWER_FLOOR`'s share of the arm's draws, and a
 * `refused-only:` entry says why the seeding cannot
 * reach it and is checked to still be true. A new op arrives unclassified
 * and fails the run until someone answers for it.
 */
type OpReach = 'answers' | `refused-only: ${string}`
const OP_REACH: Record<string, OpReach> = {
  'wb_workspace_edit/document.create(markdown)': 'answers',
  'wb_workspace_edit/document.create(spatial)': 'answers',
  'wb_workspace_edit/document.set': 'answers',
  'wb_workspace_edit/document.move': 'answers',
  'wb_workspace_edit/document.delete': 'answers',
  'wb_body_edit/body.replace': 'answers',
  'wb_canvas_edit/node.add': 'answers',
  'wb_canvas_edit/node.patch': 'answers',
  'wb_canvas_edit/node.splice': 'answers',
  'wb_canvas_edit/node.remove': 'answers',
  'wb_canvas_edit/edge.add': 'answers',
  'wb_canvas_edit/edge.patch': 'answers',
  'wb_canvas_edit/edge.remove': 'answers',
  'wb_canvas_edit/line.add': 'answers',
  'wb_canvas_edit/line.patch': 'answers',
  'wb_canvas_edit/line.remove': 'answers',
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
  row: string = tool.name,
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
    const byReason = reasons.get(row) ?? new Map<string, number>()
    reasons.set(row, byReason)
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

/**
 * The share of a row's draws that must reach the answering path. A floor of
 * ONE answer is a coin the run tosses: a row answering 4 draws in 60 misses
 * entirely on about one seed in sixty, and reads as a broken op when the
 * generator was simply too sparse to reach it. A share is the denser
 * generator's contract instead — each row is steered at what the seeded
 * workspace holds until it clears this with room, so a miss is a
 * regression, not a seed. Measured: steered, the sparsest arm answers about
 * two draws in five, which falls under a tenth of 60 on roughly one run in
 * five million; unsteered, `edge.patch` answered one in fifteen and fell
 * under it on three runs in four.
 */
const ANSWER_FLOOR = 0.1
const answersOften = (counts: Record<Outcome, number>): boolean => {
  const draws = Object.values(counts).reduce((sum, n) => sum + n, 0)
  return counts.answered >= Math.ceil(draws * ANSWER_FLOOR)
}

describe('every tool answers or refuses an input its own schema admits', () => {
  for (const [key, tool] of Object.entries(catalogue) as [string, ToolLike][]) {
    const counts = emptyTally()
    tally.set(tool.name, counts)
    const drawn = arbitraryForSchema(tool.inputSchema, { override })
    const inputs = (shapeFor[tool.name] ?? inTheSeededWorkspace)(drawn)
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
      const shaped = (shapeFor[tool.name] ?? inTheSeededWorkspace)(single)
      fcTest.prop([shaped], withDefaults({ numRuns: 60 }))(
        `${tool.name} with one ${arm.op} op`,
        async (input) => {
          await runOnce(key, tool, input, armCounts, `${tool.name}/${arm.op}`)
        },
      )
    }
  }

  // Every test in this suite is a tool's or an op arm's row, and each feeds a tally.
  afterAllFloor('every test', () => {
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
    // A tool this lane never got past a refusing double is unexercised, and
    // that has to be visible rather than read as green — as does an arm the
    // ledger says answers. Both in one list, so a red names every sparse row.
    const sparse = [...tally.entries()]
      .filter(([, counts]) => !answersOften(counts))
      .map(([name, counts]) => `${name}: ${JSON.stringify(counts)}`)
    const wrong = arms.flatMap((arm) => {
      const counts = opTally.get(arm)
      const claim = OP_REACH[arm]
      if (counts === undefined || claim === undefined) return []
      if (claim === 'answers' && !answersOften(counts))
        return [`${arm}: claimed to answer, too seldom: ${JSON.stringify(counts)}`]
      if (claim !== 'answers' && counts.answered > 0) return [`${arm}: ${claim} — but it answered`]
      return []
    })
    expect([...sparse, ...wrong], `rows answering under ${ANSWER_FLOOR * 100}% of draws`).toEqual(
      [],
    )
  })

  // Registered after the floor so it runs first: afterAll hooks run in reverse,
  // and a failing floor stops the ones after it.
  afterAll(() => {
    if (process.env.FUZZ_TALLY) {
      // stdout, not console: vitest's agent-session reporter drops a passing test's console.
      for (const [name, counts] of tally) {
        process.stdout.write(
          `${name} ${JSON.stringify(counts)} ${[...(reasons.get(name) ?? [])].join(' | ')}\n`,
        )
        process.stdout.write(
          `  answered-shapes ${name} ${[...(answeredShapes.get(name) ?? [])].join(' | ')}\n`,
        )
      }
      for (const [name, counts] of opTally)
        process.stdout.write(
          `op ${name} ${JSON.stringify(counts)} ${[...(reasons.get(name) ?? [])].join(' | ')}\n`,
        )
    }
  })
})
