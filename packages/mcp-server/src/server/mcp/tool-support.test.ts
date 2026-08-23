import type { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { z } from 'zod'
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
      { outputSchema: z.object({ ok: z.boolean() }) },
      async () => ({ structuredContent: { ok: true }, content: [] }),
    )

    const registerToolMock = vi.mocked(server.registerTool)
    const config = registerToolMock.mock.calls[0]?.[1] as { _meta?: Record<string, unknown> }
    expect(config._meta).toBeUndefined()
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
