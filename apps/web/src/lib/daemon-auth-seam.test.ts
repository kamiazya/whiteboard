import { describe, expect, it } from 'vitest'

/**
 * Single-seam invariant: `createDaemonFetch` in daemon-api-client.ts is the
 * ONLY code path allowed to attach an `Authorization` header toward the
 * daemon origin. Centralizing it here (rather than scattering it across
 * call sites, as the now-removed reconnect-client.ts once did) is what
 * keeps a future browser-extension proxy (the safe way to bring back
 * unattended reconnect — extension storage is scoped to the extension ID,
 * not a squattable web origin) a one-file swap instead of an audit of
 * every fetch call in the app.
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

const ALLOWED_SETTER = './daemon-api-client.ts'

const AUTHORIZATION_HEADER_PATTERNS: readonly RegExp[] = [
  // headers.set('Authorization', ...) / headers.append('Authorization', ...)
  /headers\s*\.\s*(set|append)\s*\(\s*['"]Authorization['"]/,
  // { Authorization: ... } as a headers object literal
  /\bAuthorization\s*:/,
  // ['Authorization'] as a computed/object key
  /\[\s*['"]Authorization['"]\s*\]/,
]

function isProductionSource(path: string): boolean {
  return !path.includes('.test.') && !path.includes('.browser.test.') && !path.includes('.stories.')
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

  it('mutation-check: the allowed setter itself matches the guarded pattern', () => {
    const contents = sourceModules[ALLOWED_SETTER]
    expect(contents).toBeDefined()
    const matches = AUTHORIZATION_HEADER_PATTERNS.some((pattern) => pattern.test(contents ?? ''))
    expect(matches, 'expected daemon-api-client.ts to still set Authorization').toBe(true)
  })
})
