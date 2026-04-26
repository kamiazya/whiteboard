# Template Fragment JSON Format

`template_insert` can load either a built-in `templateId` or an external JSON file. It is **not** Excalidraw native-library compatible. Instead, it uses a lightweight template format that reuses `annotate_batch` recipes, so inserted elements remain normally editable on the canvas.

## Schema

```json
{
  "format": "excalidraw-tool-template",
  "version": 1,
  "id": "service-fragment",
  "title": "Service Fragment",
  "description": "Reusable architecture part",
  "variables": [
    { "name": "service", "default": "API" },
    { "name": "store", "default": "DB" }
  ],
  "annotations": [
    {
      "type": "box_with_label",
      "name": "service",
      "target": { "x": 0, "y": 40 },
      "width": 180,
      "height": 84,
      "text": "{{service}}"
    },
    {
      "type": "box_with_label",
      "name": "store",
      "target": { "x": 260, "y": 40 },
      "width": 180,
      "height": 84,
      "text": "{{store}}"
    },
    {
      "type": "arrow",
      "startBoxName": "service",
      "endBoxName": "store",
      "label": "read/write"
    }
  ]
}
```

## Constraints and behavior

- **Coordinate mode** — Each annotation omits `coords`, which means default `absolute` mode. Template coordinates are treated as offsets from the insertion `target`. `relative` and `parent` are reserved for future support.
- **No group memberIds** — `group.memberIds` refer to real element IDs on an existing canvas, so writing them into a template is meaningless. They are not interpolation or scaling targets.
- **Variable expansion** — `{{variable}}` placeholders expand inside string fields such as `text`, `subText`, `title`, `label`, `name`, `startBoxName`, and `endBoxName`. Binding names themselves can be parameterized (e.g. `name: "{{id}}-box"`), which works well with the binding-name DSL for multiple instances.
- **Silent expansion of undeclared variables** — Variables passed through `variables` that are not declared in the template definition are still expanded. Typos are not detected. Be careful.
- **`scale` semantics** — `scale` applies to `target`, `endTarget`, `width`, `height`, `padding`, `labelOffset`, and `layout.cellW,cellH,gap,origin`. It does **not** apply to `row` or `col`, which are grid indexes.

## Why a custom format

The format reuses `annotate_batch`'s recipes (boxes, arrows, frames, groups, layouts) directly, so a template insert and a regular agent annotation produce structurally identical elements on the canvas. There is no special "template object" — the inserted elements are normal Excalidraw shapes that the user and the agent can keep editing.

For Excalidraw's native library format (`.excalidrawlib`), use the canvas itself plus `canvas_export_json` to round-trip with excalidraw.com or the desktop app.
