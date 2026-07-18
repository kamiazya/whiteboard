// Static complement to the Playwright network-interception smoke: a build
// could still ship a broken widget that never actually fires the flagged
// request (dead code, conditional branch) and the runtime zero-network
// assertion would pass anyway. Grepping the built HTML for
// resource-loading positions closes that gap.
// Only `src=`/`href=`/`url()` are resource-loading positions. This
// deliberately does NOT match `xmlns="http://..."` (an SVG namespace
// declaration, not a fetch) or http(s) strings inside comments/text nodes
// (e.g. a license URL) — those never trigger a network request.
const RESOURCE_ATTR_PATTERN = /(?:src|href)\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi
const CSS_URL_PATTERN = /url\(\s*(["']?)(https?:\/\/[^"')]+)\1\s*\)/gi

// Excalidraw's own minified bundle assigns these as literal
// `.src = "https://…"` strings for its optional tweet/reddit embed feature
// (an `iframe`/`script` element type a scene CAN request, not something the
// bundle fetches at rest). They match the resource-attribute pattern above
// as a byproduct of grepping compiled JS text rather than a DOM tree, so
// they need an explicit allowlist rather than a smarter parser.
export const DEFAULT_INERT_URL_ALLOWLIST: ReadonlySet<string> = new Set([
  'https://platform.twitter.com/widgets.js',
  'https://embed.reddit.com/widgets.js',
])

export function findExternalResourceUrls(
  html: string,
  allowlist: ReadonlySet<string> = DEFAULT_INERT_URL_ALLOWLIST,
): string[] {
  const found = new Set<string>()
  for (const pattern of [RESOURCE_ATTR_PATTERN, CSS_URL_PATTERN]) {
    for (const url of matchAll(html, pattern)) {
      if (!allowlist.has(url)) found.add(url)
    }
  }
  return [...found]
}

function matchAll(html: string, pattern: RegExp): string[] {
  const urls: string[] = []
  for (const match of html.matchAll(pattern)) {
    const url = match[2]
    if (url) urls.push(url)
  }
  return urls
}
