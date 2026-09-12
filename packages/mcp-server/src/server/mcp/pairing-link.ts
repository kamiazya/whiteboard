import {
  daemonConnectionPayloadSchema,
  encodeBase64UrlText,
  isBareHttpOrigin,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/pairing-link'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  type AllowedWebOrigins,
  DEFAULT_ALLOWED_WEB_ORIGINS,
  isAllowedWebOrigin,
  resolveAllowedWebOrigins,
} from '../security/web-origin-allowlist.js'
import { registerToolWithAnnotations } from './tool-support.js'

// The daemon's own default onboarding destination — kept in sync with the
// hosted-origin CORS allowlist so a link minted with no explicit webOrigin
// always points somewhere the daemon itself admits by default.
const DEFAULT_PRODUCTION_WEB_ORIGIN = DEFAULT_ALLOWED_WEB_ORIGINS[0]

// Bare http(s) origin: scheme + host + optional port, nothing else — the
// shared contract's predicate, so this cannot drift from what the payload
// schema itself enforces on baseUrl. A pairing link targets one concrete
// origin, so a wildcard host is rejected here even though
// WHITEBOARD_ALLOWED_WEB_ORIGINS itself may admit one.
const bareHttpOriginSchema = z.string().url().refine(isBareHttpOrigin, {
  message:
    'webOrigin must be a bare http(s) origin (scheme + host + optional port, no path, query, hash, credentials, or wildcards)',
})

// Single source of truth for wb_pairing_link_create's input: a raw shape so
// it can be passed directly to registerToolWithAnnotations (which requires
// z.ZodRawShape and cannot accept a refined z.object()). The cross-field
// "path requires workspaceId" rule cannot live here for that reason — it is
// enforced in execute() below instead.
export const pairingLinkInputShape = {
  workspaceId: z
    .string()
    .min(1)
    .optional()
    .describe('Target workspace ID. Required when path is set.'),
  path: z
    .string()
    .min(1)
    .optional()
    .describe('Target document path within workspaceId. Requires workspaceId to also be set.'),
  webOrigin: bareHttpOriginSchema
    .optional()
    .describe(
      'Web app origin to embed in the link (e.g. "https://app.example.com"). Defaults to the WHITEBOARD_WEB_ORIGIN env var, or the official hosted whiteboard web app origin.',
    ),
  fullscreen: z
    .boolean()
    .optional()
    .describe('Open the paired document in fullscreen mode once connected.'),
} satisfies z.ZodRawShape

export const pairingLinkInputSchema = z.object(pairingLinkInputShape)

// `authMode` and `expiresHint` are gone with the credential they described:
// the link carries none, so there is no mode to report and nothing to expire.
export const pairingLinkOutputSchema = z.object({
  url: z.string().url().describe('The `<webOrigin>/#wb=<payload>` pairing URL.'),
  webOrigin: z.string().describe('The web app origin embedded in url.'),
})

// The explicit webOrigin input is constrained by bareHttpOriginSchema at the
// schema layer; the env var fallback bypasses that layer entirely unless it
// is re-validated here, so a misconfigured WHITEBOARD_WEB_ORIGIN would
// otherwise silently mint a link with a path/query/wrong-scheme origin the
// web app parser rejects outright.
function resolveEnvWebOrigin(): string | undefined {
  const raw = process.env.WHITEBOARD_WEB_ORIGIN
  // Empty string means "unset" (a cleared env var in shell scripts), not a
  // misconfiguration — fall back to the default rather than failing loudly.
  if (!raw) return undefined

  const parsed = bareHttpOriginSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `wb_pairing_link_create: WHITEBOARD_WEB_ORIGIN is not a bare http(s) origin: ${raw}`,
    )
  }
  return parsed.data
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin)
    return (
      hostname === 'localhost' ||
      // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
      // Node's WHATWG URL keeps the brackets ('[::1]'); the bare form is
      // retained for runtimes that strip them.
      hostname === '::1' ||
      hostname === '[::1]'
    )
  } catch {
    return false
  }
}

// The link carries no credential, so this is guidance rather than a warning:
// what it has to tell the caller is that the recipient still approves on the
// daemon's own page, and that a hosted origin needs an allowlist entry.
export const PAIRING_LINK_NOTE =
  'This URL carries no credential — opening it asks the daemon for access, which the person at the daemon approves on its own /pair page (or which is granted silently if that browser origin was approved before). Hosted (non-loopback) webOrigin values must be added to WHITEBOARD_ALLOWED_WEB_ORIGINS on the daemon (an exact origin or a https://*.example.com wildcard subdomain pattern); loopback origins need no allowlist entry.'

// A non-loopback webOrigin absent from the daemon's own admitted set: the
// link would open, but the paired web app's request to the daemon is exactly
// what /api CORS, /mcp origin, and WS upgrade would reject — so the mint
// itself is not wrong, but the resulting link is dead until the operator
// adds the entry.
const HOSTED_ORIGIN_NOT_ALLOWLISTED_WARNING =
  'This webOrigin is not in WHITEBOARD_ALLOWED_WEB_ORIGINS on this daemon — the paired web app would be rejected by CORS/origin checks until you add it there.'

export function buildPairingLinkText(
  result: z.infer<typeof pairingLinkOutputSchema>,
  webOrigin: string,
  allowedWebOrigins: readonly string[] = [],
): string {
  const lines = [result.url, '', PAIRING_LINK_NOTE]
  if (!isLoopbackOrigin(webOrigin) && !isAllowedWebOrigin(webOrigin, allowedWebOrigins)) {
    lines.push(HOSTED_ORIGIN_NOT_ALLOWLISTED_WARNING)
  }
  return lines.join('\n')
}

// The daemon's own origin, threaded in by the composition root
// (http-server.ts, via createApp/createMcpServer) rather than read from
// process.env inside this module — the stdio entrypoint has no HTTP daemon
// of its own to describe, which is the standalone case below.
//
// It used to carry the daemon's bootstrap token too, to embed in the link.
// Nothing embeds a credential any more, so the field is gone rather than
// left unread: a context that cannot reach the token cannot leak it.
export interface PairingLinkContext {
  daemonBaseUrl: string
  // The daemon's own WHITEBOARD_ALLOWED_WEB_ORIGINS (the same set /api CORS,
  // /mcp origin, and WS upgrade enforce), so a non-loopback webOrigin can be
  // checked against real coverage instead of only reminding the caller to
  // check it themselves. Kept as the raw array-or-provider value (never
  // resolved here) and re-resolved on every call via resolveAllowedWebOrigins
  // — in local-daemon mode this is a live function backed by pairing grants
  // approved at runtime, and freezing its result once at app construction
  // would make this tool's advisory text stale for the rest of the process.
  // Absent (rather than defaulted here) when the caller has no allowlist to
  // report — e.g. server-mode has no meaning for this field at all.
  allowedWebOrigins?: AllowedWebOrigins
}

const PAIRING_LINK_TOOL_NAME = 'wb_pairing_link_create'

// Why `pairing` is absent — the caller (createMcpServer's composition root)
// knows which of these it is; this module cannot infer it from `undefined`
// alone. 'stdio' is the default because that is this module's own standalone
// entrypoint's reason, with no HTTP daemon of any kind.
export type PairingUnavailableReason =
  // The stdio entrypoint: no HTTP listener exists at all to embed a link to.
  | 'stdio'
  // A real HTTP /mcp connection, but server-mode has no single daemon
  // origin/bootstrap-token to embed — clients authenticate via their own
  // configured strategy (API key/OAuth) instead.
  | 'server-mode'
  // local-daemon mode, but the composition root gave no daemonBaseUrl (an
  // ad-hoc or test caller with no real HTTP listener behind it).
  | 'no-daemon-base-url'

const PAIRING_UNAVAILABLE_MESSAGES: Record<PairingUnavailableReason, string> = {
  stdio:
    'wb_pairing_link_create: this MCP server is running standalone over stdio, which has no HTTP daemon to pair with. Start the `whiteboard` daemon (pnpm mcp:http:dev in development, or the installed daemon in production) and connect through its HTTP /mcp endpoint instead.',
  'server-mode':
    'wb_pairing_link_create: this MCP server is running in server-mode, which has no single daemon origin or bootstrap token to embed in a pairing link — server-mode clients authenticate through their own configured strategy (API key or OAuth) instead of a daemon pairing link.',
  'no-daemon-base-url':
    'wb_pairing_link_create: this MCP server has no daemonBaseUrl configured, so there is no HTTP origin to embed in a pairing link.',
}

export function registerPairingLinkTool(
  server: McpServer,
  pairing: PairingLinkContext | undefined,
  unavailableReason: PairingUnavailableReason = 'stdio',
): void {
  registerToolWithAnnotations(
    server,
    PAIRING_LINK_TOOL_NAME,
    {
      description:
        "Mint a `#wb=` daemon-pairing URL that lets the whiteboard web app connect to this local daemon, optionally targeting a specific workspace/document. The URL carries no credential: access is approved on the daemon's own /pair page.",
      // The OBJECT, strict, not the shape: handed a shape, the SDK rebuilds
      // a non-strict object around it and a misspelt optional parameter is
      // dropped rather than refused (ADR-0031 C10).
      inputSchema: z.object(pairingLinkInputShape).strict(),
      outputSchema: pairingLinkOutputSchema,
    },
    async (rawArgs) => {
      if (pairing === undefined) {
        // Registered on every transport/mode too (so tools/list stays one
        // authoritative list), but not every caller has a daemon origin to
        // embed in the link — refuse with the reason-specific remedy rather
        // than one message that only fits one of the three cases.
        throw new Error(PAIRING_UNAVAILABLE_MESSAGES[unavailableReason])
      }

      const args = pairingLinkInputSchema.parse(rawArgs)

      // Cross-field guard: raw-shape registration cannot express this as a
      // schema refinement (registerToolWithAnnotations requires
      // z.ZodRawShape), so it is enforced here, before any daemon
      // interaction.
      if (args.path !== undefined && args.workspaceId === undefined) {
        throw new Error('wb_pairing_link_create: workspaceId is required when path is set')
      }

      const webOrigin = args.webOrigin ?? resolveEnvWebOrigin() ?? DEFAULT_PRODUCTION_WEB_ORIGIN

      const payload = daemonConnectionPayloadSchema.parse({
        // Normalize to a bare origin: a trailing slash (or any
        // non-normalized form) in the daemon's baseUrl would fail the
        // strict shared schema and turn a valid daemon into a tool error.
        baseUrl: new URL(pairing.daemonBaseUrl).origin,
        workspaceId: args.workspaceId,
        path: args.path,
        fullscreen: args.fullscreen,
      })

      const fragment = encodeBase64UrlText(JSON.stringify(payload))
      const url = `${webOrigin}/#wb=${fragment}`

      const result: z.infer<typeof pairingLinkOutputSchema> = { url, webOrigin }
      // Deliberately NOT structuredJsonResult(result): that helper emits
      // only the bare structuredContent JSON as content[0].text, which is
      // the one place a caller (or a transcript relaying this call's
      // output) actually sees the minted link. The allowlist advice has to
      // travel with the URL on every call, not just once in the static
      // tool description.
      return {
        structuredContent: result,
        content: [
          {
            type: 'text' as const,
            text: buildPairingLinkText(
              result,
              webOrigin,
              resolveAllowedWebOrigins(pairing.allowedWebOrigins),
            ),
          },
        ],
      }
    },
  )
}
