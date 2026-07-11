import { z } from 'zod'
import type { DaemonClient } from '../daemon-client.js'

// Defense-in-depth floor mirroring apps/web/src/lib/daemon-connection-payload.ts's
// MIN_BOOTSTRAP_TOKEN_LENGTH — the daemon itself is the real security boundary
// (ADR-0002), this only stops us minting a link the web parser would reject outright.
const MIN_BOOTSTRAP_TOKEN_LENGTH = 8

// Duplicated from apps/web/src/lib/pages-origin-policy.ts's PROVISIONAL_PRODUCTION_ORIGIN.
// mcp-server cannot import across the apps/web package boundary, so this literal is
// pinned by a drift test in pairing-link.test.ts that reads the web source directly.
const PROVISIONAL_PRODUCTION_ORIGIN = 'https://kamiazya-whiteboard.pages.dev'

// Bare http(s) origin: scheme + host + optional port, nothing else. Mirrors
// bareOriginSchema in apps/web/src/runtime-config.ts, narrowed to http(s) only —
// daemon pairing (ADR-0002) never uses another scheme.
const bareHttpOriginSchema = z
  .string()
  .url()
  .refine(
    (v) => {
      try {
        const url = new URL(v)
        return (
          url.origin === v &&
          !url.hostname.includes('*') &&
          (url.protocol === 'http:' || url.protocol === 'https:')
        )
      } catch {
        return false
      }
    },
    {
      message:
        'webOrigin must be a bare http(s) origin (scheme + host + optional port, no path, query, hash, credentials, or wildcards)',
    },
  )

// Single source of truth for create_pairing_link's input: a raw shape so it can be
// passed directly to registerToolWithAnnotations (which requires z.ZodRawShape and
// cannot accept a refined z.object()). The cross-field "slug requires workspaceId"
// rule cannot live here for that reason — it is enforced in execute() below instead.
export const createPairingLinkInputShape = {
  workspaceId: z
    .string()
    .min(1)
    .optional()
    .describe('Target workspace ID. Required when slug is set.'),
  slug: z
    .string()
    .min(1)
    .optional()
    .describe('Target canvas slug within workspaceId. Requires workspaceId to also be set.'),
  webOrigin: bareHttpOriginSchema
    .optional()
    .describe(
      'Web app origin to embed in the link (e.g. "https://app.example.com"). Defaults to the WHITEBOARD_WEB_ORIGIN env var, or the production whiteboard web app origin.',
    ),
  fullscreen: z
    .boolean()
    .optional()
    .describe('Open the paired canvas in fullscreen mode once connected.'),
} satisfies z.ZodRawShape

export const createPairingLinkInputSchema = z.object(createPairingLinkInputShape)

export const createPairingLinkOutputSchema = z.object({
  url: z.string().url().describe('The `${webOrigin}/#wb=<payload>` pairing URL.'),
  webOrigin: z.string().describe('The web app origin embedded in url.'),
  authMode: z.enum(['bootstrap', 'none']).describe('Auth mode encoded in the pairing payload.'),
  // Omitted entirely (never emitted as `undefined`) whenever no real expiry source
  // exists — which is always today, since bootstrap tokens surface no TTL to the
  // MCP layer. Flip this to always-emitted only once a real expiry source lands.
  expiresHint: z.string().optional().describe('Human-readable expiry hint, when known.'),
})

// Mirrors apps/web/src/lib/daemon-connection-payload.ts's daemonConnectionPayloadSchema.
// Duplicated (not imported) because mcp-server cannot depend on apps/web; the fixture
// round-trip assertions in pairing-link.test.ts guard against silent drift.
const mirroredDaemonConnectionPayloadSchema = z
  .object({
    baseUrl: bareHttpOriginSchema,
    workspaceId: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    bootstrapToken: z.string().min(MIN_BOOTSTRAP_TOKEN_LENGTH).optional(),
    authMode: z.enum(['bootstrap', 'none']),
    fullscreen: z.boolean().optional(),
  })
  .strict()
  .refine((payload) => payload.authMode !== 'bootstrap' || payload.bootstrapToken !== undefined, {
    message: 'bootstrapToken is required when authMode is "bootstrap"',
    path: ['bootstrapToken'],
  })
  .refine((payload) => payload.slug === undefined || payload.workspaceId !== undefined, {
    message: 'workspaceId is required when slug is set',
    path: ['workspaceId'],
  })

// Node's 'base64url' Buffer encoding is unpadded and uses the same alphabet as the
// web side's hand-rolled encodeBase64Url, so the two implementations produce
// byte-identical fragments for the same JSON text.
function encodeBase64UrlJson(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')
}

// The explicit webOrigin input is constrained by bareHttpOriginSchema at the
// schema layer; the env var fallback bypasses that layer entirely unless it is
// re-validated here, so a misconfigured WHITEBOARD_WEB_ORIGIN would otherwise
// silently mint a link with a path/query/wrong-scheme origin the web app
// parser rejects outright.
function resolveEnvWebOrigin(): string | undefined {
  const raw = process.env.WHITEBOARD_WEB_ORIGIN
  if (raw === undefined) return undefined

  const parsed = bareHttpOriginSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `create_pairing_link: WHITEBOARD_WEB_ORIGIN is not a bare http(s) origin: ${raw}`,
    )
  }
  return parsed.data
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin)
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    )
  } catch {
    return false
  }
}

export const PAIRING_LINK_CREDENTIAL_NOTE =
  'SECURITY: this URL embeds the daemon bootstrap token — treat it like a credential and share it only with the intended recipient. Hosted (non-loopback) webOrigin values must be added to WHITEBOARD_ALLOWED_WEB_ORIGINS on the daemon; loopback origins need no allowlist entry.'

// The MCP process cannot read the daemon's WHITEBOARD_ALLOWED_WEB_ORIGINS
// configuration, so this warning is deliberate best-effort: it reminds the
// caller to check rather than confirming coverage.
const HOSTED_ORIGIN_ALLOWLIST_WARNING =
  'This webOrigin is non-loopback; the MCP process cannot confirm it is present in WHITEBOARD_ALLOWED_WEB_ORIGINS on the daemon — verify that allowlist entry yourself before sharing the link.'

export function buildPairingLinkText(
  result: z.infer<typeof createPairingLinkOutputSchema>,
  webOrigin: string,
): string {
  const lines = [result.url, '', PAIRING_LINK_CREDENTIAL_NOTE]
  if (!isLoopbackOrigin(webOrigin)) lines.push(HOSTED_ORIGIN_ALLOWLIST_WARNING)
  return lines.join('\n')
}

export function pairingLinkTool() {
  return {
    name: 'create_pairing_link',
    description:
      'Mint a `#wb=` daemon-pairing URL that lets the whiteboard web app connect to this local daemon, optionally targeting a specific workspace/canvas. ' +
      PAIRING_LINK_CREDENTIAL_NOTE,
    execute: async (
      args: z.infer<typeof createPairingLinkInputSchema>,
      client: Pick<DaemonClient, 'baseUrl' | 'token'>,
    ): Promise<z.infer<typeof createPairingLinkOutputSchema>> => {
      // Cross-field guard: raw-shape registration cannot express this as a schema
      // refinement (registerToolWithAnnotations requires z.ZodRawShape), so it is
      // enforced here, before any daemon interaction.
      if (args.slug !== undefined && args.workspaceId === undefined) {
        throw new Error('create_pairing_link: workspaceId is required when slug is set')
      }

      const webOrigin = args.webOrigin ?? resolveEnvWebOrigin() ?? PROVISIONAL_PRODUCTION_ORIGIN

      const hasToken = client.token.length > 0
      if (hasToken && client.token.length < MIN_BOOTSTRAP_TOKEN_LENGTH) {
        // Fail loudly rather than emit a URL the web-side schema would reject as
        // invalid once opened — a dead link is worse than an explicit tool error.
        throw new Error(
          `create_pairing_link: daemon bootstrap token is only ${client.token.length} chars (minimum ${MIN_BOOTSTRAP_TOKEN_LENGTH}); refusing to mint a pairing link the web app would reject`,
        )
      }

      const payload = mirroredDaemonConnectionPayloadSchema.parse({
        baseUrl: client.baseUrl,
        workspaceId: args.workspaceId,
        slug: args.slug,
        fullscreen: args.fullscreen,
        authMode: hasToken ? 'bootstrap' : 'none',
        bootstrapToken: hasToken ? client.token : undefined,
      })

      const fragment = encodeBase64UrlJson(payload)
      const url = `${webOrigin}/#wb=${fragment}`

      return { url, webOrigin, authMode: payload.authMode }
    },
  }
}
