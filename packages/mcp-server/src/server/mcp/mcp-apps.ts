import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { getLogger } from '../log.js'
import { WHITEBOARD_ROOT } from '../config.js'

// Re-exported so callers (tool-registration.ts, tests) share one import
// source for the MCP Apps (SEP-1865, io.modelcontextprotocol/ui) wire
// constants instead of reaching into the ext-apps package directly.
export { EXTENSION_ID, RESOURCE_MIME_TYPE }

// _meta key ext-apps' registerAppTool normalizes `_meta.ui.resourceUri`
// into for backward compatibility with older hosts. Tool registrations in
// this codebase set `_meta.ui.resourceUri` directly (the preferred,
// non-deprecated form) rather than this legacy key.
export const RESOURCE_URI_META_KEY = 'ui/resourceUri'

// Canonical ui:// resource for the Phase-A read-only canvas view widget.
// Registered once and linked from tool _meta.ui.resourceUri; the widget
// itself is the self-contained bundle built by
// packages/canvas-viewer's `build:widget` script and copied into this
// package's dist by scripts/copy-widget-into-dist.mjs at build time.
export const CANVAS_VIEW_RESOURCE_URI = 'ui://whiteboard/canvas-view'

// Resolved relative to WHITEBOARD_ROOT (the package root, not this source
// file) so the same path works from ts-node/tsx (dev, src/) and from the
// compiled dist/ layout — see DIST_WEB_APP_DIR in config.ts for the same
// pattern with apps/web's bundle.
export const WIDGET_HTML_PATH = resolve(WHITEBOARD_ROOT, 'dist/widget/canvas-viewer.html')

let activeWidgetHtmlPath = WIDGET_HTML_PATH
let cachedWidgetHtml: string | undefined

// Reads and caches the widget HTML at module scope. A per-request McpServer
// (the HTTP /mcp handler constructs one per request) must not re-read this
// ~8.5 MB file from disk on every resources/read call, and the read is
// async so the first request never blocks the event loop on it. Only a
// successful read is cached — a missing file stays retryable (e.g. a build
// finishing after the daemon started).
async function readWidgetHtml(): Promise<string> {
  if (cachedWidgetHtml !== undefined) return cachedWidgetHtml
  try {
    cachedWidgetHtml = await readFile(activeWidgetHtmlPath, 'utf-8')
  } catch (err) {
    getLogger('mcp-apps').error(
      { path: activeWidgetHtmlPath, err },
      'canvas-viewer widget HTML missing — run `pnpm build` (packages/canvas-viewer build:widget + copy-widget-into-dist.mjs) before serving ui://whiteboard/canvas-view',
    )
    // The raw fs error message embeds WIDGET_HTML_PATH, the server's
    // absolute install path — the MCP SDK surfaces this error verbatim to
    // the calling client, so re-throw a generic message instead. The
    // detailed path already reached the structured log above.
    throw new Error('widget asset unavailable')
  }
  return cachedWidgetHtml
}

// Test-only hook: clears the module-scope cache and optionally redirects
// reads at a temp fixture path. Tests must pass an override instead of
// writing to the real WIDGET_HTML_PATH — deleting the genuine build output
// in an afterEach breaks any later same-machine smoke run that expects the
// built widget to still exist.
export function resetWidgetHtmlCacheForTests(overridePath?: string): void {
  cachedWidgetHtml = undefined
  activeWidgetHtmlPath = overridePath ?? WIDGET_HTML_PATH
}

// Declares MCP Apps (SEP-1865) support and registers the ui:// resource
// referenced by UI-linked tools' `_meta.ui.resourceUri`. Called once per
// McpServer instance (both stdio and per-request HTTP /mcp transports),
// mirroring how registerAllTools is invoked in index.ts.
export function registerMcpAppsExtension(server: McpServer): void {
  // The extensions capability field exists on ServerCapabilitiesSchema but
  // is not yet part of the SDK's typed capabilities options accepted by
  // the McpServer/Server constructor, so it is declared via the
  // low-level Server's registerCapabilities() instead of the constructor.
  server.server.registerCapabilities({
    extensions: { [EXTENSION_ID]: {} },
  })

  server.registerResource(
    'whiteboard-canvas-view',
    CANVAS_VIEW_RESOURCE_URI,
    {
      title: 'Whiteboard canvas view',
      description:
        'Read-only interactive Excalidraw canvas view rendered inline in the chat. Pan/zoom/select a scene snapshot; no daemon credentials are ever passed into the widget.',
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: CANVAS_VIEW_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readWidgetHtml(),
        },
      ],
    }),
  )
}
