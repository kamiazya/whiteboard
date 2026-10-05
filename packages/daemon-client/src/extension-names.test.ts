import { describe, expect, it } from 'vitest'
import { BRIDGE_PROTOCOL_VERSION } from './extension-names.js'

describe('BRIDGE_PROTOCOL_VERSION', () => {
  // The page, the extension and the native host ship separately, and every
  // test of the handshake reads this constant on both sides, so a change to
  // its value passes them all while every installed extension stops being
  // accepted. Raising it is a protocol break; this is where it is decided.
  it('is 1, the version an installed extension and native host speak', () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(1)
  })
})
