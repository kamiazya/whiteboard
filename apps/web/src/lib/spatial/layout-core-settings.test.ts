import { describe, expect, it } from 'vitest'
import { coreSettingsFrom } from './layout-core-settings.js'

describe('coreSettingsFrom', () => {
  it('routes in Rust in a production build', () => {
    expect(coreSettingsFrom({ DEV: false, MODE: 'production' })).toEqual({
      impl: 'rust',
      mismatch: 'log',
    })
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
