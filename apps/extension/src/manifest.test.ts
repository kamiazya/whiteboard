/**
 * ADR-0050: the extension is the only thing that may start the native host,
 * and the hosted app is the only thing that may reach the extension. Both
 * sides of that are written in the manifest.
 */
import { createHash } from 'node:crypto'
import { WHITEBOARD_EXTENSION_ID } from '@kamiazya/whiteboard-daemon-client/extension-names'
import { describe, expect, it } from 'vitest'
import { admitsOrigin, manifestFor } from './manifest.js'

/** Chromium's extension id: the first 32 hex digits of the key's SHA-256, spelled a-p. */
function extensionIdOf(key: string): string {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('')
}

describe('manifestFor', () => {
  // The native host's manifest allows exactly this id, so a key that drifted
  // from it would load an extension the host refuses to start for.
  it('carries the key the host manifest names', () => {
    expect(extensionIdOf(manifestFor('production').key)).toBe(WHITEBOARD_EXTENSION_ID)
  })

  it('lets only the hosted app reach it, and asks for nothing but native messaging', () => {
    const manifest = manifestFor('production')
    expect(manifest.externally_connectable.matches).toEqual([
      'https://kamiazya-whiteboard.pages.dev/*',
    ])
    expect(manifest.permissions).toEqual(['nativeMessaging'])
    expect(manifest).not.toHaveProperty('host_permissions')
    expect(manifest).not.toHaveProperty('content_scripts')
  })

  // A loopback page can be served by any user of the machine, and a preview
  // deployment is built from anybody's pull request; neither may reach a
  // daemon through a build meant for everyday use.
  it('admits a development server only in the development build', () => {
    expect(manifestFor('development').externally_connectable.matches).toEqual([
      'https://kamiazya-whiteboard.pages.dev/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ])
  })
})

describe('admitsOrigin', () => {
  const matches = manifestFor('development').externally_connectable.matches

  it('admits a listed page on any port, as a match pattern does', () => {
    expect(admitsOrigin(matches, 'https://kamiazya-whiteboard.pages.dev')).toBe(true)
    expect(admitsOrigin(matches, 'http://localhost:5173')).toBe(true)
  })

  it.each([
    'https://evil.example',
    'https://pr-12.kamiazya-whiteboard.pages.dev',
    'http://kamiazya-whiteboard.pages.dev',
    'https://localhost:5173',
    'not a url',
    undefined,
  ])('refuses %s', (origin) => {
    expect(admitsOrigin(matches, origin)).toBe(false)
  })
})
