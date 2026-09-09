// The tool-surface scoreboard: what the tool TABLE costs a model to read,
// and how much of it explains itself (ADR-0031).
//
// `tool-call-count-quality.test.ts` prices an errand once a model has chosen
// a tool. This prices the choosing. Every definition below is in the model's
// context on every turn whether or not the turn uses it, and a parameter
// with no description is one the model guesses at. Both are read off a REAL
// McpServer's `tools/list` over an in-memory transport, so a number here is
// what a client receives rather than what a registration says; the
// behavioural rows call the tool the same way.
//
// The numbers are pinned EXACTLY. An improvement has to be as loud as a
// regression, because the point is that someone says why it moved.
//
// DEBT rows target zero: `undescribed`, `strays`. PRICE rows have no target
// and exist so a change cannot buy one with the other silently: a
// consolidation that folds three tools into one can halve the count and
// double `visibleBytes`, and the pair is what says which happened.
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import {
  crossReferences,
  descriptionWords,
  type ListedTool,
  modelVisibleBytes,
  parameterCoverage,
  wireBytes,
} from '../../shared/test-utils/tool-surface-metrics.js'
import { InMemoryDocumentStore } from '../store/inmemory/in-memory-document-store.js'
import { registerDocumentTools } from './document-tools.js'
import { ALL_REGISTERED_TOOLS } from './mcp-smoke-coverage.js'
import { registerPairingLinkTool } from './pairing-link.js'

async function connect(): Promise<{ client: Client; tools: readonly ListedTool[] }> {
  const server = new McpServer({ name: 'whiteboard-surface', version: '0.0.0' })
  registerDocumentTools(server, {
    documentStore: new InMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
  })
  // Registered separately in index.ts, so registered separately here: the
  // scoreboard reads the whole table, not the document half of it.
  registerPairingLinkTool(server, undefined, undefined)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'surface', version: '0.0.0' })
  await client.connect(clientSide)
  const { tools } = await client.listTools()
  return { client, tools: tools as readonly ListedTool[] }
}

const firstText = (result: { content?: unknown }): string => {
  const content = result.content as { type?: string; text?: string }[] | undefined
  return content?.find((block) => block.type === 'text')?.text ?? ''
}

interface Row {
  /** name + description + input schema, as the Messages API sends a tool. */
  visibleBytes: number
  /** The whole `tools/list` entry, output schema and annotations included. */
  wireBytes: number
  descriptionWords: number
  /** Properties the input schema declares at any depth (union arms counted each). */
  parameters: number
  /** DEBT — of those, the ones with no description. */
  undescribed: number
  /**
   * DEBT — what a top-level key the schema does not declare gets:
   * `refused` (the error names it) or `stripped` (silently dropped, so a
   * typo'd optional parameter does nothing and the call looks like it
   * worked). `unreached` when the tool refuses before validating anything.
   */
  strays: 'refused' | 'stripped' | 'unreached'
  /** The other tools the description names — the "when to use" edges. */
  names: readonly string[]
}

describe('what the tool table costs to read', () => {
  it('scores every registered tool', async () => {
    const { client, tools } = await connect()
    expect(tools.map((tool) => tool.name).sort()).toEqual([...ALL_REGISTERED_TOOLS].sort())

    const rows: Record<string, Row> = {}
    for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
      const coverage = parameterCoverage(tool.inputSchema)
      // An unknown key beside nothing else: a refusal that names it has
      // read it; one that lists only the missing fields has dropped it.
      const stray = await client.callTool({ name: tool.name, arguments: { zz_stray: true } })
      const strayText = firstText(stray)
      rows[tool.name] = {
        visibleBytes: modelVisibleBytes(tool),
        wireBytes: wireBytes(tool),
        descriptionWords: descriptionWords(tool),
        parameters: coverage.parameters,
        undescribed: coverage.parameters - coverage.described,
        strays: strayText.includes('zz_stray')
          ? 'refused'
          : strayText.startsWith('Input validation error')
            ? 'stripped'
            : 'unreached',
        names: crossReferences(tool),
      }
    }

    expect(rows).toEqual({
      // Every tool refuses a stray key since every registration hands the
      // SDK the Zod OBJECT rather than its `.shape` (ADR-0031 C10): handed
      // a shape, the SDK rebuilt a non-strict object around it, and a
      // misspelt optional parameter was dropped with the call reporting
      // success — 15 of 18 tools, and wb_facet_list, every parameter of
      // which is optional, answered the unfiltered list to any input at
      // all. The price is 29 visible bytes a tool (`"additionalProperties":
      // false`), 493 across the table.
      //
      // The MCP Apps UI tool. Nearly all of its wire size is an OUTPUT
      // schema (the whole scene), which the model never reads.
      canvas_view: {
        visibleBytes: 733,
        wireBytes: 15664,
        descriptionWords: 39,
        parameters: 3,
        undescribed: 3,
        strays: 'refused',
        names: [],
      },
      // +817 when the text anchor's fields were described: the lane's one
      // refusal on this tool was a model omitting `start`/`end`, and the
      // anchor is emitted here and in wb_thread_edit's anchor union. The
      // C3 case ADR-0031 §3b pays for: described because a model guessed,
      // not because a column said so.
      wb_body_edit: {
        visibleBytes: 2663,
        wireBytes: 18794,
        descriptionWords: 112,
        parameters: 18,
        undescribed: 7,
        strays: 'refused',
        names: [],
      },
      // 39% of everything the model reads, in one tool: the ops union
      // carries the full node and edge schemas once per arm, and not one
      // of its 207 properties says what it is for. -1,640 bytes when the
      // model's integers stopped emitting safe-integer bounds (sixty
      // `minimum: -9007199254740991, maximum: 9007199254740991` pairs on
      // one tool; `integerSchema` in packages/model).
      // -1,320 more when the node extension a WRITER sends became one
      // flat object narrowed on parse (nodeExtensionWriteSchema) instead of
      // the stored two-variant union inlined eight times.
      // -3,391 (26% of the tool, 10% of the table) when `region.set` stopped
      // carrying the node union a second time: it names members by id now,
      // and a member is created by `node.add` with `within` (+1 parameter,
      // described). The lane placed the change: on the errand the op was
      // built for, the old shape had a model writing x/y/width/height for
      // every box, the ones already there included (ADR-0031 §4).
      // +1,095 for a SELECTOR where an id goes — `within` (every node
      // inside a group) and `all` on patch, remove and lock, `within` on
      // tidy; eleven parameters, every one described. Placed by the lane:
      // "lock every item on the roadmap" went from three calls to two in
      // two trials of three (the snapshot that only learned the ids was
      // skipped), and "colour every box inside the Clients group" from two
      // ops to one; six trials of six reached for the selector unprompted.
      wb_canvas_edit: {
        visibleBytes: 10770,
        wireBytes: 30798,
        descriptionWords: 169,
        parameters: 147,
        undescribed: 133,
        strays: 'refused',
        names: [],
      },
      wb_canvas_snapshot: {
        visibleBytes: 705,
        wireBytes: 3935,
        descriptionWords: 53,
        parameters: 3,
        undescribed: 3,
        strays: 'refused',
        names: ['wb_document_get'],
      },
      wb_document_get: {
        visibleBytes: 979,
        wireBytes: 2757,
        descriptionWords: 63,
        parameters: 4,
        undescribed: 3,
        strays: 'refused',
        names: [],
      },
      wb_document_list: {
        visibleBytes: 473,
        wireBytes: 1130,
        descriptionWords: 32,
        parameters: 1,
        undescribed: 1,
        strays: 'refused',
        names: [],
      },
      // Re-pinned when the filter learned to stand alone (ADR-0031 §4):
      // `query` is optional now, and +379 visible bytes say so on the
      // parameter and in the description, with the last two undescribed
      // parameters described. Rung 3 on "count the tagged documents", three
      // trials: 3 calls each before (a search that answered nothing, then
      // a list and a read of every document), 1 after.
      wb_document_search: {
        visibleBytes: 1410,
        wireBytes: 2240,
        descriptionWords: 68,
        parameters: 5,
        undescribed: 0,
        strays: 'refused',
        names: [],
      },
      wb_facet_list: {
        visibleBytes: 422,
        wireBytes: 1096,
        descriptionWords: 30,
        parameters: 1,
        undescribed: 1,
        strays: 'refused',
        names: [],
      },
      // Re-pinned when the tool learned to tag (ADR-0031 §4): +1,122
      // visible bytes buy `tags.add` / `tags.remove` — three parameters, all
      // described, and the four that were not now are — and a description
      // that says "tags", which three trials of "tag this note" had never
      // once been able to act on. Rung 3 on that task: 5.7 calls and 7 tool
      // errors over three trials before, 2 calls and 0 after.
      wb_facet_set: {
        visibleBytes: 2176,
        wireBytes: 2995,
        descriptionWords: 108,
        parameters: 8,
        undescribed: 1,
        strays: 'refused',
        names: ['wb_facet_list'],
      },
      wb_pairing_link_create: {
        visibleBytes: 1257,
        wireBytes: 1919,
        descriptionWords: 70,
        parameters: 4,
        undescribed: 0,
        strays: 'refused',
        names: [],
      },
      wb_scene_render: {
        visibleBytes: 2189,
        wireBytes: 2536,
        descriptionWords: 51,
        parameters: 5,
        undescribed: 2,
        strays: 'refused',
        names: [],
      },
      wb_thread_edit: {
        visibleBytes: 3375,
        wireBytes: 3942,
        descriptionWords: 122,
        parameters: 32,
        undescribed: 25,
        strays: 'refused',
        names: [],
      },
      // The version tools, the pairing tool and now wb_facet_set are the
      // ones whose every parameter is described. They are the shape to copy.
      wb_version_list: {
        visibleBytes: 604,
        wireBytes: 1535,
        descriptionWords: 20,
        parameters: 2,
        undescribed: 0,
        strays: 'refused',
        names: [],
      },
      wb_version_restore: {
        visibleBytes: 1504,
        wireBytes: 2156,
        descriptionWords: 41,
        parameters: 6,
        undescribed: 0,
        strays: 'refused',
        names: [],
      },
      wb_version_save: {
        visibleBytes: 982,
        wireBytes: 2052,
        descriptionWords: 54,
        parameters: 3,
        undescribed: 0,
        strays: 'refused',
        names: ['wb_version_restore'],
      },
      wb_viewport_set: {
        visibleBytes: 900,
        wireBytes: 1298,
        descriptionWords: 52,
        parameters: 8,
        undescribed: 8,
        strays: 'refused',
        names: ['wb_canvas_edit'],
      },
      wb_workspace_edit: {
        visibleBytes: 2287,
        wireBytes: 3252,
        descriptionWords: 44,
        parameters: 18,
        undescribed: 14,
        strays: 'refused',
        names: [],
      },
    } satisfies Record<(typeof ALL_REGISTERED_TOOLS)[number], Row>)
  })

  it('totals: what the whole table costs, and how much of it is unexplained', async () => {
    const { tools } = await connect()
    const total = (pick: (tool: ListedTool) => number) => tools.reduce((n, t) => n + pick(t), 0)
    expect({
      tools: tools.length,
      // PRICE. ~8.7k tokens at four bytes a token, on every turn of every
      // conversation that has this server attached — under the ~10k tokens
      // at which Anthropic's own guidance says to stop loading a table
      // upfront and search it instead, and one tool is 45% of it.
      visibleBytes: total(modelVisibleBytes),
      // PRICE, paid by the client on connect rather than by the model:
      // two-thirds of it is output schemas.
      wireBytes: total(wireBytes),
      // DEBT. 327 declared, 32 described: wb_facet_set's seven were the
      // first tool paid down (+3 declared, all described).
      parameters: total((t) => parameterCoverage(t.inputSchema).parameters),
      undescribed: total((t) => {
        const c = parameterCoverage(t.inputSchema)
        return c.parameters - c.described
      }),
    }).toEqual({
      // 17: wb_document_resolve retired (ADR-0031 §4) — its one answer, an
      // id's path, is a column of every wb_document_list row, so the table
      // lost 442 bytes and no errand lost a way to be done. Rung 3 after:
      // see the ADR's baseline.
      tools: 17,
      // +1,122 for wb_facet_set's tags (see its row), +464 for every tool
      // refusing a stray key (see canvas_view; sixteen tools, the two that
      // already registered the object unchanged), +379 for a search filter
      // that stands alone (see wb_document_search). Under the ~40,000 at
      // which ADR-0031 §5 says to reconsider loading the table upfront.
      // -1,912 when the model's integer fields stopped emitting safe-integer
      // bounds (see wb_canvas_edit): the first cut that took nothing away
      // from what a model can do.
      // -1,320 for wb_canvas_edit's flat write-side extension; +1,366 for
      // the text anchor and the body change described (see wb_body_edit).
      // -3,391 for region.set naming members by id (see wb_canvas_edit):
      // 31,394 is the first reading under 32,000 since the table was
      // first pinned at 34,960.
      // +1,095 for selectors where an id goes (see wb_canvas_edit).
      // +940 when the render theme layer landed on main (ADR-0030): `style`
      // on canvas_view and wb_scene_render, `target` on wb_facet_set; the
      // two new undescribed parameters are that layer's, not this sweep's.
      visibleBytes: 33429,
      wireBytes: 98099,
      parameters: 268,
      undescribed: 201,
    })
  })

  // C10, held as a statement rather than only as eighteen pinned rows: a
  // tool that starts stripping again fails here by name.
  it('every tool refuses an unknown top-level key by name', async () => {
    const { client, tools } = await connect()
    for (const tool of tools) {
      const result = await client.callTool({ name: tool.name, arguments: { zz_stray: true } })
      expect(result.isError, tool.name).toBe(true)
      expect(firstText(result), tool.name).toContain('zz_stray')
    }
  })

  // MCP 2025-11-25 (SEP-1303): an input the schema rejects is answered as a
  // TOOL error the model can read and repair from, never as a JSON-RPC
  // protocol error that ends the turn. Held for every tool rather than
  // sampled, because the registration helper is what decides it and a tool
  // registered around the helper would be the one that regresses.
  it('every tool answers an empty call with a tool error that names the missing field', async () => {
    const { client, tools } = await connect()
    for (const tool of tools) {
      const required = tool.inputSchema.required ?? []
      // A tool with nothing required (wb_facet_list) answers an empty call
      // rather than refusing it, and has no field to name.
      if (required.length === 0) continue
      const result = await client.callTool({ name: tool.name, arguments: {} })
      expect(result.isError, tool.name).toBe(true)
      const text = firstText(result)
      // wb_pairing_link_create refuses for want of a daemon before it
      // validates; that refusal is a tool error too, but names no field.
      if (text.startsWith('Input validation error')) {
        expect(text, tool.name).toContain(required[0])
      }
    }
  })
})
