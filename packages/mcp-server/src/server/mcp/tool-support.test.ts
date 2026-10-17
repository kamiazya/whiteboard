import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer, type RequestId } from '@modelcontextprotocol/server'
import { trace } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { z } from 'zod'
import type { ResolvedGrant } from '../security/credential-resolver.js'
import { runAsMcpCaller } from '../security/mcp-caller.js'
import type { MemberProfileStore } from '../security/member-profile-store.js'
import { corruptStoredData } from '../store/corrupt-stored-data.js'
import { RESOURCE_URI_META_KEY } from './mcp-apps.js'
import { registerToolWithAnnotations } from './tool-support.js'

function fakeServer() {
  const registerTool = vi.fn()
  return { server: { registerTool }, registerTool } as unknown as McpServer
}

describe('registerToolWithAnnotations', () => {
  it('mirrors _meta.ui.resourceUri into the deprecated ui/resourceUri key for older hosts', () => {
    const server = fakeServer()
    registerToolWithAnnotations(
      server,
      'canvas_view',
      {
        inputSchema: {},
        outputSchema: z.object({ ok: z.boolean() }),
        _meta: { ui: { resourceUri: 'ui://whiteboard/canvas-view' } },
      },
      async () => ({ structuredContent: { ok: true }, content: [] }),
    )

    const registerToolMock = vi.mocked(server.registerTool)
    const config = registerToolMock.mock.calls[0]?.[1] as { _meta?: Record<string, unknown> }
    expect(config._meta).toEqual({
      ui: { resourceUri: 'ui://whiteboard/canvas-view' },
      [RESOURCE_URI_META_KEY]: 'ui://whiteboard/canvas-view',
    })
  })

  it('leaves _meta untouched for tools without MCP Apps UI linkage', () => {
    const server = fakeServer()
    registerToolWithAnnotations(
      server,
      'canvas_open',
      { inputSchema: {}, outputSchema: z.object({ ok: z.boolean() }) },
      async () => ({ structuredContent: { ok: true }, content: [] }),
    )

    const registerToolMock = vi.mocked(server.registerTool)
    const config = registerToolMock.mock.calls[0]?.[1] as { _meta?: Record<string, unknown> }
    expect(config._meta).toBeUndefined()
  })

  // An omission must prompt rather than slip past: a tool nobody profiled is
  // announced as the worst case, not as a harmless write.
  it('announces a tool with no profile as destructive, titled by its name', () => {
    const server = fakeServer()
    registerToolWithAnnotations(
      server,
      'zz_unprofiled_tool',
      { inputSchema: {}, outputSchema: z.object({ ok: z.boolean() }) },
      async () => ({ structuredContent: { ok: true }, content: [] }),
    )

    const config = vi.mocked(server.registerTool).mock.calls[0]?.[1] as {
      annotations?: Record<string, unknown>
    }
    expect(config.annotations).toMatchObject({
      destructiveHint: true,
      title: 'zz_unprofiled_tool',
    })
  })

  // Type-level only — these bodies never execute. Widening `I` to accept a
  // whole schema (for wb_body_patch's discriminated union) must not
  // silently collapse the 17 existing raw-shape callers' handler argument
  // inference to `any`: an `any` args object would satisfy every downstream
  // use and typecheck would stay green while the outputSchema<->handler
  // binding document-tools.ts depends on quietly stopped checking anything.
  it('infers handler args from both a raw shape and a whole schema', () => {
    registerToolWithAnnotations(
      fakeServer(),
      'raw-shape-tool',
      { inputSchema: { a: z.string(), b: z.number() } },
      async (args) => {
        expectTypeOf(args).toEqualTypeOf<{ a: string; b: number }>()
        expectTypeOf(args).not.toBeAny()
        return { content: [] }
      },
    )

    registerToolWithAnnotations(
      fakeServer(),
      'whole-schema-tool',
      { inputSchema: z.object({ a: z.string(), b: z.number() }) },
      async (args) => {
        expectTypeOf(args).toEqualTypeOf<{ a: string; b: number }>()
        return { content: [] }
      },
    )

    const union = z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('full'), body: z.string() }),
      z.object({ mode: z.literal('range'), from: z.number() }),
    ])
    registerToolWithAnnotations(
      fakeServer(),
      'union-tool',
      { inputSchema: union },
      async (args) => {
        // Narrows on the discriminant, proving the union's arms — not just
        // its outer shape — survive registration.
        if (args.mode === 'full') {
          expectTypeOf(args.body).toEqualTypeOf<string>()
        } else {
          expectTypeOf(args.from).toEqualTypeOf<number>()
        }
        return { content: [] }
      },
    )
  })
})

describe('a tool call span', () => {
  afterEach(() => {
    trace.disable()
  })

  // Driven through a real McpServer and client so the request context is the
  // one the installed SDK actually passes, not a shape the test builds itself.
  it('carries the MCP semantic-convention method, tool and request attributes', async () => {
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    trace.setGlobalTracerProvider(provider)
    const server = new McpServer({ name: 'tool-span', version: '0.0.0' })
    registerToolWithAnnotations(server, 'canvas_open', { inputSchema: {} }, async () => ({
      content: [],
    }))
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = new Client({ name: 'tool-span', version: '0.0.0' })
    await client.connect(clientSide)

    const sentIds: RequestId[] = []
    const send = clientSide.send.bind(clientSide)
    clientSide.send = async (message, options) => {
      if ('method' in message && message.method === 'tools/call' && 'id' in message) {
        sentIds.push(message.id)
      }
      return send(message, options)
    }
    await client.callTool({ name: 'canvas_open', arguments: {} })
    await client.close()

    const [span] = exporter.getFinishedSpans()
    await provider.shutdown()
    expect(sentIds).toHaveLength(1)
    expect(span?.name).toBe('mcp.tool.call canvas_open')
    expect(span?.attributes).toEqual({
      'mcp.method.name': 'tools/call',
      'mcp.tool.name': 'canvas_open',
      'mcp.request.id': String(sentIds[0]),
    })
  })
})

class FakeRefusalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FakeRefusalError'
  }
}

/** The handler a tool that throws `thrown` registers, as the SDK would call it. */
function throwingHandler(thrown: unknown) {
  const server = fakeServer()
  registerToolWithAnnotations(
    server,
    'wb_document_get',
    { inputSchema: {}, outputSchema: z.object({ ok: z.boolean() }) },
    async () => {
      throw thrown
    },
  )
  const handler = vi.mocked(server.registerTool).mock.calls[0]?.[2] as (
    args: unknown,
    extra: unknown,
  ) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>
  return () => handler({}, {})
}

const serverModeCaller = {
  grant: { kind: 'external-bearer', scopes: [] } satisfies ResolvedGrant,
  members: {} as MemberProfileStore,
}
const asServerMode = <T>(fn: () => Promise<T>) => runAsMcpCaller(serverModeCaller, fn)
const STORED = '/srv/whiteboard/tenants/self-host/workspaces/w1/files/a.png'

describe('tool error text on server mode', () => {
  it('keeps a corrupt stored file out of the text, while the local daemon still names it', async () => {
    const call = throwingHandler(corruptStoredData(STORED, 'stored file is empty'))
    const remote = await asServerMode(call)
    expect(remote.isError).toBe(true)
    expect(remote.content[0]?.text).toMatch(/^internal_error:/)
    expect(remote.content[0]?.text).not.toContain('/')
    expect((await call()).content[0]?.text).toContain(STORED)
  })

  it('passes a named refusal through verbatim', async () => {
    const call = throwingHandler(new FakeRefusalError('node n1 is not on this canvas'))
    expect((await asServerMode(call)).content[0]?.text).toBe('node n1 is not on this canvas')
  })

  it('hides a refusal that quotes a fault it wraps', async () => {
    const fault = corruptStoredData(STORED, 'stored file is empty')
    const call = throwingHandler(
      new FakeRefusalError(`ops[0] (document.set) could not be applied: ${fault.message}`, {
        cause: fault,
      }),
    )
    expect((await asServerMode(call)).content[0]?.text).not.toContain('/')
  })

  it('hides an unnamed error and a raw filesystem error', async () => {
    const enoent = Object.assign(new FakeRefusalError(`ENOENT: open '${STORED}'`), {
      syscall: 'open',
    })
    for (const thrown of [new Error(`failed at ${STORED}`), enoent]) {
      expect((await asServerMode(throwingHandler(thrown))).content[0]?.text).not.toContain('/')
    }
  })
})
