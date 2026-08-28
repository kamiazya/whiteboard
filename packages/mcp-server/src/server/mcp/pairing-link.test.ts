// These tests drive a real McpServer + Client over an in-memory transport
// (the same pattern body-patch-registration.test.ts uses), so the SDK's own
// argument/output validation is what judges the tool rather than a
// restatement of it.
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  daemonConnectionPayloadSchema,
  decodeBase64UrlText,
} from '../../shared/api-contracts/pairing-link.js'
import { DEFAULT_ALLOWED_WEB_ORIGINS } from '../security/web-origin-allowlist.js'
import {
  PAIRING_LINK_CREDENTIAL_NOTE,
  type PairingLinkContext,
  registerPairingLinkTool,
} from './pairing-link.js'

function decodeFragment(url: string): unknown {
  const marker = '#wb='
  const idx = url.indexOf(marker)
  if (idx === -1) throw new Error(`url missing #wb= fragment: ${url}`)
  const fragment = url.slice(idx + marker.length)
  return JSON.parse(decodeBase64UrlText(fragment))
}

async function connectedClient(
  pairing: PairingLinkContext | undefined,
  unavailableReason?: Parameters<typeof registerPairingLinkTool>[2],
) {
  const server = new McpServer({ name: 'whiteboard-test', version: '0.0.0' })
  registerPairingLinkTool(server, pairing, unavailableReason)

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new Client({ name: 'pairing-link-test', version: '0.0.0' })
  await client.connect(clientSide)
  return { client, server }
}

describe('wb_pairing_link_create — with a daemon pairing context', () => {
  let harness: Awaited<ReturnType<typeof connectedClient>>

  beforeEach(async () => {
    harness = await connectedClient({
      daemonBaseUrl: 'http://127.0.0.1:54231',
      bootstrapToken: 'x'.repeat(24),
    })
  })

  afterEach(async () => {
    await harness.client.close().catch(() => {})
    await harness.server.close().catch(() => {})
  })

  const call = (args: Record<string, unknown>) =>
    harness.client.callTool({ name: 'wb_pairing_link_create', arguments: args })

  it('emits a url whose fragment decodes to a shared-schema-valid bootstrap payload', async () => {
    const res = await call({ workspaceId: 'ws1', path: 'canvas-a', fullscreen: true })
    expect(res.isError, JSON.stringify(res)).not.toBe(true)
    const result = res.structuredContent as {
      url: string
      webOrigin: string
      authMode: string
    }
    expect(result.authMode).toBe('bootstrap')
    expect(result.url.startsWith(`${result.webOrigin}/#wb=`)).toBe(true)
    expect(result.url.split('#').length - 1).toBe(1)

    const decoded = daemonConnectionPayloadSchema.parse(decodeFragment(result.url))
    expect(decoded).toEqual({
      baseUrl: 'http://127.0.0.1:54231',
      workspaceId: 'ws1',
      path: 'canvas-a',
      fullscreen: true,
      authMode: 'bootstrap',
      bootstrapToken: 'x'.repeat(24),
    })

    // The credential warning has to reach the tool's REAL content, not just
    // be buildable from the structuredContent in a test — a client only
    // ever sees res.content, never a value it computes for itself.
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? ''
    expect(text).toContain(result.url)
    expect(text).toContain(PAIRING_LINK_CREDENTIAL_NOTE)
  })

  it('rejects path without workspaceId before any daemon interaction', async () => {
    const res = await call({ path: 'canvas-a' })
    expect(res.isError).toBe(true)
    expect((res.content as Array<{ text: string }>)[0]?.text).toMatch(/workspaceId/i)
  })

  it('resolves webOrigin: explicit input > default production origin', async () => {
    const defaultResult = await call({})
    expect((defaultResult.structuredContent as { webOrigin: string }).webOrigin).toBe(
      'https://kamiazya-whiteboard.pages.dev',
    )

    const explicit = await call({ webOrigin: 'https://explicit.example.com' })
    expect((explicit.structuredContent as { webOrigin: string }).webOrigin).toBe(
      'https://explicit.example.com',
    )
  })

  it('rejects a non-bare-origin webOrigin at the input schema layer', async () => {
    const res = await call({ webOrigin: 'https://example.com/some/path' })
    expect(res.isError).toBe(true)
  })

  it('warns about the allowlist for a non-loopback webOrigin, not for loopback', async () => {
    // Asserts on the tool's REAL content array (what a client actually
    // receives), not on buildPairingLinkText called directly against
    // structuredContent — that would pass even if the handler never
    // called buildPairingLinkText at all.
    // PAIRING_LINK_CREDENTIAL_NOTE itself always mentions
    // WHITEBOARD_ALLOWED_WEB_ORIGINS in its general-rule sentence, so the
    // per-call not-admitted warning is identified by its own distinct
    // substring instead.
    const NOT_ADMITTED_MARKER = 'would be rejected by CORS/origin checks'

    const hosted = await call({ webOrigin: 'https://example.pages.dev' })
    const hostedText = (hosted.content as Array<{ text: string }>)[0]?.text ?? ''
    expect(hostedText).toContain(PAIRING_LINK_CREDENTIAL_NOTE)
    expect(hostedText).toContain(NOT_ADMITTED_MARKER)

    const loopback = await call({ webOrigin: 'http://localhost:5173' })
    const loopbackText = (loopback.content as Array<{ text: string }>)[0]?.text ?? ''
    expect(loopbackText).toContain(PAIRING_LINK_CREDENTIAL_NOTE)
    expect(loopbackText).not.toContain(NOT_ADMITTED_MARKER)
  })
})

describe('wb_pairing_link_create — daemon reports its own resolved allowlist', () => {
  it('confirms coverage instead of warning when webOrigin is actually admitted', async () => {
    const { client, server } = await connectedClient({
      daemonBaseUrl: 'http://127.0.0.1:54231',
      bootstrapToken: 'x'.repeat(24),
      allowedWebOrigins: ['https://admitted.example.com'],
    })
    try {
      const res = await client.callTool({
        name: 'wb_pairing_link_create',
        arguments: { webOrigin: 'https://admitted.example.com' },
      })
      const text = (res.content as Array<{ text: string }>)[0]?.text ?? ''
      expect(text).toContain(PAIRING_LINK_CREDENTIAL_NOTE)
      expect(text).not.toContain('would be rejected by CORS/origin checks')
    } finally {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  })

  it('still warns when webOrigin is non-loopback and absent from the resolved allowlist', async () => {
    const { client, server } = await connectedClient({
      daemonBaseUrl: 'http://127.0.0.1:54231',
      bootstrapToken: 'x'.repeat(24),
      allowedWebOrigins: ['https://admitted.example.com'],
    })
    try {
      const res = await client.callTool({
        name: 'wb_pairing_link_create',
        arguments: { webOrigin: 'https://unlisted.example.com' },
      })
      const text = (res.content as Array<{ text: string }>)[0]?.text ?? ''
      expect(text).toContain('would be rejected by CORS/origin checks')
    } finally {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  })

  it('re-reads a live allowedWebOrigins provider on every call instead of a startup snapshot', async () => {
    // http-server.ts passes allowedWebOrigins as a FUNCTION so a pairing
    // grant approved after daemon startup is admitted immediately by CORS,
    // /mcp origin, and WS — this pins that wb_pairing_link_create's own
    // advisory text tracks the same live set instead of freezing whatever
    // the provider returned at construction time.
    let origins: readonly string[] = []
    const { client, server } = await connectedClient({
      daemonBaseUrl: 'http://127.0.0.1:54231',
      bootstrapToken: 'x'.repeat(24),
      allowedWebOrigins: () => origins,
    })
    try {
      const before = await client.callTool({
        name: 'wb_pairing_link_create',
        arguments: { webOrigin: 'https://granted-later.example.com' },
      })
      const beforeText = (before.content as Array<{ text: string }>)[0]?.text ?? ''
      expect(beforeText).toContain('would be rejected by CORS/origin checks')

      // Simulate a pairing grant approved mid-process: the provider now
      // returns the newly admitted origin.
      origins = ['https://granted-later.example.com']

      const after = await client.callTool({
        name: 'wb_pairing_link_create',
        arguments: { webOrigin: 'https://granted-later.example.com' },
      })
      const afterText = (after.content as Array<{ text: string }>)[0]?.text ?? ''
      expect(afterText).not.toContain('would be rejected by CORS/origin checks')
    } finally {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  })
})

describe('wb_pairing_link_create — daemon has no bootstrap token', () => {
  it('uses authMode "none" and omits bootstrapToken from the fragment', async () => {
    const { client, server } = await connectedClient({ daemonBaseUrl: 'http://127.0.0.1:54231' })
    try {
      const res = await client.callTool({ name: 'wb_pairing_link_create', arguments: {} })
      const result = res.structuredContent as { url: string; authMode: string }
      expect(result.authMode).toBe('none')
      const decoded = decodeFragment(result.url) as Record<string, unknown>
      expect('bootstrapToken' in decoded).toBe(false)
    } finally {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  })
})

describe('wb_pairing_link_create — daemon has a too-short bootstrap token', () => {
  it('refuses loudly instead of emitting a dead link', async () => {
    const { client, server } = await connectedClient({
      daemonBaseUrl: 'http://127.0.0.1:54231',
      bootstrapToken: 'short',
    })
    try {
      const res = await client.callTool({ name: 'wb_pairing_link_create', arguments: {} })
      expect(res.isError).toBe(true)
      expect((res.content as Array<{ text: string }>)[0]?.text).toMatch(/token/i)
    } finally {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  })
})

describe('wb_pairing_link_create — standalone stdio (no pairing context)', () => {
  it('is still listed in tools/list and answers isError explaining the HTTP-daemon requirement', async () => {
    const { client, server } = await connectedClient(undefined)
    try {
      const tools = await client.listTools()
      expect(tools.tools.map((t) => t.name)).toContain('wb_pairing_link_create')

      const res = await client.callTool({ name: 'wb_pairing_link_create', arguments: {} })
      expect(res.isError).toBe(true)
      const text = (res.content as Array<{ text: string }>)[0]?.text ?? ''
      expect(text).toMatch(/http/i)
      expect(text).toMatch(/daemon/i)
    } finally {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  })
})

describe('wb_pairing_link_create — server-mode (no pairing context, reason: server-mode)', () => {
  it('names server-mode, not stdio, and does not tell an already-HTTP-connected caller to connect over HTTP', async () => {
    // Regression: app.ts's pairingLinkContext is undefined for
    // authMode: 'server-mode' exactly as it is for stdio, but a server-mode
    // caller is reached over a real, working HTTP /mcp connection — the
    // stdio-shaped message ("running standalone over stdio ... connect
    // through its HTTP /mcp endpoint instead") is false for this caller.
    const { client, server } = await connectedClient(undefined, 'server-mode')
    try {
      const res = await client.callTool({ name: 'wb_pairing_link_create', arguments: {} })
      expect(res.isError).toBe(true)
      const text = (res.content as Array<{ text: string }>)[0]?.text ?? ''
      expect(text).toMatch(/server-mode/i)
      expect(text).not.toMatch(/standalone over stdio/i)
      expect(text).not.toMatch(/connect through its HTTP/i)
    } finally {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  })
})

describe('wb_pairing_link_create — WHITEBOARD_WEB_ORIGIN env fallback', () => {
  const ENV_KEY = 'WHITEBOARD_WEB_ORIGIN'
  let originalValue: string | undefined

  beforeEach(() => {
    originalValue = process.env[ENV_KEY]
  })

  afterEach(() => {
    if (originalValue === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = originalValue
  })

  it('uses WHITEBOARD_WEB_ORIGIN when no explicit webOrigin arg is passed', async () => {
    process.env[ENV_KEY] = 'https://env-configured.example.com'
    const { client, server } = await connectedClient({
      daemonBaseUrl: 'http://127.0.0.1:54231',
      bootstrapToken: 'x'.repeat(24),
    })
    try {
      const res = await client.callTool({ name: 'wb_pairing_link_create', arguments: {} })
      expect((res.structuredContent as { webOrigin: string }).webOrigin).toBe(
        'https://env-configured.example.com',
      )
    } finally {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  })

  it('an explicit webOrigin arg still wins over the env fallback', async () => {
    process.env[ENV_KEY] = 'https://env-configured.example.com'
    const { client, server } = await connectedClient({
      daemonBaseUrl: 'http://127.0.0.1:54231',
      bootstrapToken: 'x'.repeat(24),
    })
    try {
      const res = await client.callTool({
        name: 'wb_pairing_link_create',
        arguments: { webOrigin: 'https://explicit.example.com' },
      })
      expect((res.structuredContent as { webOrigin: string }).webOrigin).toBe(
        'https://explicit.example.com',
      )
    } finally {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  })

  it('treats an empty-string WHITEBOARD_WEB_ORIGIN as unset, falling back to the default origin', async () => {
    // resolveEnvWebOrigin() has an explicit `if (!raw) return undefined`
    // branch distinguishing "" (a cleared env var in shell scripts) from a
    // real misconfiguration — pin it separately from the misconfigured case
    // below so a regression treating "" as an error (or as a literal origin)
    // is caught.
    process.env[ENV_KEY] = ''
    const { client, server } = await connectedClient({
      daemonBaseUrl: 'http://127.0.0.1:54231',
      bootstrapToken: 'x'.repeat(24),
    })
    try {
      const res = await client.callTool({ name: 'wb_pairing_link_create', arguments: {} })
      expect(res.isError, JSON.stringify(res)).not.toBe(true)
      expect((res.structuredContent as { webOrigin: string }).webOrigin).toBe(
        DEFAULT_ALLOWED_WEB_ORIGINS[0],
      )
    } finally {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  })

  it('surfaces isError instead of minting a broken link when the env var is misconfigured', async () => {
    // A path makes this fail bareHttpOriginSchema — the same check an
    // explicit webOrigin arg goes through at the input-schema layer, but the
    // env fallback bypasses that layer unless resolveEnvWebOrigin re-checks.
    process.env[ENV_KEY] = 'https://example.com/some/path'
    const { client, server } = await connectedClient({
      daemonBaseUrl: 'http://127.0.0.1:54231',
      bootstrapToken: 'x'.repeat(24),
    })
    try {
      const res = await client.callTool({ name: 'wb_pairing_link_create', arguments: {} })
      expect(res.isError).toBe(true)
      const text = (res.content as Array<{ text: string }>)[0]?.text ?? ''
      expect(text).toMatch(/WHITEBOARD_WEB_ORIGIN/)
    } finally {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  })
})
