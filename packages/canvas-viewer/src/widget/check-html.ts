// Static complement to the Playwright network-interception smoke: a build
// could still ship a broken widget that never actually fires the flagged
// request (dead code, conditional branch) and the runtime zero-network
// assertion would pass anyway. Grepping the built HTML for
// resource-loading positions closes that gap.
//
// Inline <script> BODIES are stripped before scanning: compiled JS text
// legitimately contains URL string constants (e.g. Excalidraw's optional
// tweet/reddit embed feature assigns `.src = "https://…"` at runtime) that
// are not resource-loading positions in the DOCUMENT. Tag attributes —
// including a genuine `<script src="https://…">` — live on the tag itself,
// which is kept, so this is strictly safer than a URL allowlist (which
// would also have suppressed a real external tag for the same URL).
const SCRIPT_BODY_PATTERN = /(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi

// `src=`/`href=` in quoted OR unquoted attribute form, and CSS `url()`,
// are resource-loading positions. This deliberately does NOT match
// `xmlns="http://..."` (an SVG namespace declaration, not a fetch) or
// http(s) strings inside comments/text nodes (e.g. a license URL) — those
// never trigger a network request.
const QUOTED_ATTR_PATTERN = /(?:src|href)\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi
const UNQUOTED_ATTR_PATTERN = /(?:src|href)\s*=\s*(https?:\/\/[^\s"'>]+)/gi
const CSS_URL_PATTERN = /url\(\s*(["']?)(https?:\/\/[^"')]+)\1\s*\)/gi

export function findExternalResourceUrls(html: string): string[] {
  // Keep the tags themselves (attributes stay scannable); drop only the
  // raw-text bodies.
  const withoutScriptBodies = html.replace(SCRIPT_BODY_PATTERN, '$1$2')
  const found = new Set<string>()
  for (const match of withoutScriptBodies.matchAll(QUOTED_ATTR_PATTERN)) {
    if (match[2]) found.add(match[2])
  }
  for (const match of withoutScriptBodies.matchAll(UNQUOTED_ATTR_PATTERN)) {
    if (match[1]) found.add(match[1])
  }
  for (const match of withoutScriptBodies.matchAll(CSS_URL_PATTERN)) {
    if (match[2]) found.add(match[2])
  }
  return [...found]
}
