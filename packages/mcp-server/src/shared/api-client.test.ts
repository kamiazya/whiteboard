import { describe, expect, it } from 'vitest'
import { readRuntimeConfig, runtimeConfigSchema } from './api-client.js'

describe('runtimeConfigSchema', () => {
  it('accepts a valid daemonToken string', () => {
    expect(runtimeConfigSchema.parse({ daemonToken: 'abc' })).toEqual({ daemonToken: 'abc' })
  })

  it('accepts a null daemonToken', () => {
    expect(runtimeConfigSchema.parse({ daemonToken: null })).toEqual({ daemonToken: null })
  })

  it('rejects a non-string, non-null daemonToken', () => {
    expect(() => runtimeConfigSchema.parse({ daemonToken: 42 })).toThrow()
  })
})

describe('readRuntimeConfig', () => {
  it('falls back to a null daemonToken when window is not defined', () => {
    expect(readRuntimeConfig()).toEqual({ daemonToken: null })
  })

  it('falls back to a null daemonToken when the injected global fails schema validation', () => {
    const fakeWindow = {
      location: { origin: 'http://localhost' },
      __WHITEBOARD_RUNTIME_CONFIG__: { daemonToken: 42 },
    }
    ;(globalThis as { window?: unknown }).window = fakeWindow
    try {
      expect(readRuntimeConfig()).toEqual({ daemonToken: null })
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })

  it('returns the injected daemonToken when it passes schema validation', () => {
    const fakeWindow = {
      location: { origin: 'http://localhost' },
      __WHITEBOARD_RUNTIME_CONFIG__: { daemonToken: 'seeded-token' },
    }
    ;(globalThis as { window?: unknown }).window = fakeWindow
    try {
      expect(readRuntimeConfig()).toEqual({ daemonToken: 'seeded-token' })
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })
})
