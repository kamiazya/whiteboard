import { describe, expect, it } from 'vitest'
import { coreSourcePlugin } from './vite-plugin-core-source.js'

type Load = (id: string) => string | undefined
type Env = Record<string, string | boolean>
interface Shipping {
  readonly artifactStaged?: boolean
  readonly ship?: string
}

/** The plugin as vite builds it: told the resolved config's env, then asked to load. */
function loadOf(env: Env, shipping: Shipping = {}): Load {
  const plugin = coreSourcePlugin({
    artifactStaged: () => shipping.artifactStaged ?? false,
    ship: shipping.ship,
  })
  ;(plugin.configResolved as (config: { env: Env }) => void)({ env })
  return plugin.load as Load
}
const PRODUCTION = { DEV: false, MODE: 'production' }

const SOURCE = '/repo/apps/web/src/lib/spatial/layout-core-source.ts'

describe('coreSourcePlugin', () => {
  it('replaces the module that names the wasm with a stub in a build that routes in TypeScript', () => {
    const stub = loadOf(PRODUCTION)(SOURCE)
    expect(stub).toBeDefined()
    expect(stub).not.toContain('core-wasm')
    expect(stub).toContain('export')
  })

  it('also catches the module when asked for by a query', () => {
    expect(loadOf(PRODUCTION)(`${SOURCE}?worker_file`)).toBeDefined()
  })

  it.each([
    'differential',
    'rust',
  ])('leaves the module alone when the build asks for %s', (impl) => {
    expect(loadOf({ ...PRODUCTION, VITE_WHITEBOARD_CORE: impl })(SOURCE)).toBeUndefined()
  })

  it('leaves the module alone in the dev server, which runs the core beside TypeScript', () => {
    expect(loadOf({ DEV: true, MODE: 'development' })(SOURCE)).toBeUndefined()
  })

  it('keeps the real module in a build that routes in TypeScript once the artifact is staged, so a release ships the wasm', () => {
    expect(loadOf(PRODUCTION, { artifactStaged: true })(SOURCE)).toBeUndefined()
  })

  it('still stubs when the build is told not to ship the wasm, whatever is staged', () => {
    expect(loadOf(PRODUCTION, { artifactStaged: true, ship: '0' })(SOURCE)).toBeDefined()
  })

  it('refuses to build a release that is to ship the wasm when none is staged', () => {
    expect(() => loadOf(PRODUCTION, { artifactStaged: false, ship: '1' })).toThrow(
      /WHITEBOARD_SHIP_CORE_WASM/,
    )
  })

  it('leaves every other module alone', () => {
    expect(loadOf(PRODUCTION)('/repo/apps/web/src/lib/spatial/layout-core.ts')).toBeUndefined()
  })
})
