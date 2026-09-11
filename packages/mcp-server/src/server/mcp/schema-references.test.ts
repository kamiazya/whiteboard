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

  it('resolves the edge endpoint to the union it names, not to something else', async () => {
    const tools = await listTools()
    const edit = tools.find((tool) => tool.name === 'wb_canvas_edit')
    const document = edit?.inputSchema as Record<string, unknown>
    const defs = document?.$defs as Record<string, unknown> | undefined
    const endpoint = defs?.EdgeEndpoint as Record<string, unknown> | undefined
    expect(Object.keys(defs ?? {})).toContain('EdgeEndpoint')

    // The point of the check: a `$ref` that resolves is not yet a `$ref` that
    // resolves to the RIGHT thing. Both arms, by their discriminator.
    const arms = (endpoint?.oneOf ?? endpoint?.anyOf) as Array<Record<string, unknown>> | undefined
    const kinds = (arms ?? [])
      .map(
        (arm) => (arm.properties as Record<string, { const?: unknown }> | undefined)?.kind?.const,
      )
      .sort()
    expect(kinds).toEqual(['node', 'point'])

    // And that the sites really reference it rather than inlining it, which
    // is the whole saving: four sites, `from` and `to` on edge.add and
    // edge.patch.
    const toEndpoint = refsIn(document).filter((r) => r.ref === '#/$defs/EdgeEndpoint')
    expect(toEndpoint.length).toBe(4)
  })
})
