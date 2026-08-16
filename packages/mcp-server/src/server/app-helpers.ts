import { decodeFrontiers, LoroDoc } from 'loro-crdt'
import { corruptStoredData } from './store/corrupt-stored-data.js'

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'unknown error'
}

export function shouldLogMcpHttpDebug(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCP_HTTP_DEBUG === '1'
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A floor, not a ceiling. This runs after every route, so `set`ting a header a
// route already chose would silently *downgrade* it — the OAuth approval page
// ships a `default-src 'none'` CSP that this baseline would otherwise replace
// with the far weaker frame-ancestors-only policy. Every header below is
// applied unconditionally except CSP, whose value is route-specific by nature.
export function setBaselineSecurityHeaders(headers: Headers): void {
  if (!headers.has('Content-Security-Policy')) {
    headers.set('Content-Security-Policy', "frame-ancestors 'none'")
  }
  headers.set('X-Frame-Options', 'DENY')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
}

// Serialize a value for inlining into a `<script>` body, escaping `<` so a
// value such as `</script>` cannot terminate the tag and inject markup. Tokens
// today are nanoid-generated (safe), but this keeps the path safe if
// user-controlled values are ever inlined here.
// https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements
export function toInlineScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

// Paths reserved for /api, /mcp, /ws, and .well-known routes must never
// fall through to the SPA catch-all: an unmatched request under one of
// these prefixes means "route not found", not "serve index.html".
export function isReservedUiPath(path: string): boolean {
  return (
    path === '/api' ||
    path.startsWith('/api/') ||
    path === '/mcp' ||
    path.startsWith('/mcp/') ||
    path === '/ws' ||
    path.startsWith('/ws/') ||
    path.startsWith('/.well-known/') ||
    path === '/token'
  )
}

// Minimal, honest placeholder served at server-mode's root. Server-mode has
// its own OAuth/JWT auth (see AsyncAuthStrategy) and no local-daemon bearer
// token; apps/web's provider model only knows browser-local and
// local-daemon-token auth, so injecting it here without a real token would
// serve a UI whose every request 401s. Point operators at the API/MCP
// surface instead until apps/web grows a server-mode-aware auth flow.
export const SERVER_MODE_PLACEHOLDER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Whiteboard (server mode)</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<h1>Whiteboard server</h1>
<p>This daemon is running in server mode, which does not serve the browser UI.</p>
<p>Use the HTTP API under <code>/api</code> or connect an MCP client to <code>/mcp</code>.</p>
</body>
</html>
`

export function extractInitializeDebugPayload(parsedBody: unknown) {
  if (!isJsonObject(parsedBody) || parsedBody.method !== 'initialize') {
    return null
  }
  const params = isJsonObject(parsedBody.params) ? parsedBody.params : {}
  const capabilities = isJsonObject(params.capabilities) ? params.capabilities : {}
  const clientInfo = isJsonObject(params.clientInfo) ? params.clientInfo : {}
  return {
    requestId: parsedBody.id ?? null,
    protocolVersion: params.protocolVersion ?? null,
    clientInfo: {
      name: clientInfo.name ?? null,
      version: clientInfo.version ?? null,
    },
    capabilities,
  }
}

export function decodeBranchTipOrThrow(
  workspaceId: string,
  path: string,
  branchName: string,
  tipFrontiersBase64: string,
) {
  try {
    return decodeFrontiers(new Uint8Array(Buffer.from(tipFrontiersBase64, 'base64')))
  } catch (error) {
    throw corruptStoredData(
      `${workspaceId}/branches/${path}.json#${branchName}.tipFrontiers`,
      `tipFrontiers could not be decoded (${errorMessage(error)})`,
    )
  }
}

export function checkoutCloneOrThrow(
  doc: LoroDoc,
  target: ReturnType<typeof decodeFrontiers>,
  location: string,
  detail: string,
): LoroDoc {
  const clone = LoroDoc.fromSnapshot(doc.export({ mode: 'snapshot' }))
  try {
    clone.checkout(target)
  } catch (error) {
    throw corruptStoredData(location, `${detail} (${errorMessage(error)})`)
  }
  return clone
}
