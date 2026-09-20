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
  // Per-response nonce for the single <style> block. The page ships
  // `default-src 'none'`, so a stylesheet needs an explicit grant; a nonce
  // keeps that grant to this one response instead of blanket
  // `style-src 'unsafe-inline'`. The caller must put the same value in the
  // CSP header, or the page renders unstyled rather than insecurely.
  styleNonce: string
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

// One stylesheet, sent inline under a per-response nonce. A local consent
// screen must render correctly with no network access of any kind — an
// external stylesheet would need `style-src` to admit an origin, and a page
// whose job is to explain a trust decision must not depend on a fetch that
// can fail or be tampered with.
const STYLES = `
:root { color-scheme: light dark; --fg:#111; --muted:#5b6169; --bg:#f4f5f7;
  --card:#fff; --line:#dfe2e6; --danger:#8a2b2b; --danger-bg:#fdf1f1; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e9eaec; --muted:#a2a8b0; --bg:#16181c; --card:#1e2126;
    --line:#31353c; --danger:#f0a8a8; --danger-bg:#2a1c1c; }
}
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; padding:2rem 1rem;
  background:var(--bg); color:var(--fg);
  font:16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width:100%; max-width:30rem; background:var(--card); border:1px solid var(--line);
  border-radius:14px; padding:1.75rem; box-shadow:0 1px 2px rgba(0,0,0,.05), 0 12px 32px rgba(0,0,0,.06); }
.eyebrow { margin:0 0 .35rem; font-size:.75rem; letter-spacing:.08em; text-transform:uppercase;
  color:var(--muted); }
h1 { margin:0 0 .5rem; font-size:1.4rem; line-height:1.25; overflow-wrap:anywhere; }
.origin { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
.lede { margin:0 0 1.25rem; color:var(--muted); font-size:.9rem; }
ul { margin:0 0 1.25rem; padding:0; list-style:none; border-top:1px solid var(--line); }
li { padding:.6rem .1rem; border-bottom:1px solid var(--line); font-size:.95rem; }
li.write::after { content:"can change your data"; float:right; font-size:.72rem; color:var(--danger);
  background:var(--danger-bg); border-radius:999px; padding:.1rem .5rem; }
.consequence { margin:0 0 1.5rem; font-size:.85rem; color:var(--muted); }
form { display:flex; gap:.6rem; }
button { flex:1; padding:.65rem 1rem; font:inherit; font-weight:600; font-size:.95rem;
  border-radius:9px; border:1px solid var(--line); background:transparent; color:var(--fg);
  cursor:pointer; transition:background .12s ease, border-color .12s ease; }
button:hover { background:var(--bg); }
button.primary { background:var(--fg); color:var(--card); border-color:var(--fg); }
button.primary:hover { opacity:.88; }
button:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
`

function pageShell(title: string, body: string, styleNonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style nonce="${escapeHtml(styleNonce)}">${STYLES}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`
}

// Scopes that let the grantee change something, as opposed to only read it.
// The consent screen calls these out visually: "read my documents" and "rewrite
// my documents" are not the same decision and must not look the same.
const WRITE_SCOPES: ReadonlySet<AuthScope> = new Set<AuthScope>([
  'canvas:write',
  'workspace:write',
  'versions:write',
  'files:write',
  'runtime:admin',
  'mcp:call',
])

export function renderApprovalPage(input: ApprovalPageInput): string {
  const { transactionId, csrfToken, view, styleNonce } = input
  const origin = relyingPartyOrigin(view.redirectUri)
  const scopeItems = view.scopes
    .map(
      (scope) =>
        `<li${WRITE_SCOPES.has(scope) ? ' class="write"' : ''}>${escapeHtml(SCOPE_COPY[scope])}</li>`,
    )
    .join('')

  const body = `
<p class="eyebrow">Authorization request</p>
<h1>Allow <span class="origin">${escapeHtml(origin)}</span> to use this whiteboard?</h1>
<p class="lede">It is asking for:</p>
<ul>${scopeItems}</ul>
<p class="consequence">Approving lets that site act on the data stored on this computer until you revoke it. Only approve if you opened it yourself, just now.</p>
<form method="post" action="/authorize/decision">
<input type="hidden" name="transaction_id" value="${escapeHtml(transactionId)}">
<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
<button type="submit" name="decision" value="deny" autofocus>Deny</button>
<button type="submit" name="decision" value="approve" class="primary">Approve</button>
</form>`

  return pageShell(`Authorize ${origin}`, body, styleNonce)
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

export function renderAuthorizeErrorPage(reason: AuthorizeErrorReason, styleNonce: string): string {
  const body = `
<p class="eyebrow">Authorization request</p>
<h1>This request was not granted</h1>
<p class="lede">${escapeHtml(ERROR_COPY[reason])}</p>`

  return pageShell('Authorization request failed', body, styleNonce)
}
