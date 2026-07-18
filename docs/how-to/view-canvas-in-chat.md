# View a canvas inline in your AI chat (MCP Apps)

Whiteboard's local daemon MCP server implements the [MCP Apps extension](https://github.com/modelcontextprotocol/ext-apps)
(`io.modelcontextprotocol/ui`, spec 2026-01-26). When your MCP client supports it, calling
the `canvas_view` tool renders an interactive canvas view directly inside the chat —
no need to switch to a browser tab to see what the agent drew.

## What you get

- A read-only, pan/zoom/select view of the current canvas scene, rendered inline.
- The same self-contained Excalidraw viewer bundle used for
  [self-contained HTML export](../explanation/) — no daemon credentials, tokens, or
  base URLs are ever passed into the widget. The widget only ever receives a scene
  snapshot — the canvas elements plus any embedded image binaries — nothing else.
- Zero external network access: the widget bundle is fully self-contained (fonts and
  all Excalidraw assets are inlined), so the client's CSP for the view can stay at its
  strictest default.

## What you do not get (yet)

This is **Phase A** of MCP Apps support:

- The view is **read-only**. There is no in-widget editing, annotation, or refresh
  button yet — call `canvas_view` again to see a fresh snapshot.
- Only `canvas_view` renders inline. `canvas_open` (opens the full editor in a real
  browser tab) and `export_canvas` (writes a file) are intentionally **not**
  UI-linked — `canvas_open` would need to pass the daemon's base URL into the widget,
  and `export_canvas` has a file-write side effect that a UI "refresh" action should
  never trigger silently.
- Live sync (the view updating as the agent keeps drawing, without calling the tool
  again) is a future phase.

## Requirements

- A local daemon connection (see [Connect to a local daemon](connect-to-local-daemon.md)).
- An MCP client that implements the MCP Apps extension. As of this writing that
  includes Claude Desktop, VS Code (Copilot), Goose, Postman, and MCPJam — check your
  client's own documentation, since host support varies. Clients without MCP Apps
  support still get `canvas_view`'s JSON result as plain structured content; they just
  will not render the inline widget.

## Using it

Ask your agent to view the canvas, or call the tool directly:

```json
{
  "name": "canvas_view",
  "arguments": { "canvasId": "<workspaceId>/<slug>" }
}
```

The result's `structuredContent` is `{ canvasId, scene: { elements } }` — the same
shape the canvas-viewer package's `parseViewerScene` accepts, so a supporting client
renders it immediately. On a client without MCP Apps support, you see this JSON as
the tool result instead of an inline view.

← Back to [How-to guides](README.md)
