# View a canvas inline in your AI chat (MCP Apps)

> **Available, minus the sticky note.** `canvas_view` is wired back up to the widget
> resource, so the inline view works again. The add-a-sticky-note control is gone:
> it called an `annotate` tool the OpenCanvas migration removed, so every submission
> failed at the host while the control still looked live. Everything else on this
> page reflects what ships today.

Whiteboard's local daemon MCP server implements the [MCP Apps extension](https://github.com/modelcontextprotocol/ext-apps)
(`io.modelcontextprotocol/ui`, spec 2026-01-26). When your MCP client supports it, calling
the `canvas_view` tool renders an interactive canvas view directly inside the chat —
no need to switch to a browser tab to see what the agent drew.

## What you get

- A read-only view of the current canvas document, rendered inline.
- Its **file references resolved**: a node pointing at a markdown document in the
  same workspace shows that document's prose, and every reference is labelled with
  its readable name rather than its raw id. The widget has no store of its own, so
  the server resolves these and sends them in the tool result alongside the scene.
- The same self-contained viewer bundle used for
  [self-contained HTML export](../explanation/) — no daemon credentials, tokens, or
  base URLs are ever passed into the widget. The widget only ever receives the scene
  snapshot plus the resolved references above — nothing else.
- Zero external network access: the widget bundle is fully self-contained (fonts and
  every other asset are inlined), so the client's CSP for the view can stay at its
  strictest default.

## Refreshing the view

On clients whose MCP Apps host advertises the `serverTools` capability, the widget
shows a small **Refresh** button once the initial `canvas_view` result has loaded. It
re-invokes `canvas_view` for the same `canvasId` through the host and swaps in the
latest scene — you do not need to leave the chat or call the tool again by hand. On
clients that do not advertise `serverTools`, or when the widget cannot confirm a host
connection at all, the button never appears; call `canvas_view` again to see a fresh
snapshot instead.

## Adding a sticky note from the widget

Removed. The control called an `annotate` tool that no longer exists, so it could
only ever fail. Restoring it is not just re-wiring: OpenCanvas has no `annotate`
equivalent, and a sticky note is a `wb_node_add` of a text node — so it needs a
decision about whether this widget should mutate a document at all, given that it
is otherwise strictly read-only. See the `TODO(annotate)` note in
`packages/canvas-viewer/src/widget-entry.ts`.

## What you do not get (yet)

This is **Phase A** of MCP Apps support:

- The view is **read-only**. Refresh reloads the current document, but there is no
  in-widget editing, moving, or deleting.
- Only `canvas_view` is UI-linked. It is the sole tool whose registration carries
  `_meta.ui.resourceUri`; every other tool returns ordinary structured content. A
  tool that opened the full editor would have to pass the daemon's base URL into the
  widget, and an export tool has a file-write side effect a UI "refresh" should
  never trigger silently — so neither is a candidate for linking.
- Live sync (the view updating as the agent keeps drawing, without you or the widget
  calling the tool again) is a future phase.

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
  "arguments": { "workspaceId": "<workspaceId>", "canvasId": "<document id>" }
}
```

The result's `structuredContent` carries `{ canvasId, scene, references }`, where
`references` maps each file node's reference to its resolved `{ label?, body? }` and
`scene` is a
shape the canvas-viewer package's `parseViewerScene` accepts, so a supporting client
renders it immediately. On a client without MCP Apps support, you see this JSON as
the tool result instead of an inline view.

← Back to [How-to guides](README.md)
