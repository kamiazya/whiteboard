// A published schema that REFERENCES a subschema has to be readable on its
// own, and that is a different claim from the server working.
//
// `edgeEndpointSchema` is named in zod's global registry so it is emitted
// into `$defs` once and referenced at each of its four sites, which is what
// keeps the tool table under ADR-0031 §5's ceiling (see
// `tool-surface-quality.test.ts`). The failure mode that buys is a DANGLING
// reference: a `$ref` whose `$defs` entry is missing, or one pointing at the
// wrong definition. Neither breaks the server — it validates with zod and
// never reads its own JSON Schema — so the smoke stays green and only a
// client reading the table is hurt. Nothing else in the suite looks.
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { InMemoryVersionHistory } from '../../shared/test-utils/in-memory-version-history.js'
import type { ListedTool } from '../../shared/test-utils/tool-surface-metrics.js'
import { InMemoryDocumentStore } from '../store/inmemory/in-memory-document-store.js'
import { registerDocumentTools } from './document-tools.js'
import { registerPairingLinkTool } from './pairing-link.js'

async function listTools(): Promise<readonly ListedTool[]> {
  const server = new McpServer({ name: 'whiteboard-refs', version: '0.0.0' })
  registerDocumentTools(server, {
    documentStore: new InMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
    versions: new InMemoryVersionHistory(),
  } as never)
  registerPairingLinkTool(server, undefined, undefined)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'refs', version: '0.0.0' })
  await client.connect(clientSide)
  const { tools } = await client.listTools()
  return tools as readonly ListedTool[]
}

/** Every `$ref` string anywhere in a schema, with the path that held it. */
function refsIn(node: unknown, at = '$'): Array<{ at: string; ref: string }> {
  if (node === null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((item, i) => refsIn(item, `${at}[${i}]`))
  const out: Array<{ at: string; ref: string }> = []
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') out.push({ at, ref: value })
    else out.push(...refsIn(value, `${at}.${key}`))
  }
  return out
}

/** What a local `#/$defs/Name` pointer resolves to, or undefined. */
function resolve(document: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined
  let current: unknown = document
  for (const segment of ref.slice(2).split('/')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[
      segment.replaceAll('~1', '/').replaceAll('~0', '~')
    ]
  }
  return current
}

describe('a published schema resolves its own references', () => {
  it('leaves no dangling or external $ref in any input or output schema', async () => {
    const tools = await listTools()
    const dangling: string[] = []
    let seen = 0
    for (const tool of tools) {
      for (const [which, schema] of [
        ['inputSchema', tool.inputSchema],
        ['outputSchema', (tool as { outputSchema?: unknown }).outputSchema],
      ] as const) {
        if (schema === undefined) continue
        const document = schema as Record<string, unknown>
        for (const { at, ref } of refsIn(document)) {
          seen += 1
          // An external `$ref` is as broken as a dangling one for a reader
          // that fetches nothing, and MCP gives it nowhere to fetch from.
          if (!ref.startsWith('#/')) dangling.push(`${tool.name}.${which} ${at}: non-local ${ref}`)
          else if (resolve(document, ref) === undefined)
            dangling.push(`${tool.name}.${which} ${at}: ${ref} resolves to nothing`)
        }
      }
    }
    expect(dangling).toEqual([])
    // A count beside the walk, so a `refsIn` that stops matching reports
    // itself instead of reporting a clean table.
    expect(seen, 'the table publishes references at all').toBeGreaterThan(0)
  })

  it('references the edge end and the line end, each emitted once', async () => {
    const tools = await listTools()
    const edit = tools.find((tool) => tool.name === 'wb_canvas_edit')
    const document = edit?.inputSchema as Record<string, unknown>
    const defs = (document?.$defs as Record<string, unknown>) ?? {}

    // ADR-0038 decision 2 narrowed an edge's end to a node reference, so what
    // is registered here is a small flat object rather than the old
    // node-or-point union. Registering it is still the saving: measured,
    // leaving it out took the visible table 37,796 -> 38,317 bytes on a
    // strictly SIMPLER schema, because the saving belongs to the repetition
    // and not to the shape.
    expect(Object.keys(defs)).toContain('EdgeEnd')
    const end = defs.EdgeEnd as { properties?: Record<string, unknown> } | undefined
    expect(Object.keys(end?.properties ?? {}).sort()).toEqual(['end', 'node', 'side'])

    // Four sites: `from` and `to`, on `edge.add` and on `edge.patch`.
    expect(refsIn(document).filter((r) => r.ref === '#/$defs/EdgeEnd')).toHaveLength(4)

    // The gap this test used to RECORD is closed: the node-or-point union
    // lives on a LINE, and `line.add`/`line.patch` are what make one
    // authorable, so `LineEnd` is published too. What it asked its closer to
    // assert is exactly this — that the name resolves to the union it names,
    // both arms reachable by their discriminator.
    expect(Object.keys(defs)).toContain('LineEnd')
    // `oneOf`, not `anyOf`: a zod DISCRIMINATED union emits the stricter
    // keyword, which is what tells a client's validator the two arms are
    // mutually exclusive rather than merely both acceptable.
    const lineEnd = defs.LineEnd as { oneOf?: readonly Record<string, unknown>[] } | undefined
    const arms = (lineEnd?.oneOf ?? []).map((arm) => {
      const properties = (arm.properties ?? {}) as Record<string, { const?: unknown }>
      return properties.kind?.const
    })
    expect(arms.sort()).toEqual(['node', 'point'])

    // Four sites for it too: `from` and `to`, on `line.add` and `line.patch`.
    // The count is what says the union is REFERENCED rather than inlined at
    // each one — the saving that kept the edge end under ADR-0031 §5's
    // ceiling, claimed again for a strictly larger schema.
    expect(refsIn(document).filter((r) => r.ref === '#/$defs/LineEnd')).toHaveLength(4)
  })
})
