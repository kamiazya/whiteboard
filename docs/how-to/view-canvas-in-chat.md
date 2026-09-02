# View a canvas inline in your AI chat (MCP Apps)

> **Available, comments included.** `canvas_view` renders inline, Refresh
> re-reads the document through the host, and you can comment on the canvas:
> click a spot (or a node), type, and the comment is pinned there through
> `wb_canvas_edit` — and, on hosts that support it, delivered straight into
> the conversation so the agent responds to it. Everything on this page
> reflects what ships today.

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
re-invokes `canvas_view` for the same document through the host (using the workspace
and document ids the result echoed) and swaps in the latest scene — you do not need
to leave the chat or call the tool again by hand. On clients that do not advertise
`serverTools`, or when the widget cannot confirm a host connection at all, the button
never appears; call `canvas_view` again to see a fresh snapshot instead.

## Commenting on the canvas from the widget

Behind the same gate as Refresh, the widget shows a comment field. **Click the
canvas** to pick the spot the comment is about — clicking inside a node pins
the comment to that node, so it follows the node if the agent later moves it —
then type and press **Comment**. The widget writes one `comment.add` through
`wb_canvas_edit`, and the comment renders as an amber pin with a floating
bubble on every surface that shows the canvas (this widget, the web app,
exports). The submit button stays disabled until a spot is picked, because a
comment is about a place.

Where the host also advertises the MCP Apps `message` capability, the widget
then injects the comment into the conversation as a message from you — so the
agent sees the feedback immediately and can act on it, instead of noticing it
on its next read of the canvas. On hosts without that capability the comment
still lands in the document; the agent picks it up whenever it next reads the
board (`wb_canvas_snapshot` carries comments).

A refused or failed write keeps your text and spot for retry; they clear only
once the comment is committed. This is the widget's ONE write — everything
else stays read-only, and the only tools it can ever call through the host
are `canvas_view` and this comment.

## What you do not get (yet)

This is **Phase A** of MCP Apps support:

- The view is **read-only apart from commenting**. Refresh reloads the
  current document, but there is no in-widget editing, moving, or deleting of
  existing content — and no in-widget resolving of comments yet (an agent
  resolves them with a `comment.resolve` op).
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
  "arguments": { "workspaceId": "<workspaceId>", "documentId": "<document id>" }
}
```

The result's `structuredContent` carries `{ workspaceId, documentId, scene, references }`, where
`references` maps each file node's reference to its resolved `{ label?, body? }` and
`scene` is a
shape the canvas-viewer package's `parseViewerScene` accepts, so a supporting client
renders it immediately. On a client without MCP Apps support, you see this JSON as
the tool result instead of an inline view.

← Back to [How-to guides](README.md)
