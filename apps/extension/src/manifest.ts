/**
 * The extension's Manifest V3, as data so a test can hold it. The build
 * writes it next to the service worker.
 * https://developer.chrome.com/docs/extensions/reference/manifest
 */
import {
  WHITEBOARD_DEV_GECKO_ID,
  WHITEBOARD_GECKO_ID,
} from '@kamiazya/whiteboard-daemon-client/extension-names'
import { HOSTED_APP_ORIGIN } from '@kamiazya/whiteboard-daemon-client/hosted-app'
import { version } from '../package.json' with { type: 'json' }

/**
 * The public half of the key the extension id is derived from, so a build
 * loaded by hand has the id the native host's manifest allows. The private
 * half is not kept: a store signs what it publishes.
 */
const EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnUvZtXWvNjLEOfD+ohEovcqQUeLSMkkASGgA/vrhRDMMLuLrc38I1X371rgYutJ/RfjncF/NKxx4YVavgVl5R2s7LJutdfukxUIlLF8628Nv3S3oQOOh1GgRlDRragxtdTx8PLM5Tb+JH7mW928IxSwnVY3nEE/JXMlPxrb1KI9t8xj2b+zpt1dnPoLPbrU2hSMrOqgVrfjfA7u+AeusPt1Yrng+x+P7pxEogCbcepzf24/njM5BRyT5vmT+LwvckSNDwONV5eN1Of78arQCbj+OTaf5ZoM3jVsvVY6ZbMoQp1gkMxmK/34OcIo1sjokh/noQbcDchwLGlDrJS+6HQIDAQAB'

/**
 * The development build's own key, kept the same way. It must not derive the
 * production id: that build admits loopback pages, and a host installed for
 * everyday use allows the production id alone.
 */
const DEVELOPMENT_EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArc4RaaS8jwRhUFSepxIKc3B607yTOy3z/xK2DjENsYkCZp9kFlpqNKJMhz0/0Y1/k9W7vxyeUB9DeEGF0es2UFIX5thZ2Kvw2KEsl07qIOoYaXcQ5garUvzCy3TV7PzQH0xdyaWs2/nckziLvhXdV0Hxn4irkKE1DOClrG3DtiwM77ER50wJ+9NZqZ0M9hep7YWtqBezFQCPxQa2/7vg8SyBDOar9pT0/wtIoeSqgQ5iipOefOZMcMu7aTXAjmSuioioGz/z9ncnW1VEz9DqxuwzyFLTmg3olCLeDaN9gxZEU8tDCPwNyWZG8mLZjORz+u6nVmmdhmt/XUoM3CV+wwIDAQAB'

const HOSTED_APP = `${HOSTED_APP_ORIGIN}/*`

/** Development servers; never in a build meant for everyday use. */
const DEVELOPMENT_PAGES = ['http://localhost/*', 'http://127.0.0.1/*']

export type BuildMode = 'production' | 'development'

const admittedPages = (mode: BuildMode) =>
  mode === 'development' ? [HOSTED_APP, ...DEVELOPMENT_PAGES] : [HOSTED_APP]

export function manifestFor(mode: BuildMode) {
  return {
    manifest_version: 3,
    name: 'Whiteboard',
    description: 'Connects the whiteboard app to the whiteboard daemon on this computer.',
    version,
    key: mode === 'development' ? DEVELOPMENT_EXTENSION_KEY : EXTENSION_KEY,
    permissions: ['nativeMessaging'],
    background: { service_worker: 'background.js', type: 'module' },
    externally_connectable: { matches: admittedPages(mode) },
  }
}

/**
 * The Firefox build. Firefox lets no page message an extension, so a content
 * script on the admitted pages relays between the page and the background
 * script; Firefox takes the id from `gecko.id` rather than from a key.
 * https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings
 */
export function firefoxManifestFor(mode: BuildMode) {
  return {
    manifest_version: 3,
    name: 'Whiteboard',
    description: 'Connects the whiteboard app to the whiteboard daemon on this computer.',
    version,
    permissions: ['nativeMessaging'],
    background: { scripts: ['background.js'], type: 'module' },
    content_scripts: [
      { matches: admittedPages(mode), js: ['content.js'], run_at: 'document_start' },
    ],
    // 128 is the ESR that grants a content script's hosts at install.
    browser_specific_settings: {
      gecko: {
        id: mode === 'development' ? WHITEBOARD_DEV_GECKO_ID : WHITEBOARD_GECKO_ID,
        strict_min_version: '128.0',
      },
    },
  }
}

/** The part of a manifest that says which pages may reach the relay. */
export interface AdmittingManifest {
  externally_connectable?: { matches?: string[] }
  content_scripts?: Array<{ matches?: string[] }>
}

/** The pages this build admits, read from whichever list its browser enforces. */
export function admittedMatches(manifest: AdmittingManifest): string[] {
  return (
    manifest.externally_connectable?.matches ??
    manifest.content_scripts?.flatMap((script) => script.matches ?? []) ??
    []
  )
}

/**
 * Whether a page's origin is one `matches` admits. Chromium already refuses
 * any other page a connection; this is the relay's own check of the same
 * list. A match pattern names no port, so neither does the comparison.
 * https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
 */
export function admitsOrigin(matches: readonly string[], origin: string | undefined): boolean {
  if (origin === undefined) return false
  let page: URL
  try {
    page = new URL(origin)
  } catch {
    return false
  }
  return matches.some((pattern) => {
    const allowed = new URL(pattern.replace(/\/\*$/, '/'))
    return allowed.protocol === page.protocol && allowed.hostname === page.hostname
  })
}
