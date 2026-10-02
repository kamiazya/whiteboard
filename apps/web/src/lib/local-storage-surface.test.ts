// @vitest-environment node
/**
 * `localStorage` is touched in ONE module, `safe-local-storage.ts`.
 *
 * The guard around it was written seven ways: two identical
 * `safeGetItem`/`safeSetItem` pairs, three hand-rolled try/catch blocks that
 * each remembered a different half of what can throw, and two sites that
 * reached for `window.localStorage` bare — where a browser that blocks storage
 * raises on the property itself, before any method is called. A bare access
 * compiles, passes every test that runs in a browser which allows storage, and
 * fails only on the device that blocks it.
 *
 * Source comes from `?raw`, not `node:fs`: apps/web is browser-only and
 * `web-app-boundary.test.ts` enforces it.
 */
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob(
  ['../**/*.ts', '../**/*.tsx', '!../**/*.test.*', '!../test-utils/**'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>

/** The one module that may touch it, and the reason. Paths are relative to this file. Both-sided below. */
const ALLOWLIST: Readonly<Record<string, string>> = {
  './safe-local-storage.ts': 'the guarded accessor itself',
}

const ACCESS = /\blocalStorage\s*\??\.\s*(?:getItem|setItem|removeItem|clear|key|length)\b/

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

const touching = Object.entries(sources)
  .filter(([, source]) => ACCESS.test(withoutComments(source)))
  .map(([path]) => path)
  .sort()

describe('localStorage is reached through one guarded module', () => {
  it('reads a tree worth scanning', () => {
    // An empty glob agrees with every rule; the count is what keeps it honest.
    expect(Object.keys(sources).length, 'the ?raw glob matched almost nothing').toBeGreaterThan(300)
  })

  it('recognises each way a bare access is spelled', () => {
    for (const spelling of [
      'localStorage.getItem(k)',
      'window.localStorage.setItem(k, v)',
      'globalThis.localStorage?.getItem(k)',
      'localStorage .removeItem(k)',
    ]) {
      expect(ACCESS.test(spelling), spelling).toBe(true)
    }
    expect(ACCESS.test('const localStorageKey = 1')).toBe(false)
  })

  it('no module outside the allowlist touches localStorage directly', () => {
    expect(
      touching.filter((path) => ALLOWLIST[path] === undefined),
      'import safeGetItem / safeSetItem / safeRemoveItem from lib/safe-local-storage.ts: a bare access throws on a browser that blocks storage',
    ).toEqual([])
  })

  it('every allowlist entry still touches localStorage', () => {
    expect(
      Object.keys(ALLOWLIST).filter((path) => !touching.includes(path)),
      'an entry that outlives its access is how an allowlist stops being read',
    ).toEqual([])
  })
})
