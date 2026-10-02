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
 * The version of the frames the page, the extension and the native host
 * exchange. The three are released separately, so a page cannot assume the
 * extension beside it was built from the same schemas; the extension says
 * which it speaks when asked whether it is installed, and the page refuses to
 * use one it does not match. Raise it when a frame changes in a way an
 * older reader would misread rather than strip.
 */
export const BRIDGE_PROTOCOL_VERSION = 1

/**
 * Firefox lets no page message an extension directly, so a content script
 * relays between the page's window and the extension; this names the
 * messages that belong to that relay.
 */
export const WINDOW_BRIDGE_CHANNEL = 'whiteboard-extension-bridge'
