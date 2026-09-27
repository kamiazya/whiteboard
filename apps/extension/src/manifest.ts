/**
 * The extension's Manifest V3, as data so a test can hold it. The build
 * writes it next to the service worker.
 * https://developer.chrome.com/docs/extensions/reference/manifest
 */

/**
 * The public half of the key the extension id is derived from, so a build
 * loaded by hand has the id the native host's manifest allows. The private
 * half is not kept: a store signs what it publishes.
 */
const EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnUvZtXWvNjLEOfD+ohEovcqQUeLSMkkASGgA/vrhRDMMLuLrc38I1X371rgYutJ/RfjncF/NKxx4YVavgVl5R2s7LJutdfukxUIlLF8628Nv3S3oQOOh1GgRlDRragxtdTx8PLM5Tb+JH7mW928IxSwnVY3nEE/JXMlPxrb1KI9t8xj2b+zpt1dnPoLPbrU2hSMrOqgVrfjfA7u+AeusPt1Yrng+x+P7pxEogCbcepzf24/njM5BRyT5vmT+LwvckSNDwONV5eN1Of78arQCbj+OTaf5ZoM3jVsvVY6ZbMoQp1gkMxmK/34OcIo1sjokh/noQbcDchwLGlDrJS+6HQIDAQAB'

const HOSTED_APP = 'https://kamiazya-whiteboard.pages.dev/*'

/** Development servers; never in a build meant for everyday use. */
const DEVELOPMENT_PAGES = ['http://localhost/*', 'http://127.0.0.1/*']

export type BuildMode = 'production' | 'development'

export function manifestFor(mode: BuildMode) {
  return {
    manifest_version: 3,
    name: 'Whiteboard',
    description: 'Connects the whiteboard app to the whiteboard daemon on this computer.',
    version: '0.0.1',
    key: EXTENSION_KEY,
    permissions: ['nativeMessaging'],
    background: { service_worker: 'background.js', type: 'module' },
    externally_connectable: {
      matches: mode === 'development' ? [HOSTED_APP, ...DEVELOPMENT_PAGES] : [HOSTED_APP],
    },
  }
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
