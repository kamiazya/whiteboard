import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  buildPairingLinkText,
  createPairingLinkInputSchema,
  createPairingLinkInputShape,
  createPairingLinkOutputSchema,
  pairingLinkTool,
  PAIRING_LINK_CREDENTIAL_NOTE,
} from './pairing-link.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Mirrors apps/web/src/lib/daemon-connection-payload.ts's daemonConnectionPayloadSchema,
// duplicated here to decode the fragment the tool emits without importing across the
// package boundary. Kept in sync with the production schema by the round-trip test below.
const mirroredWebPayloadSchema = z
  .object({
    baseUrl: z.string().url(),
    workspaceId: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    bootstrapToken: z.string().min(8).optional(),
    authMode: z.enum(['bootstrap', 'none']),
    fullscreen: z.boolean().optional(),
  })
  .strict()

function decodeFragment(url: string): unknown {
  const marker = '/#wb='
  const idx = url.indexOf(marker)
  if (idx === -1) throw new Error(`url missing #wb= fragment: ${url}`)
  const fragment = url.slice(idx + marker.length)
  const json = Buffer.from(fragment, 'base64url').toString('utf-8')
  return JSON.parse(json)
}

function stubClient(overrides: Partial<{ baseUrl: string; token: string }> = {}) {
  return {
    baseUrl: overrides.baseUrl ?? 'http://127.0.0.1:54231',
    token: overrides.token ?? 'a'.repeat(21),
  }
}

describe('pairing-link input/registration shape coherence', () => {
  it('derives createPairingLinkInputSchema from the exact registered raw shape', () => {
    expect(createPairingLinkInputSchema.shape).toStrictEqual(createPairingLinkInputShape)
  })
})

describe('create_pairing_link tool', () => {
  it('emits a url whose fragment decodes to a valid bootstrap payload', async () => {
    const tool = pairingLinkTool()
    const client = stubClient({ baseUrl: 'http://127.0.0.1:54231', token: 'x'.repeat(24) })
    const result = await tool.execute(
      { workspaceId: 'ws1', slug: 'canvas-a', fullscreen: true },
      client,
    )

    expect(result.authMode).toBe('bootstrap')
    expect(result.url.startsWith(`${result.webOrigin}/#wb=`)).toBe(true)
    // Exactly one '#' in the URL.
    expect(result.url.split('#').length - 1).toBe(1)

    const decoded = mirroredWebPayloadSchema.parse(decodeFragment(result.url))
    expect(decoded).toEqual({
      baseUrl: 'http://127.0.0.1:54231',
      workspaceId: 'ws1',
      slug: 'canvas-a',
      fullscreen: true,
      authMode: 'bootstrap',
      bootstrapToken: 'x'.repeat(24),
    })
  })

  it('uses authMode "none" and omits bootstrapToken when the daemon has no token', async () => {
    const tool = pairingLinkTool()
    const client = stubClient({ token: '' })
    const result = await tool.execute({}, client)

    expect(result.authMode).toBe('none')
    const decoded = decodeFragment(result.url) as Record<string, unknown>
    expect('bootstrapToken' in decoded).toBe(false)
  })

  it('rejects a short daemon token loudly instead of emitting a dead link', async () => {
    const tool = pairingLinkTool()
    const client = stubClient({ token: 'short' })
    await expect(tool.execute({}, client)).rejects.toThrow(/token/i)
  })

  it('rejects slug without workspaceId before any daemon interaction', async () => {
    const tool = pairingLinkTool()
    const client = stubClient()
    await expect(tool.execute({ slug: 'canvas-a' }, client)).rejects.toThrow(/workspaceId/i)
  })

  it('resolves webOrigin: explicit input > env > default production origin', async () => {
    const tool = pairingLinkTool()
    const client = stubClient()

    const defaultResult = await tool.execute({}, client)
    expect(defaultResult.webOrigin).toBe('https://kamiazya-whiteboard.pages.dev')

    const previousEnv = process.env.WHITEBOARD_WEB_ORIGIN
    try {
      process.env.WHITEBOARD_WEB_ORIGIN = 'https://custom.example.com'
      const envResult = await tool.execute({}, client)
      expect(envResult.webOrigin).toBe('https://custom.example.com')

      const explicitResult = await tool.execute(
        { webOrigin: 'https://explicit.example.com' },
        client,
      )
      expect(explicitResult.webOrigin).toBe('https://explicit.example.com')
    } finally {
      if (previousEnv === undefined) delete process.env.WHITEBOARD_WEB_ORIGIN
      else process.env.WHITEBOARD_WEB_ORIGIN = previousEnv
    }
  })

  it('rejects an invalid WHITEBOARD_WEB_ORIGIN env value instead of minting an unvalidated link', async () => {
    const tool = pairingLinkTool()
    const client = stubClient()

    const previousEnv = process.env.WHITEBOARD_WEB_ORIGIN
    try {
      process.env.WHITEBOARD_WEB_ORIGIN = 'https://example.com/some/path'
      await expect(tool.execute({}, client)).rejects.toThrow(/WHITEBOARD_WEB_ORIGIN/)
    } finally {
      if (previousEnv === undefined) delete process.env.WHITEBOARD_WEB_ORIGIN
      else process.env.WHITEBOARD_WEB_ORIGIN = previousEnv
    }
  })

  it('rejects a non-bare-origin webOrigin at the input schema layer', () => {
    expect(() =>
      createPairingLinkInputSchema.parse({ webOrigin: 'https://example.com/some/path' }),
    ).toThrow()
    expect(() => createPairingLinkInputSchema.parse({ webOrigin: 'ftp://example.com' })).toThrow()
  })

  it('omits expiresHint entirely — no real expiry source exists today', async () => {
    const tool = pairingLinkTool()
    const client = stubClient()
    const result = await tool.execute({}, client)
    expect('expiresHint' in result).toBe(false)
  })

  it('registered tool description carries the credential security note', () => {
    const tool = pairingLinkTool()
    expect(tool.description).toContain('bootstrap token')
    expect(tool.description).toContain('WHITEBOARD_ALLOWED_WEB_ORIGINS')
  })

  it('text output warns about the allowlist for non-loopback webOrigin, not for loopback', async () => {
    const tool = pairingLinkTool()
    const client = stubClient()

    const hostedResult = await tool.execute({ webOrigin: 'https://example.pages.dev' }, client)
    const hostedText = buildPairingLinkText(hostedResult, hostedResult.webOrigin)
    expect(hostedText).toContain(PAIRING_LINK_CREDENTIAL_NOTE)
    expect(hostedText).toContain('WHITEBOARD_ALLOWED_WEB_ORIGINS')

    const loopbackResult = await tool.execute({ webOrigin: 'http://localhost:5173' }, client)
    const loopbackText = buildPairingLinkText(loopbackResult, loopbackResult.webOrigin)
    expect(loopbackText).toContain(PAIRING_LINK_CREDENTIAL_NOTE)
    expect(loopbackText).not.toContain('cannot confirm it is present')
  })
})

describe('output schema', () => {
  it('accepts the shape returned by the tool', async () => {
    const tool = pairingLinkTool()
    const client = stubClient()
    const result = await tool.execute({}, client)
    expect(() => createPairingLinkOutputSchema.parse(result)).not.toThrow()
  })
})

describe('PROVISIONAL_PRODUCTION_ORIGIN drift pin', () => {
  it('matches the literal declared in apps/web/src/lib/pages-origin-policy.ts', async () => {
    const p = resolve(__dirname, '../../../../../../apps/web/src/lib/pages-origin-policy.ts')
    if (!existsSync(p)) throw new Error(`expected web source file not found: ${p}`)
    const src = readFileSync(p, 'utf-8')
    const match = src.match(/PROVISIONAL_PRODUCTION_ORIGIN = '([^']+)'/)
    if (!match)
      throw new Error('could not find PROVISIONAL_PRODUCTION_ORIGIN literal in web source')

    const tool = pairingLinkTool()
    const client = stubClient()
    const result = await tool.execute({}, client)
    expect(result.webOrigin).toBe(match[1])
  })
})
