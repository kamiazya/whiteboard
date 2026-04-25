import { describe, it, expect } from 'vitest'
import { buildSpawnArgs } from './spawn-args.js'

const defaults = {
  serverPath: '/abs/src/server/index.ts',
  port: 3099,
  tsxBin: '/abs/node_modules/.bin/tsx',
}

describe('buildSpawnArgs - production mode (default)', () => {
  it('starts with node + tsx/esm loader when WHITEBOARD_DEV is unset', () => {
    const result = buildSpawnArgs({ env: {}, ...defaults })
    expect(result.command).toBe('node')
    expect(result.args).toEqual([
      '--import',
      'tsx/esm',
      '/abs/src/server/index.ts',
      '--port=3099',
    ])
  })

  it('treats WHITEBOARD_DEV="0" as production', () => {
    const result = buildSpawnArgs({ env: { WHITEBOARD_DEV: '0' }, ...defaults })
    expect(result.command).toBe('node')
    expect(result.args).toContain('--import')
    expect(result.args).not.toContain('watch')
  })

  it('treats WHITEBOARD_DEV="true" and any non-"1" value as production', () => {
    const result = buildSpawnArgs({ env: { WHITEBOARD_DEV: 'true' }, ...defaults })
    expect(result.command).toBe('node')
    expect(result.args).not.toContain('watch')
  })

  it('treats WHITEBOARD_DEV="" as production', () => {
    const result = buildSpawnArgs({ env: { WHITEBOARD_DEV: '' }, ...defaults })
    expect(result.command).toBe('node')
    expect(result.args).not.toContain('watch')
  })
})

describe('buildSpawnArgs - development mode (WHITEBOARD_DEV=1)', () => {
  it('starts with node --watch + tsx/esm when WHITEBOARD_DEV="1"', () => {
    const result = buildSpawnArgs({ env: { WHITEBOARD_DEV: '1' }, ...defaults })
    expect(result.command).toBe('node')
    expect(result.args).toEqual([
      '--watch',
      '--import',
      'tsx/esm',
      '/abs/src/server/index.ts',
      '--port=3099',
    ])
  })

  it('still passes serverPath and --port in dev mode', () => {
    const result = buildSpawnArgs({ env: { WHITEBOARD_DEV: '1' }, ...defaults })
    expect(result.args).toContain('/abs/src/server/index.ts')
    expect(result.args).toContain('--port=3099')
  })

  it('stringifies the numeric port as --port=XXXX', () => {
    const result = buildSpawnArgs({
      env: { WHITEBOARD_DEV: '1' },
      ...defaults,
      port: 4242,
    })
    expect(result.args).toContain('--port=4242')
  })
})
