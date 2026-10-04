// Every prefix the web app's service worker refuses to answer with the app
// shell must be one the server answers itself.
//
// The denylist keeps a navigation to a server route (`/api/...`, `/mcp`) from
// being replaced by `index.html` offline. An entry the server no longer serves
// does nothing but suggest a route exists: `/ws` outlived the WebSocket sync
// transport that gave it a meaning, because nothing compared the two lists.
// The server owns the reserved-prefix rule (`isReservedUiPath`), so its suite
// is where the web app's list is held against it; reading apps/web source from
// here is the same deliberate direction as `web-api-paths-mounted.test.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../../shared/test-utils/repo-root.js'
import { stripComments } from '../../shared/test-utils/strip-comments.js'
import { isReservedUiPath } from '../app-helpers.js'

/** The first path segment of each `/^\/<segment>(\/|$)/` entry in the denylist. */
function denylistPrefixes(optionsSource: string): string[] {
  const list = /navigateFallbackDenylist:\s*\[([^\]]*)\]/.exec(stripComments(optionsSource))
  return [...(list?.[1] ?? '').matchAll(/\/\^\\\/([\w.-]+)/g)].map((m) => `/${m[1]}`)
}

describe('the service worker navigateFallbackDenylist names only routes the server serves', () => {
  const source = readFileSync(join(repoRoot(), 'apps/web/vite-pwa-options.ts'), 'utf-8')
  const prefixes = denylistPrefixes(source)

  it('finds the denylist entries', () => {
    expect(prefixes).toEqual(expect.arrayContaining(['/api', '/mcp']))
  })

  it('reads the prefixes out of a regex-literal list, and nothing else', () => {
    expect(
      denylistPrefixes('x: { navigateFallbackDenylist: [/^\\/a(\\/|$)/, /^\\/b-c(\\/|$)/] }'),
    ).toEqual(['/a', '/b-c'])
    expect(denylistPrefixes('// navigateFallbackDenylist: [/^\\/a(\\/|$)/]')).toEqual([])
  })

  it('is reserved by the server, so a navigation there never falls through to the app shell', () => {
    const unserved = prefixes.filter((prefix) => !isReservedUiPath(prefix))
    expect(unserved, 'denylisted prefixes the server does not reserve').toEqual([])
  })
})
