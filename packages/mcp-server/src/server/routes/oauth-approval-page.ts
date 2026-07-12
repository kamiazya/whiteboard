// Pure HTML renderers for the /authorize approval surface (ADR-0005).
//
// These functions take no request/response objects and perform no I/O —
// the route module (a later slice) owns cookies, status codes, and
// headers. Keeping the render pure makes the security-sensitive
// properties below (escaping, CSP-safe markup, default-deny ordering)
// assertable without spinning up an HTTP server.
//
// No inline JavaScript, no <script> tag: the route sends
// `script-src 'none'` and this page has to work under that policy, not
// merely avoid tripping it in a test.

import type { AuthScope } from '../security/auth-strategy.js'
import type { ApprovalView } from '../security/oauth-authz-transactions.js'

export interface ApprovalPageInput {
  transactionId: string
  csrfToken: string
  view: ApprovalView
}

// Every reason the /authorize route can refuse to redirect at all —
// an unregistered client or redirect_uri must never receive a
// Location header pointing anywhere, so those refusals render locally
// instead of bouncing through the (unverified) party's own callback.
export type AuthorizeErrorReason =
  | 'unknown_client'
  | 'redirect_uri_mismatch'
  | 'transaction_not_found'
  | 'rate_limited'
  // The approval POST failed its cross-site / double-submit checks. Rendered
  // rather than returned as a bare 403 so a user who hit it by navigating
  // oddly (stale tab, cleared cookies) is told what to do, not shown what
  // reads like a server bug.
  | 'csrf_check_failed'

// Human copy for every scope in the vocabulary. `Record<AuthScope, string>`
// makes omitting a scope here a compile error rather than a silent gap in
// what the consent screen discloses to the user.
const SCOPE_COPY: Record<AuthScope, string> = {
  'canvas:read': 'Read canvas content',
  'canvas:write': 'Modify canvas content',
  'workspace:read': 'Read workspace metadata',
  'workspace:write': 'Modify workspace metadata',
  'versions:read': 'Read version history',
  'versions:write': 'Create versions',
  'files:read': 'Read attached files',
  'files:write': 'Write files',
  'runtime:read': 'Read daemon runtime status',
  'runtime:admin': 'Administer the daemon runtime',
  'mcp:call': 'Call MCP tools',
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// The relying-party identity shown to the user is derived ONLY from the
// registered redirect_uri's origin — never from Origin, Referer, or any
// query parameter on the request, all of which are attacker-controlled
// inputs that must not influence what the user is told they're trusting.
function relyingPartyOrigin(redirectUri: string): string {
  return new URL(redirectUri).origin
}

function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
</head>
<body>
${body}
</body>
</html>`
}

export function renderApprovalPage(input: ApprovalPageInput): string {
  const { transactionId, csrfToken, view } = input
  const origin = relyingPartyOrigin(view.redirectUri)
  const scopeItems = view.scopes
    .map((scope) => `<li>${escapeHtml(SCOPE_COPY[scope])}</li>`)
    .join('')

  const body = `
<h1>Grant access to ${escapeHtml(origin)}?</h1>
<p><strong>${escapeHtml(view.clientId)}</strong> is requesting the following:</p>
<ul>${scopeItems}</ul>
<form method="post" action="/authorize/decision">
<input type="hidden" name="transaction_id" value="${escapeHtml(transactionId)}">
<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
<button type="submit" name="decision" value="deny" autofocus>Deny</button>
<button type="submit" name="decision" value="approve">Approve</button>
</form>`

  return pageShell(`Authorize ${origin}`, body)
}

const ERROR_COPY: Record<AuthorizeErrorReason, string> = {
  unknown_client: 'This application is not registered with this daemon.',
  redirect_uri_mismatch: 'The requested redirect address is not registered for this application.',
  transaction_not_found:
    'This approval request no longer exists, most likely because the daemon restarted. Start the authorization request again.',
  rate_limited: 'Too many authorization attempts. Please wait a minute and try again.',
  csrf_check_failed:
    'This approval could not be verified as coming from this page. Start the authorization request again.',
}

export function renderAuthorizeErrorPage(reason: AuthorizeErrorReason): string {
  const body = `
<h1>Authorization request failed</h1>
<p>${escapeHtml(ERROR_COPY[reason])}</p>`

  return pageShell('Authorization request failed', body)
}
