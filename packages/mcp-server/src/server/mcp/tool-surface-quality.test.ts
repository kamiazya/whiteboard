// The tool-surface scoreboard: what the tool TABLE costs a model to read,
// and how much of it explains itself (ADR-0030).
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
      // The MCP Apps UI tool. Nearly all of its wire size is an OUTPUT
      // schema (the whole scene), which the model never reads.
      canvas_view: {
        visibleBytes: 572,
        wireBytes: 16572,
        descriptionWords: 39,
        parameters: 2,
        undescribed: 2,
        strays: 'stripped',
        names: [],
      },
      // One of two tools registered with the whole Zod object rather than
      // its `.shape`, which is why its `.strict()` survives to the boundary
      // and a stray key is refused. The rest hand the SDK a shape, and the
      // SDK rebuilds a non-strict object around it.
      wb_body_edit: {
        visibleBytes: 1900,
        wireBytes: 18512,
        descriptionWords: 112,
        parameters: 18,
        undescribed: 18,
        strays: 'refused',
        names: [],
      },
      // 45% of everything the model reads, in one tool: the ops union
      // carries the full node and edge schemas once per arm, and not one
      // of its 207 properties says what it is for.
      wb_canvas_edit: {
        visibleBytes: 15829,
        wireBytes: 36448,
        descriptionWords: 169,
        parameters: 207,
        undescribed: 207,
        strays: 'stripped',
        names: [],
      },
      wb_canvas_snapshot: {
        visibleBytes: 676,
        wireBytes: 4016,
        descriptionWords: 53,
        parameters: 3,
        undescribed: 3,
        strays: 'stripped',
        names: ['wb_document_get'],
      },
      wb_document_get: {
        visibleBytes: 950,
        wireBytes: 2728,
        descriptionWords: 63,
        parameters: 4,
        undescribed: 3,
        strays: 'stripped',
        names: [],
      },
      wb_document_list: {
        visibleBytes: 444,
        wireBytes: 1101,
        descriptionWords: 32,
        parameters: 1,
        undescribed: 1,
        strays: 'stripped',
        names: [],
      },
      wb_document_resolve: {
        visibleBytes: 413,
        wireBytes: 951,
        descriptionWords: 12,
        parameters: 2,
        undescribed: 2,
        strays: 'stripped',
        names: [],
      },
      wb_document_search: {
        visibleBytes: 1002,
        wireBytes: 1832,
        descriptionWords: 42,
        parameters: 5,
        undescribed: 2,
        strays: 'stripped',
        names: [],
      },
      // Every parameter optional, so a stray key is not even an error: the
      // call answers the unfiltered list as if it had been asked for.
      wb_facet_list: {
        visibleBytes: 393,
        wireBytes: 1067,
        descriptionWords: 30,
        parameters: 1,
        undescribed: 1,
        strays: 'unreached',
        names: [],
      },
      wb_facet_set: {
        visibleBytes: 774,
        wireBytes: 1401,
        descriptionWords: 45,
        parameters: 4,
        undescribed: 4,
        strays: 'stripped',
        names: [],
      },
      // Refuses for want of a daemon before it validates anything.
      wb_pairing_link_create: {
        visibleBytes: 1228,
        wireBytes: 1890,
        descriptionWords: 70,
        parameters: 4,
        undescribed: 0,
        strays: 'unreached',
        names: [],
      },
      wb_scene_render: {
        visibleBytes: 1603,
        wireBytes: 1950,
        descriptionWords: 51,
        parameters: 4,
        undescribed: 2,
        strays: 'stripped',
        names: [],
      },
      wb_thread_edit: {
        visibleBytes: 3015,
        wireBytes: 3582,
        descriptionWords: 122,
        parameters: 32,
        undescribed: 32,
        strays: 'stripped',
        names: [],
      },
      // The version tools and the pairing tool are the only ones whose every
      // parameter is described. They are the shape to copy.
      wb_version_list: {
        visibleBytes: 575,
        wireBytes: 1655,
        descriptionWords: 20,
        parameters: 2,
        undescribed: 0,
        strays: 'stripped',
        names: [],
      },
      wb_version_restore: {
        visibleBytes: 1475,
        wireBytes: 2127,
        descriptionWords: 41,
        parameters: 6,
        undescribed: 0,
        strays: 'stripped',
        names: [],
      },
      wb_version_save: {
        visibleBytes: 953,
        wireBytes: 2172,
        descriptionWords: 54,
        parameters: 3,
        undescribed: 0,
        strays: 'stripped',
        names: ['wb_version_restore'],
      },
      wb_viewport_set: {
        visibleBytes: 871,
        wireBytes: 1269,
        descriptionWords: 52,
        parameters: 8,
        undescribed: 8,
        strays: 'stripped',
        names: ['wb_canvas_edit'],
      },
      // The other whole-object registration; see wb_body_edit.
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
      // DEBT. 324 declared, 25 described.
      parameters: total((t) => parameterCoverage(t.inputSchema).parameters),
      undescribed: total((t) => {
        const c = parameterCoverage(t.inputSchema)
        return c.parameters - c.described
      }),
    }).toEqual({
      tools: 18,
      visibleBytes: 34960,
      wireBytes: 102525,
      parameters: 324,
      undescribed: 299,
    })
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
