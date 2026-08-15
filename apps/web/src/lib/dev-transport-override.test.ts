import { afterEach, describe, expect, it } from 'vitest'
import { DEV_TRANSPORT_OVERRIDE_KEY, devTransportOverride } from './dev-transport-override.js'

afterEach(() => window.localStorage.clear())

describe('devTransportOverride', () => {
  it('is absent when nothing has asked for one', () => {
    expect(devTransportOverride()).toBeUndefined()
  })

  it('answers with the transport a developer pinned', () => {
    window.localStorage.setItem(DEV_TRANSPORT_OVERRIDE_KEY, 'sse')
    expect(devTransportOverride()).toBe('sse')
    window.localStorage.setItem(DEV_TRANSPORT_OVERRIDE_KEY, 'websocket')
    expect(devTransportOverride()).toBe('websocket')
  })

  it('ignores a value that is not a transport', () => {
    // A typo has to read as "no override" rather than as a third transport
    // nothing downstream handles — the failure would land far from the typo.
    window.localStorage.setItem(DEV_TRANSPORT_OVERRIDE_KEY, 'SSE')
    expect(devTransportOverride()).toBeUndefined()
    window.localStorage.setItem(DEV_TRANSPORT_OVERRIDE_KEY, 'true')
    expect(devTransportOverride()).toBeUndefined()
  })

  // That the override cannot exist in a PRODUCTION bundle is not testable
  // here — `import.meta.env.DEV` is true under vitest, which is what lets the
  // cases above run at all. The guarantee is the build folding that constant
  // to `false` and eliminating the reader, and it is asserted where it can be:
  // `scripts/smoke-artifact.mjs` fails if this key appears anywhere in dist/.
})
