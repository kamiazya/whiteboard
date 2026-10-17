import { describe, expect, it } from 'vitest'
import {
  BRIDGE_PROTOCOL_VERSION,
  extensionIdForPage,
  WHITEBOARD_DEV_EXTENSION_ID,
  WHITEBOARD_EXTENSION_ID,
} from './extension-names.js'
import { HOSTED_APP_ORIGIN } from './hosted-app.js'

describe('BRIDGE_PROTOCOL_VERSION', () => {
  // The page, the extension and the native host ship separately, and every
  // test of the handshake reads this constant on both sides, so a change to
  // its value passes them all while every installed extension stops being
  // accepted. Raising it is a protocol break; this is where it is decided.
  it('is 1, the version an installed extension and native host speak', () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBe(1)
  })
})

describe('extensionIdForPage', () => {
  it('addresses the production build from the hosted app', () => {
    expect(extensionIdForPage(HOSTED_APP_ORIGIN, HOSTED_APP_ORIGIN)).toBe(WHITEBOARD_EXTENSION_ID)
  })

  // The production build admits no other page, so a loopback dev server or a
  // look-alike origin can only be answered by the development build.
  it.each([
    'http://localhost:5173',
    'http://127.0.0.1:4173',
    'https://pr-12.kamiazya-whiteboard.pages.dev',
    `${HOSTED_APP_ORIGIN}.evil.example`,
  ])('addresses the development build from %s', (origin) => {
    expect(extensionIdForPage(origin, HOSTED_APP_ORIGIN)).toBe(WHITEBOARD_DEV_EXTENSION_ID)
  })
})
