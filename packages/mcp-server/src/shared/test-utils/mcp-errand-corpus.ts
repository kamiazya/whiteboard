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
  /**
   * Stencils to seed as this workspace's LIBRARY — a markdown document at
   * the library path carrying `visual.stencils/v0` — before the errand
   * runs.
   *
   * A precondition, never part of the count: somebody authored the
   * vocabulary in an earlier conversation, and what is being measured is
   * what it costs an agent to find and use it afterwards.
   */
  readonly seedStencilLibrary?: Readonly<Record<string, { displayName: string; color?: string }>>
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
): Promise<Awaited<ReturnType<ErrandContext['client']['callTool']>>> => {
  const result = await context.client.callTool({ name, arguments: args })
  if (result.isError) {
    const text = (result.content as { type?: string; text?: string }[] | undefined)?.find(
      (block) => block.type === 'text',
    )?.text
    throw new Error(`${name} refused: ${text ?? 'no message'}`)
  }
  return result
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
      const created = await call(context, 'wb_workspace_edit', {
        workspaceId: context.workspaceId,
        // Workspaces are never materialised implicitly, so a first
        // document in a fresh workspace carries this flag rather than
        // costing a separate call. Without it the create fails loudly,
        // which is the design and not a quirk of the fixture.
        createWorkspace: true,
        ops: [{ op: 'document.create', path: 'drawing', kind: 'spatial' }],
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
          edge: {
            id: `e${i}`,
            from: { node: `n${i}` },
            to: { node: `n${i + 1}` },
          },
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
    // Neither axis: a VOCABULARY errand, and the one the stencil field
    // (ADR-0034) is judged by. Six boxes given a kind each.
    //
    // Read the calls column first and do not expect it to move: dressing
    // boxes was never more than one call, because `wb_canvas_edit` batches.
    // What a stencil lifts is the PAYLOAD and the deciding — by hand each
    // box carries a colour, a silhouette facet and a badge facet under
    // their stored keys, and the author has to pick a scheme that tells six
    // kinds apart.
    //
    // Measured both ways when this was written: the same six boxes dressed
    // by hand cost 1253 request bytes, and 916 with the vocabulary named —
    // 337 fewer, at one call either way.
    //
    // **That does not pay for itself in bytes, and the comparison belongs
    // here rather than in a PR nobody re-reads.** The `stencil` field costs
    // `wb_canvas_edit` 480 visible bytes on the rung-1 scoreboard, and a
    // model pays those on EVERY turn of every conversation with this server
    // attached, while the 337 is saved once per errand that dresses
    // anything. The case for the field is not the byte count: it is that a
    // board says what its kinds ARE (ADR-0033's facet axis) instead of
    // spending a private scheme invented per drawing. Judge it there.
    name: 'dress six boxes as six kinds',
    seedDocuments: 1,
    run: async (context) => {
      const kinds = [
        'visual.datastore',
        'visual.service',
        'visual.gateway',
        'visual.queue',
        'visual.actor',
        'visual.external',
      ]
      await call(context, 'wb_canvas_edit', {
        workspaceId: context.workspaceId,
        documentId: context.documentIds[0],
        mode: 'apply',
        ops: kinds.map((stencil, i) => ({
          op: 'node.add',
          node: {
            id: `s${i}`,
            type: 'text',
            x: (i % 3) * 240,
            y: Math.floor(i / 3) * 140,
            width: 200,
            height: 80,
            text: `box ${i}`,
          },
          stencil,
        })),
      })
    },
  },
  {
    // A DISCOVERY errand, and the one 足場4b is judged by. A workspace has
    // its own stencil library (ADR-0034 decision 4); an agent that has
    // never seen it has to LEARN the vocabulary before it can dress
    // anything with it.
    //
    // Two calls: ask what may be named, then name it. The id is read out of
    // the answer rather than written into the errand, because an errand
    // that hard-codes `workspace.lakehouse` measures an agent that already
    // knew — which is the one thing this increment does not assume.
    //
    // The path it replaces cost THREE, and none of them was discovery: list
    // the workspace's documents, get the one at `stencils`, and parse its
    // frontmatter by hand — which also required knowing that a library
    // lives at that path and that its facet key is `visual.stencils/v0`.
    // Neither is written anywhere a model reads. So 3 -> 2 understates it:
    // the old route was not a more expensive way to succeed, it was a way
    // to succeed only if you already knew where to look.
    name: 'wear a stencil this workspace defines',
    seedDocuments: 1,
    seedStencilLibrary: { lakehouse: { displayName: 'Lakehouse', color: '3' } },
    run: async (context) => {
      const listed = await call(context, 'wb_facet_list', {
        workspaceId: context.workspaceId,
        assetKind: 'stencils',
      })
      const assets = (listed.structuredContent as { assets?: { id: string }[] } | undefined)?.assets
      const stencil = assets?.find((asset) => asset.id.startsWith('workspace.'))?.id
      if (stencil === undefined) {
        throw new Error('wb_facet_list answered no workspace stencil to wear')
      }
      await call(context, 'wb_canvas_edit', {
        workspaceId: context.workspaceId,
        documentId: context.documentIds[0],
        mode: 'apply',
        ops: [
          {
            op: 'node.add',
            node: {
              id: 'lake',
              type: 'text',
              x: 0,
              y: 200,
              width: 200,
              height: 80,
              text: 'orders',
            },
            stencil,
          },
        ],
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
              // Too narrow for three auto-sized boxes in a row on purpose:
              // the third wraps and the group grows to hold it, which is
              // the path a model without geometry actually takes.
              //
              // Sized against the BOARD's box width, not a constant. A node
              // added without one takes the width its board already uses,
              // and this harness seeds a 120-wide box — at the 700 this said
              // while the default was a flat 260, all three fitted in one
              // row, the group never grew, and the errand measured a
              // cheaper payload than the one it exists to price. It still
              // passed; only the exact pin caught it.
              width: 300,
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
