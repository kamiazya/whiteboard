import { afterEach, describe, expect, it, vi } from 'vitest'
import { openOnSingleActivation } from './open-on-single-activation.js'

const stubPointer = (coarse: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: coarse && query.includes('coarse') }))

afterEach(() => vi.unstubAllGlobals())

describe('openOnSingleActivation', () => {
  it('selects on a single activation with a fine pointer', () => {
    stubPointer(false)
    expect(openOnSingleActivation()).toBe(false)
    expect(openOnSingleActivation('mouse')).toBe(false)
  })

  it('opens on a single activation when the primary pointer is coarse', () => {
    stubPointer(true)
    expect(openOnSingleActivation()).toBe(true)
  })

  it('opens on a touch event even where the primary pointer is fine', () => {
    stubPointer(false)
    expect(openOnSingleActivation('touch')).toBe(true)
  })
})
