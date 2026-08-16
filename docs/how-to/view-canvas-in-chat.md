# View a canvas inline in your AI chat (MCP Apps)

> **Partly available.** `canvas_view` is wired back up to the widget resource, so
> the inline view works again. The **Add a sticky note** control described near the
> bottom of this page does not: it calls an `annotate` tool that the OpenCanvas
> migration removed and nothing has replaced. Everything else on this page reflects
> what ships today.

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

> **Not currently working.** The control below calls the `annotate` tool, which the
> OpenCanvas migration removed; nothing has replaced it, so submitting a note fails.
> The description is kept because the widget control itself still ships.

On the same clients that show Refresh (host connected and `serverTools`
advertised), the widget also shows a small text field with an **Add** button
in the top-left corner. Typing a note and submitting it calls the `annotate`
tool through the host to add a `box_with_label` sticky note to the canvas,
placed automatically so it does not overlap existing elements, then
refreshes the view so the new note appears. This is **append-only** — there
is no in-widget way to edit or remove an existing note or any other element;
use the full editor or the `annotate` / other canvas tools directly for that.
The field is disabled while a note is being added and re-enabled once the
follow-up refresh completes.

## What you do not get (yet)

This is **Phase A** of MCP Apps support:

- Beyond adding a new sticky note as described above, the view is
  **read-only** — Refresh reloads the current scene, but there is no
  in-widget editing, moving, or deleting of existing elements.
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
