/**
 * The hosted app's origin is spelled in ONE place, and this scan is the
 * executable half of that.
 *
 * Three parties must agree on it: the extension's manifest admits the page
 * that may message it (a match pattern), the web app's origin policy names
 * the one origin it treats as production, and the daemon opens it in a
 * browser on first run. A rename of the deployment that reached two of them
 * leaves an extension refusing the page it was built for, or a daemon opening
 * a host nobody serves. All three import `daemon-client`, so the value lives
 * there and each derives its own shape from it; what this scan finds is the
 * host spelled again by hand in code.
 *
 * Comments are not read: a comment naming the host as an example is not a
 * value anything acts on. `index.html`'s `og:url` cannot import, so it is the
 * one copy left, compared against the owner instead.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, relativeToRepo, SCAN_ROOTS } from './scan-roots.js'
import { isShippedPath, walkSourceFiles } from './source-scan.js'
import { stripComments } from './strip-comments.js'

/** Where the one spelling lives. Exempt by construction: it IS the place. */
const OWNER = 'packages/daemon-client/src/hosted-app.ts'

const sourceOf = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')

const ownerOrigin = /export const HOSTED_APP_ORIGIN = '([^']+)'/.exec(sourceOf(OWNER))?.[1]
const ownerHost = ownerOrigin === undefined ? undefined : new URL(ownerOrigin).host

/** Copies that cannot import the owner, each compared against it instead. */
const COPIES = [
  {
    label: 'index.html og:url',
    file: 'apps/web/index.html',
    pattern: /<meta property="og:url" content="([^"]+)"/,
  },
] as const

/**
 * Shipped source only. A smoke's preview host is a fixture that a move would
 * fail loudly, not a value that silently keeps working.
 */
const files = SCAN_ROOTS.flatMap((root) => walkSourceFiles(join(REPO_ROOT, root)))
  .map((path) => relativeToRepo(path))
  .filter(isShippedPath)

/** The code in `source`, comments removed, that spells `host`. */
function spellsHost(source: string, host: string, fileName?: string): boolean {
  // The plain search first: stripping parses the file, and almost none match.
  return source.includes(host) && stripComments(source, fileName).includes(host)
}

describe('the hosted app origin is spelled in one place', () => {
  it('reads the owner and a tree worth scanning', () => {
    // A renamed owner constant would leave nothing to look for, and every
    // file would pass a scan for `undefined`.
    expect(ownerOrigin, `${OWNER} no longer exports HOSTED_APP_ORIGIN as a literal`).toBeDefined()
    expect(ownerHost && spellsHost(sourceOf(OWNER), ownerHost)).toBe(true)
    expect(files.length).toBeGreaterThan(500)
    expect(files).toContain(OWNER)
    expect(files).toContain('apps/extension/src/manifest.ts')
  })

  it('no other shipped source spells the host', () => {
    const host = ownerHost as string
    const hits = files.filter((rel) => rel !== OWNER && spellsHost(sourceOf(rel), host, rel))
    expect(
      hits,
      `derive it from HOSTED_APP_ORIGIN (${OWNER}): a second spelling is one a rename misses`,
    ).toEqual([])
  })

  it('has every copy that cannot import name the owner host over https', () => {
    const found = COPIES.map(({ label, file, pattern }) => ({
      label,
      value: pattern.exec(sourceOf(file))?.[1],
    }))
    expect(found.filter(({ value }) => value === undefined).map(({ label }) => label)).toEqual([])
    for (const { label, value } of found) {
      const url = new URL(value as string)
      expect({ label, host: url.host, protocol: url.protocol }).toEqual({
        label,
        host: ownerHost,
        protocol: 'https:',
      })
    }
  })

  it('finds a spelling in code but not in a comment', () => {
    expect(spellsHost("const A = 'https://x.example/*'", 'x.example')).toBe(true)
    expect(spellsHost('// e.g. "x.example"\nconst A = 1', 'x.example')).toBe(false)
  })
})
