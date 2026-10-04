// @vitest-environment node
import { describe, expect, it } from 'vitest'

/**
 * No-credential invariant: the page holds no daemon credential (the extension
 * relays its requests and the daemon authenticates the connection, not the
 * request), so nothing in apps/web may set an `Authorization` header. One
 * appearing here would be a credential the page was never meant to carry,
 * readable by any script on its origin.
 *
 * Sources are captured via Vite's build-time `import.meta.glob` (raw text),
 * mirroring canvas-render's import-guard.test.ts pattern, so this scans
 * every production source under apps/web/src without a runtime fs read.
 */
const sourceModules = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

/**
 * Deliberately broad: a header name is case-insensitive (Fetch spec) and can
 * reach a request through `set`/`append`, an object literal, a computed key,
 * or `Headers` array entries — under any receiver name. Rather than enumerate
 * call shapes and keep losing that race, these match the *name* wherever it
 * appears, quoted or as a bare key.
 *
 * The cost is that a source file cannot write the quoted string
 * `'Authorization'` in a comment without tripping the guard. That trade is
 * intentional: a tripwire that is easy to walk around protects nothing.
 */
const AUTHORIZATION_HEADER_PATTERNS: readonly RegExp[] = [
  // Any quoted header-name literal: set/append arguments, computed keys,
  // Headers array entries, quoted object keys.
  /['"]authorization['"]/i,
  // A bare object-literal key: { Authorization: ... } / { authorization: ... }
  /\bauthorization\s*:/i,
]

// '.test.' also covers '.browser.test.' and '.property.browser.test.'.
function isProductionSource(path: string): boolean {
  return !path.includes('.test.') && !path.includes('.stories.')
}

describe('apps/web sets no Authorization header', () => {
  const productionSources = Object.entries(sourceModules).filter(([path]) =>
    isProductionSource(path),
  )

  it('scans at least one production source file', () => {
    expect(productionSources.length).toBeGreaterThan(0)
  })

  it.each(productionSources)('%s does not set an Authorization header', (path, contents) => {
    for (const pattern of AUTHORIZATION_HEADER_PATTERNS) {
      expect(
        pattern.test(contents),
        `${path} matched an Authorization-header pattern (${pattern}) — the page holds no daemon credential`,
      ).toBe(false)
    }
  })

  /**
   * The scan above can only fail when a real violation exists, so a pattern
   * that misses a setter form would go unnoticed until the day it mattered.
   * These samples make that weakening fail immediately instead.
   *
   * Header names are case-insensitive per the Fetch spec, and the `Headers`
   * constructor accepts array entries — so `new Headers([['authorization',
   * token]])` attaches the credential just as effectively as `headers.set`,
   * under a receiver this guard never sees.
   */
  it.each([
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string IS the code shape under test
    ['headers.set, canonical case', "headers.set('Authorization', `Bearer ${token}`)"],
    ['headers.append', "headers.append('Authorization', value)"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string IS the code shape under test
    ['object literal', 'fetch(url, { headers: { Authorization: `Bearer ${token}` } })'],
    ['computed key', "h['Authorization'] = value"],
    ['lowercase name', "headers.set('authorization', value)"],
    ['arbitrary receiver', "h.set('Authorization', value)"],
    ['Headers from array entries', "new Headers([['authorization', token]])"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string IS the code shape under test
    ['Headers from object', 'new Headers({ authorization: `Bearer ${token}` })'],
  ])('the guard catches %s', (_form, sample) => {
    const matched = AUTHORIZATION_HEADER_PATTERNS.some((pattern) => pattern.test(sample))
    expect(matched, `no pattern matched: ${sample}`).toBe(true)
  })

  it('the guard does not fire on an unrelated header', () => {
    const sample = "headers.set('Content-Type', 'application/json')"
    expect(AUTHORIZATION_HEADER_PATTERNS.some((pattern) => pattern.test(sample))).toBe(false)
  })
})
