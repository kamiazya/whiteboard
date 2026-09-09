import type { Client } from '@modelcontextprotocol/client'

/**
 * Errands for the tool-call scoreboard.
 *
 * "Fewer tool calls" is a claim about a NUMBER, and nothing counted it. An
 * errand is a realistic thing somebody asks an agent to do, written to use
 * the FEWEST calls the tool surface allows TODAY — a lazily-written errand
 * inflates its own baseline and makes any consolidation look good, so each
 * one below says in a comment where its calls go and why they cannot be
 * fewer.
 *
 * Two axes are visible in the counts, and they are not the same problem:
 *
 *   A — many operations on ONE subject. `wb_canvas_edit`, `wb_workspace_edit`,
 *       `wb_thread_edit` and `wb_body_edit` already take an `ops` array, so
 *       an errand that stays inside one document is already cheap.
 *   B — many SUBJECTS in one call. `wb_document_get`, `wb_facet_set` and
 *       `wb_version_save` all take `documentIds`, so an errand that touches
 *       N documents no longer costs N calls. What still takes exactly one
 *       `documentId` is the per-document CONTENT verbs — `wb_canvas_edit`,
 *       `wb_body_edit`, `wb_thread_edit` — where each document's payload is
 *       its own and there is nothing to share.
 */

interface ErrandContext {
  readonly client: Client
  readonly workspaceId: string
  /** Document ids seeded before the errand runs, in a stable order. */
  readonly documentIds: readonly string[]
}

export interface Errand {
  readonly name: string
  /** How many documents the corpus seeds before this errand runs. */
  readonly seedDocuments: number
  /** What the errand is FOR, in the caller's terms rather than the tool's. */
  readonly run: (context: ErrandContext) => Promise<void>
}

const call = async (
  context: ErrandContext,
  name: string,
  args: Record<string, unknown>,
): Promise<void> => {
  await context.client.callTool({ name, arguments: args })
}

export const MCP_ERRAND_CORPUS: readonly Errand[] = [
  {
    // Axis A, and already cheap: `ops` carries every node and edge, so the
    // count is create + one edit however big the drawing is.
    name: 'author a canvas of 8 nodes and 6 edges',
    seedDocuments: 0,
    run: async (context) => {
      const created = await context.client.callTool({
        name: 'wb_document_create',
        arguments: {
          workspaceId: context.workspaceId,
          path: 'drawing',
          kind: 'spatial',
          // Workspaces are never materialised implicitly, so a first
          // document in a fresh workspace carries this flag rather than
          // costing a separate call. Without it the create fails loudly,
          // which is the design and not a quirk of the fixture.
          createWorkspace: true,
        },
      })
      const documentId = documentIdOf(created)
      const ops = [
        ...Array.from({ length: 8 }, (_, i) => ({
          op: 'node.add',
          node: {
            id: `n${i}`,
            type: 'text',
            x: (i % 4) * 200,
            y: Math.floor(i / 4) * 120,
            width: 160,
            height: 80,
            text: `node ${i}`,
          },
        })),
        ...Array.from({ length: 6 }, (_, i) => ({
          op: 'edge.add',
          edge: { id: `e${i}`, fromNode: `n${i}`, toNode: `n${i + 1}` },
        })),
      ]
      await call(context, 'wb_canvas_edit', {
        workspaceId: context.workspaceId,
        documentId,
        mode: 'apply',
        ops,
      })
    },
  },
  {
    // Axis B, reads. `wb_document_list` answers with METADATA only — id,
    // path, name, kind, updatedAt, shadowed — so the content of five
    // documents genuinely needs a second call; it no longer needs five.
    name: 'read every document in a workspace of 5',
    seedDocuments: 5,
    run: async (context) => {
      await call(context, 'wb_document_list', { workspaceId: context.workspaceId })
      await call(context, 'wb_document_get', {
        workspaceId: context.workspaceId,
        documentIds: [...context.documentIds],
      })
    },
  },
  {
    // Axis B, writes: one call, because `wb_facet_set` takes `documentIds`
    // and one shared payload.
    name: 'tag 5 documents',
    seedDocuments: 5,
    run: async (context) => {
      await call(context, 'wb_facet_set', {
        workspaceId: context.workspaceId,
        documentIds: [...context.documentIds],
        facets: { 'core/v1': { tags: ['reviewed'] } },
      })
    },
  },
  {
    // Axis B again, on a different verb — so the scoreboard shows the cost
    // tracks the SUBJECT count rather than anything about facets.
    name: 'save a labelled version of 4 documents',
    seedDocuments: 4,
    run: async (context) => {
      await call(context, 'wb_version_save', {
        workspaceId: context.workspaceId,
        documentIds: context.documentIds.slice(0, 4),
        label: 'before the edit',
      })
    },
  },
]

function documentIdOf(result: unknown): string {
  const structured = (result as { structuredContent?: { documentId?: unknown } }).structuredContent
  const id = structured?.documentId
  if (typeof id !== 'string') throw new Error('wb_document_create returned no documentId')
  return id
}
