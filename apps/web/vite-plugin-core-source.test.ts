import { describe, expect, it } from 'vitest'
import { coreSourcePlugin } from './vite-plugin-core-source.js'

interface Shipping {
  readonly artifactStaged?: boolean
  readonly ship?: string
}

/** The plugin as vite builds it: told the resolved config's command. */
function resolve(shipping: Shipping = {}, command = 'build'): void {
  const plugin = coreSourcePlugin({
    artifactStaged: () => shipping.artifactStaged ?? false,
    ship: shipping.ship,
  })
  ;(plugin.configResolved as (config: { command: string }) => void)({ command })
}

describe('coreSourcePlugin', () => {
  it('lets a build through once the artifact is staged', () => {
    expect(() => resolve({ artifactStaged: true })).not.toThrow()
  })

  it('fails a build when no artifact is staged, naming the step that stages it', () => {
    expect(() => resolve({ artifactStaged: false })).toThrow(/build:wasm/)
  })

  it('fails a release build that is to ship the wasm when none is staged', () => {
    expect(() => resolve({ artifactStaged: false, ship: '1' })).toThrow(/build:wasm/)
  })

  it('refuses a build told to leave the wasm out, whatever is staged', () => {
    expect(() => resolve({ artifactStaged: true, ship: '0' })).toThrow(
      /WHITEBOARD_SHIP_CORE_WASM=0/,
    )
  })

  it('does not require the artifact of the dev server', () => {
    expect(() => resolve({}, 'serve')).not.toThrow()
  })
})
