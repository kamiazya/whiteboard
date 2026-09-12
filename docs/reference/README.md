# Reference

Information-oriented and precise. Reference describes *what is* — configuration keys, file
formats, and contracts — without tutorials' hand-holding or explanation's reasoning. Reach for
it when you already know what you are doing and need exact details.

Reference pages:

- **[configuration](configuration.md)** — runtime environment variables and storage layout.
- **[keyboard shortcuts](keyboard-shortcuts.md)** — every canvas-editor binding and its pointer equivalent.
- **[export formats](export-formats.md)** — OKF Markdown / JSON Canvas via `wb_document_get`, SVG via `wb_scene_render`.
- **[what a JSON Canvas export costs](json-canvas-loss.md)** — every field position the model can hold, and which of them the format states, rounds, carries on `x-whiteboard`, or cannot take. Generated from the projection itself.
- **[what an OCIF export costs](ocif-loss.md)** — the same positions measured against [OCIF v0.7.0](https://spec.canvasprotocol.org/). Read beside the table above: nothing is dropped here, and where the two disagree is where the choice of format costs a reader something. Generated from the projection itself.
- **MCP tools** — the tools the MCP server exposes (entry point to the live `tools/list`) _(planned)_.

← Back to [documentation home](../)
