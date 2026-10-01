import { describe, expect, it } from 'vitest'
import { factsCacheFor } from '../references/content-source.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { vectorCacheFor } from './document-vector-cache.js'

describe('caches held by the deps', () => {
  it('answers the same facts and vector cache for one deps, and its own for another', () => {
    const deps = makeTestDeps()
    expect(factsCacheFor(deps)).toBe(factsCacheFor(deps))
    expect(vectorCacheFor(deps)).toBe(vectorCacheFor(deps))
    expect(vectorCacheFor(deps).facts).toBe(factsCacheFor(deps))

    const other = makeTestDeps()
    expect(factsCacheFor(other)).not.toBe(factsCacheFor(deps))
    expect(vectorCacheFor(other)).not.toBe(vectorCacheFor(deps))
  })
})
