/**
 * The hosted app's origin is spelled by three packages that cannot import one
 * another, so nothing but this test makes them one value.
 *
 * - the extension's manifest admits the page that may message it
 *   (`externally_connectable`), as a match pattern;
 * - the web app's origin policy names the one origin it treats as production;
 * - the daemon opens it in a browser on first run.
 *
 * Each is pinned by its own package's literal, so a rename of the deployment
 * that updates two of the three still passes every one of those tests, and
 * what breaks is the third surface: an extension that refuses the page it was
 * built for, or a daemon that opens a host nobody serves. The `index.html`
 * `og:url` carries the same origin and rides along, since it too is a copy.
 *
 * Read as text: the three live in a root that may not import the others
 * (`architecture-map.md` rule 2), and one is a `.html`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

interface Spelling {
  readonly label: string
  readonly file: string
  /** One capture group: the quoted value, in the shape that file writes it. */
  readonly pattern: RegExp
}

const SPELLINGS: readonly Spelling[] = [
  {
    label: 'extension manifest match pattern',
    file: 'apps/extension/src/manifest.ts',
    pattern: /const HOSTED_APP = '([^']+)'/,
  },
  {
    label: 'web origin policy (origin)',
    file: 'apps/web/src/lib/pages-origin-policy.ts',
    pattern: /export const PROVISIONAL_PRODUCTION_ORIGIN = '([^']+)'/,
  },
  {
    label: 'web origin policy (pages domain)',
    file: 'apps/web/src/lib/pages-origin-policy.ts',
    pattern: /const PAGES_DOMAIN = '([^']+)'/,
  },
  {
    label: 'daemon auto-open URL',
    file: 'packages/mcp-server/src/cli/daemon-run-auto-open.ts',
    pattern: /const OFFICIAL_HOSTED_APP_URL = '([^']+)'/,
  },
  {
    label: 'index.html og:url',
    file: 'apps/web/index.html',
    pattern: /<meta property="og:url" content="([^"]+)"/,
  },
]

/** `https://host/*` (a match pattern), `https://host/`, `https://host` and a bare `host` all name one host. */
function hostOf(value: string): string {
  const withScheme = value.includes('://') ? value : `https://${value}`
  return new URL(withScheme.replace(/\/\*$/, '/')).host
}

const found = SPELLINGS.map((spelling) => {
  const match = spelling.pattern.exec(readFileSync(join(REPO_ROOT, spelling.file), 'utf8'))
  return { ...spelling, value: match?.[1] }
})

describe('the hosted app origin is one value', () => {
  it('finds every spelling it exists to compare', () => {
    // A pattern that stopped matching would drop its spelling from the
    // comparison below and read as agreement.
    expect(
      found.filter(({ value }) => value === undefined).map(({ label }) => label),
      'a spelling was renamed or reshaped — update its pattern here',
    ).toEqual([])
  })

  it('has every spelling name the same host', () => {
    const hosts = found.map(({ label, value }) => ({ label, host: hostOf(value as string) }))
    const distinct = new Set(hosts.map(({ host }) => host))
    expect(
      [...distinct],
      `the hosted app is spelled with more than one host:\n${JSON.stringify(hosts, null, 2)}`,
    ).toHaveLength(1)
  })

  it('has every spelling that carries a scheme use https', () => {
    // A downgraded scheme in the extension's pattern would admit a page an
    // attacker can serve over plain http.
    const insecure = found
      .filter(({ value }) => (value as string).includes('://'))
      .filter(({ value }) => !(value as string).startsWith('https://'))
    expect(insecure.map(({ label }) => label)).toEqual([])
  })
})
