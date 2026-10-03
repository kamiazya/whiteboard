/**
 * ADR-0050: the extension is the only thing that may start the native host,
 * and the hosted app is the only thing that may reach the extension. Both
 * sides of that are written in the manifest.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  WHITEBOARD_EXTENSION_ID,
  WHITEBOARD_GECKO_ID,
} from '@kamiazya/whiteboard-daemon-client/extension-names'
import { describe, expect, it } from 'vitest'
import { admitsOrigin, admittedMatches, firefoxManifestFor, manifestFor } from './manifest.js'

/** Chromium's extension id: the first 32 hex digits of the key's SHA-256, spelled a-p. */
function extensionIdOf(key: string): string {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('')
}

// The page quotes this version when it reports a bridge skew, so it must be
// the one the extension's package declares, not a copy that stops moving.
describe('the version both builds stamp', () => {
  const declared = (
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
  ).version

  it('is the extension package version', () => {
    expect(manifestFor('production').version).toBe(declared)
    expect(firefoxManifestFor('production').version).toBe(declared)
  })

  // Both browsers accept one to four dot-separated integers and no more.
  it('is a version a browser accepts', () => {
    expect(declared).toMatch(/^\d+(\.\d+){0,3}$/)
  })
})

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

// Firefox lets no page message an extension, so its build reaches the page
// through a content script instead — injected into the same pages Chromium
// admits, and nowhere else.
describe('firefoxManifestFor', () => {
  it('carries the id the host manifest names', () => {
    expect(firefoxManifestFor('production').browser_specific_settings.gecko.id).toBe(
      WHITEBOARD_GECKO_ID,
    )
  })

  // The content script's hosts are granted at install only from the ESR that
  // introduced it, so an older minimum would install an extension that cannot
  // reach the page.
  it('requires a Firefox that grants a content script its hosts at install', () => {
    const minimum =
      firefoxManifestFor('production').browser_specific_settings.gecko.strict_min_version
    expect(Number.parseInt(minimum, 10)).toBeGreaterThanOrEqual(128)
  })

  it('relays through a content script on the pages the Chromium build admits', () => {
    for (const mode of ['production', 'development'] as const) {
      const manifest = firefoxManifestFor(mode)
      expect(manifest.content_scripts).toEqual([
        {
          matches: manifestFor(mode).externally_connectable.matches,
          js: ['content.js'],
          run_at: 'document_start',
        },
      ])
      expect(manifest.permissions).toEqual(['nativeMessaging'])
      expect(manifest).not.toHaveProperty('externally_connectable')
      expect(manifest).not.toHaveProperty('key')
    }
  })
})

describe('admittedMatches', () => {
  it('reads the list the browser enforces, in either build', () => {
    expect(admittedMatches(manifestFor('development'))).toEqual(
      manifestFor('development').externally_connectable.matches,
    )
    expect(admittedMatches(firefoxManifestFor('development'))).toEqual(
      manifestFor('development').externally_connectable.matches,
    )
    expect(admittedMatches({})).toEqual([])
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
