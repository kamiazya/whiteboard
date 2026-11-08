import { describe, expect, it } from 'vitest'
import { coreSourcePlugin } from './vite-plugin-core-source.js'

type Load = (id: string) => string | undefined
type Env = Record<string, string | boolean>

/** The plugin as vite builds it: told the resolved config's env, then asked to load. */
function loadOf(env: Env): Load {
  const plugin = coreSourcePlugin()
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

  it('leaves every other module alone', () => {
    expect(loadOf(PRODUCTION)('/repo/apps/web/src/lib/spatial/layout-core.ts')).toBeUndefined()
  })
})
