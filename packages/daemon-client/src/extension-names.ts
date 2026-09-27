/**
 * The two names the browser checks when the whiteboard extension starts its
 * native host (ADR-0050). Apart from the bridge's schemas so the extension,
 * which relays without reading, carries no validator it never runs.
 */

/** The native messaging host's name, as the browser looks it up. */
export const NATIVE_HOST_NAME = 'io.github.kamiazya.whiteboard'

/** The extension's id, fixed by the public key in its manifest. */
export const WHITEBOARD_EXTENSION_ID = 'ckgipndlpblkhiplhnbbdnpnibflplje'

/** The Firefox build's id, which Firefox takes from the manifest as written. */
export const WHITEBOARD_GECKO_ID = 'whiteboard@kamiazya.github.io'

/**
 * Firefox lets no page message an extension directly, so a content script
 * relays between the page's window and the extension; this names the
 * messages that belong to that relay.
 */
export const WINDOW_BRIDGE_CHANNEL = 'whiteboard-extension-bridge'
