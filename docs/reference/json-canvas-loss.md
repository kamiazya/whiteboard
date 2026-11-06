<!-- Generated from packages/codec/src/spatial/projection.ts. Do not edit by hand:
     `pnpm vitest run --project codec-node loss-table -u` regenerates it. -->

# What a JSON Canvas export keeps, and what it costs

A whiteboard document is not a JSON Canvas file. JSON Canvas 1.0 is a **projection** of it
([ADR-0037](../contributing/adr/0037-model-and-format.md)), and first-party support means a
tested projection rather than an identity: a round-trip property over the expressible subset,
and this table for everything else.

The model can hold **50** field positions. **22** of them are something the format
can state; **28** reach a reader only through the single extension key, or not at all.

Two export modes, and the difference between them is exactly the `x-whiteboard` rows below:

- **`extended`** — JSON Canvas 1.0 plus the one extension key. Lossless over everything the key
  can hold. This is what `wb_document_get` emits by default.
- **`strict`** — plain JSON Canvas 1.0, the extension key removed entirely
  (`wb_document_get` with `options.strict: true`).

## Stated by JSON Canvas 1.0 — 17

Every reader of the format gets these, in both export modes. Nothing is lost and nothing needs the extension key.

| field | what a reader gets |
| --- | --- |
| `edges[].color` | survives both modes |
| `edges[].from.end` | survives both modes |
| `edges[].from.node` | survives both modes |
| `edges[].from.side` | survives both modes |
| `edges[].id` | survives both modes |
| `edges[].label` | survives both modes |
| `edges[].to.end` | survives both modes |
| `edges[].to.node` | survives both modes |
| `edges[].to.side` | survives both modes |
| `nodes[].background` | survives both modes |
| `nodes[].backgroundStyle` | survives both modes |
| `nodes[].color` | survives both modes |
| `nodes[].id` | survives both modes |
| `nodes[].label` | survives both modes |
| `nodes[].resource.content` | survives both modes |
| `nodes[].resource.location` | survives both modes |
| `nodes[].resource.subpath` | survives both modes |

## Stated, but not exactly — 5

The format has the field and cannot hold the value. What a reader gets instead is named per row; the document still draws in the right place.

| field | what a reader gets |
| --- | --- |
| `nodes[].height` | crosses as the nearest integer pixel |
| `nodes[].resource.mimeType` | crosses as the format's node kind |
| `nodes[].width` | crosses as the nearest integer pixel |
| `nodes[].x` | crosses as the nearest integer pixel |
| `nodes[].y` | crosses as the nearest integer pixel |

## Carried on `x-whiteboard` — 28

Survives the `extended` export and disappears from the `strict` one, which emits plain JSON Canvas 1.0. A reader that drops the key keeps the whole of what the format can state.

| field | what a reader gets |
| --- | --- |
| `edges[].bends[].x` | dropped by `strict` |
| `edges[].bends[].y` | dropped by `strict` |
| `edges[].facets/*` | dropped by `strict` |
| `edges[].tags[]` | dropped by `strict` |
| `facets/*` | dropped by `strict` |
| `lines[].bends[].x` | dropped by `strict` |
| `lines[].bends[].y` | dropped by `strict` |
| `lines[].color` | dropped by `strict` |
| `lines[].facets/*` | dropped by `strict` |
| `lines[].from.end` | dropped by `strict` |
| `lines[].from.kind` | dropped by `strict` |
| `lines[].from.node` | dropped by `strict` |
| `lines[].from.point.x` | dropped by `strict` |
| `lines[].from.point.y` | dropped by `strict` |
| `lines[].from.side` | dropped by `strict` |
| `lines[].id` | dropped by `strict` |
| `lines[].label` | dropped by `strict` |
| `lines[].to.end` | dropped by `strict` |
| `lines[].to.kind` | dropped by `strict` |
| `lines[].to.node` | dropped by `strict` |
| `lines[].to.point.x` | dropped by `strict` |
| `lines[].to.point.y` | dropped by `strict` |
| `lines[].to.side` | dropped by `strict` |
| `nodes[].embed.documentId` | dropped by `strict` |
| `nodes[].embed.versionRef` | dropped by `strict` |
| `nodes[].facets/*` | dropped by `strict` |
| `nodes[].tags[]` | dropped by `strict` |
| `tags[]` | dropped by `strict` |

## Cannot cross at all — 0

Named here so the absence is a decision rather than a surprise.

_None today._

## What this table does not cover

- **What is inside a facet bucket.** A `…/*` row is one entry because the format can say a bucket
  is present and nothing about its contents, and those contents belong to whichever plugins a
  deployment carries. Every one of them is lost in `strict`, whatever it is.
- **OKF Markdown.** This is the spatial side only. A markdown document round-trips through OKF
  preserving root keys this codebase does not model, which is a different promise made a
  different way.
- **`wb_scene_render`.** SVG is an explicitly lossy rendering, not a document format, and has
  never claimed otherwise.
- **The comments.** A conversation is the document’s annotation layer, kept beside its content
  rather than in it ([ADR-0026](../contributing/adr/0026-annotation-layer.md) decision 1b), so
  no export carries it, `extended` included, and it is not a field position here. A file an
  older version exported with `x-whiteboard.comments` is refused on import, naming the key,
  rather than read with its comments silently gone.

← Back to [reference](README.md)
