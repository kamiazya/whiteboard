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
  /** What kind the seeded documents are; spatial unless the errand says. */
  readonly seedKind?: 'spatial' | 'markdown'
  /** What the errand is FOR, in the caller's terms rather than the tool's. */
  readonly run: (context: ErrandContext) => Promise<void>
}

/**
 * A refused call is a THROWN one here. The scoreboard counts calls, and a
 * refusal is a call that did nothing — an errand that keeps counting past
 * one reports itself as cheap while achieving nothing, which is how the
 * tag errand measured a refused write for a week: its payload used a key
 * the tool never accepted, and the count was 1 all the same.
 */
const call = async (
  context: ErrandContext,
  name: string,
  args: Record<string, unknown>,
): Promise<void> => {
  const result = await context.client.callTool({ name, arguments: args })
  if (result.isError) {
    const text = (result.content as { type?: string; text?: string }[] | undefined)?.find(
      (block) => block.type === 'text',
    )?.text
    throw new Error(`${name} refused: ${text ?? 'no message'}`)
  }
}

export const MCP_ERRAND_CORPUS: readonly Errand[] = [
  {
    // Axis A, and already cheap: `ops` carries every node and edge, so the
    // count is create + one edit however big the drawing is.
    //
    // The create goes through `wb_workspace_edit` because the standalone
    // `wb_document_create` is retired. It costs bytes and not calls — the
    // op has to be wrapped in an array and the reply is a results list —
    // which is exactly the trade the scoreboard's price column is for.
    name: 'author a canvas of 8 nodes and 6 edges',
    seedDocuments: 0,
    run: async (context) => {
      const created = await context.client.callTool({
        name: 'wb_workspace_edit',
        arguments: {
          workspaceId: context.workspaceId,
          // Workspaces are never materialised implicitly, so a first
          // document in a fresh workspace carries this flag rather than
          // costing a separate call. Without it the create fails loudly,
          // which is the design and not a quirk of the fixture.
          createWorkspace: true,
          ops: [{ op: 'document.create', path: 'drawing', kind: 'spatial' }],
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
    // Axis A on the one DECLARATIVE op: a group's contents made to match a
    // list. One call, because the group, its members (node.add with
    // `within`) and the reconciliation ride the same batch; the price
    // column is what that payload costs, which is what any change to the
    // op's shape is judged against.
    name: 'make a group hold exactly three boxes',
    seedDocuments: 1,
    run: async (context) => {
      await call(context, 'wb_canvas_edit', {
        workspaceId: context.workspaceId,
        documentId: context.documentIds[0],
        mode: 'apply',
        ops: [
          {
            op: 'node.add',
            node: {
              id: 'g',
              type: 'group',
              label: 'Clients',
              x: 0,
              y: 600,
              // Too narrow for three default-size boxes in a row on purpose:
              // the third wraps and the group grows to hold it, which is
              // the path a model without geometry actually takes.
              width: 700,
              height: 300,
            },
          },
          ...[
            { id: 'cli', text: 'CLI' },
            { id: 'web', text: 'Web app' },
            { id: 'mobile', text: 'Mobile app' },
          ].map((box) => ({
            op: 'node.add' as const,
            node: { id: box.id, type: 'text' as const, text: box.text },
            within: 'g',
          })),
          { op: 'region.set', within: 'g', nodes: ['cli', 'web', 'mobile'] },
        ],
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
    // and one shared payload. Markdown documents, because tags are OKF
    // frontmatter and a canvas has none; and the errand's shape (`add`,
    // not the whole list) is what lets one payload tag five documents
    // that each already carry tags of their own.
    name: 'tag 5 documents',
    seedDocuments: 5,
    seedKind: 'markdown',
    run: async (context) => {
      await call(context, 'wb_facet_set', {
        workspaceId: context.workspaceId,
        documentIds: [...context.documentIds],
        tags: { add: ['reviewed'] },
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
  const structured = (result as { structuredContent?: { results?: { documentId?: unknown }[] } })
    .structuredContent
  const id = structured?.results?.[0]?.documentId
  if (typeof id !== 'string') throw new Error('wb_workspace_edit returned no documentId')
  return id
}
