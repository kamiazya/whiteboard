import { describe, expect, it } from 'vitest'
import { coreSourcePlugin } from './vite-plugin-core-source.js'

type Load = (id: string) => string | undefined
type Env = Record<string, string | boolean>
interface Shipping {
  readonly artifactStaged?: boolean
  readonly ship?: string
}

/** The plugin as vite builds it: told the resolved config's env, then asked to load. */
function loadOf(env: Env, shipping: Shipping = {}, command = 'build'): Load {
  const plugin = coreSourcePlugin({
    artifactStaged: () => shipping.artifactStaged ?? false,
    ship: shipping.ship,
  })
  ;(plugin.configResolved as (config: { env: Env; command: string }) => void)({ env, command })
  return plugin.load as Load
}
const PRODUCTION = { DEV: false, MODE: 'production' }
const TYPESCRIPT = { ...PRODUCTION, VITE_WHITEBOARD_CORE: 'ts' }

const SOURCE = '/repo/apps/web/src/lib/spatial/layout-core-source.ts'

describe('coreSourcePlugin', () => {
  it('replaces the module that names the wasm with a stub in a build that opted out to TypeScript', () => {
    const stub = loadOf(TYPESCRIPT)(SOURCE)
    expect(stub).toBeDefined()
    expect(stub).not.toContain('core-wasm')
    expect(stub).toContain('export')
  })

  it('also catches the module when asked for by a query', () => {
    expect(loadOf(TYPESCRIPT)(`${SOURCE}?worker_file`)).toBeDefined()
  })

  it.each([
    ['the default', PRODUCTION],
    ['differential', { ...PRODUCTION, VITE_WHITEBOARD_CORE: 'differential' }],
    ['rust', { ...PRODUCTION, VITE_WHITEBOARD_CORE: 'rust' }],
  ])('leaves the module alone when the build routes with %s and the artifact is staged', (_, env) => {
    expect(loadOf(env, { artifactStaged: true })(SOURCE)).toBeUndefined()
  })

  it.each([
    ['the default', PRODUCTION],
    ['differential', { ...PRODUCTION, VITE_WHITEBOARD_CORE: 'differential' }],
    ['rust', { ...PRODUCTION, VITE_WHITEBOARD_CORE: 'rust' }],
  ])('fails a build that routes with %s when no artifact is staged, instead of stubbing it', (_, env) => {
    expect(() => loadOf(env, { artifactStaged: false })).toThrow(/VITE_WHITEBOARD_CORE=ts/)
  })

  it('fails a build told to leave the wasm out while it routes with the core', () => {
    expect(() => loadOf(PRODUCTION, { artifactStaged: true, ship: '0' })).toThrow(
      /WHITEBOARD_SHIP_CORE_WASM=0/,
    )
  })

  it('does not require the artifact of the dev server, which falls back to TypeScript per call', () => {
    expect(loadOf({ DEV: true, MODE: 'development' }, {}, 'serve')(SOURCE)).toBeUndefined()
  })

  it('keeps the real module in an opted-out build once the artifact is staged, so the wasm still ships', () => {
    expect(loadOf(TYPESCRIPT, { artifactStaged: true })(SOURCE)).toBeUndefined()
  })

  it('still stubs an opted-out build told not to ship the wasm, whatever is staged', () => {
    expect(loadOf(TYPESCRIPT, { artifactStaged: true, ship: '0' })(SOURCE)).toBeDefined()
  })

  it('refuses to build a release that is to ship the wasm when none is staged', () => {
    expect(() => loadOf(TYPESCRIPT, { artifactStaged: false, ship: '1' })).toThrow(
      /WHITEBOARD_SHIP_CORE_WASM/,
    )
  })

  it('leaves every other module alone', () => {
    expect(loadOf(TYPESCRIPT)('/repo/apps/web/src/lib/spatial/layout-core.ts')).toBeUndefined()
  })
})
