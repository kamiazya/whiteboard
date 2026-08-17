import { describe, expect, it } from 'vitest'

/**
 * Single-seam invariant: `createDaemonFetch` in daemon-api-client.ts is the
 * ONLY code path allowed to attach an `Authorization` header toward the
 * daemon origin. Centralizing it there keeps a browser-extension proxy — the
 * only place a persisted daemon credential can live safely, because extension
 * storage is scoped to the extension ID rather than to a web origin another
 * process can take over — a one-file swap instead of an audit of every fetch
 * call in the app.
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

const ALLOWED_SETTER = './daemon-auth-fetch.ts'

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

describe('daemon Authorization header single-seam guard', () => {
  const productionSources = Object.entries(sourceModules).filter(([path]) =>
    isProductionSource(path),
  )

  it('scans at least one production source file', () => {
    expect(productionSources.length).toBeGreaterThan(0)
  })

  it.each(productionSources)('%s does not set an Authorization header', (path, contents) => {
    if (path === ALLOWED_SETTER) return
    for (const pattern of AUTHORIZATION_HEADER_PATTERNS) {
      expect(
        pattern.test(contents),
        `${path} matched an Authorization-header pattern (${pattern}) — only ${ALLOWED_SETTER} may set this header`,
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

  it('mutation-check: the allowed setter itself matches the guarded pattern', () => {
    const contents = sourceModules[ALLOWED_SETTER]
    expect(contents).toBeDefined()
    const matches = AUTHORIZATION_HEADER_PATTERNS.some((pattern) => pattern.test(contents ?? ''))
    expect(matches, 'expected daemon-auth-fetch.ts to still set Authorization').toBe(true)
  })
})
