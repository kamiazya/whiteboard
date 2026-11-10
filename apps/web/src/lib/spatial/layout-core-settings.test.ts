import { describe, expect, it } from 'vitest'
import { coreSettingsFrom } from './layout-core-settings.js'

describe('coreSettingsFrom', () => {
  it('routes in Rust in a production build', () => {
    expect(coreSettingsFrom({ DEV: false, MODE: 'production' })).toEqual({
      impl: 'rust',
      spatial: 'rust',
      mismatch: 'log',
    })
  })

  it('reads JSON Canvas in Rust in a build, differential in the dev server, TypeScript in a test run', () => {
    expect(coreSettingsFrom({ DEV: false, MODE: 'production' }).spatial).toBe('rust')
    expect(
      coreSettingsFrom({ DEV: false, MODE: 'production', VITE_WHITEBOARD_CORE_SPATIAL: 'ts' })
        .spatial,
    ).toBe('ts')
    expect(coreSettingsFrom({ DEV: true, MODE: 'test' }).spatial).toBe('ts')
    expect(coreSettingsFrom({ DEV: true, MODE: 'development' }).spatial).toBe('differential')
    expect(
      coreSettingsFrom({ DEV: true, MODE: 'test', VITE_WHITEBOARD_CORE_SPATIAL: 'differential' })
        .spatial,
    ).toBe('differential')
    expect(
      coreSettingsFrom({ DEV: false, MODE: 'production', VITE_WHITEBOARD_CORE_SPATIAL: 'rust' })
        .spatial,
    ).toBe('rust')
    expect(() => coreSettingsFrom({ VITE_WHITEBOARD_CORE_SPATIAL: 'fast' })).toThrow()
  })

  it('has no OKF switch left, so a variable that once set one changes nothing', () => {
    const retired = { DEV: false, MODE: 'production', VITE_WHITEBOARD_CORE_OKF: 'ts' }
    expect(coreSettingsFrom(retired)).not.toHaveProperty('okf')
  })

  it('runs both routings beside each other in the dev server', () => {
    expect(coreSettingsFrom({ DEV: true, MODE: 'development' }).impl).toBe('differential')
  })

  it('stays on TypeScript under a test run unless the run asks for the core', () => {
    expect(coreSettingsFrom({ DEV: true, MODE: 'test' }).impl).toBe('ts')
    expect(coreSettingsFrom({ DEV: true, MODE: 'test', VITE_WHITEBOARD_CORE: 'rust' }).impl).toBe(
      'rust',
    )
  })

  it('lets the environment override either default', () => {
    expect(
      coreSettingsFrom({ DEV: false, MODE: 'production', VITE_WHITEBOARD_CORE: 'differential' })
        .impl,
    ).toBe('differential')
    expect(
      coreSettingsFrom({ DEV: true, MODE: 'development', VITE_WHITEBOARD_CORE: 'ts' }).impl,
    ).toBe('ts')
    expect(
      coreSettingsFrom({ DEV: false, MODE: 'production', VITE_WHITEBOARD_CORE: 'ts' }).impl,
    ).toBe('ts')
  })

  it('reads the mismatch policy, defaulting to log', () => {
    expect(coreSettingsFrom({ VITE_WHITEBOARD_CORE_MISMATCH: 'throw' }).mismatch).toBe('throw')
    expect(coreSettingsFrom({ VITE_WHITEBOARD_CORE_MISMATCH: '' }).mismatch).toBe('log')
  })

  it('refuses a value it does not know, so a typo cannot compare nothing', () => {
    expect(() => coreSettingsFrom({ VITE_WHITEBOARD_CORE: 'diferential' })).toThrow()
    expect(() => coreSettingsFrom({ VITE_WHITEBOARD_CORE_MISMATCH: 'warn' })).toThrow()
  })
})
